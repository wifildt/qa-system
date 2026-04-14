/**
 * ============================================================================
 * CLAUDE CODE RUNNER — AI Agent Integration via Claude Code CLI
 * ============================================================================
 *
 * Instead of calling Claude API directly, this engine spawns `claude` CLI
 * as a subprocess. Benefits:
 *   - No API key management (uses existing auth)
 *   - No SDK dependency
 *   - Claude Code can read/write files directly in the target repo
 *   - Full tool access (Read, Write, Grep, Glob, Bash)
 *
 * Usage:
 *   const runner = new ClaudeCodeRunner({ projectRoot: '/path/to/repo' });
 *   const result = await runner.run({
 *     agentType: 'ui-test-generator',
 *     prompt: 'Generate Playwright tests for the StudentList section',
 *     systemPromptFile: 'prompts/03-ui-test-generation.md',
 *     outputFile: 'qa-system/test/ui/student-list.spec.ts',
 *   });
 * ============================================================================
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { FRAMEWORK_ROOT, frameworkAsset } from './paths.js';
import { ExperienceLibrary } from './experience-library.js';
import { StrategyEvolutionEngine } from './strategy-evolution.js';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Model selection: subscription-based, no per-token cost.
 *   Default: sonnet / high  (fast + good quality)
 *   Best:    opus / max     (user passes --model opus)
 */
const DEFAULT_MODEL = 'sonnet';
const DEFAULT_EFFORT = 'high';

/** Timeouts per agent type — needed for subprocess management */
const AGENT_TIMEOUTS: Record<string, number> = {
  'auth-fixture':         120_000,
  'file-reader':           60_000,
  'ui-test-generator':    600_000,
  'api-test-generator':   600_000,
  'state-test-generator': 600_000,
  'feature-understanding':300_000,
  'test-strategy':        300_000,
  'consistency-analysis': 180_000,
  'default':              180_000,
};

export interface RunnerConfig {
  /** Root directory of the target project */
  projectRoot: string;
  /** Model override: 'sonnet' (default) or 'opus' (best quality) */
  model?: string;
  /** Override timeout for all tasks (ms) */
  timeout?: number;
  /** Additional directories to give claude access to */
  additionalDirs?: string[];
  /** Path to the qa-agent-framework root (for prompts/rules) */
  frameworkRoot?: string;
}

export interface AgentTask {
  /** Which agent type this is (maps to prompt template) */
  agentType: string;
  /** The main prompt/instruction */
  prompt: string;
  /** System prompt file (relative to framework root) */
  systemPromptFile?: string;
  /** Where to write the output file (relative to project root) */
  outputFile?: string;
  /** Allowed tools (default: Read,Write,Glob,Grep) */
  allowedTools?: string[];
  /** Extra context to append to the prompt */
  context?: string;
}

export interface RunResult {
  success: boolean;
  output: string;
  outputFile?: string;
  durationMs: number;
  error?: string;
}

// ============================================================================
// CLAUDE CODE RUNNER
// ============================================================================

export class ClaudeCodeRunner {
  private config: RunnerConfig & { projectRoot: string; frameworkRoot: string; additionalDirs: string[] };

  constructor(config: RunnerConfig) {
    this.config = {
      ...config,
      projectRoot: path.resolve(config.projectRoot),
      additionalDirs: config.additionalDirs || [],
      frameworkRoot: config.frameworkRoot || FRAMEWORK_ROOT,
    };
  }

  private getModel(): string { return this.config.model || DEFAULT_MODEL; }
  private getEffort(): string { return this.getModel() === 'opus' ? 'max' : DEFAULT_EFFORT; }
  private getTimeout(agentType: string): number {
    return this.config.timeout ?? AGENT_TIMEOUTS[agentType] ?? AGENT_TIMEOUTS['default'];
  }

  /**
   * Run a single agent task via claude CLI.
   */
  async run(task: AgentTask): Promise<RunResult> {
    const start = Date.now();
    const model = this.getModel();
    const effort = this.getEffort();
    const timeout = this.getTimeout(task.agentType);

    // Inject experience from previous runs (if available)
    const experienceCtx = this.loadExperienceContext(task.agentType);
    if (experienceCtx) {
      task = { ...task, context: (task.context || '') + experienceCtx };
      console.log(`[${task.agentType}] Injected experience from previous runs`);
    }

    // Build the full prompt
    const fullPrompt = this.buildPrompt(task);

    // Build CLI args
    const args = this.buildArgs(task, model, effort);

    console.log(`[${task.agentType}] model=${model} effort=${effort}`);

    try {
      const output = await this.execute(fullPrompt, args, timeout);
      const durationMs = Date.now() - start;

      // Check if output file was created
      const outputFile = task.outputFile
        ? path.resolve(this.config.projectRoot, task.outputFile)
        : undefined;
      const fileCreated = outputFile ? fs.existsSync(outputFile) : false;

      return {
        success: true,
        output,
        outputFile: fileCreated ? outputFile : undefined,
        durationMs,
      };
    } catch (err: any) {
      return {
        success: false,
        output: '',
        durationMs: Date.now() - start,
        error: err.message || String(err),
      };
    }
  }

  /**
   * Run multiple agent tasks sequentially (pipeline).
   */
  async runPipeline(tasks: AgentTask[]): Promise<RunResult[]> {
    const results: RunResult[] = [];
    for (const task of tasks) {
      const result = await this.run(task);
      results.push(result);
      if (!result.success) {
        console.error(`[PIPELINE] Task "${task.agentType}" failed: ${result.error}`);
        // Continue pipeline — don't abort on single failure
      }
    }
    return results;
  }

  // --------------------------------------------------------------------------
  // PROMPT BUILDING
  // --------------------------------------------------------------------------

  private buildPrompt(task: AgentTask): string {
    const parts: string[] = [];

    // System prompt from file (injected as context)
    if (task.systemPromptFile) {
      const promptPath = path.resolve(this.config.frameworkRoot, task.systemPromptFile);
      if (fs.existsSync(promptPath)) {
        parts.push(`--- AGENT INSTRUCTIONS (from ${task.systemPromptFile}) ---`);
        parts.push(fs.readFileSync(promptPath, 'utf-8'));
        parts.push('--- END AGENT INSTRUCTIONS ---\n');
      }
    }

    // Main prompt
    parts.push(task.prompt);

    // Output file instruction
    if (task.outputFile) {
      parts.push(`\nWrite the output to: ${task.outputFile}`);
      parts.push('Create the file using the Write tool. Do not just output the code — actually write it to disk.');
    }

    // Extra context
    if (task.context) {
      parts.push(`\n--- ADDITIONAL CONTEXT ---`);
      parts.push(task.context);
    }

    return parts.join('\n');
  }

  // --------------------------------------------------------------------------
  // EXPERIENCE INJECTION — feeds previous run learnings into prompts
  // --------------------------------------------------------------------------

  /**
   * Load experience from project's qa-system/ and generate additional context.
   * Returns empty string if no experience DB exists (first run = base prompt only).
   */
  private loadExperienceContext(agentType: string): string {
    const qaDir = path.join(this.config.projectRoot, 'qa-system');
    const dbPath = path.join(qaDir, 'experience-db.json');

    if (!fs.existsSync(dbPath)) return '';

    const library = ExperienceLibrary.load(dbPath);
    if (library.stats.totalExperiences === 0) return '';

    const sections: string[] = [];

    // Failure patterns — what went wrong before
    const failureCtx = library.generatePromptContext('failure_pattern', 5);
    if (failureCtx) sections.push(failureCtx);

    // Fix strategies — what worked to fix it
    const fixCtx = library.generatePromptContext('fix_strategy', 5);
    if (fixCtx) sections.push(fixCtx);

    // Anti-patterns — what to avoid
    const antiCtx = library.generatePromptContext('anti_pattern', 3);
    if (antiCtx) sections.push(antiCtx);

    // Strategy mutations — approach changes from evolution engine
    const stratPath = path.join(qaDir, 'strategy-evolution-db.json');
    if (fs.existsSync(stratPath)) {
      try {
        const stratEngine = StrategyEvolutionEngine.load(stratPath);
        const stratSection = stratEngine.generateStrategyPromptSection();
        if (stratSection) sections.push(stratSection);
      } catch { /* no strategy data yet */ }
    }

    if (sections.length === 0) return '';

    return [
      '',
      '--- EXPERIENCE FROM PREVIOUS RUNS (apply these lessons) ---',
      ...sections,
      '> These are real lessons from past executions. Apply them proactively.',
      '--- END EXPERIENCE ---',
    ].join('\n');
  }

  // --------------------------------------------------------------------------
  // CLI ARGS
  // --------------------------------------------------------------------------

  private buildArgs(task: AgentTask, model: string, effort: string): string[] {
    const args: string[] = [
      '--print',
      '--model', model,
      '--effort', effort,
      '--output-format', 'text',
      '--no-session-persistence',
    ];

    // Allowed tools — restrict what claude can do
    const tools = task.allowedTools || ['Read', 'Write', 'Glob', 'Grep', 'Bash'];
    args.push('--allowedTools', tools.join(' '));

    // Give access to project root
    args.push('--add-dir', this.config.projectRoot);

    // Give access to framework root (for reading prompts/rules)
    if (this.config.frameworkRoot !== this.config.projectRoot) {
      args.push('--add-dir', this.config.frameworkRoot);
    }

    // Additional dirs
    for (const dir of this.config.additionalDirs) {
      args.push('--add-dir', dir);
    }

    return args;
  }

  // --------------------------------------------------------------------------
  // EXECUTE
  // --------------------------------------------------------------------------

  private execute(prompt: string, args: string[], timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('claude', args, {
        cwd: this.config.projectRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      // Send prompt via stdin
      proc.stdin.write(prompt);
      proc.stdin.end();

      // Timeout
      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error(`Claude CLI timed out after ${timeout}ms`));
      }, timeout);

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Claude CLI exited with code ${code}: ${stderr || stdout}`));
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Failed to spawn claude CLI: ${err.message}`));
      });
    });
  }

  // --------------------------------------------------------------------------
  // PARALLEL EXECUTION
  // --------------------------------------------------------------------------

  /**
   * Run multiple tasks concurrently with limited concurrency.
   */
  async runParallel(tasks: AgentTask[], concurrency: number = 3): Promise<RunResult[]> {
    const results: RunResult[] = new Array(tasks.length);
    const queue = tasks.map((t, i) => ({ task: t, index: i }));

    const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
      while (queue.length > 0) {
        const item = queue.shift()!;
        results[item.index] = await this.run(item.task);
        if (!results[item.index].success) {
          console.error(`[PARALLEL] Task "${item.task.agentType}" failed: ${results[item.index].error}`);
        }
      }
    });

    await Promise.all(workers);
    return results;
  }
}

// ============================================================================
// TEST GENERATION — 2-step: plan then generate
// ============================================================================

export interface GenerateOptions {
  /** Target specific sections by ID */
  sections?: string[];
  /** Free-text description of what to test */
  describe?: string;
}

/**
 * Build shared project context string from config.
 */
function buildProjectContext(config: any, feature: any): string {
  const parts: string[] = [
    `Project: ${config.project.name}`,
    `Framework: ${config.framework.name} + ${config.framework.ui_library}`,
    `State: ${config.state.manager} + ${config.state.side_effects}`,
    `Feature: ${feature.name}`,
    `Pages: ${feature.pages_glob?.join(', ')}`,
    `Store module: ${feature.store_module}`,
    `Entry URL: ${feature.entry_url}`,
    `Roles: ${feature.roles?.join(', ')}`,
  ];

  if (config.auth?.accounts) {
    parts.push('\nTest Accounts:');
    for (const [role, acc] of Object.entries(config.auth.accounts) as any) {
      parts.push(`  ${role}: ${acc.credentials.username} / ${acc.credentials.password} (${acc.description})`);
    }
  }

  if (feature.sections) {
    parts.push('\nFeature sections:');
    for (const s of feature.sections) {
      parts.push(`  - ${s.id}: ${s.name}${s.component ? ` (component: ${s.component})` : ''}`);
    }
  }

  return parts.join('\n');
}

/**
 * Load validation rules as context string.
 */
function loadRulesContext(): string {
  const rulesDir = frameworkAsset('src', 'rules');
  if (!fs.existsSync(rulesDir)) return '';

  const ruleFiles = fs.readdirSync(rulesDir).filter(f => f.endsWith('.json'));
  let ctx = '\n--- VALIDATION RULES (generated tests MUST comply) ---\n';
  for (const rf of ruleFiles) {
    try {
      const rules = JSON.parse(fs.readFileSync(path.join(rulesDir, rf), 'utf-8'));
      ctx += `\n[${rf}]\n`;
      if (Array.isArray(rules.rules)) {
        for (const r of rules.rules) {
          ctx += `- ${r.id}: ${r.description}\n`;
        }
      }
    } catch { /* skip bad rule file */ }
  }
  return ctx;
}

/**
 * Common test generation rules included in every prompt.
 */
const TEST_RULES = `
STRICT TEST RULES:
- Import { test, expect, BASE_URL } from "../../fixtures/auth"
- Use the pre-authenticated page fixtures (gvcnPage, adminPage, teacherPage)
- Every test MUST call page.screenshot() for evidence capture
- Use getByRole/getByText/getByLabel — NEVER use CSS class selectors (.ant-*, .sc-*)
- NO page.waitForTimeout() — use waitForResponse or waitForLoadState
- For data mutations: intercept API with page.waitForResponse()
- For Ant Design Select: use getByRole("combobox"), click with { force: true }
- Login URL is /dang-nhap (NOT /login)
`.trim();

/**
 * Build auth fixture task (if not already generated).
 */
function buildAuthTask(config: any, context: string, rulesContext: string): AgentTask | null {
  const authPath = path.join(config.project.root, 'qa-system', 'fixtures', 'auth.ts');
  if (fs.existsSync(authPath)) return null;

  return {
    agentType: 'auth-fixture',
    prompt: [
      `Read the login page source code in the project (look in src/Pages/Authentication/).`,
      `Understand: form fields, selectors, submit button, login API endpoint, redirect behavior.`,
      `Generate a Playwright auth fixture at qa-system/fixtures/auth.ts that:`,
      `1. Imports from "playwright/test" (NOT "@playwright/test")`,
      `2. Exports loginAs(page, role) function using real selectors from the code`,
      `3. Exports extended test fixture with pre-authenticated pages per role`,
      `4. Uses the BASE_URL and accounts from config below`,
    ].join('\n'),
    outputFile: 'qa-system/fixtures/auth.ts',
    context: context + rulesContext,
  };
}

/**
 * Build the test plan task — claude reads project and outputs a plan JSON.
 */
function buildPlanTask(config: any, feature: any, context: string, rulesContext: string, options: GenerateOptions): AgentTask {
  const scopeInstruction = options.describe
    ? `USER REQUEST: "${options.describe}"\nGenerate tests specifically for what the user described.`
    : options.sections?.length
      ? `TARGET SECTIONS: ${options.sections.join(', ')}\nGenerate tests only for these sections.`
      : `Generate comprehensive tests for ALL sections of this feature.`;

  return {
    agentType: 'test-strategy',
    prompt: [
      `You are a QA test strategist. Read the project source code and create a test plan.`,
      ``,
      `${scopeInstruction}`,
      ``,
      `STEPS:`,
      `1. Read the feature's page components (${feature.pages_glob?.join(', ')})`,
      `2. Read the store module (src/${feature.store_module}/) to understand API calls`,
      `3. Read qa-system/fixtures/auth.ts to understand available auth fixtures`,
      `4. Analyze each section: is it view-only, form+save, CRUD table, statistics, or per-student?`,
      `5. Group related sections into logical test files`,
      `6. Output a JSON test plan`,
      ``,
      `OUTPUT FORMAT — write a JSON file to qa-system/test-plan.json:`,
      `{`,
      `  "testFiles": [`,
      `    {`,
      `      "path": "qa-system/test/ui/<filename>.spec.ts",`,
      `      "description": "What this test file covers",`,
      `      "sections": ["section-id-1", "section-id-2"],`,
      `      "readFiles": ["src/path/to/Component1.jsx", "src/path/to/Component2.jsx"],`,
      `      "testScenarios": ["scenario 1 description", "scenario 2 description"]`,
      `    }`,
      `  ]`,
      `}`,
      ``,
      `GUIDELINES:`,
      `- Group 2-4 related sections per test file (don't make 20 files)`,
      `- Each test file should have 3-6 test scenarios`,
      `- Include readFiles — the specific component files claude should read when generating`,
      `- Always include a "navigation" test file that covers page load + sidebar navigation`,
      `- For CRUD sections: include add/edit/delete scenarios`,
      `- For form sections: include edit/save/dirty-guard scenarios`,
      `- For view-only sections: just navigation + verify render`,
    ].join('\n'),
    outputFile: 'qa-system/test-plan.json',
    context: context + rulesContext,
  };
}

/**
 * Build test generation tasks from a test plan JSON.
 */
export function buildTestsFromPlan(
  planPath: string,
  projectRoot: string,
  context: string,
  rulesContext: string,
): AgentTask[] {
  if (!fs.existsSync(planPath)) return [];

  let plan: any;
  try {
    plan = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
  } catch {
    console.error(`[PLAN] Failed to parse test-plan.json`);
    return [];
  }

  if (!plan.testFiles || !Array.isArray(plan.testFiles)) return [];

  return plan.testFiles.map((tf: any) => ({
    agentType: 'ui-test-generator',
    prompt: [
      `Generate a Playwright E2E test file.`,
      ``,
      `WHAT TO TEST: ${tf.description}`,
      `Sections: ${tf.sections?.join(', ')}`,
      ``,
      `READ THESE FILES to understand the components:`,
      ...(tf.readFiles || []).map((f: string) => `- ${f}`),
      `- qa-system/fixtures/auth.ts (for auth fixture imports)`,
      ``,
      `TEST SCENARIOS to implement:`,
      ...(tf.testScenarios || []).map((s: string, i: number) => `${i + 1}. ${s}`),
      ``,
      TEST_RULES,
      ``,
      `Write the file to: ${tf.path}`,
    ].join('\n'),
    outputFile: tf.path,
    context,
  }));
}

/**
 * Build all test generation tasks for a feature.
 * 2-step process: returns auth + plan tasks first.
 * After plan executes, call buildTestsFromPlan() for the actual test tasks.
 */
export function buildTestGenerationTasks(
  projectConfigPath: string,
  frameworkRoot: string,
  featureIndex: number = 0,
  options: GenerateOptions = {},
): { authTask: AgentTask | null; planTask: AgentTask; config: any; context: string; rulesContext: string } | null {
  const config = JSON.parse(fs.readFileSync(projectConfigPath, 'utf-8'));
  const feature = config.features?.[featureIndex];
  if (!feature) return null;

  const context = buildProjectContext(config, feature);
  const rulesContext = loadRulesContext();

  const authTask = buildAuthTask(config, context, rulesContext);
  const planTask = buildPlanTask(config, feature, context, rulesContext, options);

  return { authTask, planTask, config, context, rulesContext };
}
