#!/usr/bin/env node
/**
 * ============================================================================
 * QA Agent Framework — CLI
 * ============================================================================
 *
 * Commands:
 *   qa detect <repo-path>             Auto-detect conventions, generate config
 *   qa validate [--config <path>]     Validate test files against rules
 *   qa run [--config <path>]          Full pipeline: validate → execute → heal
 *   qa heal <results-path>            Self-heal from execution results
 *   qa experience [--stats|--query]   Manage experience library
 *   qa evolve [--report]               Run strategy evolution engine
 *   qa generate [--config <path>]     Generate tests via Claude Code CLI
 *   qa init                           Initialize qa-system in current project
 *
 * ============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_DIR = path.resolve(__dirname, '..', 'src');

// ============================================================================
// CLI PARSER
// ============================================================================

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

interface CLIArgs {
  command: string;
  target?: string;
  config?: string;
  flags: Record<string, boolean | string>;
}

function parseArgs(): CLIArgs {
  const raw = process.argv.slice(2);
  const command = raw[0] || 'help';
  const flags: Record<string, boolean | string> = {};
  let target: string | undefined;

  for (let i = 1; i < raw.length; i++) {
    if (raw[i].startsWith('--')) {
      const key = raw[i].replace(/^--/, '');
      if (raw[i + 1] && !raw[i + 1].startsWith('--')) {
        flags[key] = raw[++i];
      } else {
        flags[key] = true;
      }
    } else if (!target) {
      target = raw[i];
    }
  }

  return { command, target, config: flags['config'] as string, flags };
}

// ============================================================================
// COMMANDS
// ============================================================================

async function cmdDetect(target: string): Promise<void> {
  const { detectConventions } = await import('../src/engine/convention-detector.js');

  const repoPath = path.resolve(target);
  console.log(`\n${BOLD}QA Framework — Convention Detector${RESET}`);
  console.log(`Scanning: ${repoPath}\n`);

  const config = detectConventions(repoPath);

  // Print detection results
  console.log('Detection Results:');
  console.log('─'.repeat(60));
  for (const entry of config._detection_log) {
    const conf = (entry.result.confidence * 100).toFixed(0);
    const icon = entry.result.confidence >= 0.8 ? `${GREEN}✓${RESET}` : entry.result.confidence >= 0.5 ? `${YELLOW}~${RESET}` : `${RED}?${RESET}`;
    console.log(`  ${icon} ${entry.category.padEnd(20)} ${entry.result.detected.padEnd(20)} ${conf}%  ${DIM}(${entry.result.evidence})${RESET}`);
  }
  console.log('─'.repeat(60));

  // Write config
  const { _detection_log, ...cleanConfig } = config;
  const outputPath = path.resolve('qa-system', 'project.config.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(cleanConfig, null, 2));

  console.log(`\n${GREEN}Config written to: ${outputPath}${RESET}`);
  console.log(`\nNext steps:`);
  console.log(`  1. Edit ${outputPath} — add auth accounts, features, entry URLs`);
  console.log(`  2. Run: ${CYAN}qa validate --config ${outputPath}${RESET}`);
  console.log(`  3. Run: ${CYAN}qa run --config ${outputPath}${RESET}`);
}

async function cmdValidate(configPath?: string): Promise<void> {
  const { runEngine } = await import('../src/engine/validation-engine.js');

  console.log(`\n${BOLD}QA Framework — Validation Engine${RESET}\n`);

  // Find test files
  const testDir = configPath
    ? path.join(path.dirname(configPath), 'test')
    : path.resolve('qa-system', 'test');

  const testFiles = findFiles(testDir, ['.spec.ts', '.spec.js']);

  if (testFiles.length === 0) {
    console.log(`${YELLOW}No test files found in ${testDir}${RESET}`);
    process.exit(0);
  }

  console.log(`Found ${testFiles.length} test files\n`);
  const report = runEngine(testFiles);

  // Print results
  for (const result of report.results) {
    const icon = result.passed ? `${GREEN}PASS${RESET}` : `${RED}BLOCKED${RESET}`;
    console.log(`${icon}  ${path.basename(result.file)}  (${result.stats.errors} errors, ${result.stats.warnings} warnings)`);

    for (const v of result.violations) {
      const color = v.severity === 'error' ? RED : YELLOW;
      console.log(`  ${color}${v.severity.toUpperCase()}${RESET} [${v.ruleId}] line ${v.line}: ${v.message}`);
      console.log(`  ${DIM}  ${v.snippet}${RESET}`);
      console.log(`  ${CYAN}  Fix: ${v.fix_hint}${RESET}`);
    }
  }

  console.log();
  if (report.blocked > 0) {
    console.log(`${RED}${BOLD}BLOCKED: ${report.blocked} file(s) failed validation.${RESET}`);
    process.exit(1);
  } else {
    console.log(`${GREEN}${BOLD}ALL PASSED: ${report.passed} file(s) cleared for execution.${RESET}`);
  }
}

async function cmdRun(configPath?: string, flags: Record<string, boolean | string> = {}): Promise<void> {
  const { execSync } = await import('child_process');

  const qaDir = configPath ? path.dirname(configPath) : path.resolve('qa-system');
  const cfgPath = configPath || path.join(qaDir, 'project.config.json');
  const skipGenerate = flags['skip-generate'] === true;
  const skipExecute = flags['skip-execute'] === true;
  const modelOverride = flags['model'] as string | undefined;

  // Read project name from config if available
  let projectName = 'default';
  if (fs.existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      projectName = cfg.project?.name || projectName;
    } catch { /* use default */ }
  }

  console.log(`\n${BOLD}QA Framework — Full Pipeline${RESET}`);
  console.log(`${DIM}generate → validate → execute → heal → learn → evolve → summary${RESET}`);
  console.log(`Project: ${CYAN}${projectName}${RESET}`);
  if (modelOverride) console.log(`Model: ${CYAN}${modelOverride}${RESET}`);
  console.log();

  // ── Phase 1: Generate (optional) ──────────────────────────────────
  if (!skipGenerate && fs.existsSync(cfgPath)) {
    console.log(`${YELLOW}[Phase 1/6] Generating tests...${RESET}`);
    const { ClaudeCodeRunner, buildTestGenerationTasks } = await import('../src/engine/claude-code-runner.js');
    const config = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    const projectRoot = config.project?.root || path.dirname(cfgPath);
    const tasks = buildTestGenerationTasks(cfgPath, SRC_DIR.replace('/src', ''));

    if (tasks.length > 0) {
      const runner = new ClaudeCodeRunner({ projectRoot, frameworkRoot: SRC_DIR.replace('/src', ''), model: modelOverride });
      const results = await runner.runPipeline(tasks);
      const passed = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;
      console.log(`${GREEN}Generated: ${passed}${RESET}${failed > 0 ? `  ${RED}Failed: ${failed}${RESET}` : ''}\n`);
    } else {
      console.log(`${DIM}No features in config — skipping generation${RESET}\n`);
    }
  } else if (skipGenerate) {
    console.log(`${DIM}[Phase 1/6] Skipping generation (--skip-generate)${RESET}\n`);
  }

  // ── Phase 2: Validate ─────────────────────────────────────────────
  console.log(`${YELLOW}[Phase 2/6] Validating tests...${RESET}`);
  const { runEngine } = await import('../src/engine/validation-engine.js');

  const testDir = path.join(qaDir, 'test');
  const testFiles = findFiles(testDir, ['.spec.ts', '.spec.js']);

  if (testFiles.length === 0) {
    console.log(`${YELLOW}No test files found in ${testDir}. Run 'qa generate' first.${RESET}`);
    process.exit(0);
  }

  const valReport = runEngine(testFiles);
  if (valReport.blocked > 0) {
    console.log(`${RED}BLOCKED: ${valReport.blocked} file(s) failed validation. Fix before executing.${RESET}`);
    process.exit(2);
  }
  console.log(`${GREEN}Validation passed: ${valReport.passed} file(s)${RESET}\n`);

  // ── Phase 3: Execute (Playwright) ─────────────────────────────────
  const resultsPath = path.join(qaDir, 'reports', 'execution-results.json');
  if (!skipExecute) {
    console.log(`${YELLOW}[Phase 3/6] Executing tests (Playwright)...${RESET}`);
    const playwrightConfig = path.join(qaDir, 'playwright.config.ts');
    const configFlag = fs.existsSync(playwrightConfig) ? `--config=${playwrightConfig}` : '';

    try {
      execSync(`npx playwright test ${configFlag}`, {
        cwd: qaDir,
        stdio: 'inherit',
        timeout: 300_000,
      });
      console.log(`${GREEN}All tests passed.${RESET}\n`);
    } catch {
      console.log(`${RED}Some tests failed.${RESET}\n`);
      // Continue pipeline — healing will attempt fixes
    }
  } else {
    console.log(`${DIM}[Phase 3/6] Skipping execution (--skip-execute)${RESET}\n`);
  }

  // ── Phase 4: Heal ─────────────────────────────────────────────────
  if (fs.existsSync(resultsPath)) {
    console.log(`${YELLOW}[Phase 4/6] Self-healing from results...${RESET}`);
    const { heal } = await import('../src/engine/self-healing-agent.js');
    const healReport = heal(resultsPath, flags['dry-run'] === true);

    if (healReport.autoFixed > 0) {
      console.log(`${GREEN}Auto-fixed: ${healReport.autoFixed}${RESET}`);
    }
    if (healReport.needsRegeneration > 0) {
      console.log(`${YELLOW}Needs AI regeneration: ${healReport.needsRegeneration}${RESET}`);
    }
    console.log();
  } else {
    console.log(`${DIM}[Phase 4/6] No execution results — skipping heal${RESET}\n`);
  }

  // ── Phase 5: Learn ────────────────────────────────────────────────
  console.log(`${YELLOW}[Phase 5/6] Extracting experience...${RESET}`);
  const { ExperienceLibrary } = await import('../src/engine/experience-library.js');
  const { extractExperiences } = await import('../src/engine/experience-extractor.js');

  const dbPath = path.join(qaDir, 'experience-db.json');
  const lib = ExperienceLibrary.load(dbPath);

  const extraction = extractExperiences({
    projectName,
    executionResults: readJson(resultsPath),
    validationReport: valReport,
    healingReport: readJson(path.join(qaDir, 'reports', 'healing-report.json')),
  }, lib);

  if (extraction.extracted > 0) {
    console.log(`${GREEN}Extracted ${extraction.extracted} new experiences${RESET}`);
  }
  console.log();

  // ── Phase 6: Evolve ───────────────────────────────────────────────
  console.log(`${YELLOW}[Phase 6/6] Strategy evolution...${RESET}`);
  const { StrategyEvolutionEngine } = await import('../src/engine/strategy-evolution.js');
  const stratPath = path.join(qaDir, 'strategy-evolution-db.json');
  const stratEngine = StrategyEvolutionEngine.load(stratPath);
  const evolution = stratEngine.evolve(lib, projectName);

  if (evolution.newMutations.length > 0) {
    for (const m of evolution.newMutations) {
      console.log(`${GREEN}MUTATION: ${m.concern}: ${m.from} → ${m.to}${RESET}`);
    }
  }
  if (evolution.revertedMutations.length > 0) {
    for (const m of evolution.revertedMutations) {
      console.log(`${RED}REVERTED: ${m.concern}: ${m.from} → ${m.to}${RESET}`);
    }
  }
  if (evolution.confirmedMutations.length > 0) {
    for (const m of evolution.confirmedMutations) {
      console.log(`${GREEN}CONFIRMED: ${m.concern}: ${m.from} → ${m.to}${RESET}`);
    }
  }

  // ── Phase 7: Summary (sonnet reads reports → human-readable summary) ──
  console.log(`\n${YELLOW}[Phase 7/7] Generating summary...${RESET}`);
  try {
    const { ClaudeCodeRunner } = await import('../src/engine/claude-code-runner.js');
    const reportsDir = path.join(qaDir, 'reports');

    // Collect all available report data
    const reportData: string[] = ['QA Pipeline Run Summary Data:'];

    const valJson = readJson(path.join(reportsDir, 'validation-report.json'));
    if (valJson) reportData.push(`\n--- Validation Report ---\n${JSON.stringify(valJson, null, 2).slice(0, 2000)}`);

    const execJson = readJson(path.join(reportsDir, 'execution-results.json'));
    if (execJson) reportData.push(`\n--- Execution Results ---\n${JSON.stringify(execJson, null, 2).slice(0, 3000)}`);

    const healJson = readJson(path.join(reportsDir, 'healing-report.json'));
    if (healJson) reportData.push(`\n--- Healing Report ---\n${JSON.stringify(healJson, null, 2).slice(0, 2000)}`);

    const expStats = lib.stats;
    reportData.push(`\n--- Experience Library ---\n${JSON.stringify(expStats, null, 2)}`);

    const evolveStats = {
      activeMutations: evolution.activeMutations.length,
      newMutations: evolution.newMutations.map(m => `${m.concern}: ${m.from} → ${m.to}`),
      revertedMutations: evolution.revertedMutations.map(m => `${m.concern}: ${m.from} → ${m.to}`),
      confirmedMutations: evolution.confirmedMutations.map(m => `${m.concern}: ${m.from} → ${m.to}`),
    };
    reportData.push(`\n--- Strategy Evolution ---\n${JSON.stringify(evolveStats, null, 2)}`);

    const runner = new ClaudeCodeRunner({
      projectRoot: qaDir,
      model: 'sonnet',
    });

    const summaryResult = await runner.run({
      agentType: 'file-reader',
      prompt: [
        'Read the QA pipeline data below and write a concise summary to stdout.',
        'Format: short paragraphs, use numbers. Vietnamese OK.',
        'Include: total tests, pass/fail count, what was auto-healed, what was learned, any strategy mutations.',
        'Keep it under 300 words. Do NOT write any files.',
        '',
        reportData.join('\n'),
      ].join('\n'),
      allowedTools: ['Read'],
    });

    if (summaryResult.success && summaryResult.output) {
      console.log(`\n${BOLD}━━━ Pipeline Summary ━━━${RESET}\n`);
      console.log(summaryResult.output.trim());
      console.log(`\n${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
    }
  } catch {
    // Summary is optional — don't fail pipeline if claude CLI unavailable
    console.log(`${DIM}(Summary skipped — claude CLI not available)${RESET}`);
  }

  console.log(`\n${GREEN}${BOLD}Pipeline complete.${RESET}`);
}

async function cmdHeal(resultsPath: string): Promise<void> {
  const { heal } = await import('../src/engine/self-healing-agent.js');

  console.log(`\n${BOLD}QA Framework — Self-Healing${RESET}`);
  console.log(`Reading: ${resultsPath}\n`);

  if (!fs.existsSync(resultsPath)) {
    console.error(`${RED}File not found: ${resultsPath}${RESET}`);
    process.exit(1);
  }

  const report = heal(resultsPath, false);

  console.log(`Total failures:  ${report.totalFailures}`);
  console.log(`${GREEN}Auto-fixed:${RESET}      ${report.autoFixed}`);
  console.log(`${YELLOW}Needs regen:${RESET}     ${report.needsRegeneration}`);
  console.log(`${RED}Unresolvable:${RESET}    ${report.unresolvable}`);

  if (report.regenerationQueue.length > 0) {
    console.log(`\n${YELLOW}Regeneration queue:${RESET}`);
    for (const item of report.regenerationQueue) {
      console.log(`  > ${path.basename(item.testFile)}: ${DIM}${item.context}${RESET}`);
    }
  }
}

async function cmdExperience(flags: Record<string, boolean | string>): Promise<void> {
  const { ExperienceLibrary } = await import('../src/engine/experience-library.js');

  const dbPath = path.resolve('qa-system', 'experience-db.json');
  const lib = ExperienceLibrary.load(dbPath);

  if (flags['stats'] || Object.keys(flags).length === 0) {
    console.log(`\n${BOLD}Experience Library Stats${RESET}`);
    console.log(JSON.stringify(lib.stats, null, 2));
  }

  if (flags['query'] && typeof flags['query'] === 'string') {
    const tags = (flags['query'] as string).split(',');
    const results = lib.query(...tags);
    console.log(`\n${BOLD}Query: ${tags.join(', ')}${RESET} — ${results.length} results`);
    for (const exp of results.slice(0, 10)) {
      console.log(`  [${exp.category}] confidence: ${(exp.confidence * 100).toFixed(0)}% — ${JSON.stringify(exp).slice(0, 120)}...`);
    }
  }

  if (flags['prompt-context']) {
    const category = (flags['prompt-context'] as string) || 'failure_pattern';
    const ctx = lib.generatePromptContext(category as any, 10);
    console.log(`\n${BOLD}Prompt Context (${category}):${RESET}`);
    console.log(ctx || '(empty — no experiences yet)');
  }
}

async function cmdGenerate(configPath?: string, flags: Record<string, boolean | string> = {}): Promise<void> {
  const { ClaudeCodeRunner, buildTestGenerationTasks } = await import('../src/engine/claude-code-runner.js');

  const cfgPath = configPath || path.resolve('qa-system', 'project.config.json');
  if (!fs.existsSync(cfgPath)) {
    console.error(`${RED}Config not found: ${cfgPath}${RESET}`);
    console.log(`Run: ${CYAN}qa detect <repo-path>${RESET} first.`);
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  const projectRoot = config.project?.root || path.dirname(cfgPath);
  const featureIndex = flags['feature'] ? parseInt(flags['feature'] as string, 10) : 0;
  const modelOverride = flags['model'] as string | undefined;

  console.log(`\n${BOLD}QA Framework — Test Generation (via Claude Code CLI)${RESET}`);
  console.log(`Project: ${CYAN}${config.project?.name}${RESET}`);
  console.log(`Feature: ${CYAN}${config.features?.[featureIndex]?.name || 'default'}${RESET}`);
  if (modelOverride) console.log(`Model override: ${CYAN}${modelOverride}${RESET}`);
  console.log();

  // Build tasks
  const tasks = buildTestGenerationTasks(cfgPath, SRC_DIR.replace('/src', ''), featureIndex);
  if (tasks.length === 0) {
    console.log(`${YELLOW}No features found in config. Add features to project.config.json.${RESET}`);
    return;
  }

  console.log(`${DIM}Tasks: ${tasks.length}${RESET}`);
  for (const t of tasks) {
    console.log(`  ${DIM}[${t.agentType}] → ${t.outputFile || '(stdout)'}${RESET}`);
  }
  console.log();

  // Run
  const runner = new ClaudeCodeRunner({
    projectRoot,
    model: modelOverride,
    frameworkRoot: SRC_DIR.replace('/src', ''),
  });

  const results = await runner.runPipeline(tasks);

  // Report
  let passed = 0;
  let failed = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const t = tasks[i];
    if (r.success) {
      passed++;
      console.log(`${GREEN}DONE${RESET} [${t.agentType}] ${(r.durationMs / 1000).toFixed(1)}s${r.outputFile ? ` → ${path.basename(r.outputFile)}` : ''}`);
    } else {
      failed++;
      console.log(`${RED}FAIL${RESET} [${t.agentType}] ${r.error?.slice(0, 200)}`);
    }
  }

  console.log(`\n${passed > 0 ? GREEN : ''}Generated: ${passed}${RESET}  ${failed > 0 ? RED : ''}Failed: ${failed}${RESET}`);

  if (passed > 0) {
    console.log(`\nNext: ${CYAN}qa validate --config ${cfgPath}${RESET}`);
  }
}

async function cmdEvolve(flags: Record<string, boolean | string>, target?: string): Promise<void> {
  const { ExperienceLibrary } = await import('../src/engine/experience-library.js');
  const { StrategyEvolutionEngine } = await import('../src/engine/strategy-evolution.js');

  const projectName = (flags['project'] as string) || target || 'default';
  const dbPath = path.resolve('qa-system', 'experience-db.json');
  const stratPath = path.resolve('qa-system', 'strategy-evolution-db.json');

  const lib = ExperienceLibrary.load(dbPath);
  const engine = StrategyEvolutionEngine.load(stratPath);

  if (flags['report']) {
    console.log(`\n${engine.generateReport()}`);
    return;
  }

  console.log(`\n${BOLD}QA Framework — Strategy Evolution${RESET}`);
  console.log(`Project: ${CYAN}${projectName}${RESET}`);
  console.log(`${DIM}Analyzing experience library for strategy mutations...${RESET}\n`);

  const result = engine.evolve(lib, projectName);

  if (result.newMutations.length > 0) {
    console.log(`${GREEN}${BOLD}New mutations:${RESET}`);
    for (const m of result.newMutations) {
      console.log(`  ${GREEN}+${RESET} ${m.concern}: ${DIM}${m.from}${RESET} → ${CYAN}${m.to}${RESET}`);
      console.log(`    ${DIM}${m.reason}${RESET}`);
      console.log(`    Trigger: "${m.triggerPattern}" x${m.triggerFrequency} (confidence: ${(m.triggerConfidence * 100).toFixed(0)}%)`);
    }
  }

  if (result.revertedMutations.length > 0) {
    console.log(`\n${RED}${BOLD}Reverted mutations:${RESET}`);
    for (const m of result.revertedMutations) {
      console.log(`  ${RED}✗${RESET} ${m.concern}: ${m.from} → ${m.to} — failure rate increased`);
    }
  }

  if (result.confirmedMutations.length > 0) {
    console.log(`\n${GREEN}${BOLD}Confirmed mutations:${RESET}`);
    for (const m of result.confirmedMutations) {
      console.log(`  ${GREEN}✓${RESET} ${m.concern}: ${m.from} → ${m.to} — proven effective`);
    }
  }

  if (result.activeMutations.length > 0) {
    console.log(`\n${YELLOW}Active mutations (evaluating):${RESET}`);
    for (const m of result.activeMutations) {
      console.log(`  ~ ${m.concern}: ${m.from} → ${m.to} (${m.runsAfterMutation}/3 runs)`);
    }
  }

  if (result.newMutations.length === 0 && result.revertedMutations.length === 0 && result.confirmedMutations.length === 0) {
    console.log(`${DIM}No mutations triggered. Thresholds: frequency ≥ ${5}, confidence ≥ ${60}%${RESET}`);
  }

  // Show prompt section preview
  const promptSection = engine.generateStrategyPromptSection(projectName);
  if (promptSection) {
    console.log(`\n${BOLD}Strategy prompt section (will be injected into Test Strategy Agent):${RESET}`);
    console.log(`${DIM}${promptSection.slice(0, 500)}...${RESET}`);
  }
}

async function cmdInit(): Promise<void> {
  console.log(`\n${BOLD}QA Framework — Initialize${RESET}\n`);

  const qaDir = path.resolve('qa-system');
  if (fs.existsSync(qaDir)) {
    console.log(`${YELLOW}qa-system/ already exists. Skipping.${RESET}`);
    return;
  }

  // Create directory structure
  const dirs = [
    'qa-system/test/ui',
    'qa-system/test/api',
    'qa-system/test/state',
    'qa-system/reports',
    'qa-system/fixtures',
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }

  console.log(`${GREEN}Created qa-system/ directory structure.${RESET}`);
  console.log(`\nNext: ${CYAN}qa detect .${RESET} to auto-detect conventions and generate config.`);
}

function cmdHelp(): void {
  console.log(`
${BOLD}QA Agent Framework${RESET} — Self-learning QA system for frontend apps

${BOLD}COMMANDS${RESET}

  ${CYAN}qa detect${RESET} <repo-path>            Scan repo, auto-detect conventions, generate config
  ${CYAN}qa init${RESET}                          Create qa-system/ directory in current project
  ${CYAN}qa validate${RESET} [--config <path>]     Validate test files against quality rules
  ${CYAN}qa run${RESET} [--config <path>]          Full pipeline: generate → validate → execute → heal → learn → evolve → summary
  ${CYAN}qa heal${RESET} <results.json>            Self-heal failed tests from execution results
  ${CYAN}qa experience${RESET} [--stats|--query]   View experience library
  ${CYAN}qa generate${RESET} [--config <path>]       Generate tests via Claude Code CLI
  ${CYAN}qa evolve${RESET} [--report]              Run strategy evolution (detect + apply mutations)

${BOLD}MODEL OPTIONS${RESET}

  Default: sonnet / high (fast + good quality)
  Best:    --model opus  (opus / max — highest quality)

${BOLD}WORKFLOW${RESET}

  ${DIM}# 1. Initialize in your project${RESET}
  cd my-frontend-app
  qa init
  qa detect .

  ${DIM}# 2. Edit the generated config${RESET}
  vim qa-system/project.config.json
  ${DIM}# add auth accounts, feature entry URLs, sections${RESET}

  ${DIM}# 3. Full pipeline (generate + validate + execute + heal + learn + evolve)${RESET}
  qa run --config qa-system/project.config.json

  ${DIM}# 4. Or step by step${RESET}
  qa generate --config qa-system/project.config.json
  qa validate --config qa-system/project.config.json
  qa run --skip-generate    ${DIM}# validate + execute + heal + learn + evolve${RESET}

  ${DIM}# 5. After multiple runs — system learns and evolves${RESET}
  qa experience --stats
  qa evolve --report

${BOLD}PREREQUISITES${RESET}

  Node.js >= 20, Playwright, Claude Code CLI (for qa generate/run)
`);
}

// ============================================================================
// HELPERS
// ============================================================================

function findFiles(dir: string, extensions: string[]): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findFiles(full, extensions));
    } else if (extensions.some(ext => entry.name.endsWith(ext))) {
      results.push(full);
    }
  }
  return results;
}

function readJson(filePath: string): any {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
  const args = parseArgs();

  switch (args.command) {
    case 'detect':
      await cmdDetect(args.target || '.');
      break;
    case 'validate':
      await cmdValidate(args.config);
      break;
    case 'run':
      await cmdRun(args.config, args.flags);
      break;
    case 'heal':
      if (!args.target) {
        console.error(`${RED}Usage: qa heal <execution-results.json>${RESET}`);
        process.exit(1);
      }
      await cmdHeal(args.target);
      break;
    case 'experience':
      await cmdExperience(args.flags);
      break;
    case 'evolve':
      await cmdEvolve(args.flags, args.target);
      break;
    case 'generate':
      await cmdGenerate(args.config, args.flags);
      break;
    case 'init':
      await cmdInit();
      break;
    case 'help':
    case '--help':
    case '-h':
    default:
      cmdHelp();
  }
}

main().catch((err) => {
  console.error(`${RED}Error: ${err.message}${RESET}`);
  process.exit(1);
});
