# Changelog

All notable changes to this project will be documented in this file.

## [v0.1.0] - 2026-02-28

### Added

- **Hybrid agent architecture** — Claude Agent SDK + Claude CLI + Codex CLI + generic CLI
  - `claude-sdk` agent mode via `@anthropic-ai/claude-agent-sdk` with structured events
  - `claude` agent mode via CLI spawning with stream-json output parsing
  - `codex` agent mode via Codex CLI with JSON output parsing
  - Generic agent mode for any CLI command accepting a prompt argument
  - `--agent` CLI flag to set default agent, per-task `agent` field in POST /api/tasks
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
- **Test coverage** — 71 BDD-style tests across 5 suites (AgentRunner, Scheduler, WebServer, Store, WorktreePool)
- **Pre-commit hooks** — automatic tsc + test verification via `.githooks/pre-commit`
- **CI/CD** — GitHub Actions workflow with Node 20/22 matrix, type checking, build, and test
- **Task cleanup** — DELETE /api/tasks/cleanup?days=N to remove old completed tasks
- **Error endpoint** — GET /api/tasks/errors for recent failures
- **Health check** — GET /api/health
- **API docs** — GET /api/docs

### Fixed

- **Timeout race condition** — `handleClaudeEvent` no longer overwrites timeout status with late result messages
- **Build verification** — `verifyBuild()` now async (no longer blocks event loop for 5-15s)
- **Event cap** — task events capped at 200 entries to prevent unbounded SQLite growth

### Changed

- Agent execution supports both SDK and CLI modes (hybrid architecture)
- Dashboard uses Promise.allSettled (one failed API call no longer blanks the UI)
- getDailyStats returns `{total, success, cost, successRate}` (was `{count, cost, successRate}`)
- Logger enhanced with level filtering and stderr routing for errors

### Removed

- Legacy Python test files and scripts

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
