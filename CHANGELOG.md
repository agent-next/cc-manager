# Changelog

All notable changes to this project will be documented in this file.

## [v0.1.0] - 2026-02-28

### Added

- **Multi-agent support** — use Claude Code, Codex, or any terminal CLI agent as workers
  - `--agent` CLI flag to set default agent (`claude`, `codex`, or any command)
  - Per-task `agent` field in POST /api/tasks
  - CLI-based spawning via `child_process.spawn` with stream-json output parsing
- **Priority queue** — tasks support `urgent`, `high`, `normal`, `low` priorities
- **Batch operations** — POST /api/tasks/batch for submitting multiple tasks
- **Task retry** — POST /api/tasks/:id/retry to requeue failed tasks
- **Task search** — GET /api/tasks/search?q=keyword across prompts and output
- **Task filtering** — ?status, ?limit, ?offset, ?tag query parameters
- **Budget controls** — per-task `maxBudget` and global `--total-budget` limit
- **System prompt from file** — `--system-prompt-file` flag (overrides `--system-prompt`)
- **Structured logging** — JSON logs with debug/info/warn/error levels, `--verbose`/`--quiet` flags
- **Daily stats** — GET /api/stats/daily with total, success count, cost per day
- **Budget API** — GET /api/budget for remaining spend tracking
- **Performance insights** — GET /api/insights with duration percentiles, success rates
- **Self-evolution system** — round analysis, code review heuristics, evolution log
- **Dashboard improvements** — dark/light theme, agent column, Promise.allSettled resilience
- **XSS hardening** — all user-controlled values escaped in dashboard innerHTML
- **Test coverage** — 66 BDD-style tests across 5 suites (AgentRunner, Scheduler, WebServer, Store, WorktreePool)
- **Task cleanup** — DELETE /api/tasks/cleanup?days=N to remove old completed tasks
- **Error endpoint** — GET /api/tasks/errors for recent failures
- **Health check** — GET /api/health
- **API docs** — GET /api/docs

### Changed

- Agent execution rewritten from SDK-based to CLI-based spawning
- Dashboard uses Promise.allSettled (one failed API call no longer blanks the UI)
- getDailyStats returns `{total, success, cost, successRate}` (was `{count, cost, successRate}`)
- Logger enhanced with level filtering and stderr routing for errors

### Removed

- `@anthropic-ai/claude-agent-sdk` dependency (replaced by CLI spawning)

## [v0.1.0-alpha] - 2026-02-27

### Added

- Multi-agent orchestration with git worktrees
- REST API with 20+ endpoints
- Real-time SSE events
- Web dashboard with task submission and monitoring
- SQLite persistence
- Priority queue with retry logic
- Self-evolution analysis system
- Cost and token tracking per task
