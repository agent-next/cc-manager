import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../scheduler.js";
import type { Task } from "../types.js";
import type { WorktreePool } from "../worktree-pool.js";
import type { AgentRunner } from "../agent-runner.js";
import type { Store } from "../store.js";

function makePool(): WorktreePool {
  return {
    available: 2,
    busy: 0,
    acquire: async () => ({ name: "w0", path: "/tmp/w0", branch: "worker/w0", busy: true }),
    release: async () => ({ merged: true }),
    init: async () => {},
    getStatus: () => [],
  } as unknown as WorktreePool;
}

function makeRunner(): AgentRunner {
  return {
    run: async (task: Task) => { task.status = "success"; task.durationMs = 100; return task; },
  } as unknown as AgentRunner;
}

function makeStore(): Store {
  const map = new Map<string, Task>();
  return {
    save: (t: Task) => { map.set(t.id, t); },
    get: (id: string) => map.get(id) ?? null,
    list: () => [...map.values()],
    stats: () => ({ total: map.size, byStatus: {} as Record<string, number>, totalCost: 0 }),
    close: () => {},
  } as unknown as Store;
}

describe("Scheduler", () => {
  it("submit() creates a task and listTasks() returns it", () => {
    const s = new Scheduler(makePool(), makeRunner(), makeStore());
    const task = s.submit("hello");
    assert.ok(task.id);
    assert.strictEqual(task.prompt, "hello");
    assert.strictEqual(task.status, "pending");
    const all = s.listTasks();
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].id, task.id);
  });

  it("getTask() retrieves by id, undefined for missing", () => {
    const s = new Scheduler(makePool(), makeRunner(), makeStore());
    const task = s.submit("find me");
    assert.strictEqual(s.getTask(task.id)?.id, task.id);
    assert.strictEqual(s.getTask("nope"), undefined);
  });

  it("cancel() a pending task sets status to cancelled", () => {
    const s = new Scheduler(makePool(), makeRunner(), makeStore());
    const task = s.submit("cancel me");
    assert.strictEqual(s.cancel(task.id), true);
    assert.strictEqual(s.getTask(task.id)?.status, "cancelled");
    assert.strictEqual(s.cancel(task.id), false); // no longer pending
  });

  it("getStats() returns correct counts", () => {
    const s = new Scheduler(makePool(), makeRunner(), makeStore());
    s.submit("a");
    s.submit("b");
    const stats = s.getStats();
    assert.strictEqual(stats.total, 2);
    assert.strictEqual(stats.queueSize, 2);
    assert.strictEqual(stats.activeWorkers, 0);
    assert.strictEqual(stats.availableWorkers, 2);
  });

  it("submit() adds task to queue and emits task_queued event", () => {
    const events: Record<string, unknown>[] = [];
    const s = new Scheduler(makePool(), makeRunner(), makeStore(), (ev) => events.push(ev));
    const task = s.submit("queued task");
    assert.strictEqual(s.getQueueDepth(), 1);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, "task_queued");
    assert.strictEqual(events[0].taskId, task.id);
    assert.strictEqual(events[0].queueSize, 1);
  });

  it("cancel() removes a pending task from the queue", () => {
    const s = new Scheduler(makePool(), makeRunner(), makeStore());
    const task = s.submit("to be removed");
    assert.strictEqual(s.getQueueDepth(), 1);
    const result = s.cancel(task.id);
    assert.strictEqual(result, true);
    assert.strictEqual(s.getQueueDepth(), 0);
    assert.strictEqual(s.getTask(task.id)?.status, "cancelled");
  });

  it("getStats() returns correct counts with multiple tasks and pool state", () => {
    const s = new Scheduler(makePool(), makeRunner(), makeStore());
    s.submit("x");
    s.submit("y");
    s.submit("z");
    const stats = s.getStats();
    assert.strictEqual(stats.total, 3);
    assert.strictEqual(stats.queueSize, 3);
    assert.strictEqual(stats.activeWorkers, 0);
    assert.strictEqual(stats.availableWorkers, 2);
    assert.strictEqual(stats.avgDurationMs, 0);
    assert.strictEqual(stats.totalBudgetLimit, 0);
  });

  it("getQueuePosition() returns correct position for each task", () => {
    const s = new Scheduler(makePool(), makeRunner(), makeStore());
    const t1 = s.submit("first");
    const t2 = s.submit("second");
    assert.strictEqual(s.getQueuePosition(t1.id), 1);
    assert.strictEqual(s.getQueuePosition(t2.id), 2);
    assert.strictEqual(s.getQueuePosition("nonexistent"), -1);
    s.cancel(t1.id);
    // t1 is cancelled and removed from the queue
    assert.strictEqual(s.getQueuePosition(t1.id), -1);
    // t2 is now first in the queue
    assert.strictEqual(s.getQueuePosition(t2.id), 1);
  });
});
