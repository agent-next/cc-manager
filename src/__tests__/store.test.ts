import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Store } from "../store.js";
import type { Task } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp directory, return the Store and a cleanup callback. */
function makeTempStore(): { store: Store; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-manager-test-"));
  const store = new Store(dir);
  return {
    store,
    cleanup: () => {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Build a minimal valid Task, merging any supplied overrides. */
function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-001",
    prompt: "Test prompt",
    status: "pending",
    priority: "normal",
    output: "",
    error: "",
    events: [],
    createdAt: "2024-01-01T00:00:00.000Z",
    timeout: 300,
    maxBudget: 5,
    costUsd: 0,
    tokenInput: 0,
    tokenOutput: 0,
    durationMs: 0,
    retryCount: 0,
    maxRetries: 2,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Store", () => {
  it("saves and retrieves a task by id", () => {
    const { store, cleanup } = makeTempStore();
    try {
      const task = makeTask({
        id: "abc123",
        prompt: "Write a function",
        status: "running",
        worktree: "/tmp/wt1",
        startedAt: "2024-01-01T01:00:00.000Z",
        completedAt: "2024-01-01T02:00:00.000Z",
        tokenInput: 100,
        tokenOutput: 200,
        costUsd: 0.05,
        durationMs: 3_600_000,
        retryCount: 1,
        events: [{ type: "start", timestamp: "2024-01-01T01:00:00.000Z" }],
      });

      store.save(task);
      const got = store.get("abc123");

      assert.ok(got !== null, "task should be found");
      assert.strictEqual(got.id, task.id);
      assert.strictEqual(got.prompt, task.prompt);
      assert.strictEqual(got.status, task.status);
      assert.strictEqual(got.worktree, task.worktree);
      assert.strictEqual(got.output, task.output);
      assert.strictEqual(got.error, task.error);
      assert.deepStrictEqual(got.events, task.events);
      assert.strictEqual(got.createdAt, task.createdAt);
      assert.strictEqual(got.startedAt, task.startedAt);
      assert.strictEqual(got.completedAt, task.completedAt);
      assert.strictEqual(got.timeout, task.timeout);
      assert.strictEqual(got.maxBudget, task.maxBudget);
      assert.strictEqual(got.costUsd, task.costUsd);
      assert.strictEqual(got.tokenInput, task.tokenInput);
      assert.strictEqual(got.tokenOutput, task.tokenOutput);
      assert.strictEqual(got.durationMs, task.durationMs);
      assert.strictEqual(got.retryCount, task.retryCount);
    } finally {
      cleanup();
    }
  });

  it("get returns null for an unknown id", () => {
    const { store, cleanup } = makeTempStore();
    try {
      assert.strictEqual(store.get("does-not-exist"), null);
    } finally {
      cleanup();
    }
  });

  it("list returns tasks sorted by created_at DESC", () => {
    const { store, cleanup } = makeTempStore();
    try {
      const oldest = makeTask({ id: "t1", createdAt: "2024-01-01T00:00:00.000Z" });
      const newest = makeTask({ id: "t2", createdAt: "2024-01-03T00:00:00.000Z" });
      const middle = makeTask({ id: "t3", createdAt: "2024-01-02T00:00:00.000Z" });

      // Insert in arbitrary order — list must still return newest-first.
      store.save(oldest);
      store.save(newest);
      store.save(middle);

      const tasks = store.list();

      assert.strictEqual(tasks.length, 3);
      assert.strictEqual(tasks[0].id, "t2", "first item should be newest");
      assert.strictEqual(tasks[1].id, "t3");
      assert.strictEqual(tasks[2].id, "t1", "last item should be oldest");
    } finally {
      cleanup();
    }
  });

  it("stats returns correct counts per status and total cost", () => {
    const { store, cleanup } = makeTempStore();
    try {
      store.save(makeTask({ id: "s1", status: "pending", costUsd: 0 }));
      store.save(makeTask({ id: "s2", status: "success", costUsd: 1.5 }));
      store.save(makeTask({ id: "s3", status: "success", costUsd: 0.5 }));
      store.save(makeTask({ id: "s4", status: "failed", costUsd: 0.25 }));

      const stats = store.stats();

      assert.strictEqual(stats.total, 4, "total should be 4");
      assert.strictEqual(stats.byStatus["pending"], 1);
      assert.strictEqual(stats.byStatus["success"], 2);
      assert.strictEqual(stats.byStatus["failed"], 1);
      // Floating-point arithmetic: compare within a small epsilon.
      assert.ok(
        Math.abs(stats.totalCost - 2.25) < 0.0001,
        `Expected totalCost ≈ 2.25, got ${stats.totalCost}`,
      );
    } finally {
      cleanup();
    }
  });

  it("saving a task twice with the same id overwrites the original", () => {
    const { store, cleanup } = makeTempStore();
    try {
      const original = makeTask({ id: "upd-1", status: "pending", output: "" });
      store.save(original);

      // Mutate a copy and persist it under the same id.
      const updated: Task = {
        ...original,
        status: "success",
        output: "Task complete",
        costUsd: 0.75,
        durationMs: 5_000,
        completedAt: "2024-01-01T01:00:00.000Z",
      };
      store.save(updated);

      const got = store.get("upd-1");
      assert.ok(got !== null, "task should still exist");
      assert.strictEqual(got.status, "success");
      assert.strictEqual(got.output, "Task complete");
      assert.strictEqual(got.costUsd, 0.75);
      assert.strictEqual(got.durationMs, 5_000);
      assert.strictEqual(got.completedAt, "2024-01-01T01:00:00.000Z");

      // The upsert must not have created a duplicate row.
      assert.strictEqual(store.list().length, 1, "should be exactly one record");
    } finally {
      cleanup();
    }
  });

  describe("search", () => {
    it("finds tasks matching prompt keyword", () => {
      const { store, cleanup } = makeTempStore();
      try {
        store.save(makeTask({ id: "sr1", prompt: "Write a hello world function" }));
        store.save(makeTask({ id: "sr2", prompt: "Fix the login bug" }));
        store.save(makeTask({ id: "sr3", prompt: "Add hello banner to homepage" }));

        const results = store.search("hello");

        assert.strictEqual(results.length, 2);
        const ids = results.map((t) => t.id).sort();
        assert.deepStrictEqual(ids, ["sr1", "sr3"]);
      } finally {
        cleanup();
      }
    });

    it("returns empty array for no match", () => {
      const { store, cleanup } = makeTempStore();
      try {
        store.save(makeTask({ id: "sr4", prompt: "Write a function" }));

        const results = store.search("zzznomatchzzz");

        assert.deepStrictEqual(results, []);
      } finally {
        cleanup();
      }
    });

    it("finds tasks matching output keyword", () => {
      const { store, cleanup } = makeTempStore();
      try {
        store.save(makeTask({ id: "sr5", prompt: "do something", output: "Refactored the auth module" }));
        store.save(makeTask({ id: "sr6", prompt: "do other thing", output: "Fixed a typo" }));

        const results = store.search("auth");

        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].id, "sr5");
      } finally {
        cleanup();
      }
    });
  });

  describe("deleteOlderThan", () => {
    it("removes tasks older than N days", () => {
      const { store, cleanup } = makeTempStore();
      try {
        const old = makeTask({
          id: "old-1",
          createdAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(),
        });
        const recent = makeTask({
          id: "new-1",
          createdAt: new Date().toISOString(),
        });
        store.save(old);
        store.save(recent);

        const deleted = store.deleteOlderThan(10);

        assert.strictEqual(deleted, 1, "should delete exactly one old task");
        assert.strictEqual(store.get("old-1"), null, "old task should be gone");
        assert.ok(store.get("new-1") !== null, "recent task should remain");
      } finally {
        cleanup();
      }
    });

    it("keeps recent tasks", () => {
      const { store, cleanup } = makeTempStore();
      try {
        store.save(makeTask({ id: "rec-1", createdAt: new Date().toISOString() }));
        store.save(
          makeTask({
            id: "rec-2",
            createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
          }),
        );

        const deleted = store.deleteOlderThan(30);

        assert.strictEqual(deleted, 0, "no tasks should be deleted");
        assert.strictEqual(store.list().length, 2);
      } finally {
        cleanup();
      }
    });
  });

  describe("getRecentErrors", () => {
    it("returns failed tasks sorted by date", () => {
      const { store, cleanup } = makeTempStore();
      try {
        store.save(makeTask({ id: "err-1", status: "failed", createdAt: "2024-01-01T00:00:00.000Z" }));
        store.save(makeTask({ id: "err-2", status: "failed", createdAt: "2024-01-03T00:00:00.000Z" }));
        store.save(makeTask({ id: "err-3", status: "success", createdAt: "2024-01-02T00:00:00.000Z" }));
        store.save(makeTask({ id: "err-4", status: "timeout", createdAt: "2024-01-02T00:00:00.000Z" }));

        const errors = store.getRecentErrors(10);

        const ids = errors.map((t) => t.id);
        assert.ok(!ids.includes("err-3"), "success task should not appear");
        assert.strictEqual(errors[0].id, "err-2", "newest failed task should be first");
      } finally {
        cleanup();
      }
    });

    it("respects limit parameter", () => {
      const { store, cleanup } = makeTempStore();
      try {
        store.save(makeTask({ id: "lim-1", status: "failed", createdAt: "2024-01-01T00:00:00.000Z" }));
        store.save(makeTask({ id: "lim-2", status: "failed", createdAt: "2024-01-02T00:00:00.000Z" }));
        store.save(makeTask({ id: "lim-3", status: "failed", createdAt: "2024-01-03T00:00:00.000Z" }));

        const errors = store.getRecentErrors(2);

        assert.strictEqual(errors.length, 2, "should return exactly 2");
        assert.strictEqual(errors[0].id, "lim-3", "newest first");
        assert.strictEqual(errors[1].id, "lim-2");
      } finally {
        cleanup();
      }
    });
  });

  // ── update ──────────────────────────────────────────────────────────────────

  describe("update", () => {
    it("updates specific fields without overwriting others", () => {
      const { store, cleanup } = makeTempStore();
      try {
        store.save(makeTask({ id: "upd-1", status: "pending", prompt: "original prompt", output: "orig" }));
        const updated = store.update("upd-1", { status: "running", output: "new output" });
        assert.ok(updated !== null);
        assert.strictEqual(updated.status, "running");
        assert.strictEqual(updated.output, "new output");
        assert.strictEqual(updated.prompt, "original prompt", "prompt should not be changed");
      } finally {
        cleanup();
      }
    });

    it("returns updated task", () => {
      const { store, cleanup } = makeTempStore();
      try {
        store.save(makeTask({ id: "upd-2", costUsd: 0 }));
        const result = store.update("upd-2", { costUsd: 1.5 });
        assert.ok(result !== null);
        assert.strictEqual(result.costUsd, 1.5);
      } finally {
        cleanup();
      }
    });

    it("returns null for non-existent task", () => {
      const { store, cleanup } = makeTempStore();
      try {
        const result = store.update("nonexistent", { status: "failed" });
        assert.strictEqual(result, null);
      } finally {
        cleanup();
      }
    });

    it("returns existing task when no fields provided", () => {
      const { store, cleanup } = makeTempStore();
      try {
        store.save(makeTask({ id: "upd-3", status: "pending" }));
        const result = store.update("upd-3", {});
        assert.ok(result !== null);
        assert.strictEqual(result.status, "pending");
      } finally {
        cleanup();
      }
    });

    it("serializes events and tags fields correctly", () => {
      const { store, cleanup } = makeTempStore();
      try {
        store.save(makeTask({ id: "upd-4" }));
        const events = [{ type: "start", timestamp: "2024-01-01T00:00:00.000Z" }];
        const tags = ["test", "ci"];
        const result = store.update("upd-4", { events: events as any, tags });
        assert.ok(result !== null);
        assert.deepStrictEqual(result.events, events);
        assert.deepStrictEqual(result.tags, tags);
      } finally {
        cleanup();
      }
    });
  });

  // ── batch operations ────────────────────────────────────────────────────────

  describe("saveBatch", () => {
    it("persists multiple tasks atomically", () => {
      const { store, cleanup } = makeTempStore();
      try {
        const tasks = [
          makeTask({ id: "batch-1", prompt: "first" }),
          makeTask({ id: "batch-2", prompt: "second" }),
          makeTask({ id: "batch-3", prompt: "third" }),
        ];
        store.saveBatch(tasks);
        assert.strictEqual(store.list().length, 3);
        assert.strictEqual(store.get("batch-1")?.prompt, "first");
        assert.strictEqual(store.get("batch-3")?.prompt, "third");
      } finally {
        cleanup();
      }
    });
  });

  describe("updateBatch", () => {
    it("updates multiple tasks in a single transaction", () => {
      const { store, cleanup } = makeTempStore();
      try {
        const tasks = [
          makeTask({ id: "ub-1", status: "pending" }),
          makeTask({ id: "ub-2", status: "pending" }),
        ];
        store.saveBatch(tasks);
        tasks[0].status = "success";
        tasks[0].costUsd = 0.5;
        tasks[1].status = "failed";
        tasks[1].error = "boom";
        store.updateBatch(tasks);
        assert.strictEqual(store.get("ub-1")?.status, "success");
        assert.strictEqual(store.get("ub-1")?.costUsd, 0.5);
        assert.strictEqual(store.get("ub-2")?.status, "failed");
        assert.strictEqual(store.get("ub-2")?.error, "boom");
      } finally {
        cleanup();
      }
    });
  });

  // ── getByStatus ─────────────────────────────────────────────────────────────

  describe("getByStatus", () => {
    it("returns only tasks matching status filter", () => {
      const { store, cleanup } = makeTempStore();
      try {
        store.save(makeTask({ id: "bs-1", status: "success" }));
        store.save(makeTask({ id: "bs-2", status: "failed" }));
        store.save(makeTask({ id: "bs-3", status: "success" }));
        store.save(makeTask({ id: "bs-4", status: "pending" }));
        const successes = store.getByStatus("success");
        assert.strictEqual(successes.length, 2);
        assert.ok(successes.every((t) => t.status === "success"));
      } finally {
        cleanup();
      }
    });

    it("returns empty array for unknown status", () => {
      const { store, cleanup } = makeTempStore();
      try {
        store.save(makeTask({ id: "bs-5", status: "pending" }));
        const result = store.getByStatus("nonexistent");
        assert.deepStrictEqual(result, []);
      } finally {
        cleanup();
      }
    });
  });

  // ── transaction ─────────────────────────────────────────────────────────────

  describe("transaction", () => {
    it("commits changes on success", () => {
      const { store, cleanup } = makeTempStore();
      try {
        store.transaction(() => {
          store.save(makeTask({ id: "tx-1", prompt: "in transaction" }));
          store.save(makeTask({ id: "tx-2", prompt: "also in tx" }));
        });
        assert.strictEqual(store.list().length, 2);
        assert.strictEqual(store.get("tx-1")?.prompt, "in transaction");
      } finally {
        cleanup();
      }
    });

    it("rolls back ALL writes on error", () => {
      const { store, cleanup } = makeTempStore();
      try {
        store.save(makeTask({ id: "tx-pre", prompt: "before" }));

        try {
          store.transaction(() => {
            store.save(makeTask({ id: "tx-fail-1", prompt: "first in tx" }));
            store.save(makeTask({ id: "tx-fail-2", prompt: "second in tx" }));
            store.save(makeTask({ id: "tx-fail-3", prompt: "third in tx" }));
            throw new Error("rollback!");
          });
        } catch {
          // Expected
        }
        // ALL tasks inside the failed transaction must be absent
        assert.strictEqual(store.get("tx-fail-1"), null, "first tx write should be rolled back");
        assert.strictEqual(store.get("tx-fail-2"), null, "second tx write should be rolled back");
        assert.strictEqual(store.get("tx-fail-3"), null, "third tx write should be rolled back");
        // Pre-existing task unaffected
        assert.ok(store.get("tx-pre") !== null);
        assert.strictEqual(store.list().length, 1, "only the pre-existing task should remain");
      } finally {
        cleanup();
      }
    });
  });

  // ── R3: INSERT safety — save updates existing rows without collision ──────

  describe("save INSERT safety (R3)", () => {
    it("save() inserts new task, then updates same id without creating duplicates", () => {
      const { store, cleanup } = makeTempStore();
      try {
        const task = makeTask({ id: "r3-test", status: "pending", output: "" });
        store.save(task);
        assert.strictEqual(store.get("r3-test")?.status, "pending");

        // Update via save
        task.status = "success";
        task.output = "done";
        store.save(task);

        assert.strictEqual(store.get("r3-test")?.status, "success");
        assert.strictEqual(store.get("r3-test")?.output, "done");
        // No duplicates
        assert.strictEqual(store.list().length, 1);
      } finally {
        cleanup();
      }
    });
  });

  // ── R9: JSON safety — corrupt data doesn't crash ──────────────────────────

  describe("JSON safety (R9)", () => {
    it("rowToTask handles corrupt events JSON gracefully", () => {
      const { store, cleanup } = makeTempStore();
      try {
        // Insert a task with valid data first
        store.save(makeTask({ id: "json-test" }));
        // Corrupt the events column directly
        (store as any).db.prepare("UPDATE tasks SET events = 'not-json' WHERE id = ?").run("json-test");
        // Should not throw
        const task = store.get("json-test");
        assert.ok(task !== null);
        assert.deepStrictEqual(task.events, [], "corrupt events should default to []");
      } finally {
        cleanup();
      }
    });

    it("rowToTask handles corrupt tags JSON gracefully", () => {
      const { store, cleanup } = makeTempStore();
      try {
        store.save(makeTask({ id: "tags-test" }));
        (store as any).db.prepare("UPDATE tasks SET tags = '{invalid' WHERE id = ?").run("tags-test");
        const task = store.get("tags-test");
        assert.ok(task !== null);
        assert.deepStrictEqual(task.tags, [], "corrupt tags should default to []");
      } finally {
        cleanup();
      }
    });

    it("getEvolutionLog handles corrupt JSON in evolution entries", () => {
      const { store, cleanup } = makeTempStore();
      try {
        store.saveEvolution({
          id: "evo-corrupt",
          roundNumber: 1,
          taskIds: ["t1"],
          analysis: { key: "val" },
          createdAt: new Date().toISOString(),
        });
        // Corrupt the task_ids and analysis columns
        (store as any).db.prepare("UPDATE evolution_log SET task_ids = 'bad', analysis = 'bad' WHERE id = ?").run("evo-corrupt");
        const log = store.getEvolutionLog();
        assert.strictEqual(log.length, 1);
        assert.deepStrictEqual(log[0].taskIds, [], "corrupt task_ids should default to []");
        assert.deepStrictEqual(log[0].analysis, {}, "corrupt analysis should default to {}");
      } finally {
        cleanup();
      }
    });
  });

  // ── close ───────────────────────────────────────────────────────────────────

  describe("close", () => {
    it("closes database connection", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-manager-test-"));
      const store = new Store(dir);
      try {
        store.save(makeTask({ id: "cl-1" }));
        store.close();
        assert.throws(() => store.get("cl-1"));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // ── getDailyStats ───────────────────────────────────────────────────────────

  describe("getDailyStats", () => {
    it("returns correct total, success, cost, successRate per day", () => {
      const { store, cleanup } = makeTempStore();
      try {
        const today = new Date().toISOString();
        store.save(makeTask({ id: "ds-1", status: "success", costUsd: 0.5, createdAt: today }));
        store.save(makeTask({ id: "ds-2", status: "failed", costUsd: 0.2, createdAt: today }));
        const daily = store.getDailyStats();
        assert.ok(daily.length > 0);
        const todayEntry = daily[0];
        assert.strictEqual(todayEntry.total, 2);
        assert.strictEqual(todayEntry.success, 1);
        assert.strictEqual(todayEntry.successRate, 0.5);
        assert.ok(Math.abs(todayEntry.cost - 0.7) < 0.001, `cost should be 0.7, got ${todayEntry.cost}`);
      } finally {
        cleanup();
      }
    });

    it("does NOT return 'count' field (known gotcha)", () => {
      const { store, cleanup } = makeTempStore();
      try {
        store.save(makeTask({ id: "ds-3", createdAt: new Date().toISOString() }));
        const daily = store.getDailyStats();
        assert.ok(daily.length > 0);
        assert.strictEqual((daily[0] as any).count, undefined, "count field must not exist");
      } finally {
        cleanup();
      }
    });

    it("groups tasks by calendar day", () => {
      const { store, cleanup } = makeTempStore();
      try {
        // Two days ago and yesterday (both within 7-day window)
        const day1 = new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10) + "T12:00:00.000Z";
        const day2 = new Date(Date.now() - 1 * 86400_000).toISOString().slice(0, 10) + "T12:00:00.000Z";
        store.save(makeTask({ id: "md-1", status: "success", costUsd: 1.0, createdAt: day1 }));
        store.save(makeTask({ id: "md-2", status: "failed", costUsd: 0.5, createdAt: day1 }));
        store.save(makeTask({ id: "md-3", status: "success", costUsd: 0.3, createdAt: day2 }));
        const daily = store.getDailyStats();
        assert.strictEqual(daily.length, 2, "should have 2 distinct days");
        // Newest first
        assert.strictEqual(daily[0].total, 1);
        assert.strictEqual(daily[1].total, 2);
      } finally {
        cleanup();
      }
    });

    it("excludes tasks older than 7 days", () => {
      const { store, cleanup } = makeTempStore();
      try {
        const old = new Date(Date.now() - 10 * 86400_000).toISOString();
        const recent = new Date().toISOString();
        store.save(makeTask({ id: "old-ds", createdAt: old }));
        store.save(makeTask({ id: "new-ds", createdAt: recent }));
        const daily = store.getDailyStats();
        assert.strictEqual(daily.length, 1, "old task should be excluded");
        assert.strictEqual(daily[0].total, 1);
      } finally {
        cleanup();
      }
    });

    it("handles empty data gracefully", () => {
      const { store, cleanup } = makeTempStore();
      try {
        const daily = store.getDailyStats();
        assert.deepStrictEqual(daily, []);
      } finally {
        cleanup();
      }
    });
  });

  // ── getSummaryStats ─────────────────────────────────────────────────────────

  describe("getSummaryStats", () => {
    it("returns aggregated stats across all tasks", () => {
      const { store, cleanup } = makeTempStore();
      try {
        const now = new Date().toISOString();
        store.save(makeTask({ id: "ss-1", status: "success", costUsd: 1.0, durationMs: 5000, createdAt: now }));
        store.save(makeTask({ id: "ss-2", status: "failed", costUsd: 0.5, durationMs: 3000, createdAt: now }));
        const summary = store.getSummaryStats();
        assert.strictEqual(summary.tasksToday, 2);
        assert.strictEqual(summary.totalTasksAllTime, 2);
        assert.ok(summary.successRateToday === 50, "50% success rate");
        assert.ok(Math.abs(summary.totalCostToday - 1.5) < 0.001);
        assert.ok(summary.avgDurationToday > 0);
      } finally {
        cleanup();
      }
    });

    it("handles empty database", () => {
      const { store, cleanup } = makeTempStore();
      try {
        const summary = store.getSummaryStats();
        assert.strictEqual(summary.tasksToday, 0);
        assert.strictEqual(summary.totalTasksAllTime, 0);
        assert.strictEqual(summary.successRateToday, 0);
        assert.strictEqual(summary.overallSuccessRate, 0);
      } finally {
        cleanup();
      }
    });
  });

  // ── getPerformanceMetrics ───────────────────────────────────────────────────

  describe("getPerformanceMetrics", () => {
    it("returns p50 and p90 duration", () => {
      const { store, cleanup } = makeTempStore();
      try {
        // Create 10 tasks with ascending durations
        for (let i = 1; i <= 10; i++) {
          store.save(makeTask({
            id: `pm-${i}`,
            status: "success",
            durationMs: i * 1000,
            costUsd: 0.1,
            createdAt: new Date().toISOString(),
          }));
        }
        const metrics = store.getPerformanceMetrics();
        assert.strictEqual(metrics.totalTasks, 10);
        assert.strictEqual(metrics.successCount, 10);
        assert.ok(metrics.p50DurationMs > 0, "p50 should be > 0");
        assert.ok(metrics.p90DurationMs >= metrics.p50DurationMs, "p90 >= p50");
        assert.ok(metrics.avgDurationMs > 0);
        assert.ok(Math.abs(metrics.totalCostUsd - 1.0) < 0.001);
      } finally {
        cleanup();
      }
    });

    it("returns avg cost and total cost", () => {
      const { store, cleanup } = makeTempStore();
      try {
        store.save(makeTask({ id: "pm-a", costUsd: 1.0, createdAt: new Date().toISOString() }));
        store.save(makeTask({ id: "pm-b", costUsd: 3.0, createdAt: new Date().toISOString() }));
        const metrics = store.getPerformanceMetrics();
        assert.ok(Math.abs(metrics.avgCostUsd - 2.0) < 0.001);
        assert.ok(Math.abs(metrics.totalCostUsd - 4.0) < 0.001);
      } finally {
        cleanup();
      }
    });

    it("handles empty database", () => {
      const { store, cleanup } = makeTempStore();
      try {
        const metrics = store.getPerformanceMetrics();
        assert.strictEqual(metrics.totalTasks, 0);
        assert.strictEqual(metrics.p50DurationMs, 0);
        assert.strictEqual(metrics.p90DurationMs, 0);
      } finally {
        cleanup();
      }
    });
  });

  // ── getFailurePatterns ──────────────────────────────────────────────────────

  describe("getFailurePatterns", () => {
    it("returns common error patterns from failed tasks", () => {
      const { store, cleanup } = makeTempStore();
      try {
        store.save(makeTask({ id: "fp-1", status: "failed", error: "tsc compile error", prompt: "fix types" }));
        store.save(makeTask({ id: "fp-2", status: "timeout", error: "timeout exceeded", prompt: "long task" }));
        store.save(makeTask({ id: "fp-3", status: "success", error: "", prompt: "good task" }));
        const patterns = store.getFailurePatterns();
        assert.strictEqual(patterns.length, 2, "only failed/timeout tasks");
        assert.ok(patterns.every((p) => typeof p.prompt === "string"));
        assert.ok(patterns.every((p) => typeof p.error === "string"));
        assert.ok(patterns.every((p) => typeof p.status === "string"));
      } finally {
        cleanup();
      }
    });

    it("truncates prompt to 200 chars", () => {
      const { store, cleanup } = makeTempStore();
      try {
        const longPrompt = "x".repeat(500);
        store.save(makeTask({ id: "fp-4", status: "failed", prompt: longPrompt, error: "err" }));
        const patterns = store.getFailurePatterns();
        assert.ok(patterns[0].prompt.length <= 200);
      } finally {
        cleanup();
      }
    });
  });

  // ── evolution ───────────────────────────────────────────────────────────────

  describe("evolution", () => {
    it("saveEvolution persists entry", () => {
      const { store, cleanup } = makeTempStore();
      try {
        const entry = {
          id: "evo-1",
          roundNumber: 1,
          taskIds: ["t1", "t2"],
          analysis: { successRate: 0.8 },
          createdAt: new Date().toISOString(),
        };
        store.saveEvolution(entry);
        const log = store.getEvolutionLog();
        assert.strictEqual(log.length, 1);
        assert.strictEqual(log[0].id, "evo-1");
        assert.strictEqual(log[0].roundNumber, 1);
        assert.deepStrictEqual(log[0].taskIds, ["t1", "t2"]);
        assert.deepStrictEqual(log[0].analysis, { successRate: 0.8 });
      } finally {
        cleanup();
      }
    });

    it("getEvolutionLog returns all entries ordered by created_at DESC", () => {
      const { store, cleanup } = makeTempStore();
      try {
        store.saveEvolution({ id: "evo-a", roundNumber: 1, taskIds: [], analysis: {}, createdAt: "2024-01-01T00:00:00.000Z" });
        store.saveEvolution({ id: "evo-b", roundNumber: 2, taskIds: [], analysis: {}, createdAt: "2024-01-03T00:00:00.000Z" });
        store.saveEvolution({ id: "evo-c", roundNumber: 3, taskIds: [], analysis: {}, createdAt: "2024-01-02T00:00:00.000Z" });
        const log = store.getEvolutionLog();
        assert.strictEqual(log.length, 3);
        assert.strictEqual(log[0].id, "evo-b", "newest first");
        assert.strictEqual(log[2].id, "evo-a", "oldest last");
      } finally {
        cleanup();
      }
    });

    it("getEvolutionLog returns empty array when no data", () => {
      const { store, cleanup } = makeTempStore();
      try {
        const log = store.getEvolutionLog();
        assert.deepStrictEqual(log, []);
      } finally {
        cleanup();
      }
    });
  });
});
