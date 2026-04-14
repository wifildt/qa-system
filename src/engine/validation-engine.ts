/**
 * ============================================================================
 * VALIDATION ENGINE — Non-AI Rule Enforcement
 * ============================================================================
 *
 * This is the TRUST LAYER of the QA system. It parses generated test code
 * and REJECTS any output that violates rules. AI agents cannot bypass this.
 *
 * Pipeline position:
 *   Test Generators → [VALIDATION ENGINE] → Execution Engine
 *
 * If validation fails → test file is BLOCKED from execution.
 * The rejection report feeds back to the Self-Healing Agent for fix.
 *
 * Usage:
 *   npx tsx qa-system/scripts/validation-engine.ts test/ui/*.spec.ts
 *   npx tsx qa-system/scripts/validation-engine.ts --all
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

interface Violation {
  ruleId: string;
  severity: 'error' | 'warning';
  message: string;
  file: string;
  line: number;
  column?: number;
  snippet: string;
  fix_hint: string;
}

interface ValidationResult {
  file: string;
  passed: boolean;
  violations: Violation[];
  stats: {
    total_rules_checked: number;
    errors: number;
    warnings: number;
  };
}

interface EngineReport {
  timestamp: string;
  total_files: number;
  passed: number;
  blocked: number;
  results: ValidationResult[];
  summary: {
    most_common_violations: Array<{ ruleId: string; count: number }>;
    files_blocked: string[];
    recommendation: string;
  };
}

type RuleChecker = (
  content: string,
  lines: string[],
  filePath: string
) => Violation[];

// ============================================================================
// RULE DEFINITIONS — Each rule is a pure function: code → violations
// ============================================================================

const RULES: Record<string, { checker: RuleChecker; severity: 'error' | 'warning' }> = {

  // -------------------------------------------------------------------------
  // TQ-001: No trivial assertions
  // -------------------------------------------------------------------------
  'TQ-001': {
    severity: 'error',
    checker: (content, lines, file) => {
      const violations: Violation[] = [];
      const trivialPatterns = [
        // expect(true).toBe(true)
        /expect\s*\(\s*true\s*\)\s*\.toBe\s*\(\s*true\s*\)/,
        // expect(false).toBe(false)
        /expect\s*\(\s*false\s*\)\s*\.toBe\s*\(\s*false\s*\)/,
        // expect(1).toBe(1)
        /expect\s*\(\s*\d+\s*\)\s*\.toBe\s*\(\s*\d+\s*\)/,
        // expect(something).toBeTruthy() alone (without meaningful variable)
        /expect\s*\(\s*['"][^'"]+['"]\s*\)\s*\.toBeTruthy\s*\(\s*\)/,
        // expect(element).toBeDefined() — checks existence, not behavior
        /expect\s*\(\s*\w+\s*\)\s*\.toBeDefined\s*\(\s*\)/,
      ];

      lines.forEach((line, idx) => {
        for (const pattern of trivialPatterns) {
          if (pattern.test(line)) {
            violations.push({
              ruleId: 'TQ-001',
              severity: 'error',
              message: 'Trivial assertion detected. Must validate behavior or data, not existence.',
              file,
              line: idx + 1,
              snippet: line.trim(),
              fix_hint: 'Replace with assertion that checks actual UI content, API response data, or state values.',
            });
          }
        }
      });
      return violations;
    },
  },

  // -------------------------------------------------------------------------
  // TQ-002: No arbitrary waits
  // -------------------------------------------------------------------------
  'TQ-002': {
    severity: 'error',
    checker: (content, lines, file) => {
      const violations: Violation[] = [];

      lines.forEach((line, idx) => {
        // Detect page.waitForTimeout() without a preceding waitForResponse/waitForSelector
        const waitMatch = line.match(/waitForTimeout\s*\(\s*(\d+)\s*\)/);
        if (waitMatch) {
          const ms = parseInt(waitMatch[1], 10);
          // Allow short waits (< 1000ms) as transition buffers
          if (ms >= 1000) {
            // Check if previous 3 lines have a proper wait
            const prevLines = lines.slice(Math.max(0, idx - 3), idx).join('\n');
            const hasProperWait = /waitForResponse|waitForSelector|waitForLoadState|waitForURL/.test(prevLines);

            if (!hasProperWait) {
              violations.push({
                ruleId: 'TQ-002',
                severity: 'error',
                message: `Arbitrary wait of ${ms}ms without preceding condition wait.`,
                file,
                line: idx + 1,
                snippet: line.trim(),
                fix_hint: 'Use page.waitForResponse(), page.waitForSelector(), or page.waitForLoadState() before waitForTimeout.',
              });
            }
          }
        }

        // Detect bare sleep/delay patterns
        if (/\bsleep\s*\(\s*\d{4,}\s*\)/.test(line)) {
          violations.push({
            ruleId: 'TQ-002',
            severity: 'error',
            message: 'sleep() call detected. Use Playwright wait utilities instead.',
            file,
            line: idx + 1,
            snippet: line.trim(),
            fix_hint: 'Replace with await page.waitForResponse() or similar.',
          });
        }
      });
      return violations;
    },
  },

  // -------------------------------------------------------------------------
  // TQ-003: Evidence capture required
  // -------------------------------------------------------------------------
  'TQ-003': {
    severity: 'error',
    checker: (content, lines, file) => {
      const violations: Violation[] = [];

      // Only applies to .spec.ts files (not API tests)
      if (!file.endsWith('.spec.ts') || file.includes('.api.')) return violations;

      // Find all test() blocks
      const testBlockRegex = /\btest\s*\(\s*['"`]/g;
      let match;
      while ((match = testBlockRegex.exec(content)) !== null) {
        const startIdx = match.index;
        // Find the end of this test block (next test() or end of describe)
        const nextTest = content.indexOf('\n  test(', startIdx + 1);
        const blockEnd = nextTest > -1 ? nextTest : content.length;
        const testBlock = content.slice(startIdx, blockEnd);

        const hasScreenshot = /page\.screenshot\s*\(/.test(testBlock);
        const hasNetworkCapture = /captureNetworkDuring|waitForResponse|page\.on\s*\(\s*['"]response['"]/.test(testBlock);
        const hasStateCapture = /captureReduxState/.test(testBlock);

        if (!hasScreenshot && !hasNetworkCapture && !hasStateCapture) {
          // Find the line number
          const lineNum = content.slice(0, startIdx).split('\n').length;
          violations.push({
            ruleId: 'TQ-003',
            severity: 'error',
            message: 'Test block has no evidence capture (screenshot, network log, or state snapshot).',
            file,
            line: lineNum,
            snippet: testBlock.split('\n')[0].trim(),
            fix_hint: 'Add page.screenshot(), captureNetworkDuring(), or captureReduxState() to the test.',
          });
        }
      }
      return violations;
    },
  },

  // -------------------------------------------------------------------------
  // SEL-005: No CSS class selectors
  // -------------------------------------------------------------------------
  'SEL-005': {
    severity: 'error',
    checker: (content, lines, file) => {
      const violations: Violation[] = [];
      const forbiddenPatterns = [
        // .ant-table-row, .ant-btn, etc. used in locator/assertions
        /locator\s*\(\s*['"]\.ant-[^'"]+['"]\s*\)/,
        // .sc- (styled-components hash)
        /locator\s*\(\s*['"]\.sc-[^'"]+['"]\s*\)/,
        // .css- (emotion hash)
        /locator\s*\(\s*['"]\.css-[^'"]+['"]\s*\)/,
        // [class*= in selectors
        /locator\s*\(\s*['"][^'"]*\[class\*=[^'"]*['"]\s*\)/,
        // Generic class selector in expect assertions
        /expect\s*\(.*locator\s*\(\s*['"]\.(?!ant-message|ant-modal)[^'"]+['"]\s*\)/,
      ];

      lines.forEach((line, idx) => {
        // Skip comments
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) return;

        for (const pattern of forbiddenPatterns) {
          if (pattern.test(line)) {
            violations.push({
              ruleId: 'SEL-005',
              severity: 'error',
              message: 'CSS class selector used. These break when styling changes.',
              file,
              line: idx + 1,
              snippet: line.trim(),
              fix_hint: 'Use data-testid, aria-label, getByRole(), or getByText() instead.',
            });
            break; // One violation per line is enough
          }
        }
      });
      return violations;
    },
  },

  // -------------------------------------------------------------------------
  // SEL-006: No index-based selectors
  // -------------------------------------------------------------------------
  'SEL-006': {
    severity: 'error',
    checker: (content, lines, file) => {
      const violations: Violation[] = [];
      const forbiddenPatterns = [
        /:nth-child\s*\(/,
        /:nth-of-type\s*\(/,
        />> nth=/,
      ];

      lines.forEach((line, idx) => {
        if (line.trim().startsWith('//')) return;

        // Allow .first() and .last() — these are Playwright locator methods, not CSS
        // Only flag CSS pseudo-selectors
        for (const pattern of forbiddenPatterns) {
          if (pattern.test(line)) {
            violations.push({
              ruleId: 'SEL-006',
              severity: 'error',
              message: 'Index-based CSS selector used. These break when data order changes.',
              file,
              line: idx + 1,
              snippet: line.trim(),
              fix_hint: 'Use .filter({ hasText: "..." }) or data-testid to identify specific rows.',
            });
            break;
          }
        }
      });
      return violations;
    },
  },

  // -------------------------------------------------------------------------
  // API-001: Schema validation required (not just status check)
  // -------------------------------------------------------------------------
  'API-001': {
    severity: 'error',
    checker: (content, lines, file) => {
      const violations: Violation[] = [];

      // Only applies to API test files
      if (!file.includes('.api.')) return violations;

      // Find test blocks that check status but not body
      const testBlockRegex = /\bit\s*\(\s*['"`]([^'"`]+)['"`]/g;
      let match;
      while ((match = testBlockRegex.exec(content)) !== null) {
        const testName = match[1];
        const startIdx = match.index;
        const nextIt = content.indexOf('\n  it(', startIdx + 1);
        const nextDescribe = content.indexOf('\n  describe(', startIdx + 1);
        const blockEnd = Math.min(
          nextIt > -1 ? nextIt : content.length,
          nextDescribe > -1 ? nextDescribe : content.length
        );
        const testBlock = content.slice(startIdx, blockEnd);

        // If test checks status code
        const checksStatus = /expect\s*\(.*status.*\)\s*\.toBe\s*\(\s*200\s*\)/.test(testBlock);
        // But does NOT check response body
        const checksBody = /expect\s*\(.*data.*\)\s*\.toHaveProperty|expect\s*\(.*typeof.*\)\s*\.toBe|expect\s*\(.*Array\.isArray/.test(testBlock);

        // Only flag positive tests (200 status), not auth tests (401/403)
        if (checksStatus && !checksBody && !testName.includes('401') && !testName.includes('403') && !testName.includes('without')) {
          const lineNum = content.slice(0, startIdx).split('\n').length;
          violations.push({
            ruleId: 'API-001',
            severity: 'error',
            message: `Test "${testName}" only checks status code, not response body schema.`,
            file,
            line: lineNum,
            snippet: `it('${testName}', ...)`,
            fix_hint: 'Add expect(data).toHaveProperty() or typeof checks for response fields.',
          });
        }
      }
      return violations;
    },
  },

  // -------------------------------------------------------------------------
  // API-008: No hardcoded IDs
  // -------------------------------------------------------------------------
  'API-008': {
    severity: 'error',
    checker: (content, lines, file) => {
      const violations: Violation[] = [];
      if (!file.includes('.api.')) return violations;

      lines.forEach((line, idx) => {
        if (line.trim().startsWith('//')) return;

        // Detect hardcoded numeric IDs in URL paths
        // Pattern: /homeroom_notebooks/123/ or /class/456
        const hardcodedId = line.match(/['"`][^'"`]*\/(homeroom_notebooks|class|ban_dai_dien_cmhs|can_bo_lop|to_hs|so_do_lop)\/(\d{2,})/);
        if (hardcodedId) {
          violations.push({
            ruleId: 'API-008',
            severity: 'error',
            message: `Hardcoded ID "${hardcodedId[2]}" in URL path. IDs change between environments.`,
            file,
            line: idx + 1,
            snippet: line.trim(),
            fix_hint: 'Use dynamic ID from setup step or previous API response (e.g., discoveredNotebookId).',
          });
        }
      });
      return violations;
    },
  },

  // -------------------------------------------------------------------------
  // AH-008: No assumed user data
  // -------------------------------------------------------------------------
  'AH-008': {
    severity: 'warning',
    checker: (content, lines, file) => {
      const violations: Violation[] = [];

      // Detect hardcoded Vietnamese names in assertions
      const namePatterns = [
        /expect\s*\(.*\)\s*\.toContainText\s*\(\s*['"](?:Nguyễn|Trần|Lê|Phạm|Hoàng|Huỳnh|Phan|Vũ|Võ|Đặng|Bùi|Đỗ|Hồ|Ngô|Dương)\s+/,
        /toHaveText\s*\(\s*['"](?:Nguyễn|Trần|Lê|Phạm|Hoàng)/,
      ];

      lines.forEach((line, idx) => {
        for (const pattern of namePatterns) {
          if (pattern.test(line)) {
            violations.push({
              ruleId: 'AH-008',
              severity: 'warning',
              message: 'Hardcoded Vietnamese name in assertion. This data may not exist in all environments.',
              file,
              line: idx + 1,
              snippet: line.trim(),
              fix_hint: 'Query the data first (from API or DOM), then assert on the returned value.',
            });
          }
        }
      });
      return violations;
    },
  },

  // -------------------------------------------------------------------------
  // TQ-005: Cleanup required for mutations
  // -------------------------------------------------------------------------
  'TQ-005': {
    severity: 'warning',
    checker: (content, lines, file) => {
      const violations: Violation[] = [];

      const hasMutation = /\.click\s*\(.*\).*(?:thêm|tạo|xóa|save|lưu|add|create|delete)/i.test(content)
        || /method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/.test(content);
      const hasCleanup = /afterEach|afterAll|cleanup|teardown|delete.*after/i.test(content);
      const isReadOnly = /view.only|readonly|permission|perm-/i.test(content);

      if (hasMutation && !hasCleanup && !isReadOnly) {
        violations.push({
          ruleId: 'TQ-005',
          severity: 'warning',
          message: 'Test performs mutations but has no cleanup (afterEach/afterAll).',
          file,
          line: 1,
          snippet: '(file-level check)',
          fix_hint: 'Add afterEach() or afterAll() to clean up created/modified data, or use unique test data.',
        });
      }
      return violations;
    },
  },

  // -------------------------------------------------------------------------
  // TQ-006: Vietnamese text encoding
  // -------------------------------------------------------------------------
  'TQ-006': {
    severity: 'warning',
    checker: (content, lines, file) => {
      const violations: Violation[] = [];

      // Detect Vietnamese text without diacritics in assertions (likely wrong)
      const suspectPatterns = [
        /toContainText\s*\(\s*['"](?:Luu thanh cong|Xoa thanh cong|Them thanh cong|Cap nhat thanh cong)['"]/,
        /toContainText\s*\(\s*['"](?:Chua luu|Thay doi|Dang nhap|Thoat)['"]/,
      ];

      lines.forEach((line, idx) => {
        for (const pattern of suspectPatterns) {
          if (pattern.test(line)) {
            violations.push({
              ruleId: 'TQ-006',
              severity: 'warning',
              message: 'Vietnamese text without diacritics in assertion. Likely incorrect.',
              file,
              line: idx + 1,
              snippet: line.trim(),
              fix_hint: 'Use proper Vietnamese: "Lưu thành công", "Xóa thành công", "Chưa lưu", etc.',
            });
          }
        }
      });
      return violations;
    },
  },
};

// ============================================================================
// ENGINE CORE
// ============================================================================

function validateFile(filePath: string): ValidationResult {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const allViolations: Violation[] = [];

  let rulesChecked = 0;
  for (const [ruleId, rule] of Object.entries(RULES)) {
    rulesChecked++;
    try {
      const violations = rule.checker(content, lines, filePath);
      allViolations.push(...violations);
    } catch (err) {
      // Rule itself failed — log but don't block
      console.warn(`[WARN] Rule ${ruleId} threw error on ${filePath}: ${err}`);
    }
  }

  const errors = allViolations.filter((v) => v.severity === 'error').length;
  const warnings = allViolations.filter((v) => v.severity === 'warning').length;

  return {
    file: filePath,
    passed: errors === 0, // Warnings don't block, errors do
    violations: allViolations,
    stats: {
      total_rules_checked: rulesChecked,
      errors,
      warnings,
    },
  };
}

function runEngine(testFiles: string[]): EngineReport {
  const results: ValidationResult[] = [];

  for (const file of testFiles) {
    if (!fs.existsSync(file)) {
      console.warn(`[SKIP] File not found: ${file}`);
      continue;
    }
    results.push(validateFile(file));
  }

  // Aggregate violations
  const violationCounts: Record<string, number> = {};
  for (const result of results) {
    for (const v of result.violations) {
      violationCounts[v.ruleId] = (violationCounts[v.ruleId] || 0) + 1;
    }
  }

  const mostCommon = Object.entries(violationCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([ruleId, count]) => ({ ruleId, count }));

  const blocked = results.filter((r) => !r.passed);

  // Generate recommendation
  let recommendation = 'All tests passed validation.';
  if (blocked.length > 0) {
    const topRule = mostCommon[0];
    recommendation = `${blocked.length} file(s) blocked. Most common issue: ${topRule?.ruleId} (${topRule?.count} occurrences). Fix these before running execution engine.`;
  }

  return {
    timestamp: new Date().toISOString(),
    total_files: results.length,
    passed: results.filter((r) => r.passed).length,
    blocked: blocked.length,
    results,
    summary: {
      most_common_violations: mostCommon,
      files_blocked: blocked.map((r) => r.file),
      recommendation,
    },
  };
}

// ============================================================================
// CLI INTERFACE
// ============================================================================

function printReport(report: EngineReport): void {
  const RESET = '\x1b[0m';
  const RED = '\x1b[31m';
  const GREEN = '\x1b[32m';
  const YELLOW = '\x1b[33m';
  const CYAN = '\x1b[36m';
  const BOLD = '\x1b[1m';
  const DIM = '\x1b[2m';

  console.log('\n' + '='.repeat(70));
  console.log(`${BOLD} VALIDATION ENGINE — Rule Enforcement Report${RESET}`);
  console.log('='.repeat(70));
  console.log(`${DIM}Timestamp: ${report.timestamp}${RESET}`);
  console.log();

  // Summary
  console.log(`${BOLD}Summary:${RESET}`);
  console.log(`  Total files:  ${report.total_files}`);
  console.log(`  ${GREEN}Passed:${RESET}      ${report.passed}`);
  console.log(`  ${RED}Blocked:${RESET}     ${report.blocked}`);
  console.log();

  // Per-file details
  for (const result of report.results) {
    const icon = result.passed ? `${GREEN}PASS${RESET}` : `${RED}BLOCKED${RESET}`;
    const fileName = path.basename(result.file);
    console.log(`${icon}  ${fileName}  (${result.stats.errors} errors, ${result.stats.warnings} warnings)`);

    for (const v of result.violations) {
      const sevColor = v.severity === 'error' ? RED : YELLOW;
      console.log(`  ${sevColor}${v.severity.toUpperCase()}${RESET} [${v.ruleId}] line ${v.line}: ${v.message}`);
      console.log(`  ${DIM}  ${v.snippet}${RESET}`);
      console.log(`  ${CYAN}  Fix: ${v.fix_hint}${RESET}`);
    }

    if (result.violations.length > 0) console.log();
  }

  // Bottom line
  if (report.blocked > 0) {
    console.log(`${RED}${BOLD}BLOCKED: ${report.blocked} file(s) failed validation.${RESET}`);
    console.log(`${RED}These files will NOT be sent to the execution engine.${RESET}`);
    console.log(`${YELLOW}${report.summary.recommendation}${RESET}`);
  } else {
    console.log(`${GREEN}${BOLD}ALL PASSED: ${report.passed} file(s) cleared for execution.${RESET}`);
  }
  console.log('='.repeat(70) + '\n');
}

// ============================================================================
// MAIN
// ============================================================================

function main(): void {
  const args = process.argv.slice(2);

  let testFiles: string[] = [];

  if (args.includes('--all')) {
    // Find all test files in qa-system/test/
    const testDir = path.resolve(process.cwd(), 'qa-system', 'test');
    testFiles = findTestFiles(testDir);
  } else if (args.length > 0) {
    testFiles = args.filter((a) => !a.startsWith('--'));
  } else {
    console.log('Usage:');
    console.log('  npx tsx qa-system/scripts/validation-engine.ts --all');
    console.log('  npx tsx qa-system/scripts/validation-engine.ts test/ui/section-4-1.spec.ts');
    process.exit(0);
  }

  if (testFiles.length === 0) {
    console.log('No test files found.');
    process.exit(0);
  }

  const report = runEngine(testFiles);

  // Print to console
  printReport(report);

  // Write JSON report
  const reportPath = path.resolve(process.cwd(), 'qa-system', 'reports', 'validation-report.json');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`JSON report: ${reportPath}`);

  // Exit with non-zero if any files blocked
  if (report.blocked > 0) {
    process.exit(1);
  }
}

function findTestFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findTestFiles(fullPath));
    } else if (entry.name.endsWith('.spec.ts') || entry.name.endsWith('.spec.js')) {
      results.push(fullPath);
    }
  }
  return results;
}

// Export for programmatic use by orchestrator
export { validateFile, runEngine, RULES };
export type { ValidationResult, EngineReport, Violation };

// Run if called directly (works in both CJS and ESM)
const isMain = typeof import.meta !== 'undefined'
  ? import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('validation-engine.ts')
  : false;

if (isMain || process.argv[1]?.includes('validation-engine')) {
  main();
}
