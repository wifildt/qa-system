# QA System — Production Architecture (v4: Strategy Evolution)

## System Overview

A multi-agent, execution-backed, **self-learning** QA system for validating frontend
applications across UI, API, state, and UX layers.

**Five core principles**:
1. **No assertion without execution evidence** — AI agents analyze and generate, never mark pass/fail
2. **No test runs without enforcement** — Validation Engine BLOCKS bad tests before execution
3. **No failure without feedback** — Self-Healing Agent fixes or escalates every failure
4. **No run without learning** — Experience Library captures insights, Prompt Evolution applies them
5. **No repeated failure without strategy change** — Strategy Evolution mutates test approach when patterns persist

```
                    ┌──────────────────────────────┐
                    │       ORCHESTRATOR            │
                    │  (bin/qa-cli.ts)              │
                    └──────┬───────────────────────┘
                           │
              Phase 1-2: UNDERSTAND + PLAN
                           │
                ┌──────────v──────────┐
                │  Feature Understand. │──→ feature-map.json
                │  Test Strategy       │──→ test-plan.json
                └──────────┬──────────┘
                           │
              Phase 3: GENERATE (AI)
                           │
          ┌────────────────┼────────────────┐
          │                │                │
    ┌─────v──────┐  ┌──────v─────┐  ┌──────v──────┐
    │ UI Test    │  │ API Test   │  │ State Logic │
    │ Agent      │  │ Agent      │  │ Agent       │
    └─────┬──────┘  └──────┬─────┘  └──────┬──────┘
          │                │                │
          └────────────────┼────────────────┘
                           │
              Phase 4: ENFORCE (Non-AI)
                           │
                ┌──────────v──────────┐
                │  VALIDATION ENGINE  │
                │  (10 rules, 0 AI)   │
                │                     │
                │  PASS → execute     │
                │  BLOCK → reject +   │──→ violation report
                │    feed back to     │
                │    generators       │
                └──────────┬──────────┘
                           │ (only validated tests pass)
                           │
              Phase 5: EXECUTE (Non-AI)
                           │
                ┌──────────v──────────┐
                │  EXECUTION ENGINE   │
                │  Playwright/Vitest  │──→ screenshots, traces, HAR
                └──────────┬──────────┘
                           │
              Phase 6: HEAL (Hybrid)
                           │
                ┌──────────v──────────┐
                │  SELF-HEALING AGENT │
                │                     │
                │  auto-fix: selector,│
                │    timeout, auth    │
                │                     │
                │  escalate: stale    │──→ regeneration queue
                │    data, assertion  │    (back to Phase 3)
                │                     │
                │  learn: record fix  │──→ learning-db.json
                │    outcomes         │
                └──────────┬──────────┘
                           │
              Phase 7: ANALYZE (AI)
                           │
          ┌────────────────┼────────────────┐
          │                │                │
    ┌─────v──────┐  ┌──────v─────┐  ┌──────v──────┐
    │ Consistency│  │ UX Valid.  │  │ Report Gen. │
    │ Analyzer   │  │ Agent      │  │ Agent       │
    └────────────┘  └────────────┘  └─────────────┘
                           │
              Phase 8: LEARN
                           │
                ┌──────────v──────────┐
                │ EXPERIENCE EXTRACTOR│
                │ raw results →       │──→ experience-db.json
                │ curated insights    │
                └──────────┬──────────┘
                           │
              Phase 9: EVOLVE (New)
                           │
                ┌──────────v──────────┐
                │ STRATEGY EVOLUTION  │
                │                     │
                │ Aggregate failure   │
                │ patterns → detect   │
                │ mutation triggers   │──→ strategy-evolution-db.json
                │ → mutate test       │
                │ approach            │
                │                     │
                │ + PROMPT EVOLUTION  │──→ evolved prompts for
                │   injects mutations │    next run (Phase 2-3)
                │   + experience      │
                └─────────────────────┘
                           │
                           v
                    ┌─────────────┐
                    │  FINAL      │
                    │  REPORT     │──→ report.html + report.json
                    └─────────────┘
```

### Feedback Loops (what makes this a SYSTEM, not just a pipeline)

```
Loop 1: VALIDATION FEEDBACK (prevents bad tests)
  ┌─────────────┐        ┌───────────────┐
  │ AI Test     │───────→│ Validation    │
  │ Generators  │←───────│ Engine        │
  └─────────────┘ reject └───────────────┘
                  + hint

Loop 2: SELF-HEALING FEEDBACK (fixes broken tests)
  ┌─────────────┐        ┌───────────────┐        ┌────────────┐
  │ Execution   │───────→│ Self-Healing  │───────→│ Re-execute │
  │ Engine      │        │ Agent         │        │            │
  └─────────────┘        └──────┬────────┘        └────────────┘
                                │ can't fix?
                                v
                         ┌───────────────┐
                         │ AI Generators │ (regeneration queue)
                         │ with context  │
                         └───────────────┘

Loop 3: LEARNING FEEDBACK (system improves over time)
  ┌─────────────┐        ┌───────────────┐
  │ Fix applied │───────→│ Learning DB   │
  │ outcome     │        │ (500 entries) │
  └─────────────┘        └──────┬────────┘
                                │ same fix failed 2x?
                                v
                         Skip fix, try different strategy

Loop 4: STRATEGY EVOLUTION (system changes HOW it tests)
  ┌─────────────┐        ┌───────────────┐        ┌────────────────┐
  │ Experience  │───────→│ Pattern       │───────→│ Strategy       │
  │ Library     │        │ Aggregator    │        │ Mutation       │
  └─────────────┘        └───────────────┘        └──────┬─────────┘
                                                         │
                          Failure pattern repeated       │ mutate
                          5+ times, 60%+ confidence      │
                                                         v
                                                  ┌────────────────┐
                                                  │ Test Strategy  │
                                                  │ Agent prompt   │
                                                  │ rewritten      │
                                                  └──────┬─────────┘
                                                         │
                                                  Evaluate for 3 runs
                                                  Auto-revert if worse
```

---

## Data Flow (9 Phases)

```
Phase 1: UNDERSTAND
  Feature Understanding Agent
    reads: project source code (pages, components, store)
    outputs: qa-system/analysis/feature-map.json

Phase 2: PLAN
  Test Strategy Agent
    reads: feature-map.json + rules/*.json + strategy mutations
    outputs: qa-system/analysis/test-plan.json

Phase 3: GENERATE
  UI Test Agent    → qa-system/test/ui/*.spec.ts
  API Test Agent   → qa-system/test/api/*.api.spec.ts
  State Logic Agent → qa-system/test/state/*.state.spec.ts

Phase 4: ENFORCE
  Validation Engine (non-AI)
    reads: generated test files + rules/*.json
    action: BLOCK files with violations, PASS clean files
    outputs: validation-report.json
    feedback: violation details → back to Phase 3 for regen

Phase 5: EXECUTE (non-AI)
  Playwright runner → screenshots, traces, HAR
  API runner        → response logs
  Assertion engine  → pass/fail with evidence
  outputs: execution-results.json

Phase 6: HEAL
  Self-Healing Agent (hybrid)
    reads: execution-results.json + learning-db.json
    action: auto-fix selectors/timeouts, queue unfixable for regen
    outputs: healing-report.json
    feedback: fixed files → back to Phase 5 (re-execute)
             regen queue → back to Phase 3 (AI regenerates)
    learning: records fix outcomes in learning-db.json

Phase 7: ANALYZE
  Consistency Analyzer → cross-layer mismatches
  UX Validation Agent  → usability findings

Phase 8: LEARN
  Experience Extractor
    reads: execution/healing/validation reports
    outputs: curated entries → experience-db.json
    NOT raw logs — only actionable patterns

Phase 9: EVOLVE
  Strategy Evolution Engine
    reads: experience-db.json (aggregated failure patterns)
    action: detect mutation triggers → apply strategy changes
    outputs: strategy-evolution-db.json
    feedback: mutations injected into Phase 2-3 prompts via Prompt Evolution
    safety: auto-revert if failure rate increases >1.5x within 3 runs
```

---

## Strategy Mutations

When failure patterns persist, the system switches testing approach:

| Trigger | From | To | Example |
|---------|------|----|---------|
| Selector flaky 5+ times | `dom-selector` | `api-first` | Assert on API response, not DOM text |
| Async race conditions | `dom-selector` | `state-driven` | Poll state store, not UI elements |
| Auth token expired | `dom-selector` | `network-interception` | API-based re-auth, token validation |
| Network errors | `dom-selector` | `contract-testing` | Mock API, schema validation |
| Cross-layer data mismatch | `dom-selector` | `hybrid-ui-api` | Compare UI text vs API response |

Each mutation includes:
- **Prompt patch**: Instructions + code examples injected into agent prompts
- **Scenario overrides**: New test patterns replacing the old approach
- **Rule adjustments**: New rules added/modified for the new strategy
- **Evaluation window**: 3 runs to prove effectiveness
- **Auto-revert**: If failure rate increases by 1.5x → mutation reverted
- **Cooldown**: Reverted concerns get 5-run cooldown before retry

---

## Execution Engine Stack

| Tool | Purpose |
|------|---------|
| Playwright 1.57 | Browser automation, screenshots, traces |
| Vitest | Test runner |
| node-fetch / axios | Direct API calls |
| HAR capture | Network request/response logging |

---

## Anti-Hallucination Safeguards

1. **No AI pass/fail**: Agents generate tests; execution engine determines results
2. **Evidence-backed assertions**: Every assertion must reference a concrete value from execution
3. **Network verification**: API tests capture actual HTTP traffic, not mocked responses
4. **Screenshot evidence**: UI tests capture before/after screenshots for every interaction
5. **State snapshots**: State store is captured at key points via `page.evaluate()`
6. **Idempotent runs**: Tests must not corrupt data; use read-only checks where possible
7. **Timeout guards**: All waits have explicit timeouts with descriptive failure messages

## Trust Architecture

8. **Validation Engine gates execution**: AI-generated tests CANNOT run until they pass non-AI rule checks
9. **Self-Healing prevents blind retries**: Failures are classified → auto-fixed OR escalated, never just retried
10. **Learning DB prevents infinite loops**: If same fix fails 2x on same file, system tries different strategy
11. **Max 3 heal iterations**: After 3 failed auto-heal attempts, system escalates to human review
12. **Strategy mutations are reversible**: Auto-revert within 3 runs if they make things worse
13. **Separation of concerns**: Validation Engine NEVER modifies files (read-only). Self-Healing NEVER changes assertions (only selectors/waits). AI agents NEVER mark pass/fail. Strategy Evolution NEVER bypasses validation.

## Agent Registry (12 agents)

| # | Agent | Type | Implementation |
|---|-------|------|----------------|
| 1 | Feature Understanding | AI | Claude prompt |
| 2 | Test Strategy | AI | Claude prompt |
| 3 | UI Test Generator | AI | Claude prompt |
| 4 | API Test Generator | AI | Claude prompt |
| 5 | State Logic Validator | AI | Claude prompt |
| 6 | Execution Engine | Non-AI | Playwright + Vitest |
| 7 | Consistency Analyzer | AI | Claude prompt |
| 8 | UX Validation | AI | Claude prompt |
| 9 | Report Generator | AI | Claude prompt |
| 10 | Validation Engine | Non-AI | src/engine/validation-engine.ts |
| 11 | Self-Healing Agent | Hybrid | src/engine/self-healing-agent.ts |
| 12 | Strategy Evolution | Non-AI | src/engine/strategy-evolution.ts |
