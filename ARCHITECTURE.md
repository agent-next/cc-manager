# CC-Manager Architecture

## Overview

CC-Manager is a multi-agent orchestrator that runs parallel coding agents in isolated git worktrees. It coordinates task scheduling, agent execution, result merging, and persistence through a layered architecture.

## Module Dependency Graph

```
types.ts          ← Pure types and factory functions (no imports)
    ↓
logger.ts         ← Structured JSON logger (no imports)
    ↓
store.ts          ← SQLite persistence (imports: types, logger)
    ↓
worktree-pool.ts  ← Git worktree lifecycle (imports: types, logger)
    ↓
agent-runner.ts   ← Multi-agent CLI spawning (imports: types, logger)
    ↓
scheduler.ts      ← Task queue + orchestration (imports: types, logger, store, worktree-pool, agent-runner)
    ↓
server.ts         ← HTTP API + SSE (imports: types, logger, scheduler, store, worktree-pool)
    ↓
index.ts          ← CLI entry point (imports: all modules)
```

Dependency rule: arrows point downward only. No reverse imports.

## Core Modules

### types.ts
Shared TypeScript types and the `createTask()` factory function. Zero dependencies — every other module imports from here.

Key types: `Task`, `TaskStatus`, `TaskPriority`, `TaskEvent`, `WorkerInfo`, `Stats`, `EvolutionEntry`, `HarnessConfig`, `RoundSummary`.

### logger.ts
Structured JSON logger with level filtering (`debug`, `info`, `warn`, `error`). Errors route to stderr, everything else to stdout. Configured via `setLogLevel()`.

### store.ts
SQLite persistence using `better-sqlite3` in WAL mode. Manages the `tasks` and `evolution_log` tables with automatic schema migration.

Key operations: `saveTask()`, `getTask()`, `getTasks()`, `searchTasks()`, `getDailyStats()`, `getPerformanceMetrics()`, `saveEvolution()`.

Database file: `.cc-manager.db` in the repository root (gitignored).

### worktree-pool.ts
Manages git worktree lifecycle. On init, creates `.worktrees/worker-{N}` directories each on a `worker/worker-{N}` branch.

Key operations:
- `init()` — parallel worktree creation via `git worktree add`
- `acquire()` — claim an idle worktree, hard-reset to `main`
- `release()` — free a worktree back to the pool
- `merge()` — `git merge --no-edit` from worker branch to main (conflict-safe)

### agent-runner.ts
Spawns coding agents as child processes and parses their output. Supports three dispatch modes:

| Agent | CLI | Output format |
|-------|-----|---------------|
| `claude` | `claude -p --output-format stream-json` | stream-json events |
| `codex` | `codex exec --json` | JSON result |
| Generic | Any command with prompt as arg | Raw stdout |

Also provides:
- `buildSystemPrompt()` — context-aware prompt with CLAUDE.md injection, tsc checks, scope hints
- `reviewDiff()` — heuristic code review scoring
- `estimateCost()` — token-based cost calculation
- `verifyBuild()` — post-execution tsc compilation check

### scheduler.ts
Priority-based task queue with dispatch loop. Coordinates between the pool, runner, and store.

Flow:
1. `submit()` → validate, enqueue by priority, persist to store
2. `loop()` → await idle worker, dequeue highest-priority task
3. `executeTask()` → acquire worktree, spawn agent, stream events
4. On completion → merge branch, update store, fire SSE events

Features: retry logic (up to `maxRetries`), stale worker recovery (60s interval), total budget enforcement, dependency resolution (`dependsOn`), webhook notifications.

### server.ts
Hono-based HTTP server with 20+ REST endpoints and SSE streaming. Includes rate limiting (30 req/min per IP) and CORS.

Routes map directly to scheduler and store operations. SSE clients receive `task_queued`, `task_started`, `task_progress`, and `task_final` events.

### index.ts
Commander.js CLI entry point. Parses flags, validates inputs, wires modules together, and handles graceful shutdown (SIGINT/SIGTERM).

### web/index.html
Single-file vanilla HTML/JS dashboard. Dark/light theme, SSE-based real-time updates, task submission form, cost charts, daily stats. XSS-hardened with escaping on all interpolated values.

## Data Flow

### Task Submission
```
Client → POST /api/tasks → server.ts → scheduler.submit()
  → store.saveTask() → queue.push() → SSE: task_queued
```

### Task Execution
```
scheduler.loop() → pool.acquire(worker) → runner.run(task, cwd)
  → spawn(agent CLI) → parse stdout → SSE: task_progress
  → runner.verifyBuild() → pool.merge(worker, main)
  → store.saveTask() → SSE: task_final
```

### Error Recovery
```
scheduler.recoverStaleWorkers() [every 60s]
  → check for workers busy > task.timeout × 2
  → force release worker, mark task failed
```

## Concurrency Model

- **Worker pool**: Fixed-size array of worktrees, each exclusively locked during task execution
- **Task queue**: In-memory array sorted by priority, persisted to SQLite on every state change
- **Agent processes**: Each task gets one `child_process.spawn`, killed on timeout via `AbortController`
- **SSE**: Fan-out broadcast to all connected clients via `Set<callback>`
- **SQLite**: WAL mode handles concurrent reads; writes are serialized by Node.js event loop

## Security

- XSS: All user-controlled values escaped before innerHTML insertion (esc() with &, <, >, ", ')
- Rate limiting: 30 requests/minute per IP on mutation endpoints
- Input validation: Prompt length, timeout bounds, budget caps, port range
- Agent isolation: Each agent runs in a separate worktree with its own branch
- Claude nesting prevention: `CLAUDECODE` and `CLAUDE_CODE_*` env vars cleared when spawning
