/**
 * ============================================================================
 * EXPERIENCE EXTRACTOR — Converts raw execution data into curated knowledge
 * ============================================================================
 *
 * Pipeline position:
 *   Execution Results + Healing Report → [EXTRACTOR] → Experience Library
 *
 * What it does:
 *   1. Reads execution-results.json + healing-report.json + validation-report.json
 *   2. Identifies patterns worth remembering (NOT everything — only insights)
 *   3. Classifies into 4 categories
 *   4. Deduplicates against existing library
 *   5. Writes curated entries to Experience Library
 *
 * What it does NOT do:
 *   - Store raw logs (that's execution engine's job)
 *   - Store every failure (only patterns that repeat or teach something)
 *   - Make subjective judgments (uses deterministic classification)
 * ============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  ExperienceLibrary,
  type FailurePattern,
  type FixStrategy,
  type AntiPattern,
  type FeatureKnowledge,
} from './experience-library.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// TYPES
// ============================================================================

interface ExtractionInput {
  executionResults?: any;    // From Playwright/Vitest
  healingReport?: any;       // From Self-Healing Agent
  validationReport?: any;    // From Validation Engine
  projectName: string;
}

interface ExtractionResult {
  extracted: number;
  skipped: number;
  deduplicated: number;
  newEntries: Array<{ id: string; category: string; summary: string }>;
}

// ============================================================================
// PATTERN CLASSIFIERS — Deterministic rules for what's worth remembering
// ============================================================================

/**
 * Extract failure patterns from execution results.
 * Only extracts patterns that are ACTIONABLE — not one-off flukes.
 */
function extractFailurePatterns(
  executionResults: any,
  projectName: string
): Array<Omit<FailurePattern, 'id' | 'category' | 'useCount' | 'successCount' | 'createdAt' | 'lastUsedAt'>> {
  const patterns: Array<Omit<FailurePattern, 'id' | 'category' | 'useCount' | 'successCount' | 'createdAt' | 'lastUsedAt'>> = [];

  // Collect all failures
  const failures: Array<{ error: string; file: string; test: string }> = [];

  // Parse Playwright format
  if (executionResults?.suites) {
    for (const suite of executionResults.suites) {
      for (const spec of suite.specs || []) {
        for (const test of spec.tests || []) {
          for (const result of test.results || []) {
            if (result.status === 'failed' || result.status === 'timedOut') {
              failures.push({
                error: result.error?.message || '',
                file: suite.file || '',
                test: spec.title || '',
              });
            }
          }
        }
      }
    }
  }

  // Parse simple format
  if (executionResults?.results) {
    for (const r of executionResults.results) {
      if (r.status === 'failed') {
        failures.push({
          error: r.error_message || r.error || '',
          file: r.file || '',
          test: r.test_id || '',
        });
      }
    }
  }

  // Classify failures into known pattern categories
  const PATTERN_CLASSIFIERS: Array<{
    name: string;
    errorSignature: string;
    rootCause: string;
    layers: string[];
    tags: string[];
  }> = [
    {
      name: 'Element not interactable after modal/overlay',
      errorSignature: 'intercept.*pointer events|element is not.*visible|click.*intercepted',
      rootCause: 'z-index overlay or modal blocking interaction. Element exists in DOM but is covered.',
      layers: ['ui'],
      tags: ['selector', 'modal', 'overlay', 'z-index', 'click'],
    },
    {
      name: 'Stale element reference after re-render',
      errorSignature: 'stale element|detached from DOM|element handle.*disposed',
      rootCause: 'React re-render replaced the DOM node. Selector found old node.',
      layers: ['ui', 'state'],
      tags: ['selector', 'rerender', 'stale', 'react'],
    },
    {
      name: 'Network request timeout during test',
      errorSignature: 'waitForResponse.*timeout|net::ERR|ECONNREFUSED|fetch failed',
      rootCause: 'API server slow or unreachable. Could be rate limiting, cold start, or infra issue.',
      layers: ['api'],
      tags: ['network', 'timeout', 'api', 'infrastructure'],
    },
    {
      name: 'Auth token expired mid-test',
      errorSignature: '401|Unauthorized|token.*expired|redirect.*login',
      rootCause: 'Session expired during long test run. Token TTL shorter than test duration.',
      layers: ['api', 'ui'],
      tags: ['auth', 'token', 'session', 'expired'],
    },
    {
      name: 'Race condition between UI update and assertion',
      errorSignature: 'Expected.*but received|toHaveCount.*Expected.*Received|not yet updated',
      rootCause: 'Assertion ran before async state update completed. Missing wait between action and check.',
      layers: ['ui', 'state'],
      tags: ['race', 'timing', 'async', 'state'],
    },
    {
      name: 'Selector ambiguity in dynamic list',
      errorSignature: 'strict mode violation.*resolved to \\d+ elements',
      rootCause: 'Multiple elements match the selector. Common in table rows or repeated components.',
      layers: ['ui'],
      tags: ['selector', 'ambiguous', 'list', 'table'],
    },
    {
      name: 'Vietnamese text encoding mismatch',
      errorSignature: 'toContainText.*(?:expected|received).*[àáảãạ]',
      rootCause: 'Text comparison failed due to Unicode normalization differences (NFC vs NFD).',
      layers: ['ui'],
      tags: ['encoding', 'unicode', 'vietnamese', 'text'],
    },
  ];

  for (const failure of failures) {
    for (const classifier of PATTERN_CLASSIFIERS) {
      try {
        if (new RegExp(classifier.errorSignature, 'i').test(failure.error)) {
          patterns.push({
            scope: 'global',
            tags: classifier.tags,
            confidence: 0.7,
            source: `extractor:${projectName}`,
            pattern: classifier.name,
            errorSignature: classifier.errorSignature,
            rootCause: classifier.rootCause,
            affectedLayers: classifier.layers,
            example: {
              error: failure.error.slice(0, 200),
              context: `Test: ${failure.test} in ${failure.file}`,
            },
          });
          break; // One pattern per failure
        }
      } catch { /* invalid regex */ }
    }
  }

  return patterns;
}

/**
 * Extract fix strategies from healing report.
 * Only records fixes that ACTUALLY WORKED.
 */
function extractFixStrategies(
  healingReport: any,
  projectName: string
): Array<Omit<FixStrategy, 'id' | 'category' | 'useCount' | 'successCount' | 'createdAt' | 'lastUsedAt'>> {
  const strategies: Array<Omit<FixStrategy, 'id' | 'category' | 'useCount' | 'successCount' | 'createdAt' | 'lastUsedAt'>> = [];

  if (!healingReport?.appliedFixes) return strategies;

  for (const fix of healingReport.appliedFixes) {
    strategies.push({
      scope: 'global',
      tags: [fix.type, 'auto-fix'],
      confidence: 0.6,
      source: `healer:${projectName}`,
      triggerPattern: fix.reason.split('.')[0], // First sentence
      strategy: `${fix.type}: ${fix.reason}`,
      implementation: `Replace: ${fix.original.slice(0, 100)}\nWith: ${fix.replacement.slice(0, 100)}`,
      preconditions: [`Failure type matches ${fix.type}`],
      contraindications: [],
      effectivenessScore: 0.5, // Will be updated after re-run
    });
  }

  return strategies;
}

/**
 * Extract anti-patterns from validation report.
 * Only records patterns that appear in MULTIPLE files.
 */
function extractAntiPatterns(
  validationReport: any
): Array<Omit<AntiPattern, 'id' | 'category' | 'useCount' | 'successCount' | 'createdAt' | 'lastUsedAt'>> {
  const patterns: Array<Omit<AntiPattern, 'id' | 'category' | 'useCount' | 'successCount' | 'createdAt' | 'lastUsedAt'>> = [];

  if (!validationReport?.results) return patterns;

  // Count violations across files
  const violationCounts: Record<string, { count: number; files: string[]; example: string }> = {};

  for (const result of validationReport.results) {
    for (const violation of result.violations || []) {
      if (!violationCounts[violation.ruleId]) {
        violationCounts[violation.ruleId] = { count: 0, files: [], example: violation.snippet };
      }
      violationCounts[violation.ruleId].count++;
      violationCounts[violation.ruleId].files.push(result.file);
    }
  }

  // Only extract patterns that appear in 2+ files (systemic issue)
  for (const [ruleId, data] of Object.entries(violationCounts)) {
    const uniqueFiles = new Set(data.files).size;
    if (uniqueFiles >= 2) {
      patterns.push({
        scope: 'global',
        tags: [ruleId, 'validation', 'code-quality'],
        confidence: Math.min(0.9, 0.5 + uniqueFiles * 0.1),
        source: 'validator',
        pattern: `Rule ${ruleId} violated in ${uniqueFiles} files`,
        detection: ruleId,
        whyBad: `Systemic violation of ${ruleId} across ${uniqueFiles} test files`,
        betterAlternative: `See rule definition for ${ruleId} in rules/`,
        severity: 'warning',
      });
    }
  }

  return patterns;
}

// ============================================================================
// MAIN EXTRACTOR
// ============================================================================

export function extractExperiences(
  input: ExtractionInput,
  library: ExperienceLibrary
): ExtractionResult {
  const result: ExtractionResult = {
    extracted: 0,
    skipped: 0,
    deduplicated: 0,
    newEntries: [],
  };

  // 1. Extract failure patterns
  if (input.executionResults) {
    const failures = extractFailurePatterns(input.executionResults, input.projectName);
    for (const fp of failures) {
      const id = library.addFailurePattern(fp);
      result.extracted++;
      result.newEntries.push({ id, category: 'failure_pattern', summary: fp.pattern });
    }
  }

  // 2. Extract fix strategies
  if (input.healingReport) {
    const fixes = extractFixStrategies(input.healingReport, input.projectName);
    for (const fs of fixes) {
      const id = library.addFixStrategy(fs);
      result.extracted++;
      result.newEntries.push({ id, category: 'fix_strategy', summary: fs.strategy });
    }
  }

  // 3. Extract anti-patterns
  if (input.validationReport) {
    const aps = extractAntiPatterns(input.validationReport);
    for (const ap of aps) {
      const id = library.addAntiPattern(ap);
      result.extracted++;
      result.newEntries.push({ id, category: 'anti_pattern', summary: ap.pattern });
    }
  }

  // Save
  if (library.isDirty) {
    library.save();
  }

  return result;
}

// ============================================================================
// CLI
// ============================================================================

function main(): void {
  const args = process.argv.slice(2);
  const projectName = args.find(a => !a.startsWith('--')) || 'unknown';

  const reportsDir = path.resolve(__dirname, '..', '..', 'reports');
  const dbPath = path.resolve(__dirname, '..', '..', 'analysis', 'experience-db.json');

  const library = ExperienceLibrary.load(dbPath);

  const input: ExtractionInput = {
    projectName,
    executionResults: readJson(path.join(reportsDir, 'execution-results.json')),
    healingReport: readJson(path.join(reportsDir, 'healing-report.json')),
    validationReport: readJson(path.join(reportsDir, 'validation-report.json')),
  };

  console.log(`\nExperience Extractor — Project: ${projectName}`);
  console.log('─'.repeat(50));

  const result = extractExperiences(input, library);

  console.log(`Extracted: ${result.extracted} experiences`);
  console.log(`Library stats: ${JSON.stringify(library.stats, null, 2)}`);

  for (const entry of result.newEntries) {
    console.log(`  + [${entry.category}] ${entry.summary}`);
  }

  console.log(`\nSaved to: ${dbPath}`);
}

function readJson(filePath: string): any {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

if (process.argv[1]?.includes('experience-extractor')) {
  main();
}
