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

## How It Works

1. **Task submission** — clients POST a natural-language prompt to the API
2. **Worker assignment** — the scheduler picks an idle worker and resets its worktree to `main`
3. **Agent execution** — Claude Code runs inside the isolated worktree with `bypassPermissions`, up to 50 turns
4. **Auto-commit** — each agent is instructed to `git add -A && git commit` before finishing
5. **Auto-merge** — on success, the worker branch is merged back to `main`; on conflict, the merge is skipped
6. **Persistence** — all task metadata (cost, tokens, duration, events) is saved to SQLite

## Quick Start

```bash
cd v1
npm install
npm run build
node dist/index.js --repo /path/to/your/repo
```

For development (no build step):
```bash
npm run dev -- --repo /path/to/your/repo
```

Open the dashboard at **http://localhost:8080**

## CLI Options

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
node dist/index.js \
  --repo ~/projects/my-app \
  --workers 5 \
  --port 3000 \
  --timeout 600 \
  --budget 2 \
  --model claude-opus-4-5
```

## API Reference

### Stats

```
GET /api/stats
```
Returns queue depth, active worker count, and cost breakdown by task status.

### Tasks

```
GET  /api/tasks          # List all tasks (recent first)
GET  /api/tasks/:id      # Full task detail including event log
POST /api/tasks          # Submit a new task
DELETE /api/tasks/:id    # Cancel a pending task
```

**POST /api/tasks** body:
```json
{
  "prompt": "Refactor the auth module to use JWT",
  "timeout": 300,
  "maxBudget": 5
}
```

**Response:**
```json
{
  "id": "a1b2c3d4",
  "status": "pending",
  "prompt": "...",
  "createdAt": "2025-01-01T00:00:00.000Z"
}
```

### Workers

```
GET /api/workers         # Worker pool status (name, path, branch, busy, currentTask)
```

### Real-time Events

```
GET /api/events          # Server-Sent Events stream
```

Emits JSON events as tasks move through their lifecycle:

| Event type | When |
|------------|------|
| `task_queued` | Task accepted into queue |
| `task_started` | Worker assigned, agent running |
| `task_final` | Task completed (success / failed / timeout) |

**Example client:**
```js
const es = new EventSource('http://localhost:8080/api/events');
es.onmessage = (e) => {
  const event = JSON.parse(e.data);
  console.log(event.type, event.taskId, event.status);
};
```

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
├── docs/
│   └── AGENT-FLYWHEEL-DESIGN.md   # V2 vision: autonomous agent swarms
├── tests/                     # Pytest + shell integration tests
├── setup.sh                   # One-click environment bootstrap
└── manager.py                 # Legacy Python prototype (V0)
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
