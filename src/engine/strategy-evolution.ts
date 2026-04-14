/**
 * ============================================================================
 * STRATEGY EVOLUTION ENGINE — Change HOW You Test, Not Just WHAT
 * ============================================================================
 *
 * The missing layer between "prompt evolution" and true Hera-level learning.
 *
 * Prompt Evolution = make the same strategy work better (incremental)
 * Strategy Evolution = switch to a fundamentally different strategy (mutation)
 *
 * Example:
 *   - Selector keeps failing → stop DOM-based testing → switch to API-first
 *   - Async race conditions → stop wait-based → switch to state-driven assertions
 *   - Flaky UI tests → stop UI-only → switch to contract testing
 *
 * How it works:
 *   1. Pattern Aggregator reads Experience Library, groups failures by type
 *   2. Mutation Detector checks if any pattern crosses a mutation threshold
 *   3. Strategy Mutator produces a StrategyMutation (from → to)
 *   4. Strategy Applier rewrites the Test Strategy prompt/output
 *   5. Mutation is recorded so it can be reversed if it makes things worse
 *
 * Pipeline position:
 *   Experience Library → [STRATEGY EVOLUTION] → Test Strategy Agent prompt
 *                                             → Test generation layer/approach
 *
 * Key principle: mutations are REVERSIBLE. If a mutation increases failure rate
 * within 3 runs, it auto-reverts. This prevents catastrophic strategy drift.
 * ============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';
import { ExperienceLibrary, type FailurePattern } from './experience-library.js';

// ============================================================================
// TYPES
// ============================================================================

/** A testing approach for a specific concern */
type TestingApproach =
  | 'dom-selector'           // Find elements by CSS/role/text, assert visibility
  | 'api-first'              // Validate via API, use UI only for triggers
  | 'state-driven'           // Assert on state store (Redux/Pinia), not DOM
  | 'contract-testing'       // API schema validation, no UI at all
  | 'visual-regression'      // Screenshot comparison
  | 'network-interception'   // Intercept requests, validate payloads
  | 'event-driven'           // Listen for custom events / state transitions
  | 'hybrid-ui-api';         // UI triggers + API response validation

/** The concern area that a strategy addresses */
type ConcernArea =
  | 'element-interaction'    // Click, fill, select — DOM-level
  | 'data-validation'        // Correct data displayed / saved
  | 'async-timing'           // Waiting for async operations
  | 'auth-session'           // Login, token, session management
  | 'navigation-routing'     // Page transitions, URL changes
  | 'error-handling'         // Error states, fallbacks
  | 'cross-layer-consistency'; // UI ↔ API ↔ State agreement

/** A single mutation: change approach for a concern area */
export interface StrategyMutation {
  id: string;
  projectName: string;           // Scoped to a specific project
  concern: ConcernArea;
  from: TestingApproach;
  to: TestingApproach;
  reason: string;                // Why the mutation was triggered
  triggerPattern: string;        // The failure pattern that triggered it
  triggerFrequency: number;      // How many times the pattern occurred
  triggerConfidence: number;      // Aggregated confidence of the pattern
  appliedAt: string;             // ISO timestamp
  status: 'active' | 'reverted' | 'confirmed';
  runsAfterMutation: number;     // How many pipeline runs since mutation
  failureRateBefore: number;     // Failure rate in the concern area before
  failureRateAfter: number;      // Failure rate after (updated each run)
  promptPatch: StrategyPromptPatch; // What to inject into the strategy prompt
}

/** Instructions injected into the Test Strategy Agent prompt */
export interface StrategyPromptPatch {
  /** Section heading for the mutation */
  heading: string;
  /** Concrete instructions for test generation */
  instructions: string[];
  /** Scenario templates to replace or augment existing ones */
  scenarioOverrides: Array<{
    scenarioType: string;
    newApproach: string;
    example: string;
  }>;
  /** Rules to add/modify */
  ruleAdjustments: Array<{
    ruleId: string;
    action: 'add' | 'modify' | 'disable';
    value: string;
  }>;
}

/** Aggregated pattern from experience library */
interface AggregatedPattern {
  concern: ConcernArea;
  currentApproach: TestingApproach;
  failureType: string;
  frequency: number;
  confidence: number;
  examples: string[];
  relatedPatterns: string[];
}

/** Persistent state for strategy evolution */
interface StrategyEvolutionDB {
  version: string;
  lastUpdated: string;
  activeMutations: StrategyMutation[];
  mutationHistory: StrategyMutation[];
  baselineFailureRates: Record<ConcernArea, number>;
  totalPipelineRuns: number;
}

// ============================================================================
// CONSTANTS
// ============================================================================

/** Minimum occurrences before a mutation is considered */
const MUTATION_FREQUENCY_THRESHOLD = 5;

/** Minimum aggregated confidence to trigger mutation (high bar — avoid noisy triggers) */
const MUTATION_CONFIDENCE_THRESHOLD = 0.75;

/** If failure rate increases by this ratio after mutation, auto-revert */
const REVERT_FAILURE_INCREASE_RATIO = 1.5;

/** Number of runs to evaluate before confirming/reverting a mutation */
const EVALUATION_WINDOW_RUNS = 3;

/** Maximum active mutations at once (prevent chaos) */
const MAX_ACTIVE_MUTATIONS = 2;

// ============================================================================
// MUTATION RULES — Maps failure patterns to strategy changes
// ============================================================================

interface MutationRule {
  /** Failure types that trigger this rule (regex on failure pattern names) */
  triggerPatterns: RegExp[];
  /** The concern area this mutation addresses */
  concern: ConcernArea;
  /** What approach we're likely using now (inferred from the failures) */
  currentApproach: TestingApproach;
  /** What approach to switch to */
  targetApproach: TestingApproach;
  /** Human-readable reason */
  reason: string;
  /** Priority: higher = wins when two mutations conflict (1-10) */
  priority: number;
  /** Concerns that conflict with this mutation (can't be active simultaneously) */
  conflictsWith: ConcernArea[];
  /** The prompt patch to apply */
  patch: StrategyPromptPatch;
}

const MUTATION_RULES: MutationRule[] = [
  // ── Selector flaky → API-first validation ──
  {
    triggerPatterns: [
      /selector.*not.*found/i,
      /selector.*ambig/i,
      /stale.*element/i,
      /element.*not.*interactable/i,
      /click.*intercepted/i,
    ],
    concern: 'element-interaction',
    currentApproach: 'dom-selector',
    targetApproach: 'api-first',
    priority: 8,
    conflictsWith: ['cross-layer-consistency'],
    reason: 'DOM selectors are unreliable for this feature. Switch to API-first: trigger actions via UI, validate results via API response.',
    patch: {
      heading: '## STRATEGY MUTATION: API-First Validation (auto-evolved)',
      instructions: [
        'For data validation scenarios: DO NOT assert on DOM text content. Instead:',
        '1. Perform the UI action (click, fill, submit)',
        '2. Intercept the API request with page.waitForResponse()',
        '3. Assert on the API response payload',
        '4. Only check UI for structural presence (element exists), not data correctness',
        'This avoids selector brittleness while still testing the full flow.',
      ],
      scenarioOverrides: [
        {
          scenarioType: 'positive',
          newApproach: 'UI trigger + API response assertion',
          example: [
            'const [response] = await Promise.all([',
            '  page.waitForResponse(resp => resp.url().includes("/api/data") && resp.status() === 200),',
            '  page.getByRole("button", { name: /save/i }).click(),',
            ']);',
            'const body = await response.json();',
            'expect(body.data.field).toBe(expectedValue);',
          ].join('\n'),
        },
        {
          scenarioType: 'edit_flow',
          newApproach: 'Fill via UI + verify via API',
          example: [
            'await page.getByLabel(/field name/i).fill("new value");',
            'const [response] = await Promise.all([',
            '  page.waitForResponse(r => r.url().includes("/api/update")),',
            '  page.getByRole("button", { name: /save/i }).click(),',
            ']);',
            'expect(response.status()).toBe(200);',
            'expect((await response.json()).data.field).toBe("new value");',
          ].join('\n'),
        },
      ],
      ruleAdjustments: [
        { ruleId: 'no-text-assertion-for-data', action: 'add', value: 'Do not use toContainText() or toHaveText() for data values. Use API response assertions instead.' },
        { ruleId: 'require-api-intercept', action: 'add', value: 'Every data mutation test MUST include page.waitForResponse() to capture the API call.' },
      ],
    },
  },

  // ── Async race conditions → State-driven assertions ──
  {
    triggerPatterns: [
      /race.*condition/i,
      /timing/i,
      /async/i,
      /not.*yet.*updated/i,
      /Expected.*but.*received/i,
      /waitForResponse.*timeout/i,
    ],
    concern: 'async-timing',
    currentApproach: 'dom-selector',
    targetApproach: 'state-driven',
    priority: 9,
    conflictsWith: [],
    reason: 'Async timing issues indicate DOM is checked before state settles. Switch to state-driven: wait for state store to update, then optionally verify UI.',
    patch: {
      heading: '## STRATEGY MUTATION: State-Driven Assertions (auto-evolved)',
      instructions: [
        'For async operations: DO NOT wait for DOM changes. Instead:',
        '1. Perform the action',
        '2. Use page.evaluate() to read the application state store directly',
        '3. Poll state with a retry loop until the expected state appears',
        '4. Only after state confirms, optionally check UI rendering',
        'This decouples test timing from render timing.',
      ],
      scenarioOverrides: [
        {
          scenarioType: 'positive',
          newApproach: 'Action + state poll + optional UI check',
          example: [
            'await page.getByRole("button", { name: /load/i }).click();',
            'await expect.poll(async () => {',
            '  return page.evaluate(() => window.__store__.getState().data.loaded);',
            '}, { timeout: 10000 }).toBe(true);',
            '// State confirmed — now safe to check UI',
            'await expect(page.getByText(/loaded/i)).toBeVisible();',
          ].join('\n'),
        },
      ],
      ruleAdjustments: [
        { ruleId: 'prefer-state-assertion', action: 'add', value: 'When testing async operations, prefer state store assertions over DOM text assertions. Use page.evaluate() to read store state.' },
        { ruleId: 'no-fixed-wait', action: 'modify', value: 'Replace page.waitForTimeout() with expect.poll() on state conditions.' },
      ],
    },
  },

  // ── Auth failures → Token-aware test structure ──
  {
    triggerPatterns: [
      /auth.*expired/i,
      /token.*expired/i,
      /401/,
      /unauthorized/i,
      /redirect.*login/i,
    ],
    concern: 'auth-session',
    currentApproach: 'dom-selector',
    targetApproach: 'network-interception',
    priority: 10,
    conflictsWith: [],
    reason: 'Auth tokens expire during test runs. Switch to network interception: inject tokens at network level, validate auth state before each test.',
    patch: {
      heading: '## STRATEGY MUTATION: Token-Aware Testing (auto-evolved)',
      instructions: [
        'Auth is unreliable during long test runs. Instead of relying on UI login:',
        '1. Use storageState to persist auth between tests',
        '2. Add a beforeEach hook that validates token expiry via API',
        '3. If token is expired, re-authenticate via API (not UI) — faster + more reliable',
        '4. Intercept auth-related requests to detect 401s early',
      ],
      scenarioOverrides: [
        {
          scenarioType: 'permission',
          newApproach: 'API-based auth + network monitoring',
          example: [
            'test.beforeEach(async ({ page, context }) => {',
            '  // Check token validity via API',
            '  const resp = await page.request.get("/api/auth/me");',
            '  if (resp.status() === 401) {',
            '    // Re-auth via API, not UI',
            '    const login = await page.request.post("/api/auth/login", {',
            '      data: { username: "gvcn", password: process.env.TEST_PASSWORD }',
            '    });',
            '    const { token } = await login.json();',
            '    await context.addCookies([{ name: "token", value: token, domain: "localhost", path: "/" }]);',
            '  }',
            '});',
          ].join('\n'),
        },
      ],
      ruleAdjustments: [
        { ruleId: 'require-auth-check', action: 'add', value: 'Every test suite with authenticated routes MUST validate auth state in beforeEach.' },
      ],
    },
  },

  // ── Network errors → Contract testing ──
  {
    triggerPatterns: [
      /network.*error/i,
      /ECONNREFUSED/i,
      /fetch.*failed/i,
      /net::ERR/i,
    ],
    concern: 'data-validation',
    currentApproach: 'dom-selector',
    targetApproach: 'contract-testing',
    priority: 6,
    conflictsWith: ['cross-layer-consistency'],
    reason: 'Network unreliability makes full E2E fragile. Add contract tests: validate API schemas independently, use mocked responses for UI tests.',
    patch: {
      heading: '## STRATEGY MUTATION: Contract Testing Layer (auto-evolved)',
      instructions: [
        'API infrastructure is unreliable. Split test strategy:',
        '1. API contract tests: validate request/response schemas against OpenAPI spec (runs without UI)',
        '2. UI tests with mocked API: use page.route() to intercept and mock API responses',
        '3. Keep a small set of true E2E tests for critical paths only',
        'This isolates UI testing from API infrastructure.',
      ],
      scenarioOverrides: [
        {
          scenarioType: 'error_state',
          newApproach: 'Mocked API response for UI error states',
          example: [
            '// Mock API failure to test error UI',
            'await page.route("**/api/data", route => {',
            '  route.fulfill({ status: 500, body: JSON.stringify({ error: "Server Error" }) });',
            '});',
            'await page.goto("/dashboard");',
            'await expect(page.getByText(/error|something went wrong/i)).toBeVisible();',
          ].join('\n'),
        },
      ],
      ruleAdjustments: [
        { ruleId: 'require-mock-for-error-tests', action: 'add', value: 'Error state tests MUST use page.route() to mock API failures. Do not depend on real API errors.' },
      ],
    },
  },

  // ── Cross-layer inconsistency → Hybrid UI-API validation ──
  {
    triggerPatterns: [
      /Expected.*but.*received/i,
      /data.*mismatch/i,
      /stale.*data/i,
      /display.*incorrect/i,
    ],
    concern: 'cross-layer-consistency',
    currentApproach: 'dom-selector',
    targetApproach: 'hybrid-ui-api',
    priority: 7,
    conflictsWith: ['element-interaction', 'data-validation'],
    reason: 'UI shows stale or mismatched data. Switch to hybrid: fetch from API AND read from UI, compare the two for consistency.',
    patch: {
      heading: '## STRATEGY MUTATION: Hybrid UI-API Consistency (auto-evolved)',
      instructions: [
        'Data displayed in UI may not match API response. Test both:',
        '1. Intercept the API response that feeds the component',
        '2. Read what the UI actually renders',
        '3. Compare UI text against API response data',
        '4. This catches both rendering bugs AND stale cache issues',
      ],
      scenarioOverrides: [
        {
          scenarioType: 'positive',
          newApproach: 'Dual-source validation (API + UI)',
          example: [
            'const [response] = await Promise.all([',
            '  page.waitForResponse(r => r.url().includes("/api/students")),',
            '  page.goto("/class/students"),',
            ']);',
            'const apiData = await response.json();',
            'const uiText = await page.getByTestId("student-count").textContent();',
            'expect(uiText).toContain(String(apiData.total));',
          ].join('\n'),
        },
      ],
      ruleAdjustments: [
        { ruleId: 'require-dual-validation', action: 'add', value: 'For data display tests, MUST compare UI rendered value against API response. Do not trust UI alone.' },
      ],
    },
  },
];

// ============================================================================
// PATTERN AGGREGATOR
// ============================================================================

/**
 * Reads the Experience Library and aggregates failure patterns by concern area.
 * Groups related failures, counts frequency, and computes aggregate confidence.
 * Filters by project scope: only patterns from this project OR global scope.
 */
function aggregatePatterns(library: ExperienceLibrary, projectName: string): AggregatedPattern[] {
  const allFailures = library.getByCategory<FailurePattern>('failure_pattern');

  // Scope separation: only this project's patterns + global patterns
  const failures = allFailures.filter(f =>
    f.scope === 'global' || f.projectName === projectName
  );

  // Group failures by which mutation rule they'd trigger
  const groups = new Map<number, { patterns: FailurePattern[]; rule: MutationRule }>();

  for (const failure of failures) {
    for (let i = 0; i < MUTATION_RULES.length; i++) {
      const rule = MUTATION_RULES[i];
      const matches = rule.triggerPatterns.some(regex =>
        regex.test(failure.pattern) || regex.test(failure.errorSignature)
      );
      if (matches) {
        if (!groups.has(i)) {
          groups.set(i, { patterns: [], rule });
        }
        groups.get(i)!.patterns.push(failure);
        break; // One pattern per rule
      }
    }
  }

  // Convert to AggregatedPattern
  const aggregated: AggregatedPattern[] = [];
  for (const [, { patterns, rule }] of groups) {
    const totalConfidence = patterns.reduce((sum, p) => sum + p.confidence, 0);

    aggregated.push({
      concern: rule.concern,
      currentApproach: rule.currentApproach,
      failureType: rule.reason.split('.')[0],
      frequency: patterns.length,
      confidence: totalConfidence / patterns.length,
      examples: patterns.slice(0, 3).map(p => p.example.error),
      relatedPatterns: patterns.map(p => p.pattern),
    });
  }

  return aggregated.sort((a, b) => b.frequency - a.frequency);
}

// ============================================================================
// MUTATION DETECTOR
// ============================================================================

/**
 * Given aggregated patterns, detect which ones cross the mutation threshold.
 * Returns mutation rules that should fire, sorted by priority.
 * Resolves conflicts: if two mutations conflict, higher priority wins.
 */
function detectMutations(
  aggregated: AggregatedPattern[],
  activeMutations: StrategyMutation[],
): Array<{ pattern: AggregatedPattern; rule: MutationRule }> {
  const candidates: Array<{ pattern: AggregatedPattern; rule: MutationRule }> = [];

  for (const pattern of aggregated) {
    // Check thresholds
    if (pattern.frequency < MUTATION_FREQUENCY_THRESHOLD) continue;
    if (pattern.confidence < MUTATION_CONFIDENCE_THRESHOLD) continue;

    // Find the matching mutation rule
    const rule = MUTATION_RULES.find(r => r.concern === pattern.concern);
    if (!rule) continue;

    // Skip if already mutated for this concern
    const alreadyActive = activeMutations.some(
      m => m.concern === pattern.concern && m.status === 'active'
    );
    if (alreadyActive) continue;

    // Skip if a conflicting mutation is already active
    const conflictsWithActive = activeMutations.some(
      m => m.status === 'active' && rule.conflictsWith.includes(m.concern as ConcernArea)
    );
    if (conflictsWithActive) continue;

    candidates.push({ pattern, rule });
  }

  // Sort by priority (highest first) — when budget is limited, highest priority wins
  candidates.sort((a, b) => b.rule.priority - a.rule.priority);

  // Resolve conflicts between candidates: if A conflicts with B, drop B (lower priority)
  const accepted: Array<{ pattern: AggregatedPattern; rule: MutationRule }> = [];
  const blockedConcerns = new Set<ConcernArea>();

  for (const candidate of candidates) {
    if (blockedConcerns.has(candidate.rule.concern)) continue;
    accepted.push(candidate);
    // Block all concerns this mutation conflicts with
    for (const conflict of candidate.rule.conflictsWith) {
      blockedConcerns.add(conflict);
    }
  }

  return accepted;
}

// ============================================================================
// STRATEGY EVOLUTION ENGINE
// ============================================================================

export class StrategyEvolutionEngine {
  private db: StrategyEvolutionDB;
  private dbPath: string;

  private constructor(db: StrategyEvolutionDB, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  static load(dbPath: string): StrategyEvolutionEngine {
    const absPath = path.resolve(dbPath);
    let db: StrategyEvolutionDB;

    if (fs.existsSync(absPath)) {
      db = JSON.parse(fs.readFileSync(absPath, 'utf-8'));
    } else {
      db = {
        version: '1.0.0',
        lastUpdated: new Date().toISOString(),
        activeMutations: [],
        mutationHistory: [],
        baselineFailureRates: {
          'element-interaction': 0,
          'data-validation': 0,
          'async-timing': 0,
          'auth-session': 0,
          'navigation-routing': 0,
          'error-handling': 0,
          'cross-layer-consistency': 0,
        },
        totalPipelineRuns: 0,
      };
    }

    return new StrategyEvolutionEngine(db, absPath);
  }

  // --------------------------------------------------------------------------
  // EVOLVE — Main entry point. Call after each pipeline run.
  // --------------------------------------------------------------------------

  /**
   * Analyze experience library and produce strategy mutations for a specific project.
   * Scope separation: only considers patterns from this project + global patterns.
   * Returns new mutations applied this run + any reverted mutations.
   */
  evolve(library: ExperienceLibrary, projectName: string = 'default'): {
    newMutations: StrategyMutation[];
    revertedMutations: StrategyMutation[];
    confirmedMutations: StrategyMutation[];
    activeMutations: StrategyMutation[];
  } {
    this.db.totalPipelineRuns++;

    const newMutations: StrategyMutation[] = [];
    const revertedMutations: StrategyMutation[] = [];
    const confirmedMutations: StrategyMutation[] = [];

    // Scope: only evaluate mutations belonging to this project
    const projectMutations = this.db.activeMutations.filter(
      m => m.projectName === projectName
    );

    // Step 1: Evaluate existing active mutations for THIS project
    for (const mutation of projectMutations) {
      if (mutation.status !== 'active') continue;
      mutation.runsAfterMutation++;

      // Update failure rate after mutation (scoped to project)
      const currentRate = this.computeFailureRate(mutation.concern, library, projectName);
      mutation.failureRateAfter = currentRate;

      if (mutation.runsAfterMutation >= EVALUATION_WINDOW_RUNS) {
        if (currentRate > mutation.failureRateBefore * REVERT_FAILURE_INCREASE_RATIO) {
          // Mutation made things worse → revert
          mutation.status = 'reverted';
          revertedMutations.push(mutation);
        } else {
          // Mutation is working → confirm
          mutation.status = 'confirmed';
          confirmedMutations.push(mutation);
        }
      }
    }

    // Move reverted/confirmed out of active list
    this.db.activeMutations = this.db.activeMutations.filter(m => m.status === 'active');
    this.db.mutationHistory.push(...revertedMutations, ...confirmedMutations);

    // Step 2: Detect new mutations (if under max active limit FOR THIS PROJECT)
    const activeForProject = this.db.activeMutations.filter(m => m.projectName === projectName);
    if (activeForProject.length < MAX_ACTIVE_MUTATIONS) {
      const aggregated = aggregatePatterns(library, projectName);
      const candidates = detectMutations(aggregated, activeForProject);

      // Also exclude concerns that were recently reverted for THIS project (within 5 runs)
      const recentReverts = this.db.mutationHistory
        .filter(m => m.status === 'reverted' && m.projectName === projectName)
        .filter(m => this.db.totalPipelineRuns - m.runsAfterMutation < 5);
      const recentRevertConcerns = new Set(recentReverts.map(m => m.concern));

      for (const { pattern, rule } of candidates) {
        if (activeForProject.length + newMutations.length >= MAX_ACTIVE_MUTATIONS) break;
        if (recentRevertConcerns.has(rule.concern)) continue;

        const mutation: StrategyMutation = {
          id: `SM-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          projectName,
          concern: rule.concern,
          from: rule.currentApproach,
          to: rule.targetApproach,
          reason: rule.reason,
          triggerPattern: pattern.relatedPatterns[0] || pattern.failureType,
          triggerFrequency: pattern.frequency,
          triggerConfidence: pattern.confidence,
          appliedAt: new Date().toISOString(),
          status: 'active',
          runsAfterMutation: 0,
          failureRateBefore: this.computeFailureRate(rule.concern, library, projectName),
          failureRateAfter: 0,
          promptPatch: rule.patch,
        };

        this.db.activeMutations.push(mutation);
        newMutations.push(mutation);
      }
    }

    // Update baseline failure rates (scoped to project)
    for (const concern of Object.keys(this.db.baselineFailureRates) as ConcernArea[]) {
      const hasActiveMutation = activeForProject.some(m => m.concern === concern);
      if (!hasActiveMutation) {
        this.db.baselineFailureRates[concern] = this.computeFailureRate(concern, library, projectName);
      }
    }

    this.save();

    return {
      newMutations,
      revertedMutations,
      confirmedMutations,
      activeMutations: [...this.db.activeMutations],
    };
  }

  // --------------------------------------------------------------------------
  // PROMPT GENERATION — Produce strategy patches for prompt injection
  // --------------------------------------------------------------------------

  /**
   * Generate a strategy evolution section for injection into the Test Strategy
   * Agent prompt. Only includes active + confirmed mutations for this project.
   */
  generateStrategyPromptSection(projectName?: string): string {
    const mutations = [
      ...this.db.activeMutations.filter(m =>
        m.status === 'active' && (!projectName || m.projectName === projectName)
      ),
      ...this.db.mutationHistory.filter(m =>
        m.status === 'confirmed' && (!projectName || m.projectName === projectName)
      ),
    ];

    if (mutations.length === 0) return '';

    const lines: string[] = [
      '',
      '# STRATEGY MUTATIONS (auto-evolved — DO NOT ignore)',
      '',
      '> These mutations were triggered by repeated failure patterns.',
      '> They represent fundamental strategy shifts, not incremental prompt improvements.',
      '> Apply them as PRIMARY approach, falling back to the original only when the mutation does not apply.',
      '',
    ];

    for (const mutation of mutations) {
      lines.push(mutation.promptPatch.heading);
      lines.push('');
      lines.push(`**Why:** ${mutation.reason}`);
      lines.push(`**Trigger:** "${mutation.triggerPattern}" occurred ${mutation.triggerFrequency} times (confidence: ${(mutation.triggerConfidence * 100).toFixed(0)}%)`);
      lines.push(`**Approach change:** \`${mutation.from}\` → \`${mutation.to}\``);
      lines.push('');

      // Instructions
      for (const instruction of mutation.promptPatch.instructions) {
        lines.push(`- ${instruction}`);
      }
      lines.push('');

      // Scenario overrides
      if (mutation.promptPatch.scenarioOverrides.length > 0) {
        lines.push('**Scenario templates:**');
        for (const override of mutation.promptPatch.scenarioOverrides) {
          lines.push('');
          lines.push(`*${override.scenarioType}* → ${override.newApproach}`);
          lines.push('```typescript');
          lines.push(override.example);
          lines.push('```');
        }
        lines.push('');
      }

      // Rule adjustments
      if (mutation.promptPatch.ruleAdjustments.length > 0) {
        lines.push('**Rule changes:**');
        for (const adj of mutation.promptPatch.ruleAdjustments) {
          lines.push(`- [${adj.action.toUpperCase()}] \`${adj.ruleId}\`: ${adj.value}`);
        }
        lines.push('');
      }

      lines.push('---');
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Get active mutations as structured data. Optionally filtered by project.
   */
  getActiveMutations(projectName?: string): StrategyMutation[] {
    if (!projectName) return [...this.db.activeMutations];
    return this.db.activeMutations.filter(m => m.projectName === projectName);
  }

  /**
   * Get all confirmed mutations (proven effective). Optionally filtered by project.
   */
  getConfirmedMutations(projectName?: string): StrategyMutation[] {
    const confirmed = this.db.mutationHistory.filter(m => m.status === 'confirmed');
    if (!projectName) return confirmed;
    return confirmed.filter(m => m.projectName === projectName);
  }

  /**
   * Get full mutation history for reporting. Optionally filtered by project.
   */
  getMutationHistory(projectName?: string): StrategyMutation[] {
    const all = [...this.db.activeMutations, ...this.db.mutationHistory];
    if (!projectName) return all;
    return all.filter(m => m.projectName === projectName);
  }

  get totalRuns(): number {
    return this.db.totalPipelineRuns;
  }

  // --------------------------------------------------------------------------
  // REPORT
  // --------------------------------------------------------------------------

  generateReport(): string {
    const lines: string[] = [
      'Strategy Evolution Report',
      '═'.repeat(50),
      '',
      `Pipeline runs: ${this.db.totalPipelineRuns}`,
      `Active mutations: ${this.db.activeMutations.length}`,
      `Confirmed: ${this.db.mutationHistory.filter(m => m.status === 'confirmed').length}`,
      `Reverted: ${this.db.mutationHistory.filter(m => m.status === 'reverted').length}`,
      '',
    ];

    if (this.db.activeMutations.length > 0) {
      lines.push('Active Mutations:');
      for (const m of this.db.activeMutations) {
        lines.push(`  [${m.status}] ${m.concern}: ${m.from} → ${m.to}`);
        lines.push(`    Trigger: "${m.triggerPattern}" x${m.triggerFrequency}`);
        lines.push(`    Failure rate: ${(m.failureRateBefore * 100).toFixed(0)}% → ${(m.failureRateAfter * 100).toFixed(0)}%`);
        lines.push(`    Runs since mutation: ${m.runsAfterMutation}/${EVALUATION_WINDOW_RUNS}`);
      }
      lines.push('');
    }

    if (this.db.mutationHistory.length > 0) {
      lines.push('Mutation History:');
      for (const m of this.db.mutationHistory.slice(-10)) {
        const icon = m.status === 'confirmed' ? '✓' : '✗';
        lines.push(`  ${icon} ${m.concern}: ${m.from} → ${m.to} [${m.status}]`);
      }
    }

    lines.push('');
    lines.push('Baseline Failure Rates:');
    for (const [concern, rate] of Object.entries(this.db.baselineFailureRates)) {
      const bar = '#'.repeat(Math.round(rate * 20));
      lines.push(`  ${concern.padEnd(28)} ${(rate * 100).toFixed(0).padStart(3)}%  ${bar}`);
    }

    return lines.join('\n');
  }

  // --------------------------------------------------------------------------
  // INTERNALS
  // --------------------------------------------------------------------------

  /**
   * Compute failure rate for a concern area based on experience library data.
   * Scoped to project: only counts this project's patterns + global patterns.
   */
  private computeFailureRate(concern: ConcernArea, library: ExperienceLibrary, projectName: string = 'default'): number {
    const CONCERN_TAGS: Record<ConcernArea, string[]> = {
      'element-interaction': ['selector', 'click', 'z-index', 'stale'],
      'data-validation': ['data', 'mismatch', 'encoding'],
      'async-timing': ['race', 'timing', 'async', 'timeout'],
      'auth-session': ['auth', 'token', 'session', 'expired'],
      'navigation-routing': ['navigation', 'routing', 'redirect'],
      'error-handling': ['error', 'network', 'infrastructure'],
      'cross-layer-consistency': ['state', 'api', 'consistency'],
    };

    const tags = CONCERN_TAGS[concern] || [];
    const relevant = library.query(...tags);

    // Scope: only this project + global
    const scoped = relevant.filter(e =>
      e.scope === 'global' || e.projectName === projectName
    );
    const failures = scoped.filter(e => e.category === 'failure_pattern');
    const fixes = scoped.filter(e => e.category === 'fix_strategy');

    if (failures.length === 0) return 0;

    // Rate = failures / (failures + successful fixes)
    const successfulFixes = fixes.filter(e => e.confidence > 0.5).length;
    return failures.length / (failures.length + successfulFixes + 1);
  }

  private save(): void {
    this.db.lastUpdated = new Date().toISOString();
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    fs.writeFileSync(this.dbPath, JSON.stringify(this.db, null, 2));
  }
}
