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
  'ui-test-generator':    300_000,
  'api-test-generator':   300_000,
  'state-test-generator': 300_000,
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
}

// ============================================================================
// PRESET TASKS — Common agent tasks ready to use
// ============================================================================

/**
 * Build agent tasks for a specific feature from project config.
 */
export function buildTestGenerationTasks(
  projectConfigPath: string,
  frameworkRoot: string,
  featureIndex: number = 0,
): AgentTask[] {
  const config = JSON.parse(fs.readFileSync(projectConfigPath, 'utf-8'));
  const feature = config.features?.[featureIndex];
  if (!feature) return [];

  const projectRoot = config.project.root;
  const tasks: AgentTask[] = [];

  // Read project context
  const contextParts: string[] = [
    `Project: ${config.project.name}`,
    `Framework: ${config.framework.name} + ${config.framework.ui_library}`,
    `State: ${config.state.manager} + ${config.state.side_effects}`,
    `Feature: ${feature.name}`,
    `Pages glob: ${feature.pages_glob?.join(', ')}`,
    `Store module: ${feature.store_module}`,
    `Entry URL: ${feature.entry_url}`,
    `Roles: ${feature.roles?.join(', ')}`,
  ];

  // Auth info
  if (config.auth?.accounts) {
    contextParts.push('\nTest Accounts:');
    for (const [role, acc] of Object.entries(config.auth.accounts) as any) {
      contextParts.push(`  ${role}: ${acc.credentials.username} / ${acc.credentials.password} (${acc.description})`);
    }
  }

  // Sections
  if (feature.sections) {
    contextParts.push('\nSections to test:');
    for (const s of feature.sections) {
      contextParts.push(`  - ${s.id}: ${s.name} (component: ${s.component})`);
    }
  }

  const context = contextParts.join('\n');

  // Load rules for context
  const rulesDir = frameworkAsset('src', 'rules');
  let rulesContext = '';
  if (fs.existsSync(rulesDir)) {
    const ruleFiles = fs.readdirSync(rulesDir).filter(f => f.endsWith('.json'));
    rulesContext = '\n--- VALIDATION RULES (tests MUST comply) ---\n';
    for (const rf of ruleFiles) {
      const rules = JSON.parse(fs.readFileSync(path.join(rulesDir, rf), 'utf-8'));
      rulesContext += `\n[${rf}]\n`;
      if (Array.isArray(rules.rules)) {
        for (const r of rules.rules) {
          rulesContext += `- ${r.id}: ${r.description}\n`;
        }
      }
    }
  }

  // Task 1: Generate auth fixture
  tasks.push({
    agentType: 'auth-fixture',
    prompt: [
      `Read the login page at src/Pages/Authentication/ in the project root.`,
      `Understand how login works — what form fields, what selectors, what API endpoint.`,
      `Then generate a Playwright auth fixture at qa-system/fixtures/auth.ts that:`,
      `1. Imports from "playwright/test" (NOT "@playwright/test")`,
      `2. Exports loginAs(page, role) function`,
      `3. Exports extended test fixture with pre-authenticated pages for each role`,
      `4. Uses http://localhost:3001 as BASE_URL`,
      `5. Uses the real login form selectors from the actual code`,
      `6. Includes the test accounts from the config below`,
    ].join('\n'),
    outputFile: 'qa-system/fixtures/auth.ts',
    context: context + rulesContext,
  });

  // Task 2+: Generate UI tests per section (one task per section, keeps scope narrow)
  const sections = feature.sections || [];
  const sectionsToTest = sections.slice(0, 3); // Start with first 3 critical sections

  // First: a navigation + page load test
  tasks.push({
    agentType: 'ui-test-generator',
    prompt: [
      `Generate a Playwright E2E test for the "${feature.name}" feature.`,
      ``,
      `Read ONLY these files to understand the page:`,
      `- src/${feature.pages_glob?.[0]?.replace('/**', '')}/index.jsx`,
      `- src/${feature.pages_glob?.[0]?.replace('/**', '')}/SoChuNhiem.jsx (if exists)`,
      `- src/${feature.pages_glob?.[0]?.replace('/**', '')}/NotebookDialog/index.jsx (if exists)`,
      `- qa-system/fixtures/auth.ts (to understand the auth fixture)`,
      ``,
      `Generate tests that cover:`,
      `1. Login as GVCN → navigate to ${feature.entry_url} → verify page loads`,
      `2. Click to open notebook → verify dialog appears (use API intercept as signal)`,
      `3. Login as Admin → navigate to admin URL → verify filter controls visible`,
      ``,
      `STRICT RULES:`,
      `- Import { test, expect, BASE_URL } from "../../fixtures/auth"`,
      `- Every test MUST call page.screenshot() for evidence capture`,
      `- Use getByRole/getByText/getByLabel — NEVER use CSS class selectors like .ant-*`,
      `- NO page.waitForTimeout() — use waitForResponse or waitForLoadState`,
      `- For data checks: use page.waitForResponse() to intercept API calls`,
      `- Write the file to: qa-system/test/ui/scn-critical-paths.spec.ts`,
    ].join('\n'),
    outputFile: 'qa-system/test/ui/scn-critical-paths.spec.ts',
    context,
  });

  return tasks;
}
