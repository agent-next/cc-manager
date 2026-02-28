# CC-Manager — Project Instructions

## Project Overview
Multi-agent orchestrator that runs parallel Claude Code agents in git worktrees. Tasks submitted via REST API, monitored via SSE, agents auto-commit and merge to main.

## Architecture
- **v1/src/index.ts** — CLI entry point (Commander.js)
- **v1/src/server.ts** — Hono REST API + SSE
- **v1/src/scheduler.ts** — Task queue, priority dispatch, retry logic, stale worker recovery
- **v1/src/agent-runner.ts** — Multi-agent CLI spawning (Claude, Codex, generic), cost tracking, code review
  - Hybrid architecture: Claude Agent SDK (`claude-sdk`) for programmatic control + CLI spawning for all agents
- **v1/src/worktree-pool.ts** — Git worktree lifecycle, parallel init, merge
- **v1/src/store.ts** — SQLite persistence (better-sqlite3, WAL mode)
- **v1/src/types.ts** — Shared TypeScript types
- **v1/src/logger.ts** — Structured JSON logger
- **v1/src/web/index.html** — Dashboard (vanilla HTML/JS, dark theme)

## Tech Stack
- TypeScript 5 / Node.js ESM
- Agent integration via `child_process.spawn` (supports Claude CLI, Codex CLI, any terminal agent)
- `hono` + `@hono/node-server`
- `better-sqlite3` (WAL mode)
- `commander` for CLI

## Build, Test & Run
```bash
cd v1 && npx tsc && cp src/web/index.html dist/web/index.html
node dist/index.js --repo /path/to/repo --workers 5 --port 8080
```

```bash
# Run tests (66 tests across 5 suites)
cd v1 && node --import tsx --test src/__tests__/*.test.ts
```

## Development Rules
- Always use `.js` extensions in TypeScript imports (ESM)
- Run `npx tsc` after changes to verify compilation
- Only modify core files — do NOT create standalone utility modules
- Core files: server.ts, scheduler.ts, store.ts, agent-runner.ts, worktree-pool.ts, index.ts, types.ts, logger.ts
- Keep changes minimal and focused — one concern per change
- Always `git add -A && git commit` after successful changes

## Agent Flywheel Strategy
The cc-manager improves itself by running agents against its own codebase.

### Proven Best Practices
- **240s timeout** — sweet spot (120s = 80% failure, 180s = occasional timeout)
- **One file per task** — prevents merge conflicts between concurrent agents
- **Simple prompts** — 3-4 sentences max, one clear objective
- **New files > modifications** — creation has ~100% success rate
- **No overlapping edits** — assign different files to concurrent tasks

### Task Quality Rules
- Every task must directly improve cc-manager core functionality
- No creating unused utility modules
- Test compilation (`npx tsc`) in every task
- Prefer additive changes (new methods) over rewrites

## API Endpoints
- `GET /api/stats` — Queue depth, worker count, cost breakdown
- `GET /api/stats/daily` — Daily stats breakdown
- `GET /api/tasks` — List tasks (supports ?status, ?limit, ?offset, ?tag filters)
- `GET /api/tasks/search?q=keyword` — Search tasks by prompt/output
- `GET /api/tasks/errors` — Recent failures
- `GET /api/tasks/:id` — Full task detail (includes queue position)
- `GET /api/tasks/:id/diff` — Git diff for completed task
- `GET /api/tasks/:id/output` — Raw task output
- `POST /api/tasks` — Submit task `{prompt, timeout?, maxBudget?, priority?, tags?, webhookUrl?}`
- `POST /api/tasks/batch` — Submit multiple tasks
- `POST /api/tasks/:id/retry` — Requeue a failed task
- `DELETE /api/tasks/:id` — Cancel pending task
- `DELETE /api/tasks/cleanup?days=30` — Remove old tasks
- `GET /api/workers` — Worker pool status
- `GET /api/events` — SSE stream (task_queued, task_started, task_progress, task_final)
- `GET /api/health` — Health check
- `GET /api/budget` — Budget status
- `GET /api/insights` — Historical performance insights
- `GET /api/evolution/log` — Self-evolution analysis history
- `POST /api/evolution/analyze` — Trigger round analysis `{taskIds: string[]}`
- `GET /api/docs` — API documentation

## Task Lifecycle
```
pending → running → success (branch merged to main)
                  → failed  (branch abandoned, may retry up to maxRetries)
                  → timeout (AbortController fired)
       → cancelled          (removed before worker assigned)
```

## Quality Pyramid (bottom-up)
1. **Agent Quality** — System prompt with tsc check, post-execution build verification, output validation
2. **Code Quality** — Type-safe unions (not bare strings), input validation, global error handling
3. **Module Quality** — Unit tests, BDD specs, transaction support
4. **Integration Quality** — E2E tests, flywheel validation, merge conflict handling
5. **Product Quality** — Dashboard UX, API consistency, real-time updates

## Harness Engineering Principles (from OpenAI, critically adapted)
- **Failures are orchestration problems, not reasoning problems** — focus on harness quality, not model prompting tricks
- **Documentation as executable specification** — CLAUDE.md is the agent's single source of truth, enforced mechanically
- **Fewer general tools > many specialized tools** — agents have bash + files, no tool proliferation
- **Context is a managed resource with budgets** — enforce prompt size limits, token budgets per task
- **Error trace retention** — remember failed approaches, inject anti-patterns into future task context
- **Layered dependency enforcement** — types → store → scheduler → server → dashboard (no reverse imports)
- **NOT copied**: MCP protocol, filesystem-as-memory, logits masking, over-engineered state machines

## Self-Evolution System (R21+)
- **Types**: CodeAnalysis, ReviewResult, EvolutionEntry in types.ts
- **Persistence**: evolution_log table in store.ts (saveEvolution, getEvolutionLog, getLatestEvolution)
- **Analysis**: scheduler.analyzeRound() computes per-round metrics and patterns
- **Review**: AgentRunner.reviewDiff() does heuristic code review on diffs
- **API**: GET /api/evolution/log, POST /api/evolution/analyze

## Long-Term Vision
1. **Self-improving flywheel** — auto-analyze code, generate tasks, execute, review, learn
2. **External review gate** — pluggable reviewer (Codex, Gemini) as quality gate before merge
3. **Smart scheduling** — predict cost/duration from historical data
4. **Dynamic system prompt** — inject CLAUDE.md + error history into agent context
5. **Complete test coverage** — all core modules have BDD-style unit tests
6. **Multi-repo support** — manage agents across multiple repositories

## Flywheel Management (PDCA)
- **Plan**: Each round targets specific quality layer or feature area
- **Do**: 5 agents execute with one-file-per-task isolation
- **Check**: Reflect on success rate, cost, functional value, architectural contribution
- **Act**: Adjust timeout, prompt style, task scope based on data

### Quality Evaluation (not just success rate)
- **Functional value** — Does each task add real capability?
- **Task design** — Is the prompt well-scoped and achievable?
- **Architectural contribution** — Does it improve structure, not just add features?
- **Test coverage** — Are new features tested?
- **Code consistency** — Does the code maintain unified style?
- **Technical debt** — Are we creating debt or paying it down?

## Test Files
- `v1/src/__tests__/store.test.ts` — Store CRUD, search, cleanup, errors (BDD-style)
- `v1/src/__tests__/worktree-pool.test.ts` — WorktreePool lifecycle
- `v1/src/__tests__/scheduler.test.ts` — Submit, cancel, stats, queue position
- `v1/src/__tests__/agent-runner.test.ts` — Cost estimation, code review, system prompt, CLI dispatch
- `v1/src/__tests__/server.test.ts` — API input validation (prompt, timeout, priority, tags, webhookUrl)

## Repository
- **GitHub**: `agent-next/cc-manager` (private)
- **Version**: v0.1.0

## Known Gotchas
- `getDailyStats()` returns `{total, success, cost, successRate}` — do NOT use `count` (old field name, causes silent breakage in dashboard + scheduler)
- Dashboard `esc()` must escape single quotes (`&#39;`) for onclick handlers
- Claude CLI spawning: must clear `CLAUDECODE` and `CLAUDE_CODE_*` env vars to prevent nesting
- `POST /api/tasks` accepts `agent` field: `"claude"` (CLI), `"claude-sdk"` (Agent SDK), `"codex"`, or any CLI command string
- `"claude-sdk"` uses programmatic `query()` API with structured events, AbortController, precise cost tracking
- `"claude"` uses `claude -p --dangerously-skip-permissions --output-format stream-json` CLI spawning
