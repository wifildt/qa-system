/**
 * ============================================================================
 * SELF-HEALING AGENT — Closed-Loop Feedback System
 * ============================================================================
 *
 * Pipeline position:
 *   Execution Engine → [SELF-HEALING] → Test Generators (feedback loop)
 *
 * When tests fail, this agent:
 * 1. CLASSIFIES the failure type (selector, timing, data, assertion, infra)
 * 2. APPLIES automatic fixes for known patterns
 * 3. RECORDS the fix in the learning database for future runs
 * 4. REGENERATES tests that cannot be auto-fixed (sends back to AI agents)
 *
 * The learning DB grows over time → system gets smarter with each run.
 *
 * Usage:
 *   npx tsx qa-system/scripts/self-healing-agent.ts reports/execution-results.json
 * ============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// TYPES
// ============================================================================

interface TestFailure {
  testId: string;
  testFile: string;
  error: string;
  stackTrace?: string;
  screenshot?: string;
  networkLog?: string[];
  duration_ms?: number;
}

type FailureType =
  | 'selector_not_found'
  | 'selector_ambiguous'
  | 'timeout_waiting'
  | 'stale_data'
  | 'assertion_mismatch'
  | 'network_error'
  | 'auth_expired'
  | 'infrastructure'
  | 'unknown';

interface DiagnosedFailure extends TestFailure {
  failureType: FailureType;
  confidence: number; // 0-1
  autoFixable: boolean;
  suggestedFix?: AutoFix;
  regenerationNeeded: boolean;
  regenerationContext?: string;
}

interface AutoFix {
  type: 'selector_update' | 'wait_upgrade' | 'retry_add' | 'data_dynamic';
  file: string;
  line?: number;
  original: string;
  replacement: string;
  reason: string;
}

interface LearningEntry {
  timestamp: string;
  failurePattern: string;
  fixApplied: string;
  outcome: 'success' | 'partial' | 'failed';
  testFile: string;
  iterations: number;
}

interface HealingReport {
  timestamp: string;
  totalFailures: number;
  diagnosed: number;
  autoFixed: number;
  needsRegeneration: number;
  unresolvable: number;
  diagnoses: DiagnosedFailure[];
  appliedFixes: AutoFix[];
  regenerationQueue: Array<{ testFile: string; context: string }>;
  learningUpdates: LearningEntry[];
}

// ============================================================================
// FAILURE DIAGNOSIS — Pattern matching on error messages + stack traces
// ============================================================================

const DIAGNOSIS_PATTERNS: Array<{
  type: FailureType;
  patterns: RegExp[];
  confidence: number;
  autoFixable: boolean;
}> = [
  {
    type: 'selector_not_found',
    patterns: [
      /locator\..*Timeout.*waiting for selector/i,
      /Error: locator\.(click|fill|type).*strict mode violation/i,
      /waiting for locator\('([^']+)'\)/i,
      /page\.\$\(.*\) resolved to null/i,
      /expect\.toBeVisible.*timeout/i,
      /No element found for locator/i,
    ],
    confidence: 0.9,
    autoFixable: true,
  },
  {
    type: 'selector_ambiguous',
    patterns: [
      /strict mode violation.*resolved to (\d+) elements/i,
      /locator resolved to (\d+) elements/i,
    ],
    confidence: 0.85,
    autoFixable: true,
  },
  {
    type: 'timeout_waiting',
    patterns: [
      /Timeout.*exceeded.*while waiting/i,
      /waitForResponse.*timeout/i,
      /waitForLoadState.*timeout/i,
      /Navigation timeout/i,
      /page\.goto.*timeout/i,
    ],
    confidence: 0.8,
    autoFixable: true,
  },
  {
    type: 'stale_data',
    patterns: [
      /Expected.*to be.*but received/i,
      /Expected.*toContainText.*Received string/i,
      /expect.*toHaveCount.*Expected.*Received/i,
    ],
    confidence: 0.6, // Could also be assertion_mismatch
    autoFixable: false,
  },
  {
    type: 'assertion_mismatch',
    patterns: [
      /expect\(received\)\.toBe\(expected\)/i,
      /Expected:.*Received:/i,
      /AssertionError/i,
    ],
    confidence: 0.7,
    autoFixable: false,
  },
  {
    type: 'network_error',
    patterns: [
      /net::ERR_/i,
      /ECONNREFUSED/i,
      /ECONNRESET/i,
      /fetch failed/i,
      /NetworkError/i,
      /ERR_NAME_NOT_RESOLVED/i,
    ],
    confidence: 0.95,
    autoFixable: false,
  },
  {
    type: 'auth_expired',
    patterns: [
      /401/,
      /Unauthorized/i,
      /token.*expired/i,
      /login.*redirect/i,
    ],
    confidence: 0.85,
    autoFixable: true,
  },
  {
    type: 'infrastructure',
    patterns: [
      /ENOMEM/i,
      /ENOSPC/i,
      /browser.*closed/i,
      /browser.*disconnected/i,
      /Protocol error/i,
      /Target closed/i,
    ],
    confidence: 0.9,
    autoFixable: false,
  },
];

function diagnoseFailure(failure: TestFailure): DiagnosedFailure {
  const errorText = `${failure.error}\n${failure.stackTrace || ''}`;

  for (const pattern of DIAGNOSIS_PATTERNS) {
    for (const regex of pattern.patterns) {
      if (regex.test(errorText)) {
        return {
          ...failure,
          failureType: pattern.type,
          confidence: pattern.confidence,
          autoFixable: pattern.autoFixable,
          regenerationNeeded: !pattern.autoFixable && pattern.type !== 'infrastructure',
          regenerationContext: !pattern.autoFixable
            ? `Failure type: ${pattern.type}. Error: ${failure.error.slice(0, 200)}`
            : undefined,
        };
      }
    }
  }

  return {
    ...failure,
    failureType: 'unknown',
    confidence: 0,
    autoFixable: false,
    regenerationNeeded: true,
    regenerationContext: `Unknown failure. Error: ${failure.error.slice(0, 300)}`,
  };
}

// ============================================================================
// AUTO-FIX STRATEGIES — Deterministic fixes for known failure types
// ============================================================================

function generateSelectorFix(diagnosis: DiagnosedFailure): AutoFix | null {
  const error = diagnosis.error;

  // Extract the failing selector from the error message
  const selectorMatch = error.match(/locator\('([^']+)'\)/);
  if (!selectorMatch) return null;

  const failingSelector = selectorMatch[1];

  // Strategy 1: CSS class → getByRole or getByText
  if (failingSelector.startsWith('.') || failingSelector.includes('[class')) {
    return {
      type: 'selector_update',
      file: diagnosis.testFile,
      original: `locator('${failingSelector}')`,
      replacement: `getByRole('button', { name: /relevant-text/i }).first()`,
      reason: `CSS selector "${failingSelector}" not found. Replace with role-based selector.`,
    };
  }

  // Strategy 2: data-testid missing → fall back to text
  if (failingSelector.includes('data-testid')) {
    const testIdMatch = failingSelector.match(/data-testid="([^"]+)"/);
    const testId = testIdMatch?.[1] || 'unknown';
    return {
      type: 'selector_update',
      file: diagnosis.testFile,
      original: `locator('${failingSelector}')`,
      replacement: `getByText('${testId}', { exact: false }).first()`,
      reason: `data-testid="${testId}" not found in DOM. Element may not have data-testid yet. Fall back to text content.`,
    };
  }

  // Strategy 3: Ambiguous selector → add .first() or filter
  if (diagnosis.failureType === 'selector_ambiguous') {
    const countMatch = error.match(/resolved to (\d+) elements/);
    return {
      type: 'selector_update',
      file: diagnosis.testFile,
      original: `locator('${failingSelector}')`,
      replacement: `locator('${failingSelector}').first()`,
      reason: `Selector matched ${countMatch?.[1] || 'multiple'} elements. Added .first() — consider narrowing with .filter().`,
    };
  }

  return null;
}

function generateTimeoutFix(diagnosis: DiagnosedFailure): AutoFix | null {
  const error = diagnosis.error;

  // Extract the wait call
  const waitMatch = error.match(/(waitForResponse|waitForSelector|waitForLoadState)\s*\(/);
  if (!waitMatch) {
    // Generic timeout → add explicit wait before the failing step
    return {
      type: 'wait_upgrade',
      file: diagnosis.testFile,
      original: '// (before failing action)',
      replacement: 'await page.waitForLoadState("networkidle");\nawait page.waitForTimeout(500);',
      reason: 'Action timed out. Adding networkidle wait before the step.',
    };
  }

  // Specific timeout → increase timeout value
  return {
    type: 'wait_upgrade',
    file: diagnosis.testFile,
    original: `{ timeout: 10000 }`,
    replacement: `{ timeout: 30000 }`,
    reason: `${waitMatch[1]} timed out at default threshold. Increased to 30s for slow UAT env.`,
  };
}

function generateAuthFix(diagnosis: DiagnosedFailure): AutoFix | null {
  return {
    type: 'retry_add',
    file: diagnosis.testFile,
    original: 'test.beforeEach',
    replacement: `test.beforeEach(async ({ page }) => {
    // Auth token may have expired — force re-login
    TOKEN_CACHE = {}; // Clear cached tokens
    await loginAs(page, 'gvcn');
  })`,
    reason: 'Auth token expired during test run. Clearing token cache to force fresh login.',
  };
}

function generateAutoFix(diagnosis: DiagnosedFailure): AutoFix | null {
  switch (diagnosis.failureType) {
    case 'selector_not_found':
    case 'selector_ambiguous':
      return generateSelectorFix(diagnosis);
    case 'timeout_waiting':
      return generateTimeoutFix(diagnosis);
    case 'auth_expired':
      return generateAuthFix(diagnosis);
    default:
      return null;
  }
}

// ============================================================================
// LEARNING DATABASE — Persists across runs to improve over time
// ============================================================================

const LEARNING_DB_PATH = path.resolve(__dirname, '..', 'analysis', 'learning-db.json');

function loadLearningDb(): LearningEntry[] {
  try {
    if (fs.existsSync(LEARNING_DB_PATH)) {
      return JSON.parse(fs.readFileSync(LEARNING_DB_PATH, 'utf-8'));
    }
  } catch { /* start fresh */ }
  return [];
}

function saveLearningDb(entries: LearningEntry[]): void {
  fs.mkdirSync(path.dirname(LEARNING_DB_PATH), { recursive: true });
  // Keep last 500 entries to prevent unbounded growth
  const trimmed = entries.slice(-500);
  fs.writeFileSync(LEARNING_DB_PATH, JSON.stringify(trimmed, null, 2));
}

function recordLearning(
  db: LearningEntry[],
  failure: DiagnosedFailure,
  fix: AutoFix | null,
  outcome: 'success' | 'partial' | 'failed'
): void {
  db.push({
    timestamp: new Date().toISOString(),
    failurePattern: `${failure.failureType}:${failure.error.slice(0, 100)}`,
    fixApplied: fix ? `${fix.type}: ${fix.reason.slice(0, 100)}` : 'none',
    outcome,
    testFile: failure.testFile,
    iterations: 1,
  });
}

/**
 * Check learning DB for previous failures on same file + similar error.
 * If same fix failed before, skip it (avoid infinite loops).
 */
function hasFailedBefore(db: LearningEntry[], testFile: string, fixType: string): boolean {
  return db.some(
    (entry) =>
      entry.testFile === testFile &&
      entry.fixApplied.startsWith(fixType) &&
      entry.outcome === 'failed' &&
      entry.iterations >= 2
  );
}

// ============================================================================
// APPLY FIX — Actually modify the test file
// ============================================================================

function applyFix(fix: AutoFix): boolean {
  try {
    if (!fs.existsSync(fix.file)) {
      console.warn(`[SKIP] File not found: ${fix.file}`);
      return false;
    }

    const content = fs.readFileSync(fix.file, 'utf-8');

    if (!content.includes(fix.original)) {
      console.warn(`[SKIP] Original pattern not found in ${fix.file}: "${fix.original.slice(0, 50)}"`);
      return false;
    }

    const updated = content.replace(fix.original, fix.replacement);
    fs.writeFileSync(fix.file, updated, 'utf-8');

    console.log(`[FIX] Applied ${fix.type} to ${path.basename(fix.file)}`);
    console.log(`  ${fix.reason}`);
    return true;
  } catch (err) {
    console.error(`[ERROR] Failed to apply fix: ${err}`);
    return false;
  }
}

// ============================================================================
// MAIN HEALING PIPELINE
// ============================================================================

function parseExecutionResults(resultsPath: string): TestFailure[] {
  const raw = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));
  const failures: TestFailure[] = [];

  // Handle Playwright JSON reporter format
  const suites = raw.suites || [];
  for (const suite of suites) {
    const specs = suite.specs || [];
    for (const spec of specs) {
      for (const test of spec.tests || []) {
        for (const result of test.results || []) {
          if (result.status === 'failed' || result.status === 'timedOut') {
            failures.push({
              testId: spec.title || spec.id || 'unknown',
              testFile: suite.file || spec.file || 'unknown',
              error: result.error?.message || result.error?.snippet || 'Unknown error',
              stackTrace: result.error?.stack,
              screenshot: result.attachments?.find((a: any) => a.name === 'screenshot')?.path,
              duration_ms: result.duration,
            });
          }
        }
      }
    }
  }

  // Also handle simple { results: [...] } format
  if (raw.results) {
    for (const r of raw.results) {
      if (r.status === 'failed' || r.status === 'error') {
        failures.push({
          testId: r.test_id || r.scenario_id || 'unknown',
          testFile: r.file || 'unknown',
          error: r.error_message || r.error || 'Unknown error',
          stackTrace: r.stack_trace,
          duration_ms: r.duration_ms,
        });
      }
    }
  }

  return failures;
}

function heal(resultsPath: string, dryRun: boolean = false): HealingReport {
  const failures = parseExecutionResults(resultsPath);
  const learningDb = loadLearningDb();

  const diagnoses: DiagnosedFailure[] = [];
  const appliedFixes: AutoFix[] = [];
  const regenerationQueue: Array<{ testFile: string; context: string }> = [];
  const learningUpdates: LearningEntry[] = [];

  let autoFixed = 0;
  let needsRegeneration = 0;
  let unresolvable = 0;

  for (const failure of failures) {
    // Step 1: Diagnose
    const diagnosis = diagnoseFailure(failure);
    diagnoses.push(diagnosis);

    // Step 2: Can we auto-fix?
    if (diagnosis.autoFixable) {
      const fix = generateAutoFix(diagnosis);

      if (fix && !hasFailedBefore(learningDb, diagnosis.testFile, fix.type)) {
        diagnosis.suggestedFix = fix;

        if (!dryRun) {
          const applied = applyFix(fix);
          if (applied) {
            appliedFixes.push(fix);
            autoFixed++;
            recordLearning(learningDb, diagnosis, fix, 'success'); // optimistic — verify on re-run
          } else {
            needsRegeneration++;
            diagnosis.regenerationNeeded = true;
            diagnosis.regenerationContext = `Auto-fix failed to apply. ${fix.reason}`;
          }
        } else {
          appliedFixes.push(fix);
          autoFixed++;
        }
      } else if (fix && hasFailedBefore(learningDb, diagnosis.testFile, fix.type)) {
        // Same fix failed before → escalate to regeneration
        console.log(`[LEARN] Fix "${fix.type}" failed before on ${path.basename(diagnosis.testFile)}. Escalating to regeneration.`);
        diagnosis.regenerationNeeded = true;
        diagnosis.regenerationContext = `Previous auto-fix "${fix.type}" failed. Need AI regeneration.`;
        needsRegeneration++;
      } else {
        needsRegeneration++;
        diagnosis.regenerationNeeded = true;
      }
    } else if (diagnosis.regenerationNeeded) {
      needsRegeneration++;
    } else {
      // Infrastructure or truly unresolvable
      unresolvable++;
    }

    // Step 3: Queue for regeneration if needed
    if (diagnosis.regenerationNeeded && diagnosis.regenerationContext) {
      regenerationQueue.push({
        testFile: diagnosis.testFile,
        context: diagnosis.regenerationContext,
      });
    }
  }

  // Save learning DB
  if (!dryRun) {
    saveLearningDb([...learningDb, ...learningUpdates]);
  }

  return {
    timestamp: new Date().toISOString(),
    totalFailures: failures.length,
    diagnosed: diagnoses.length,
    autoFixed,
    needsRegeneration,
    unresolvable,
    diagnoses,
    appliedFixes,
    regenerationQueue,
    learningUpdates,
  };
}

// ============================================================================
// CLI
// ============================================================================

function printHealingReport(report: HealingReport): void {
  const RED = '\x1b[31m';
  const GREEN = '\x1b[32m';
  const YELLOW = '\x1b[33m';
  const CYAN = '\x1b[36m';
  const BOLD = '\x1b[1m';
  const DIM = '\x1b[2m';
  const RESET = '\x1b[0m';

  console.log('\n' + '='.repeat(70));
  console.log(`${BOLD} SELF-HEALING AGENT — Feedback Report${RESET}`);
  console.log('='.repeat(70));

  console.log(`\n${BOLD}Failure Analysis:${RESET}`);
  console.log(`  Total failures:        ${report.totalFailures}`);
  console.log(`  ${GREEN}Auto-fixed:${RESET}            ${report.autoFixed}`);
  console.log(`  ${YELLOW}Needs AI regeneration:${RESET} ${report.needsRegeneration}`);
  console.log(`  ${RED}Unresolvable:${RESET}          ${report.unresolvable}`);

  // Diagnosis breakdown
  const typeCounts: Record<string, number> = {};
  for (const d of report.diagnoses) {
    typeCounts[d.failureType] = (typeCounts[d.failureType] || 0) + 1;
  }
  console.log(`\n${BOLD}Failure Types:${RESET}`);
  for (const [type, count] of Object.entries(typeCounts).sort(([, a], [, b]) => b - a)) {
    const bar = '#'.repeat(Math.min(count * 3, 30));
    console.log(`  ${type.padEnd(22)} ${count}  ${DIM}${bar}${RESET}`);
  }

  // Applied fixes
  if (report.appliedFixes.length > 0) {
    console.log(`\n${GREEN}${BOLD}Applied Fixes:${RESET}`);
    for (const fix of report.appliedFixes) {
      console.log(`  ${GREEN}[${fix.type}]${RESET} ${path.basename(fix.file)}`);
      console.log(`    ${DIM}${fix.reason}${RESET}`);
    }
  }

  // Regeneration queue
  if (report.regenerationQueue.length > 0) {
    console.log(`\n${YELLOW}${BOLD}Regeneration Queue (send to AI agents):${RESET}`);
    for (const item of report.regenerationQueue) {
      console.log(`  ${YELLOW}>${RESET} ${path.basename(item.testFile)}`);
      console.log(`    ${DIM}${item.context}${RESET}`);
    }
  }

  console.log('\n' + '='.repeat(70));

  if (report.autoFixed > 0) {
    console.log(`${CYAN}${BOLD}Re-run tests to verify fixes: ./scripts/run-tests.sh${RESET}`);
  }
  console.log();
}

function main(): void {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const resultsPath = args.find((a) => !a.startsWith('--'));

  if (!resultsPath) {
    console.log('Usage:');
    console.log('  npx tsx qa-system/scripts/self-healing-agent.ts reports/execution-results.json');
    console.log('  npx tsx qa-system/scripts/self-healing-agent.ts reports/execution-results.json --dry-run');
    process.exit(0);
  }

  if (!fs.existsSync(resultsPath)) {
    console.error(`File not found: ${resultsPath}`);
    process.exit(1);
  }

  const report = heal(resultsPath, dryRun);

  printHealingReport(report);

  // Write report
  const reportPath = path.resolve(__dirname, '..', 'reports', 'healing-report.json');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`JSON report: ${reportPath}`);
}

// Export for orchestrator
export { heal, diagnoseFailure, generateAutoFix };
export type { HealingReport, DiagnosedFailure, AutoFix, LearningEntry };

// Run if called directly (ESM compatible)
if (process.argv[1]?.includes('self-healing-agent')) {
  main();
}
