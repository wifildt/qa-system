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
  console.log(`\n${BOLD}QA Framework — Full Pipeline${RESET}`);
  console.log(`${DIM}validate → execute → heal → extract experience → report${RESET}\n`);

  // Phase 1: Validate
  console.log(`${YELLOW}[Phase 1] Validating tests...${RESET}`);
  const { runEngine } = await import('../src/engine/validation-engine.js');

  const testDir = configPath
    ? path.join(path.dirname(configPath), 'test')
    : path.resolve('qa-system', 'test');
  const testFiles = findFiles(testDir, ['.spec.ts', '.spec.js']);

  if (testFiles.length === 0) {
    console.log(`${YELLOW}No test files found. Run 'qa detect' first.${RESET}`);
    process.exit(0);
  }

  const valReport = runEngine(testFiles);
  if (valReport.blocked > 0) {
    console.log(`${RED}BLOCKED: ${valReport.blocked} file(s) failed validation. Fix before executing.${RESET}`);
    process.exit(2);
  }
  console.log(`${GREEN}Validation passed: ${valReport.passed} file(s)${RESET}\n`);

  // Phase 2: Execute
  console.log(`${YELLOW}[Phase 2] Executing tests...${RESET}`);
  console.log(`${DIM}Run: npx playwright test${RESET}`);
  console.log(`${DIM}(Execution engine delegates to Playwright/Vitest — run manually or via CI)${RESET}\n`);

  // Phase 3: Heal (if results exist)
  const resultsPath = path.resolve('qa-system', 'reports', 'execution-results.json');
  if (fs.existsSync(resultsPath)) {
    console.log(`${YELLOW}[Phase 3] Self-healing from results...${RESET}`);
    const { heal } = await import('../src/engine/self-healing-agent.js');
    const healReport = heal(resultsPath, flags['dry-run'] === true);

    if (healReport.autoFixed > 0) {
      console.log(`${GREEN}Auto-fixed: ${healReport.autoFixed}${RESET}`);
    }
    if (healReport.needsRegeneration > 0) {
      console.log(`${YELLOW}Needs AI regeneration: ${healReport.needsRegeneration}${RESET}`);
    }
  }

  // Phase 4: Extract experience
  console.log(`\n${YELLOW}[Phase 4] Extracting experience...${RESET}`);
  const { ExperienceLibrary } = await import('../src/engine/experience-library.js');
  const { extractExperiences } = await import('../src/engine/experience-extractor.js');

  const dbPath = path.resolve('qa-system', 'experience-db.json');
  const lib = ExperienceLibrary.load(dbPath);

  const extraction = extractExperiences({
    projectName: configPath ? path.basename(configPath, '.config.json') : 'default',
    executionResults: readJson(resultsPath),
    validationReport: valReport,
    healingReport: readJson(path.resolve('qa-system', 'reports', 'healing-report.json')),
  }, lib);

  if (extraction.extracted > 0) {
    console.log(`${GREEN}Extracted ${extraction.extracted} new experiences${RESET}`);
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
  ${CYAN}qa run${RESET} [--config <path>]          Full pipeline: validate → execute → heal → learn
  ${CYAN}qa heal${RESET} <results.json>            Self-heal failed tests from execution results
  ${CYAN}qa experience${RESET} [--stats|--query]   View experience library

${BOLD}WORKFLOW${RESET}

  ${DIM}# 1. Initialize in your project${RESET}
  cd my-frontend-app
  qa init
  qa detect .

  ${DIM}# 2. Edit the generated config${RESET}
  vim qa-system/project.config.json
  ${DIM}# → add auth accounts, feature entry URLs, sections${RESET}

  ${DIM}# 3. Generate & validate tests (AI agents)${RESET}
  qa validate

  ${DIM}# 4. Run tests + self-heal${RESET}
  qa run

  ${DIM}# 5. After multiple runs — system learns${RESET}
  qa experience --stats

${BOLD}ARCHITECTURE${RESET}

  11 agents: 6 AI + 3 Non-AI + 2 Hybrid
  3 feedback loops: enforcement, self-healing, learning
  Experience library with confidence decay + prompt evolution
  Multi-repo via project.config.json + Convention Detector
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
