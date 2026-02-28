# CC-Manager

[![CI](https://github.com/agent-next/cc-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/agent-next/cc-manager/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> I need a Boris.

A multi-agent orchestrator that runs parallel coding agents in git worktrees. Supports Claude Agent SDK, Claude CLI, Codex CLI, and any terminal agent. Submit tasks via REST API, monitor in real-time via SSE, and agents auto-commit and merge to `main`.

```
┌─────────────┐     POST /api/tasks     ┌─────────────────┐
│   Client    │ ──────────────────────► │   Hono Server   │
│  (web/API)  │ ◄── SSE /api/events ─── │   (port 8080)   │
└─────────────┘                         └────────┬────────┘
                                                 │
                                        ┌────────▼────────┐
                                        │    Scheduler    │
                                        │ (priority queue)│
                                        └────────┬────────┘
                          ┌─────────────┬────────┴────────┬─────────────┐
                   ┌──────▼──────┐ ┌────▼────────┐ ┌──────▼──────┐    ...
                   │  Worker 0   │ │  Worker 1   │ │  Worker 2   │
                   │ (worktree)  │ │ (worktree)  │ │ (worktree)  │
                   │ Claude CLI  │ │  Codex CLI  │ │ Any Agent   │
                   └──────┬──────┘ └──────┬──────┘ └──────┬──────┘
                          └───────────────┴───────────────┘
                                          │ git merge → main
                                   ┌──────▼──────┐
                                   │   SQLite    │
                                   │    store    │
                                   └─────────────┘
```

## Features

- **Multi-agent support** — use Claude Code, OpenAI Codex, or any terminal CLI as workers
- **Parallel execution** — run up to 20 agents simultaneously, each in an isolated git worktree
- **REST API** — 20+ endpoints for task management, stats, search, and batch operations
- **Real-time streaming** — track task lifecycle via Server-Sent Events (SSE)
- **Auto-commit & merge** — agents commit work and successful branches merge back to `main`
- **SQLite persistence** — full task history with cost, tokens, duration, events, and daily stats
- **Web dashboard** — built-in dark/light theme UI with real-time updates
- **Budget controls** — per-task and total spend limits in USD
- **Priority queue** — urgent/high/normal/low task priorities with retry logic
- **Self-evolution** — built-in round analysis, code review, and improvement tracking
- **Structured logging** — JSON logs with debug/info/warn/error levels

## Prerequisites

- **Node.js 20+**
- **git**
- At least one agent CLI installed:
  - **Claude Code** (`claude` CLI) — set `ANTHROPIC_API_KEY`
  - **Codex** (`codex` CLI) — set `OPENAI_API_KEY`
  - Or any CLI that accepts a prompt as argument

## Installation

```bash
npm install -g cc-manager
```

Or run from source:

```bash
cd v1 && npm install && npx tsc
node dist/index.js --repo /path/to/repo
```

## Quick Start

```bash
# Start with Claude (default)
cc-manager --repo /path/to/your/repo

# Start with Codex
cc-manager --repo /path/to/repo --agent codex

# Start with a custom agent
cc-manager --repo /path/to/repo --agent "aider --yes"

# Submit a task
curl -X POST http://localhost:8080/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Add input validation to the login form"}'

# Submit a task to a specific agent
curl -X POST http://localhost:8080/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Fix the auth bug", "agent": "codex"}'
```

## Configuration

| Flag | Default | Description |
|------|---------|-------------|
| `--repo <path>` | *(required)* | Path to the git repository |
| `--workers <n>` | `10` | Parallel workers (1-20) |
| `--port <n>` | `8080` | HTTP server port |
| `--timeout <s>` | `300` | Per-task timeout in seconds |
| `--budget <usd>` | `5` | Max spend per task in USD |
| `--model <id>` | `claude-sonnet-4-6` | Model ID for Claude agents |
| `--agent <cmd>` | `claude` | Default agent CLI (`claude`, `codex`, or any command) |
| `--system-prompt <text>` | — | System prompt for all agents |
| `--system-prompt-file <path>` | — | Load system prompt from file (overrides `--system-prompt`) |
| `--total-budget <usd>` | `0` | Total spend limit across all tasks (0 = unlimited) |
| `--verbose` | — | Enable debug-level logging |
| `--quiet` | — | Only show errors |

## API

### Task Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/tasks` | Submit a task |
| `POST` | `/api/tasks/batch` | Submit multiple tasks |
| `GET` | `/api/tasks` | List tasks (`?status`, `?limit`, `?offset`, `?tag`) |
| `GET` | `/api/tasks/search?q=keyword` | Search tasks by prompt/output |
| `GET` | `/api/tasks/errors` | Recent failures |
| `GET` | `/api/tasks/:id` | Full task detail with queue position |
| `GET` | `/api/tasks/:id/diff` | Git diff for completed task |
| `GET` | `/api/tasks/:id/output` | Raw task output |
| `POST` | `/api/tasks/:id/retry` | Requeue a failed task |
| `DELETE` | `/api/tasks/:id` | Cancel a pending task |
| `DELETE` | `/api/tasks/cleanup?days=30` | Remove old completed tasks |

### Monitoring

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/stats` | Queue depth, workers, cost breakdown |
| `GET` | `/api/stats/daily` | Daily stats (total, success, cost) |
| `GET` | `/api/workers` | Worker pool status |
| `GET` | `/api/events` | SSE stream |
| `GET` | `/api/health` | Health check |
| `GET` | `/api/budget` | Budget status and remaining spend |
| `GET` | `/api/insights` | Historical performance metrics |

### Self-Evolution

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/evolution/log` | Evolution analysis history |
| `POST` | `/api/evolution/analyze` | Trigger round analysis |
| `GET` | `/api/docs` | API documentation |

### POST /api/tasks body

```json
{
  "prompt": "Refactor the auth module to use JWT",
  "timeout": 300,
  "maxBudget": 5,
  "priority": "high",
  "tags": ["auth", "refactor"],
  "agent": "claude",
  "webhookUrl": "https://example.com/hook"
}
```

### SSE events on GET /api/events

| Event | When |
|-------|------|
| `task_queued` | Task accepted into queue |
| `task_started` | Worker assigned, agent running |
| `task_progress` | Agent output streaming |
| `task_final` | Completed (success/failed/timeout) |

## Multi-Agent Architecture

CC-Manager supports four agent dispatch modes:

- **Claude Agent SDK** (`claude-sdk`) — programmatic control via `@anthropic-ai/claude-agent-sdk`, with structured events, AbortController support, and token-level cost tracking
- **Claude CLI** (`claude`) — `claude -p --output-format stream-json` with budget controls
- **Codex CLI** (`codex`) — `codex exec --json` with sandbox bypass for automation
- **Generic** — any CLI command that accepts a prompt argument; output captured from stdout

Each task can specify which agent to use via the `agent` field. The `--agent` flag sets the default.

## Task Lifecycle

```
pending → running → success  (branch merged to main)
                 → failed    (branch abandoned, may retry)
                 → timeout   (process killed)
       → cancelled           (removed before assignment)
```

## Project Structure

```
cc-manager/
├── v1/
│   ├── src/
│   │   ├── index.ts           # CLI entry point (Commander.js)
│   │   ├── scheduler.ts       # Priority queue, retry, budget enforcement
│   │   ├── agent-runner.ts    # Multi-agent CLI spawning + code review
│   │   ├── worktree-pool.ts   # Git worktree lifecycle
│   │   ├── server.ts          # Hono REST API + SSE
│   │   ├── store.ts           # SQLite persistence (better-sqlite3)
│   │   ├── types.ts           # Shared TypeScript types
│   │   ├── logger.ts          # Structured JSON logger with levels
│   │   ├── web/index.html     # Dashboard (dark/light theme)
│   │   └── __tests__/         # BDD-style test suites (71 tests)
│   ├── package.json
│   └── tsconfig.json
└── CLAUDE.md                  # Agent instructions & project spec
```

## Tech Stack

| Component | Library |
|-----------|---------|
| Web server | `hono` + `@hono/node-server` |
| Database | `better-sqlite3` (WAL mode) |
| CLI | `commander` |
| Language | TypeScript 5 / Node.js ESM |
| Agent integration | `@anthropic-ai/claude-agent-sdk` + `child_process.spawn` |

## License

MIT
