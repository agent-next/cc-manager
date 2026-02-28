# CC-Manager

A multi-agent orchestrator that runs multiple Claude Code agents in parallel using git worktrees. Submit tasks via REST API, monitor progress in real-time via SSE, and let agents auto-commit and merge their work back to `main`.

```
┌─────────────┐     POST /api/tasks     ┌─────────────────┐
│   Client    │ ──────────────────────► │   Hono Server   │
│  (web/API)  │ ◄── SSE /api/events ─── │   (port 8080)   │
└─────────────┘                         └────────┬────────┘
                                                 │
                                        ┌────────▼────────┐
                                        │    Scheduler    │
                                        │  (FIFO queue)   │
                                        └────────┬────────┘
                          ┌─────────────┬────────┴────────┬─────────────┐
                   ┌──────▼──────┐ ┌────▼────────┐ ┌──────▼──────┐    ...
                   │  Worker 0   │ │  Worker 1   │ │  Worker 2   │
                   │ (worktree)  │ │ (worktree)  │ │ (worktree)  │
                   │ Claude Code │ │ Claude Code │ │ Claude Code │
                   └──────┬──────┘ └──────┬──────┘ └──────┬──────┘
                          └───────────────┴───────────────┘
                                          │ git merge → main
                                   ┌──────▼──────┐
                                   │   SQLite    │
                                   │    store    │
                                   └─────────────┘
```

## Features

- **Parallel execution** — run up to N Claude Code agents simultaneously, each in an isolated git worktree
- **REST API** — submit, list, cancel, and inspect tasks over HTTP
- **Real-time streaming** — track task lifecycle events via Server-Sent Events (SSE)
- **Auto-commit & merge** — agents commit their work and successful branches are merged back to `main` automatically
- **SQLite persistence** — full task history with cost, token counts, duration, and event logs
- **Web dashboard** — built-in browser UI at `http://localhost:8080`
- **Per-task budgets** — configurable USD spend cap and timeout per task
- **Conflict-safe** — merge conflicts are detected and skipped gracefully; the task is still marked successful

## Prerequisites

- **Node.js 20+**
- **git**
- **`ANTHROPIC_API_KEY`** environment variable set to a valid Anthropic API key

## Installation

```bash
npm install -g cc-manager
```

## Quick Start

```bash
# 1. Set your API key
export ANTHROPIC_API_KEY=sk-ant-...

# 2. Start the server against your repo
cc-manager --repo /path/to/your/repo

# 3. Submit a task
curl -X POST http://localhost:8080/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Add input validation to the login form"}'
```

## Configuration

All flags can be passed to the `cc-manager` CLI (or `node dist/index.js` when running from source):

| Flag | Default | Description |
|------|---------|-------------|
| `--repo <path>` | *(required)* | Path to the git repository to operate on |
| `--workers <n>` | `10` | Number of parallel Claude Code workers |
| `--port <n>` | `8080` | HTTP server port |
| `--timeout <s>` | `300` | Per-task timeout in seconds |
| `--budget <usd>` | `5` | Max spend per task in USD (0 = unlimited) |
| `--model <id>` | `claude-sonnet-4-6` | Claude model ID |
| `--system-prompt <text>` | — | System prompt prepended to every agent session |

**Example:**
```bash
cc-manager \
  --repo ~/projects/my-app \
  --workers 5 \
  --port 3000 \
  --timeout 600 \
  --budget 2 \
  --model claude-opus-4-5
```

## API Overview

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/stats` | Queue depth, active workers, and cost breakdown by status |
| `GET` | `/api/tasks` | List all tasks, most recent first |
| `GET` | `/api/tasks/:id` | Full task detail including event log |
| `POST` | `/api/tasks` | Submit a new task with a natural-language prompt |
| `DELETE` | `/api/tasks/:id` | Cancel a pending task |
| `GET` | `/api/workers` | Worker pool status (name, path, branch, busy, currentTask) |
| `GET` | `/api/events` | Server-Sent Events stream for real-time task lifecycle events |

**POST /api/tasks** body:
```json
{
  "prompt": "Refactor the auth module to use JWT",
  "timeout": 300,
  "maxBudget": 5
}
```

SSE events emitted on `GET /api/events`:

| Event type | When |
|------------|------|
| `task_queued` | Task accepted into queue |
| `task_started` | Worker assigned, agent running |
| `task_final` | Task completed (success / failed / timeout) |

## Dashboard

Open **http://localhost:8080** in your browser after starting the server. The built-in web UI shows the live task queue, per-worker status, real-time event logs, and cost/token summaries — no extra setup required.

## How It Works

1. **Task submission** — clients POST a natural-language prompt to the API
2. **Worker assignment** — the scheduler picks an idle worker and resets its worktree to `main`
3. **Agent execution** — Claude Code runs inside the isolated worktree with `bypassPermissions`, up to 50 turns
4. **Auto-commit** — each agent is instructed to `git add -A && git commit` before finishing
5. **Auto-merge** — on success, the worker branch is merged back to `main`; on conflict, the merge is skipped
6. **Persistence** — all task metadata (cost, tokens, duration, events) is saved to SQLite

## Project Structure

```
cc-manager/
├── v1/                        # TypeScript application
│   ├── src/
│   │   ├── index.ts           # CLI entry point (Commander.js)
│   │   ├── scheduler.ts       # Task queue & worker orchestration
│   │   ├── agent-runner.ts    # Claude Agent SDK integration
│   │   ├── worktree-pool.ts   # Git worktree lifecycle management
│   │   ├── server.ts          # Hono REST API + SSE server
│   │   ├── store.ts           # SQLite persistence (better-sqlite3)
│   │   ├── types.ts           # Shared TypeScript types
│   │   └── web/index.html     # Web dashboard
│   ├── package.json
│   └── tsconfig.json
└── docs/
    └── AGENT-FLYWHEEL-DESIGN.md   # V2 vision: autonomous agent swarms
```

## Tech Stack

| Component | Library |
|-----------|---------|
| Agent runtime | `@anthropic-ai/claude-agent-sdk` |
| Web server | `hono` + `@hono/node-server` |
| Database | `better-sqlite3` (WAL mode) |
| CLI | `commander` |
| Language | TypeScript 5 / Node.js ESM |

## Task Lifecycle

```
pending → running → success  (branch merged to main)
                 → failed    (branch abandoned)
                 → timeout   (AbortController fired)
       → cancelled           (removed before worker assigned)
```

Each completed task records: output, error, cost (USD), token counts (input/output), duration (ms), and a full event log.

## Worktree Isolation

On startup, CC-Manager creates `.worktrees/worker-{N}` directories — one per worker — each on its own `worker/worker-{N}` branch. Before each task:

1. The worktree is hard-reset to `main`
2. The agent runs with that worktree as its `cwd`
3. On success, the branch is merged back to `main` with `git merge --no-edit`
4. On merge conflict, the merge is aborted and the task is still marked successful

The `.worktrees/` directory and `.cc-manager.db` are gitignored.

## License

MIT
