# QA Agent Framework

Self-learning, multi-agent QA framework for frontend applications.

Drop any frontend repo → auto-detect conventions → generate tests → execute → self-heal → learn.

## Quick Start

```bash
# In your frontend project
npx qa-agent-framework init
npx qa-agent-framework detect .
# → edit qa-system/project.config.json (add auth, features)
npx qa-agent-framework validate
npx qa-agent-framework run
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
    │          └──────────────┘        │
    └──────────────────────────────────┘
```

## 11 Agents

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

## 3 Feedback Loops

**Loop 1 — Enforcement**: AI generates test → Validation Engine parses → BLOCK or PASS

**Loop 2 — Self-Healing**: Test fails → classify → auto-fix (selector/timeout/auth) → re-run. Can't fix? → queue for AI regen. Same fix failed 2x? → learning DB skips it.

**Loop 3 — Learning**: Run completes → Experience Extractor → curated insights → Experience Library → Prompt Evolution injects lessons into next run's AI prompts.

## Experience Library

NOT a log dump. 4 categories of curated knowledge:

| Category | Example |
|----------|---------|
| Failure Pattern | "button not clickable after modal" → z-index overlay |
| Fix Strategy | "wait for modal close before click" (effectiveness: 80%) |
| Anti-Pattern | "CSS class selector in test" → always breaks on style change |
| Feature Knowledge | "dirty guard missing in section 4.1" → data loss risk |

Confidence scores decay 0.2%/day. Max 500 entries with eviction.

## Multi-Repo

```bash
# Auto-detect any frontend repo
npx qa-agent-framework detect /path/to/any-repo
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
| `qa validate` | Validate test files against quality rules |
| `qa run` | Full pipeline: validate → execute → heal → learn |
| `qa heal <results.json>` | Self-heal from execution results |
| `qa experience --stats` | View experience library stats |
| `qa experience --query selector,modal` | Search experiences by tags |

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
├── bin/qa-cli.ts                  CLI entry point
├── src/
│   ├── index.ts                   Public API exports
│   ├── engine/
│   │   ├── convention-detector.ts Auto-detect repo conventions
│   │   ├── project-adapter.ts     Normalize config for agents
│   │   ├── validation-engine.ts   Non-AI rule enforcement
│   │   ├── self-healing-agent.ts  Auto-fix + learning DB
│   │   ├── experience-library.ts  Structured memory (4 categories)
│   │   ├── experience-extractor.ts Raw data → curated insights
│   │   ├── prompt-evolution.ts    Evolve prompts from experience
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
