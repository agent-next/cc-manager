import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WebServer } from "../server.js";
import type { Scheduler } from "../scheduler.js";
import type { WorktreePool } from "../worktree-pool.js";
import type { Task } from "../types.js";
import { createTask } from "../types.js";

// ===========================================================================
// HTTP integration tests — all validation tested through real server routes
// ===========================================================================

function makePoolMock(): WorktreePool {
  return {
    available: 2,
    busy: 1,
    getStatus: () => [
      { name: "worker-0", path: "/tmp/w0", branch: "worker/worker-0", busy: true, currentTask: "t1", uptime: 5000, taskCount: 3 },
      { name: "worker-1", path: "/tmp/w1", branch: "worker/worker-1", busy: false, currentTask: undefined, uptime: undefined, taskCount: 1 },
      { name: "worker-2", path: "/tmp/w2", branch: "worker/worker-2", busy: false, currentTask: undefined, uptime: undefined, taskCount: 0 },
    ],
    getWorker: (name: string) => {
      if (name === "worker-0") return { name: "worker-0", path: "/tmp/w0", branch: "worker/worker-0", busy: true };
      return undefined;
    },
    getWorkerStats: () => ({ total: 3, busy: 1, available: 2, stale: 0 }),
  } as unknown as WorktreePool;
}

function makeSchedulerMock(): Scheduler & { _store: any } {
  const tasks = new Map<string, Task>();

  const store = {
    save: (t: Task) => { tasks.set(t.id, t); },
    get: (id: string) => tasks.get(id) ?? null,
    list: (limit = 100) => [...tasks.values()].slice(0, limit),
    stats: () => {
      const byStatus: Record<string, number> = {};
      let totalCost = 0;
      for (const t of tasks.values()) {
        byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
        totalCost += t.costUsd;
      }
      return { total: tasks.size, byStatus, totalCost };
    },
    getByStatus: (status: string) => [...tasks.values()].filter(t => t.status === status),
    search: (q: string) => [...tasks.values()].filter(t => t.prompt.includes(q) || t.output.includes(q)),
    getRecentErrors: (limit: number) => [...tasks.values()].filter(t => t.status === "failed" || t.status === "timeout").slice(0, limit),
    getDailyStats: () => [],
    getSummaryStats: () => ({ tasksToday: 0, successRateToday: 0, totalCostToday: 0, avgDurationToday: 0, totalTasksAllTime: tasks.size, overallSuccessRate: 0 }),
    getFailurePatterns: () => [],
    getEvolutionLog: () => [],
    saveEvolution: () => {},
    deleteOlderThan: (_days: number) => 0,
    getPerformanceMetrics: () => ({ totalTasks: 0, successCount: 0, failedCount: 0, timeoutCount: 0, avgDurationMs: 0, avgCostUsd: 0, totalCostUsd: 0, p50DurationMs: 0, p90DurationMs: 0 }),
    close: () => {},
  };

  let queueDepth = 0;

  const scheduler = {
    // Expose store so the WebServer's private `get store()` accessor works
    // (it does `(this._scheduler as any).store`)
    store,
    // Also keep a separate reference for test access
    _store: store,
    submit: (prompt: string, opts?: any) => {
      const task = createTask(prompt, opts);
      tasks.set(task.id, task);
      queueDepth++;
      return task;
    },
    getTask: (id: string) => tasks.get(id),
    listTasks: () => [...tasks.values()],
    cancel: (id: string) => {
      const t = tasks.get(id);
      if (!t || t.status !== "pending") return false;
      t.status = "cancelled";
      return true;
    },
    requeue: (id: string) => {
      const t = tasks.get(id);
      if (!t || (t.status !== "failed" && t.status !== "timeout")) return null;
      t.status = "pending";
      t.retryCount += 1;
      return t;
    },
    getStats: () => ({
      ...store.stats(),
      queueSize: queueDepth,
      activeWorkers: 0,
      availableWorkers: 2,
      avgDurationMs: 0,
      estimatedWaitMs: 0,
      totalBudgetLimit: 0,
    }),
    getQueuePosition: (_id: string) => -1,
    getQueueDepth: () => queueDepth,
    getHistoricalInsights: () => ({ avgDuration: 0, successRate: 0, avgCost: 0, timeoutRate: 0 }),
    getDetailedInsights: () => ({
      overall: { total: 0, successRate: 0, avgDurationMs: 0, totalCostUsd: 0, byStatus: {} },
      last7Days: [],
      analysis: { failureRate: 0, avgCostPerTask: 0, peakDay: null },
    }),
    analyzeRound: (ids: string[]) => ({
      taskCount: ids.length,
      successCount: 0,
      failedCount: 0,
      timeoutCount: 0,
      totalCost: 0,
      avgDurationMs: 0,
      successRate: 0,
    }),
    generateImprovementTasks: () => ["Review code quality"],
    getAverageDuration: () => 0,
    getFailureContext: () => "Recent failures: none",
  } as unknown as Scheduler & { _store: any };

  return scheduler;
}

function createTestServer() {
  const pool = makePoolMock();
  const server = new WebServer(pool, 0); // port 0: we never call start()
  const scheduler = makeSchedulerMock();
  server.setScheduler(scheduler as any);
  // Access the private Hono app for direct request testing
  const app = (server as any).app;
  return { app, server, scheduler, pool };
}

// ---------------------------------------------------------------------------
// GET /api/health
// ---------------------------------------------------------------------------
describe("GET /api/health", () => {
  it("returns status ok with uptime and workers", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/health");
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.status, "ok");
    assert.strictEqual(body.version, "1.0.0");
    assert.strictEqual(typeof body.uptime, "number");
    assert.strictEqual(body.workers.total, 3);
    assert.strictEqual(body.workers.busy, 1);
    assert.strictEqual(body.workers.available, 2);
    assert.strictEqual(typeof body.tasks, "object");
    assert.strictEqual(typeof body.totalCost, "number");
  });
});

// ---------------------------------------------------------------------------
// GET /api/stats
// ---------------------------------------------------------------------------
describe("GET /api/stats", () => {
  it("returns byStatus breakdown and totalCost", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/stats");
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(typeof body.byStatus, "object");
    assert.strictEqual(typeof body.totalCost, "number");
    assert.strictEqual(typeof body.queueSize, "number");
  });
});

// ---------------------------------------------------------------------------
// GET /api/tasks
// ---------------------------------------------------------------------------
describe("GET /api/tasks", () => {
  it("returns task list", async () => {
    const { app, scheduler } = createTestServer();
    // Submit a task so there is something to list
    scheduler.submit("hello world task");
    const res = await app.request("/api/tasks");
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
    assert.strictEqual(body.length, 1);
    assert.strictEqual(body[0].status, "pending");
    assert.ok(body[0].id);
  });

  it("filters by status parameter", async () => {
    const { app, scheduler } = createTestServer();
    scheduler.submit("task one");
    const t2 = scheduler.submit("task two");
    // Manually mark t2 as failed for filtering
    t2.status = "failed";
    const res = await app.request("/api/tasks?status=failed");
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.length, 1);
    assert.strictEqual(body[0].id, t2.id);
  });

  it("truncates prompt to 200 chars in list", async () => {
    const { app, scheduler } = createTestServer();
    const longPrompt = "x".repeat(300);
    scheduler.submit(longPrompt);
    const res = await app.request("/api/tasks");
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body[0].prompt.length, 200);
  });

  it("filters by tag parameter", async () => {
    const { app, scheduler } = createTestServer();
    scheduler.submit("ui task", { tags: ["ui"] });
    scheduler.submit("api task", { tags: ["api"] });
    const res = await app.request("/api/tasks?tag=ui");
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.length, 1);
    assert.deepStrictEqual(body[0].tags, ["ui"]);
  });

  it("respects limit parameter", async () => {
    const { app, scheduler } = createTestServer();
    scheduler.submit("one");
    scheduler.submit("two");
    scheduler.submit("three");
    const res = await app.request("/api/tasks?limit=2");
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.length, 2);
  });
});

// ---------------------------------------------------------------------------
// POST /api/tasks
// ---------------------------------------------------------------------------
describe("POST /api/tasks", () => {
  it("creates task and returns 201 with id", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "test task" }),
    });
    assert.strictEqual(res.status, 201);
    const body = await res.json();
    assert.ok(body.id);
    assert.strictEqual(body.status, "pending");
  });

  it("returns 400 for empty prompt", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "" }),
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.ok(body.error);
  });

  it("returns 400 for prompt over 2000 chars", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "a".repeat(2001) }),
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.ok(body.error);
  });

  it("accepts optional tags and webhookUrl", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "task with extras",
        tags: ["ui", "feature"],
        webhookUrl: "https://example.com/hook",
      }),
    });
    assert.strictEqual(res.status, 201);
    const body = await res.json();
    assert.ok(body.id);
  });

  it("returns 400 for invalid priority", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "task", priority: "critical" }),
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.ok(body.error);
  });

  it("returns 400 for invalid timeout", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "task", timeout: -5 }),
    });
    assert.strictEqual(res.status, 400);
  });

  it("returns 400 for bad JSON body", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json{{{",
    });
    assert.strictEqual(res.status, 400);
  });
});

// ---------------------------------------------------------------------------
// GET /api/tasks/:id
// ---------------------------------------------------------------------------
describe("GET /api/tasks/:id", () => {
  it("returns full task detail", async () => {
    const { app, scheduler } = createTestServer();
    const task = scheduler.submit("detail task");
    const res = await app.request(`/api/tasks/${task.id}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.id, task.id);
    assert.strictEqual(body.prompt, "detail task");
    assert.strictEqual(typeof body.queuePosition, "number");
  });

  it("returns 404 for unknown id", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/tasks/nonexistent-id");
    assert.strictEqual(res.status, 404);
    const body = await res.json();
    assert.strictEqual(body.error, "not found");
  });
});

// ---------------------------------------------------------------------------
// GET /api/tasks/:id/output
// ---------------------------------------------------------------------------
describe("GET /api/tasks/:id/output", () => {
  it("returns task output as plain text", async () => {
    const { app, scheduler } = createTestServer();
    const task = scheduler.submit("output task");
    task.output = "some output here";
    const res = await app.request(`/api/tasks/${task.id}/output`);
    assert.strictEqual(res.status, 200);
    const text = await res.text();
    assert.strictEqual(text, "some output here");
  });

  it("returns 404 for unknown task", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/tasks/nope/output");
    assert.strictEqual(res.status, 404);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/tasks/:id
// ---------------------------------------------------------------------------
describe("DELETE /api/tasks/:id", () => {
  it("cancels pending task", async () => {
    const { app, scheduler } = createTestServer();
    const task = scheduler.submit("cancel me");
    const res = await app.request(`/api/tasks/${task.id}`, { method: "DELETE" });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
  });

  it("returns 404 for unknown id", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/tasks/nonexistent", { method: "DELETE" });
    assert.strictEqual(res.status, 404);
    const body = await res.json();
    assert.ok(body.error);
  });

  it("returns 409 for running task", async () => {
    const { app, scheduler } = createTestServer();
    const task = scheduler.submit("running task");
    task.status = "running";
    const res = await app.request(`/api/tasks/${task.id}`, { method: "DELETE" });
    assert.strictEqual(res.status, 409);
    const body = await res.json();
    assert.ok(body.error.includes("running"));
  });
});

// ---------------------------------------------------------------------------
// POST /api/tasks/batch
// ---------------------------------------------------------------------------
describe("POST /api/tasks/batch", () => {
  it("creates multiple tasks", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/tasks/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompts: ["task one", "task two", "task three"] }),
    });
    assert.strictEqual(res.status, 201);
    const body = await res.json();
    assert.ok(Array.isArray(body));
    assert.strictEqual(body.length, 3);
    for (const item of body) {
      assert.ok(item.id);
      assert.strictEqual(item.status, "pending");
    }
  });

  it("returns 400 for empty prompts array", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/tasks/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompts: [] }),
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.ok(body.error);
  });

  it("returns 400 for missing prompts field", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/tasks/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.strictEqual(res.status, 400);
  });

  it("returns 400 when a prompt in the array is empty", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/tasks/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompts: ["good", ""] }),
    });
    assert.strictEqual(res.status, 400);
  });

  it("returns 400 when batch exceeds 20 prompts", async () => {
    const { app } = createTestServer();
    const prompts = Array.from({ length: 21 }, (_, i) => `task ${i}`);
    const res = await app.request("/api/tasks/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompts }),
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes("20"));
  });
});

// ---------------------------------------------------------------------------
// GET /api/workers
// ---------------------------------------------------------------------------
describe("GET /api/workers", () => {
  it("returns worker status array", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/workers");
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
    assert.strictEqual(body.length, 3);
    assert.strictEqual(body[0].name, "worker-0");
    assert.strictEqual(body[0].busy, true);
    assert.strictEqual(body[1].busy, false);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/tasks/cleanup
// ---------------------------------------------------------------------------
describe("DELETE /api/tasks/cleanup", () => {
  it("returns deleted count for valid days", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/tasks/cleanup?days=7", { method: "DELETE" });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(typeof body.deleted, "number");
  });

  it("returns 400 for invalid days parameter", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/tasks/cleanup?days=abc", { method: "DELETE" });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.ok(body.error);
  });

  it("returns 400 for zero days", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/tasks/cleanup?days=0", { method: "DELETE" });
    assert.strictEqual(res.status, 400);
  });

  it("returns 400 for negative days", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/tasks/cleanup?days=-5", { method: "DELETE" });
    assert.strictEqual(res.status, 400);
  });
});

// ---------------------------------------------------------------------------
// POST /api/tasks/:id/retry
// ---------------------------------------------------------------------------
describe("POST /api/tasks/:id/retry", () => {
  it("requeues a failed task", async () => {
    const { app, scheduler } = createTestServer();
    const task = scheduler.submit("retry me");
    task.status = "failed";
    const res = await app.request(`/api/tasks/${task.id}/retry`, { method: "POST" });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.id, task.id);
    assert.strictEqual(body.status, "pending");
    assert.strictEqual(body.retryCount, 1);
  });

  it("requeues a timed-out task", async () => {
    const { app, scheduler } = createTestServer();
    const task = scheduler.submit("timeout retry");
    task.status = "timeout";
    const res = await app.request(`/api/tasks/${task.id}/retry`, { method: "POST" });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.status, "pending");
  });

  it("returns 404 for unknown id", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/tasks/unknown/retry", { method: "POST" });
    assert.strictEqual(res.status, 404);
    const body = await res.json();
    assert.strictEqual(body.error, "not found");
  });

  it("returns 400 for task not in retryable state", async () => {
    const { app, scheduler } = createTestServer();
    const task = scheduler.submit("already ok");
    task.status = "success";
    const res = await app.request(`/api/tasks/${task.id}/retry`, { method: "POST" });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes("not in a retryable state"));
  });
});

// ---------------------------------------------------------------------------
// GET /api/budget
// ---------------------------------------------------------------------------
describe("GET /api/budget", () => {
  it("returns spent, limit, remaining", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/budget");
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(typeof body.spent, "number");
    assert.strictEqual(typeof body.limit, "number");
    // When limit is 0, remaining should be null (unlimited)
    assert.strictEqual(body.remaining, null);
  });
});

// ---------------------------------------------------------------------------
// GET /api/insights
// ---------------------------------------------------------------------------
describe("GET /api/insights", () => {
  it("returns historical insights", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/insights");
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(typeof body.avgDuration, "number");
    assert.strictEqual(typeof body.successRate, "number");
    assert.strictEqual(typeof body.avgCost, "number");
    assert.strictEqual(typeof body.timeoutRate, "number");
  });
});

// ---------------------------------------------------------------------------
// GET /api/evolution/log
// ---------------------------------------------------------------------------
describe("GET /api/evolution/log", () => {
  it("returns evolution log as array", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/evolution/log");
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
  });
});

// ---------------------------------------------------------------------------
// POST /api/evolution/analyze
// ---------------------------------------------------------------------------
describe("POST /api/evolution/analyze", () => {
  it("analyzes a round and returns entry", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/evolution/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskIds: ["t1", "t2"] }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(body.id);
    assert.deepStrictEqual(body.taskIds, ["t1", "t2"]);
    assert.strictEqual(body.analysis.taskCount, 2);
  });

  it("returns 400 for empty taskIds", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/evolution/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskIds: [] }),
    });
    assert.strictEqual(res.status, 400);
  });

  it("returns 400 for bad json", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/evolution/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "invalid{",
    });
    assert.strictEqual(res.status, 400);
  });
});

// ---------------------------------------------------------------------------
// POST /api/flywheel/suggest
// ---------------------------------------------------------------------------
describe("POST /api/flywheel/suggest", () => {
  it("returns improvement prompts", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/flywheel/suggest", { method: "POST" });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.prompts));
    assert.strictEqual(body.prompts[0], "Review code quality");
  });
});

// ---------------------------------------------------------------------------
// POST /api/flywheel/run
// ---------------------------------------------------------------------------
describe("POST /api/flywheel/run", () => {
  it("generates tasks and returns their ids", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/flywheel/run", { method: "POST" });
    assert.strictEqual(res.status, 201);
    const body = await res.json();
    assert.ok(Array.isArray(body.taskIds));
    assert.ok(body.taskIds.length > 0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/docs
// ---------------------------------------------------------------------------
describe("GET /api/docs", () => {
  it("returns API documentation", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/docs");
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.version, "1.0.0");
    assert.ok(Array.isArray(body.endpoints));
    assert.ok(body.endpoints.length > 0);
    // Each endpoint should have method, path, description
    for (const ep of body.endpoints) {
      assert.ok(ep.method);
      assert.ok(ep.path);
      assert.ok(ep.description);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/stats/daily
// ---------------------------------------------------------------------------
describe("GET /api/stats/daily", () => {
  it("returns daily stats array", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/stats/daily");
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
  });
});

// ---------------------------------------------------------------------------
// GET /api/stats/summary
// ---------------------------------------------------------------------------
describe("GET /api/stats/summary", () => {
  it("returns summary stats object", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/stats/summary");
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(typeof body.tasksToday, "number");
    assert.strictEqual(typeof body.totalTasksAllTime, "number");
  });
});

// ---------------------------------------------------------------------------
// GET /api/tasks/errors
// ---------------------------------------------------------------------------
describe("GET /api/tasks/errors", () => {
  it("returns recent errors", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/tasks/errors");
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
  });
});

// ---------------------------------------------------------------------------
// GET /api/tasks/search
// ---------------------------------------------------------------------------
describe("GET /api/tasks/search", () => {
  it("searches tasks by keyword", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/tasks/search?q=refactor");
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
  });
});

// ---------------------------------------------------------------------------
// R5: Webhook URL SSRF validation
// ---------------------------------------------------------------------------
describe("POST /api/tasks webhook validation (R5)", () => {
  it("rejects localhost webhook URL", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "test", webhookUrl: "http://localhost:3000/hook" }),
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes("public host"));
  });

  it("rejects 127.0.0.1 webhook URL", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "test", webhookUrl: "http://127.0.0.1/hook" }),
    });
    assert.strictEqual(res.status, 400);
  });

  it("rejects 169.254.x.x (link-local) webhook URL", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "test", webhookUrl: "http://169.254.169.254/latest/meta-data/" }),
    });
    assert.strictEqual(res.status, 400);
  });

  it("rejects 10.x.x.x (RFC 1918) webhook URL", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "test", webhookUrl: "http://10.0.0.1/hook" }),
    });
    assert.strictEqual(res.status, 400);
  });

  it("rejects 192.168.x.x webhook URL", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "test", webhookUrl: "http://192.168.1.1/hook" }),
    });
    assert.strictEqual(res.status, 400);
  });

  it("rejects IPv6 loopback [::1] webhook URL", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "test", webhookUrl: "http://[::1]:8080/hook" }),
    });
    assert.strictEqual(res.status, 400);
  });

  it("rejects invalid URL scheme", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "test", webhookUrl: "ftp://evil.com/hook" }),
    });
    assert.strictEqual(res.status, 400);
  });

  it("accepts valid public HTTPS webhook URL", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "test", webhookUrl: "https://example.com/webhook" }),
    });
    assert.strictEqual(res.status, 201);
  });
});

// ---------------------------------------------------------------------------
// R6: Rate limit batch endpoint
// ---------------------------------------------------------------------------
describe("POST /api/tasks/batch rate limiting (R6)", () => {
  it("rate limits batch requests based on prompt count", async () => {
    const { app } = createTestServer();
    // Submit batches to consume rate limit. Each batch of 20 counts as 20 requests.
    // Limit is 30/min, so a batch of 20 + a batch of 20 should hit 429.
    const res1 = await app.request("/api/tasks/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompts: Array.from({ length: 20 }, (_, i) => `task ${i}`) }),
    });
    assert.strictEqual(res1.status, 201);

    const res2 = await app.request("/api/tasks/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompts: Array.from({ length: 20 }, (_, i) => `task ${i + 20}`) }),
    });
    assert.strictEqual(res2.status, 429, "second large batch should hit rate limit");
  });
});

// ---------------------------------------------------------------------------
// R9: Diff endpoint worktree reassignment check
// ---------------------------------------------------------------------------
describe("GET /api/tasks/:id/diff reassignment check (R9)", () => {
  it("returns worktree reassigned message when worker has different task", async () => {
    const { app, scheduler } = createTestServer();
    const task = scheduler.submit("diff task");
    task.worktree = "worker-0";
    task.status = "success";
    // worker-0 in mock is busy with currentTask "t1", not this task's id
    const res = await app.request(`/api/tasks/${task.id}/diff`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.message, "worktree reassigned");
  });
});

// ---------------------------------------------------------------------------
// POST /api/tasks rate limiting
// ---------------------------------------------------------------------------
describe("POST /api/tasks rate limiting", () => {
  it("returns 429 after exceeding limit", async () => {
    const { app } = createTestServer();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Forwarded-For": "10.99.99.99",
    };
    let got429 = false;
    for (let i = 0; i < 32; i++) {
      const res = await app.request("/api/tasks", {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: `rate limit test ${i}` }),
      });
      if (res.status === 429) {
        got429 = true;
        const retryAfter = res.headers.get("Retry-After");
        assert.ok(retryAfter !== null, "should include Retry-After header");
        break;
      }
      // First 30 should be 201
      assert.strictEqual(res.status, 201, `request ${i} should succeed`);
    }
    assert.ok(got429, "should have received 429 status");
  });
});

// ---------------------------------------------------------------------------
// CORS headers
// ---------------------------------------------------------------------------
describe("CORS headers", () => {
  it("includes Access-Control-Allow-Origin header", async () => {
    const { app } = createTestServer();
    const res = await app.request("/api/health");
    // hono/cors middleware sets this header
    const origin = res.headers.get("Access-Control-Allow-Origin");
    assert.ok(origin, "should have CORS header");
  });
});
