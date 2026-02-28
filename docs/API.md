# API Reference

Base URL: `http://localhost:<port>`

All endpoints return `application/json` unless otherwise noted. CORS is enabled for all routes.

---

## Table of Contents

- [GET /api/health](#get-apihealth)
- [GET /api/stats](#get-apistats)
- [GET /api/tasks](#get-apitasks)
- [POST /api/tasks](#post-apitasks)
- [DELETE /api/tasks/:id](#delete-apitasksid)
- [POST /api/tasks/batch](#post-apitasksbatch)
- [GET /api/tasks/:id](#get-apitasksid)
- [GET /api/tasks/search](#get-apitaskssearch)
- [GET /api/workers](#get-apiworkers)
- [GET /api/events](#get-apievents)
- [GET /api/evolution/log](#get-apievolutionlog)

---

## GET /api/health

Health check. Returns server uptime, version, worker pool summary, and aggregate task counts.

**Response**

```json
{
  "status": "ok",
  "uptime": 3600.42,
  "version": "1.0.0",
  "workers": {
    "total": 4,
    "busy": 1,
    "available": 3
  },
  "tasks": {
    "total": 42,
    "running": 1,
    "queued": 2,
    "success": 38,
    "failed": 1
  },
  "totalCost": 0.27
}
```

| Field | Type | Description |
|---|---|---|
| `status` | `string` | Always `"ok"` when the server is reachable |
| `uptime` | `number` | Server process uptime in seconds |
| `version` | `string` | API version |
| `workers.total` | `number` | Total worker slots in the pool |
| `workers.busy` | `number` | Workers currently executing a task |
| `workers.available` | `number` | Workers ready to accept a new task |
| `tasks.total` | `number` | All-time total tasks in the store |
| `tasks.running` | `number` | Tasks with status `running` |
| `tasks.queued` | `number` | Tasks waiting in the dispatch queue |
| `tasks.success` | `number` | Tasks completed with status `success` |
| `tasks.failed` | `number` | Tasks completed with status `failed` |
| `totalCost` | `number` | Cumulative USD spent across all tasks |

---

## GET /api/stats

Detailed scheduler statistics including per-status counts, queue depth, worker availability, average duration, estimated wait time, and budget usage.

**Response**

```json
{
  "total": 42,
  "byStatus": {
    "pending": 2,
    "running": 1,
    "success": 38,
    "failed": 1,
    "timeout": 0,
    "cancelled": 0
  },
  "totalCost": 0.27,
  "queueSize": 2,
  "activeWorkers": 1,
  "availableWorkers": 3,
  "avgDurationMs": 18500,
  "estimatedWaitMs": 37000,
  "totalBudgetLimit": 10
}
```

| Field | Type | Description |
|---|---|---|
| `total` | `number` | All-time total tasks |
| `byStatus` | `object` | Task counts keyed by status string |
| `totalCost` | `number` | Cumulative USD spent |
| `queueSize` | `number` | Number of tasks waiting to be dispatched |
| `activeWorkers` | `number` | Workers currently busy |
| `availableWorkers` | `number` | Workers ready to accept a task |
| `avgDurationMs` | `number` | Average duration of completed tasks in ms |
| `estimatedWaitMs` | `number` | Estimated queue wait time in ms |
| `totalBudgetLimit` | `number` | Global USD budget cap (`0` = unlimited) |

---

## GET /api/tasks

List tasks. Results are returned newest-first. Supports optional query-string filters.

**Query Parameters**

| Parameter | Type | Description |
|---|---|---|
| `status` | `string` | Filter by status: `pending` \| `running` \| `success` \| `failed` \| `timeout` \| `cancelled` |
| `q` | `string` | Case-insensitive keyword search within task prompts |
| `limit` | `number` | Maximum number of results to return |
| `tag` | `string` | Return only tasks that include this tag |

**Response** — array of task summaries

```json
[
  {
    "id": "abc123",
    "prompt": "Refactor the auth module to use JWT…",
    "status": "success",
    "worktree": "worker-1",
    "costUsd": 0.04,
    "createdAt": "2024-01-15T10:00:00.000Z",
    "completedAt": "2024-01-15T10:00:22.000Z",
    "durationMs": 22000,
    "tags": ["auth", "refactor"]
  }
]
```

> Prompts are truncated to 200 characters in the list response. Use `GET /api/tasks/:id` to retrieve the full prompt.

---

## POST /api/tasks

Submit a single task for execution.

**Rate limit:** 30 requests per 60 seconds per IP. Exceeding the limit returns `429` with a `Retry-After` header.

**Request Body**

```json
{
  "prompt": "Add input validation to the signup form",
  "priority": "high",
  "timeout": 300,
  "maxBudget": 0.5,
  "tags": ["frontend", "validation"],
  "webhookUrl": "https://example.com/webhook"
}
```

| Field | Type | Required | Constraints |
|---|---|---|---|
| `prompt` | `string` | ✅ | Non-empty, max 5000 characters |
| `priority` | `string` | ❌ | `urgent` \| `high` \| `normal` \| `low` (default: `normal`) |
| `timeout` | `number` | ❌ | Seconds, 1–3600 |
| `maxBudget` | `number` | ❌ | USD cap per task, 0–100 |
| `tags` | `string[]` | ❌ | Max 10 items, each max 50 characters |
| `webhookUrl` | `string` | ❌ | Must start with `http` |
| `agent` | `string` | ❌ | `claude-sdk` \| `claude` \| `codex` \| any CLI command (default: server default) |

**Response** `201 Created`

```json
{
  "id": "def456",
  "status": "pending"
}
```

**Error Codes**

| Code | Reason |
|---|---|
| `400` | Validation failure (see error message for details) |
| `429` | Rate limit exceeded; check the `Retry-After` response header |

---

## DELETE /api/tasks/:id

Cancel a pending or queued task.

**Path Parameters**

| Parameter | Description |
|---|---|
| `id` | Task ID |

**Response**

```json
{ "ok": true }
```

**Error Codes**

| Code | Reason |
|---|---|
| `404` | Task not found |
| `409` | Task is currently running and cannot be cancelled |
| `400` | Task cannot be cancelled (e.g. already completed) |

---

## POST /api/tasks/batch

Submit up to 20 tasks in a single request. All tasks share the same optional `timeout` and `maxBudget` overrides. Tasks are queued independently.

**Request Body**

```json
{
  "prompts": [
    "Write unit tests for the payment module",
    "Add JSDoc comments to src/utils.ts"
  ],
  "maxBudget": 1
}
```

| Field | Type | Required | Constraints |
|---|---|---|---|
| `prompts` | `string[]` | ✅ | 1–20 non-empty strings |
| `timeout` | `number` | ❌ | Seconds, applied to every task |
| `maxBudget` | `number` | ❌ | USD cap applied to every task |

**Response** `201 Created` — array of created task stubs

```json
[
  { "id": "ghi789", "status": "pending" },
  { "id": "jkl012", "status": "pending" }
]
```

**Error Codes**

| Code | Reason |
|---|---|
| `400` | `prompts` missing, empty, contains non-strings, or exceeds 20 items |

---

## GET /api/tasks/:id

Get full details of a single task, including output, events, token counts, timing, and its current queue position.

**Path Parameters**

| Parameter | Description |
|---|---|
| `id` | Task ID |

**Response**

```json
{
  "id": "abc123",
  "prompt": "Refactor the auth module to use JWT",
  "status": "success",
  "priority": "normal",
  "worktree": "worker-1",
  "output": "Done. Updated src/auth.ts and added tests.",
  "error": "",
  "events": [
    { "type": "start", "timestamp": "2024-01-15T10:00:01.000Z" },
    { "type": "complete", "timestamp": "2024-01-15T10:00:22.000Z" }
  ],
  "createdAt": "2024-01-15T10:00:00.000Z",
  "startedAt": "2024-01-15T10:00:01.000Z",
  "completedAt": "2024-01-15T10:00:22.000Z",
  "timeout": 300,
  "maxBudget": 5,
  "costUsd": 0.04,
  "tokenInput": 1200,
  "tokenOutput": 340,
  "durationMs": 22000,
  "retryCount": 0,
  "maxRetries": 2,
  "tags": ["auth", "refactor"],
  "queuePosition": null
}
```

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique task identifier |
| `prompt` | `string` | Full task prompt |
| `status` | `string` | `pending` \| `running` \| `success` \| `failed` \| `timeout` \| `cancelled` |
| `priority` | `string` | `urgent` \| `high` \| `normal` \| `low` |
| `worktree` | `string \| undefined` | Worker name assigned to this task |
| `output` | `string` | Raw text output from the agent |
| `error` | `string` | Error message if the task failed |
| `events` | `array` | Lifecycle events (each has `type`, `timestamp`, optional `data`) |
| `createdAt` | `string` | ISO 8601 timestamp |
| `startedAt` | `string \| undefined` | ISO 8601 timestamp when execution began |
| `completedAt` | `string \| undefined` | ISO 8601 timestamp when execution finished |
| `timeout` | `number` | Timeout in seconds |
| `maxBudget` | `number` | Per-task USD spend cap |
| `costUsd` | `number` | Actual USD spent |
| `tokenInput` | `number` | Input tokens consumed |
| `tokenOutput` | `number` | Output tokens generated |
| `durationMs` | `number` | Wall-clock execution time in ms |
| `retryCount` | `number` | Number of times this task has been retried |
| `maxRetries` | `number` | Maximum automatic retries allowed |
| `tags` | `string[] \| undefined` | User-supplied tags |
| `queuePosition` | `number \| null` | Position in the dispatch queue; `null` if not queued |

**Error Codes**

| Code | Reason |
|---|---|
| `404` | Task not found |

---

## GET /api/tasks/search

Search tasks by keyword across both prompt text and output text. Uses the persistent store (includes completed tasks).

**Query Parameters**

| Parameter | Type | Description |
|---|---|---|
| `q` | `string` | Search query (required; empty string returns all tasks) |

**Response** — array of matching full task objects (same shape as `GET /api/tasks/:id`)

```json
[
  {
    "id": "abc123",
    "prompt": "Refactor the auth module to use JWT",
    "status": "success",
    "costUsd": 0.04,
    "createdAt": "2024-01-15T10:00:00.000Z"
  }
]
```

---

## GET /api/workers

List all worker slots in the pool with their name, worktree path, git branch, busy status, current task ID, uptime, and completed task count.

**Response** — array of worker status objects

```json
[
  {
    "name": "worker-1",
    "path": "/repo/.claude/worktrees/worker-1",
    "branch": "worker-1",
    "busy": true,
    "currentTask": "abc123",
    "uptime": 7200,
    "taskCount": 14
  },
  {
    "name": "worker-2",
    "path": "/repo/.claude/worktrees/worker-2",
    "branch": "worker-2",
    "busy": false,
    "currentTask": null,
    "uptime": 7200,
    "taskCount": 12
  }
]
```

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Worker slot identifier |
| `path` | `string` | Absolute path to the git worktree |
| `branch` | `string` | Git branch checked out in this worktree |
| `busy` | `boolean` | `true` while the worker is executing a task |
| `currentTask` | `string \| null` | ID of the task currently running, or `null` |
| `uptime` | `number \| undefined` | Seconds since the worker was started |
| `taskCount` | `number \| undefined` | Total tasks completed by this worker |

---

## GET /api/events

Server-Sent Events (SSE) stream for real-time task lifecycle notifications. Each message is a JSON object serialised as the SSE `data` field. A keep-alive ping (empty `data`) is sent every 15 seconds to prevent connection timeouts.

**Usage**

```
# Browser
const es = new EventSource("/api/events");
es.onmessage = (e) => console.log(JSON.parse(e.data));

# curl
curl --no-buffer http://localhost:3000/api/events
```

**Response** — `text/event-stream`

The stream emits three event types:

### `task_queued`

Emitted when a task enters the dispatch queue (on initial submission or after a retry).

```json
{
  "type": "task_queued",
  "taskId": "abc123",
  "queueSize": 3
}
```

### `task_final`

Emitted when a task reaches a terminal state (`success`, `failed`, `timeout`, or `cancelled`).

```json
{
  "type": "task_final",
  "taskId": "abc123",
  "status": "success",
  "costUsd": 0.04
}
```

### `task_progress`

Emitted every 10 seconds while a task is running, reporting elapsed time and live cost/token counters.

```json
{
  "type": "task_progress",
  "taskId": "abc123",
  "elapsedMs": 10432,
  "costUsd": 0.02,
  "tokenInput": 800,
  "tokenOutput": 120
}
```

---

## GET /api/evolution/log

Return all saved evolution log entries. Each entry records the analysis of a completed round of tasks.

**Response** — array of evolution entries, ordered by insertion

```json
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "roundNumber": 1706179200000,
    "taskIds": ["abc123", "def456"],
    "analysis": {
      "successRate": 1.0,
      "avgCostUsd": 0.04,
      "avgDurationMs": 22000,
      "patternsDetected": []
    },
    "createdAt": "2024-01-25T12:00:00.000Z"
  }
]
```

| Field | Type | Description |
|---|---|---|
| `id` | `string` | UUID of the evolution entry |
| `roundNumber` | `number` | Unix timestamp (ms) used as the round identifier |
| `taskIds` | `string[]` | IDs of the tasks analysed in this round |
| `analysis` | `object` | Arbitrary analysis data produced by the scheduler |
| `createdAt` | `string` | ISO 8601 creation timestamp |
