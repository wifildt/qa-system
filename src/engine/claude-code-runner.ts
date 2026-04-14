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

// ============================================================================
// TYPES
// ============================================================================

/** Model + effort strategy per agent type to optimize cost */
type ModelTier = 'sonnet' | 'opus';
type EffortLevel = 'low' | 'medium' | 'high' | 'max';

interface AgentCostProfile {
  model: ModelTier;
  effort: EffortLevel;
  maxBudget: number;
  timeout: number;
}

/**
 * Cost profiles per agent type.
 * - haiku/low: quick deterministic tasks (auth fixture, file reading)
 * - sonnet/medium: standard generation (UI tests, API tests)
 * - opus/high: complex reasoning (test strategy, feature understanding)
 */
const AGENT_COST_PROFILES: Record<string, AgentCostProfile> = {
  // Quick tasks — sonnet low effort
  'auth-fixture':        { model: 'sonnet', effort: 'low',    maxBudget: 0.30, timeout: 120_000 },
  'file-reader':         { model: 'sonnet', effort: 'low',    maxBudget: 0.15, timeout: 60_000 },

  // Standard generation — sonnet medium effort, generous timeout
  'ui-test-generator':   { model: 'sonnet', effort: 'medium', maxBudget: 0.80, timeout: 300_000 },
  'api-test-generator':  { model: 'sonnet', effort: 'medium', maxBudget: 0.80, timeout: 300_000 },
  'state-test-generator':{ model: 'sonnet', effort: 'medium', maxBudget: 0.80, timeout: 300_000 },

  // Complex reasoning — opus for quality
  'feature-understanding':{ model: 'opus',  effort: 'high',   maxBudget: 1.50, timeout: 300_000 },
  'test-strategy':        { model: 'opus',  effort: 'high',   maxBudget: 1.00, timeout: 300_000 },
  'consistency-analysis': { model: 'sonnet', effort: 'high',  maxBudget: 0.50, timeout: 180_000 },

  // Default
  'default':             { model: 'sonnet', effort: 'medium', maxBudget: 0.50, timeout: 180_000 },
};

export interface RunnerConfig {
  /** Root directory of the target project */
  projectRoot: string;
  /** Override model for all tasks (ignores cost profiles) */
  model?: string;
  /** Override max budget for all tasks */
  maxBudget?: number;
  /** Override timeout for all tasks */
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

  /** Get cost profile for an agent type (with config overrides) */
  private getProfile(agentType: string): AgentCostProfile {
    const base = AGENT_COST_PROFILES[agentType] || AGENT_COST_PROFILES['default'];
    return {
      model: (this.config.model as ModelTier) || base.model,
      effort: base.effort,
      maxBudget: this.config.maxBudget ?? base.maxBudget,
      timeout: this.config.timeout ?? base.timeout,
    };
  }

  /**
   * Run a single agent task via claude CLI.
   */
  async run(task: AgentTask): Promise<RunResult> {
    const start = Date.now();
    const profile = this.getProfile(task.agentType);

    // Build the full prompt
    const fullPrompt = this.buildPrompt(task);

    // Build CLI args
    const args = this.buildArgs(task, profile);

    console.log(`[${task.agentType}] model=${profile.model} effort=${profile.effort} budget=$${profile.maxBudget}`);

    try {
      const output = await this.execute(fullPrompt, args, profile.timeout);
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
  // CLI ARGS
  // --------------------------------------------------------------------------

  private buildArgs(task: AgentTask, profile: AgentCostProfile): string[] {
    const args: string[] = [
      '--print',
      '--model', profile.model,
      '--effort', profile.effort,
      '--max-budget-usd', String(profile.maxBudget),
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
