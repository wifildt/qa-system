# @ldtdev/qa-system

Self-learning QA framework for frontend applications.

Drop any frontend repo → detect conventions → generate tests → validate → execute → self-heal → learn → evolve strategy.

## Prerequisites

- Node.js >= 20
- [Claude Code CLI](https://claude.ai/code) (for `qa generate` / `qa run`)
- Playwright (installed automatically)

## Quick Start

```bash
# Install globally
npm install -g @ldtdev/qa-system

# In your frontend project
cd my-frontend-app
qa init
qa detect .
# → edit qa-system/project.config.json (add auth accounts, features, entry URLs)

# Full pipeline (generate → validate → execute → heal → learn → evolve)
qa run --config qa-system/project.config.json

# Or best quality
qa run --config qa-system/project.config.json --model opus
```

## Architecture

```
               ┌──────────────┐
               │ ORCHESTRATOR │
               └──────┬───────┘
                      │
         ┌────────────┼────────────┐
         │     EXPERIENCE LIBRARY  │  ← learns from every run
         └────────────┬────────────┘
                      │
    ┌─────────────────┼─────────────────┐
    │                 │                 │
  UNDERSTAND      GENERATE           ANALYZE
  (AI agents)     (AI agents)        (AI agents)
    │                 │                 │
    │          ┌──────v───────┐        │
    │          │  VALIDATION  │        │
    │          │  ENGINE      │← BLOCKS bad tests
    │          └──────┬───────┘        │
    │                 │                │
    │          ┌──────v───────┐        │
    │          │  EXECUTION   │        │
    │          │  ENGINE      │← Playwright + Vitest
    │          └──────┬───────┘        │
    │                 │                │
    │          ┌──────v───────┐        │
    │          │ SELF-HEALING │        │
    │          │ AGENT        │← auto-fixes selectors/timeouts
    │          └──────┬───────┘        │
    │                 │                │
    │          ┌──────v───────┐        │
    │          │  EXPERIENCE  │        │
    │          │  EXTRACTOR   │← curates insights, not logs
    │          └──────┬───────┘        │
    │                 │                │
    │          ┌──────v───────┐        │
    │          │  STRATEGY    │        │
    │          │  EVOLUTION   │← mutates test approach
    │          └──────────────┘        │
    └──────────────────────────────────┘
```

## 12 Agents

| # | Agent | Type | Purpose |
|---|-------|------|---------|
| 1 | Feature Understanding | AI | Reads code, maps features |
| 2 | Test Strategy | AI | Generates test plan |
| 3 | UI Test Generator | AI | Playwright tests |
| 4 | API Test Generator | AI | HTTP contract tests |
| 5 | State Logic Validator | AI | Redux/store validation |
| 6 | Execution Engine | Non-AI | Runs tests |
| 7 | Consistency Analyzer | AI | Cross-layer mismatch detection |
| 8 | UX Validation | AI | Usability audit |
| 9 | Report Generator | AI | HTML/JSON reports |
| 10 | **Validation Engine** | **Non-AI** | **Blocks bad tests (10 rules)** |
| 11 | **Self-Healing Agent** | **Hybrid** | **Auto-fixes + learns** |
| 12 | **Strategy Evolution** | **Non-AI** | **Mutates test approach based on failure patterns** |

## 4 Feedback Loops

**Loop 1 — Enforcement**: AI generates test → Validation Engine parses → BLOCK or PASS

**Loop 2 — Self-Healing**: Test fails → classify → auto-fix (selector/timeout/auth) → re-run. Can't fix? → queue for AI regen. Same fix failed 2x? → learning DB skips it.

**Loop 3 — Learning**: Run completes → Experience Extractor → curated insights → Experience Library → Prompt Evolution injects lessons into next run's AI prompts.

**Loop 4 — Strategy Evolution**: Failure patterns cross threshold (5+ occurrences, 60%+ confidence) → system switches testing approach entirely. Mutations are reversible — auto-revert if failure rate increases within 3 runs.

| Failure Pattern | Strategy Mutation |
|---|---|
| Selector flaky | `dom-selector` → `api-first` |
| Async race conditions | `dom-selector` → `state-driven` |
| Auth token expired | `dom-selector` → `network-interception` |
| Network errors | `dom-selector` → `contract-testing` |
| Cross-layer mismatch | `dom-selector` → `hybrid-ui-api` |

## Experience Library

NOT a log dump. 4 categories of curated knowledge:

| Category | Example |
|----------|---------|
| Failure Pattern | "button not clickable after modal" → z-index overlay |
| Fix Strategy | "wait for modal close before click" (effectiveness: 80%) |
| Anti-Pattern | "CSS class selector in test" → always breaks on style change |
| Feature Knowledge | "dirty guard missing in section 4.1" → data loss risk |

Confidence scores decay 0.5%/day. Single-use experiences decay 2x faster. Max 500 entries with eviction.

Run 1 uses base prompts only. Run 2+ injects experience + strategy mutations into generate prompts automatically.

## Multi-Repo

```bash
# Auto-detect any frontend repo
qa detect /path/to/any-repo
# → generates project.config.json

# Presets for common stacks
presets/react-redux/    # Redux + Saga/Thunk
presets/nextjs/         # App Router + Server Components
presets/vue-pinia/      # Vue 3 + Pinia
```

Convention Detector auto-detects 15 properties: framework, bundler, UI library, state management, routing, API client, styling, test runner, form library, i18n, file naming, language, package manager.

## CLI Commands

| Command | Description |
|---------|-------------|
| `qa init` | Create qa-system/ in current project |
| `qa detect <path>` | Auto-detect conventions, generate config |
| `qa generate` | Generate tests via Claude Code CLI |
| `qa validate` | Validate test files against quality rules |
| `qa run` | Full pipeline: generate → validate → execute → heal → learn → evolve |
| `qa run --skip-generate` | Skip AI generation, run from validate onwards |
| `qa heal <results.json>` | Self-heal from execution results |
| `qa experience --stats` | View experience library stats |
| `qa evolve --report` | View mutation history + baseline failure rates |

**Model options:** Default `sonnet/high`. For best quality: `qa run --model opus`

## Project Config

Single file drives the entire system:

```json
{
  "project": { "name": "My App", "root": "/path/to/repo", "src_dir": "src" },
  "framework": { "name": "react", "ui_library": "antd", "styling": "styled-components" },
  "state": { "manager": "redux-toolkit", "side_effects": "redux-saga" },
  "api": { "base_url": "https://api.example.com", "version_prefix": "/v3" },
  "auth": {
    "type": "bearer",
    "accounts": {
      "admin": { "credentials": { "username": "admin@test.com", "password": "..." } }
    }
  },
  "features": [
    { "name": "Dashboard", "pages_glob": ["pages/Dashboard/**"], "entry_url": "/dashboard" }
  ]
}
```

## Directory Structure

```
qa-agent-framework/
├── bin/qa-cli.ts                  CLI entry point (8 commands)
├── src/
│   ├── index.ts                   Public API exports
│   ├── engine/
│   │   ├── claude-code-runner.ts  AI integration via Claude Code CLI
│   │   ├── convention-detector.ts Auto-detect repo conventions
│   │   ├── project-adapter.ts     Normalize config for agents
│   │   ├── validation-engine.ts   Non-AI rule enforcement
│   │   ├── self-healing-agent.ts  Auto-fix + learning DB
│   │   ├── experience-library.ts  Structured memory (4 categories)
│   │   ├── experience-extractor.ts Raw data → curated insights
│   │   ├── prompt-evolution.ts    Evolve prompts from experience
│   │   ├── strategy-evolution.ts  Mutate test approach from failure patterns
│   │   ├── paths.ts               Portable path resolution (dev + dist + npm)
│   │   └── rule-scoring.ts        Rule precision + agent pruning
│   ├── agents/                    Agent definitions (JSON schemas)
│   ├── rules/                     Validation rules (5 sets, 38 rules)
│   └── prompts/                   Universal prompt templates
├── presets/                       Framework presets
│   ├── react-redux/
│   ├── nextjs/
│   └── vue-pinia/
└── examples/
    └── scn-homeroom/              Full working example
```

## License

MIT
