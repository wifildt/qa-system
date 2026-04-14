# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
npm run qa                    # Run CLI: tsx bin/qa-cli.ts
npm run dev                   # Watch mode: tsx watch src/index.ts
npm run typecheck             # tsc --noEmit

# Build
npm run build                 # tsc → dist/

# Test & Lint
npm run test                  # vitest run
npm run lint                  # eslint src/

# CLI commands (via tsx)
npx tsx bin/qa-cli.ts detect <repo-path>
npx tsx bin/qa-cli.ts validate --config <path>
npx tsx bin/qa-cli.ts run --config <path>
npx tsx bin/qa-cli.ts heal <results.json>
npx tsx bin/qa-cli.ts experience --stats
npx tsx bin/qa-cli.ts experience --query selector,modal
npx tsx bin/qa-cli.ts evolve --report
```

## Module Conventions

**ESM with .js extensions in .ts imports** — this is strict. TypeScript compiles `.ts` → `.js` and preserves import paths as-is.

```typescript
// CORRECT
import { ExperienceLibrary } from './engine/experience-library.js';

// WRONG — will fail at runtime
import { ExperienceLibrary } from './engine/experience-library';
```

tsconfig: `module: "ESNext"`, `target: "ES2022"`, `moduleResolution: "bundler"`, `strict: true`.

## Architecture

Self-learning multi-agent QA framework. 9 engine modules form a feedback loop:

```
Experience Library ←──────────────────────────────┐
    │                                              │
    ├→ Prompt Evolution (inject lessons into AI)   │
    ├→ Strategy Evolution (mutate test approach)   │
    └→ Rule Scoring (prune rules + agents)         │
                                                   │
Validation Engine (block bad tests, non-AI)        │
    ↓                                              │
Execution Engine (Playwright/Vitest)               │
    ↓                                              │
Self-Healing Agent (diagnose → auto-fix/regen)     │
    ↓                                              │
Experience Extractor (raw results → curated) ──────┘
```

Supporting modules:
- **Convention Detector** — auto-detects 15 conventions from any npm repo
- **Project Adapter** — normalizes any project config into standard API

## Key Design Decisions

**Validation Engine is non-AI**: Parses test code with regex rules, returns violations. Never modifies files. This is the trust anchor — AI-generated tests cannot execute until they pass deterministic checks.

**Self-Healing never changes assertions**: Only fixes selectors, waits, and auth. If an assertion is wrong, it escalates to AI regeneration. Learning DB prevents infinite loops (same fix fails 2x → skip).

**Experience Library is curated, not a log dump**: 4 categories (failure_pattern, fix_strategy, anti_pattern, feature_knowledge). Confidence decays 0.2%/day. Max 500 entries with eviction. Dedup via Jaccard similarity >= 0.7.

**Strategy Evolution is reversible**: Mutations auto-revert if failure rate increases >1.5x within 3 runs. Max 3 active mutations. Recently reverted concerns get 5-run cooldown.

**Rule Scoring auto-prunes**: Rules with precision <20% after 10 triggers get demoted. Below 10% after 20 triggers → disabled. Agents with 0 actionable findings after 5 runs → disabled.

## Engine Data Flow

Each engine reads/writes JSON databases in `qa-system/`:

| Engine | Reads | Writes |
|--------|-------|--------|
| Validation Engine | test files + rules/*.json | validation-report.json |
| Self-Healing Agent | execution-results.json + learning-db.json | healing-report.json, learning-db.json |
| Experience Extractor | execution/healing/validation reports | experience-db.json |
| Prompt Evolution | experience-db.json + base prompts | .evolved/ prompts |
| Strategy Evolution | experience-db.json | strategy-evolution-db.json |
| Rule Scoring | feedback from pipeline | rule-scores.json |

## Runtime Data Files (gitignored)

`experience-db.json`, `learning-db.json`, `rule-scores.json`, `strategy-evolution-db.json` — these accumulate across runs. Deleting them resets the learning state.

## Adding a New Engine

1. Create `src/engine/<name>.ts` — class or function, loads/saves from JSON file
2. Export from `src/index.ts`
3. Add CLI command in `bin/qa-cli.ts` (use lazy `await import()`)
4. Add runtime DB filename to `.gitignore` if applicable
