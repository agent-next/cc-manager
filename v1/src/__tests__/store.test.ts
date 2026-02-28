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
  });
});
