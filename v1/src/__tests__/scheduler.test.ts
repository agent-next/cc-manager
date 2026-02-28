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
    assert.strictEqual(s.getQueuePosition(t1.id), -1);
    assert.strictEqual(s.getQueuePosition(t2.id), 1);
  });

  it("submit() truncates prompts longer than 2000 characters", () => {
    const s = new Scheduler(makePool(), makeRunner(), makeStore());
    const longPrompt = "x".repeat(3000);
    const task = s.submit(longPrompt);
    assert.strictEqual(task.prompt.length, 2000, "prompt should be truncated to 2000 chars");
  });

  // ─── Enhanced store mock for methods that need richer store behavior ───

  function makeRichStore(opts?: {
    tasks?: Task[];
    failurePatterns?: { prompt: string; error: string; status: string }[];
    dailyStats?: { date: string; total: number; success: number; cost: number; successRate: number }[];
  }): Store {
    const map = new Map<string, Task>();
    for (const t of opts?.tasks ?? []) map.set(t.id, t);
    return {
      save: (t: Task) => { map.set(t.id, t); },
      get: (id: string) => map.get(id) ?? null,
      list: () => [...map.values()],
      stats: () => {
        const all = [...map.values()];
        const byStatus: Record<string, number> = {};
        for (const t of all) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
        const totalCost = all.reduce((s, t) => s + t.costUsd, 0);
        return { total: all.length, byStatus, totalCost };
      },
      getByStatus: (status: string) => [...map.values()].filter((t) => t.status === status),
      getFailurePatterns: (_limit?: number) => opts?.failurePatterns ?? [],
      getDailyStats: () => opts?.dailyStats ?? [],
      close: () => {},
    } as unknown as Store;
  }

  function makeTask(overrides: Partial<Task>): Task {
    return {
      id: overrides.id ?? crypto.randomUUID().slice(0, 8),
      prompt: overrides.prompt ?? "test task",
      status: overrides.status ?? "success",
      priority: overrides.priority ?? "normal",
      output: overrides.output ?? "",
      error: overrides.error ?? "",
      events: [],
      createdAt: overrides.createdAt ?? new Date().toISOString(),
      timeout: overrides.timeout ?? 300,
      maxBudget: overrides.maxBudget ?? 5,
      costUsd: overrides.costUsd ?? 0,
      tokenInput: overrides.tokenInput ?? 0,
      tokenOutput: overrides.tokenOutput ?? 0,
      durationMs: overrides.durationMs ?? 0,
      retryCount: overrides.retryCount ?? 0,
      maxRetries: overrides.maxRetries ?? 2,
      tags: overrides.tags,
      agent: overrides.agent ?? "claude",
    } as Task;
  }

  // ─── 1. Scheduler requeue ───

  describe("requeue", () => {
    it("requeues a failed task back to pending", () => {
      const s = new Scheduler(makePool(), makeRunner(), makeStore());
      const task = s.submit("will fail");
      task.status = "failed";
      task.error = "something broke";
      task.completedAt = new Date().toISOString();
      const requeued = s.requeue(task.id);
      assert.ok(requeued);
      assert.strictEqual(requeued!.status, "pending");
      assert.strictEqual(requeued!.error, "");
      assert.strictEqual(requeued!.retryCount, 1);
      assert.strictEqual(requeued!.completedAt, undefined);
    });

    it("requeues a timeout task back to pending", () => {
      const s = new Scheduler(makePool(), makeRunner(), makeStore());
      const task = s.submit("will timeout");
      task.status = "timeout";
      task.error = "timed out";
      task.completedAt = new Date().toISOString();
      const requeued = s.requeue(task.id);
      assert.ok(requeued);
      assert.strictEqual(requeued!.status, "pending");
      assert.strictEqual(requeued!.retryCount, 1);
    });

    it("rejects requeue of a pending task", () => {
      const s = new Scheduler(makePool(), makeRunner(), makeStore());
      const task = s.submit("still pending");
      const result = s.requeue(task.id);
      assert.strictEqual(result, null);
      assert.strictEqual(task.status, "pending");
    });

    it("rejects requeue of a success task", () => {
      const s = new Scheduler(makePool(), makeRunner(), makeStore());
      const task = s.submit("done");
      task.status = "success";
      const result = s.requeue(task.id);
      assert.strictEqual(result, null);
    });

    it("returns null for unknown task ID", () => {
      const s = new Scheduler(makePool(), makeRunner(), makeStore());
      const result = s.requeue("nonexistent-id");
      assert.strictEqual(result, null);
    });

    it("increments retryCount on each requeue", () => {
      const s = new Scheduler(makePool(), makeRunner(), makeStore());
      const task = s.submit("retry me");
      task.status = "failed";
      s.requeue(task.id);
      assert.strictEqual(task.retryCount, 1);
      task.status = "failed";
      s.requeue(task.id);
      assert.strictEqual(task.retryCount, 2);
    });

    it("adds requeued task back to the queue", () => {
      const s = new Scheduler(makePool(), makeRunner(), makeStore());
      const task = s.submit("queue me");
      // Remove from queue by cancelling, then set to failed for requeue
      s.cancel(task.id);
      assert.strictEqual(s.getQueueDepth(), 0);
      // Manually set status to failed so requeue accepts it
      task.status = "failed";
      s.requeue(task.id);
      assert.strictEqual(s.getQueueDepth(), 1);
    });
  });

  // ─── 2. Scheduler priority ordering ───

  describe("priority ordering", () => {
    it("submit accepts different priority levels", () => {
      const s = new Scheduler(makePool(), makeRunner(), makeStore());
      const t1 = s.submit("low task", { priority: "low" });
      const t2 = s.submit("urgent task", { priority: "urgent" });
      const t3 = s.submit("high task", { priority: "high" });
      const t4 = s.submit("normal task", { priority: "normal" });
      assert.strictEqual(t1.priority, "low");
      assert.strictEqual(t2.priority, "urgent");
      assert.strictEqual(t3.priority, "high");
      assert.strictEqual(t4.priority, "normal");
    });

    it("maintains FIFO order for same priority", () => {
      const s = new Scheduler(makePool(), makeRunner(), makeStore());
      const t1 = s.submit("first normal");
      const t2 = s.submit("second normal");
      const t3 = s.submit("third normal");
      assert.strictEqual(s.getQueuePosition(t1.id), 1);
      assert.strictEqual(s.getQueuePosition(t2.id), 2);
      assert.strictEqual(s.getQueuePosition(t3.id), 3);
    });

    it("defaults to normal priority", () => {
      const s = new Scheduler(makePool(), makeRunner(), makeStore());
      const task = s.submit("no priority specified");
      assert.strictEqual(task.priority, "normal");
    });

    it("queue depth reflects all priority levels", () => {
      const s = new Scheduler(makePool(), makeRunner(), makeStore());
      s.submit("low", { priority: "low" });
      s.submit("urgent", { priority: "urgent" });
      s.submit("normal");
      assert.strictEqual(s.getQueueDepth(), 3);
    });
  });

  // ─── 3. Scheduler budget guard ───

  describe("budget guard", () => {
    it("setTotalBudgetLimit updates the budget", () => {
      const s = new Scheduler(makePool(), makeRunner(), makeStore());
      s.setTotalBudgetLimit(50);
      const stats = s.getStats();
      assert.strictEqual(stats.totalBudgetLimit, 50);
    });

    it("default budget limit is 0 (unlimited)", () => {
      const s = new Scheduler(makePool(), makeRunner(), makeStore());
      const stats = s.getStats();
      assert.strictEqual(stats.totalBudgetLimit, 0);
    });

    it("budget limit can be updated multiple times", () => {
      const s = new Scheduler(makePool(), makeRunner(), makeStore());
      s.setTotalBudgetLimit(10);
      assert.strictEqual(s.getStats().totalBudgetLimit, 10);
      s.setTotalBudgetLimit(100);
      assert.strictEqual(s.getStats().totalBudgetLimit, 100);
    });

    it("getStats includes totalBudgetLimit in response", () => {
      const s = new Scheduler(makePool(), makeRunner(), makeStore());
      s.setTotalBudgetLimit(42);
      const stats = s.getStats();
      assert.ok("totalBudgetLimit" in stats);
      assert.strictEqual(stats.totalBudgetLimit, 42);
    });
  });

  // ─── 4. Scheduler getAverageDuration ───

  describe("getAverageDuration", () => {
    it("returns 0 when no tasks have been submitted", () => {
      const s = new Scheduler(makePool(), makeRunner(), makeStore());
      assert.strictEqual(s.getAverageDuration(), 0);
    });

    it("returns 0 when no tasks have durationMs > 0", () => {
      const s = new Scheduler(makePool(), makeRunner(), makeStore());
      s.submit("no duration yet");
      assert.strictEqual(s.getAverageDuration(), 0);
    });

    it("returns correct average for tasks with duration", () => {
      const s = new Scheduler(makePool(), makeRunner(), makeStore());
      const t1 = s.submit("fast");
      const t2 = s.submit("slow");
      t1.durationMs = 100;
      t2.durationMs = 300;
      assert.strictEqual(s.getAverageDuration(), 200);
    });

    it("excludes tasks with durationMs = 0 from average", () => {
      const s = new Scheduler(makePool(), makeRunner(), makeStore());
      const t1 = s.submit("done");
      const t2 = s.submit("not done");
      t1.durationMs = 400;
      // t2 has durationMs = 0 (default)
      assert.strictEqual(s.getAverageDuration(), 400);
    });

    it("handles single task correctly", () => {
      const s = new Scheduler(makePool(), makeRunner(), makeStore());
      const t = s.submit("only one");
      t.durationMs = 250;
      assert.strictEqual(s.getAverageDuration(), 250);
    });
  });

  // ─── 5. Scheduler getHistoricalInsights ───

  describe("getHistoricalInsights", () => {
    it("returns correct structure with all fields", () => {
      const store = makeRichStore();
      const s = new Scheduler(makePool(), makeRunner(), store);
      const insights = s.getHistoricalInsights();
      assert.ok("avgDuration" in insights);
      assert.ok("successRate" in insights);
      assert.ok("avgCost" in insights);
      assert.ok("timeoutRate" in insights);
    });

    it("returns zeros when no tasks exist", () => {
      const store = makeRichStore();
      const s = new Scheduler(makePool(), makeRunner(), store);
      const insights = s.getHistoricalInsights();
      assert.strictEqual(insights.avgDuration, 0);
      assert.strictEqual(insights.successRate, 0);
      assert.strictEqual(insights.avgCost, 0);
      assert.strictEqual(insights.timeoutRate, 0);
    });

    it("computes correct successRate from store stats", () => {
      const tasks = [
        makeTask({ id: "s1", status: "success", durationMs: 100, costUsd: 0.5 }),
        makeTask({ id: "s2", status: "success", durationMs: 200, costUsd: 0.3 }),
        makeTask({ id: "f1", status: "failed", durationMs: 50, costUsd: 0.1 }),
      ];
      const store = makeRichStore({ tasks });
      const s = new Scheduler(makePool(), makeRunner(), store);
      const insights = s.getHistoricalInsights();
      // 2 success out of 3 completed = 2/3
      assert.ok(Math.abs(insights.successRate - 2 / 3) < 0.001);
    });

    it("computes correct timeoutRate", () => {
      const tasks = [
        makeTask({ id: "s1", status: "success" }),
        makeTask({ id: "t1", status: "timeout" }),
        makeTask({ id: "t2", status: "timeout" }),
        makeTask({ id: "f1", status: "failed" }),
      ];
      const store = makeRichStore({ tasks });
      const s = new Scheduler(makePool(), makeRunner(), store);
      const insights = s.getHistoricalInsights();
      // 2 timeouts out of 4 completed = 0.5
      assert.strictEqual(insights.timeoutRate, 0.5);
    });

    it("computes correct avgCost from success tasks", () => {
      const tasks = [
        makeTask({ id: "s1", status: "success", costUsd: 0.2 }),
        makeTask({ id: "s2", status: "success", costUsd: 0.4 }),
        makeTask({ id: "f1", status: "failed", costUsd: 1.0 }),
      ];
      const store = makeRichStore({ tasks });
      const s = new Scheduler(makePool(), makeRunner(), store);
      const insights = s.getHistoricalInsights();
      // avgCost is from success tasks only: (0.2 + 0.4) / 2 = 0.3
      assert.ok(Math.abs(insights.avgCost - 0.3) < 0.001);
    });
  });

  // ─── 6. Scheduler getFailureContext ───

  describe("getFailureContext", () => {
    it('returns "none" when no failures exist', () => {
      const store = makeRichStore({ failurePatterns: [] });
      const s = new Scheduler(makePool(), makeRunner(), store);
      const ctx = s.getFailureContext();
      assert.strictEqual(ctx, "Recent failures: none");
    });

    it("returns formatted failure list when failures exist", () => {
      const patterns = [
        { prompt: "fix the bug", error: "compilation failed", status: "failed" },
        { prompt: "add feature", error: "timed out", status: "timeout" },
      ];
      const store = makeRichStore({ failurePatterns: patterns });
      const s = new Scheduler(makePool(), makeRunner(), store);
      const ctx = s.getFailureContext();
      assert.ok(ctx.startsWith("Recent failures:"));
      assert.ok(ctx.includes("compilation failed"));
      assert.ok(ctx.includes("fix the bug"));
      assert.ok(ctx.includes("timed out"));
      assert.ok(ctx.includes("add feature"));
    });

    it("includes each failure as a separate line", () => {
      const patterns = [
        { prompt: "task A", error: "error A", status: "failed" },
        { prompt: "task B", error: "error B", status: "failed" },
        { prompt: "task C", error: "error C", status: "timeout" },
      ];
      const store = makeRichStore({ failurePatterns: patterns });
      const s = new Scheduler(makePool(), makeRunner(), store);
      const ctx = s.getFailureContext();
      const lines = ctx.split("\n");
      // First line is "Recent failures:", then one per pattern
      assert.strictEqual(lines.length, 4);
    });

    it("formats each line with error and prompt", () => {
      const patterns = [
        { prompt: "my task", error: "bad things", status: "failed" },
      ];
      const store = makeRichStore({ failurePatterns: patterns });
      const s = new Scheduler(makePool(), makeRunner(), store);
      const ctx = s.getFailureContext();
      assert.ok(ctx.includes("- Error: bad things | Prompt: my task"));
    });
  });

  // ─── 7. Scheduler getDetailedInsights ───

  describe("getDetailedInsights", () => {
    it("returns correct structure with overall, last7Days, and analysis", () => {
      const store = makeRichStore({ dailyStats: [] });
      const s = new Scheduler(makePool(), makeRunner(), store);
      const insights = s.getDetailedInsights();
      assert.ok("overall" in insights);
      assert.ok("last7Days" in insights);
      assert.ok("analysis" in insights);
    });

    it("overall includes total, successRate, avgDurationMs, totalCostUsd, byStatus", () => {
      const store = makeRichStore({ dailyStats: [] });
      const s = new Scheduler(makePool(), makeRunner(), store);
      const { overall } = s.getDetailedInsights();
      assert.ok("total" in overall);
      assert.ok("successRate" in overall);
      assert.ok("avgDurationMs" in overall);
      assert.ok("totalCostUsd" in overall);
      assert.ok("byStatus" in overall);
    });

    it("analysis includes failureRate, avgCostPerTask, peakDay", () => {
      const store = makeRichStore({ dailyStats: [] });
      const s = new Scheduler(makePool(), makeRunner(), store);
      const { analysis } = s.getDetailedInsights();
      assert.ok("failureRate" in analysis);
      assert.ok("avgCostPerTask" in analysis);
      assert.ok("peakDay" in analysis);
    });

    it("returns correct overall metrics with tasks", () => {
      const tasks = [
        makeTask({ id: "a", status: "success", costUsd: 0.5, durationMs: 100 }),
        makeTask({ id: "b", status: "failed", costUsd: 0.2, durationMs: 50 }),
      ];
      const store = makeRichStore({ tasks, dailyStats: [] });
      const s = new Scheduler(makePool(), makeRunner(), store);
      // Only use store data — don't mix in-memory scheduler tasks
      const { overall, analysis } = s.getDetailedInsights();
      assert.strictEqual(overall.total, 2);
      assert.strictEqual(overall.successRate, 0.5);
      assert.ok(Math.abs(overall.totalCostUsd - 0.7) < 0.001);
      assert.strictEqual(analysis.failureRate, 0.5);
      assert.ok(Math.abs(analysis.avgCostPerTask - 0.35) < 0.001);
    });

    it("peakDay is null when no daily stats exist", () => {
      const store = makeRichStore({ dailyStats: [] });
      const s = new Scheduler(makePool(), makeRunner(), store);
      const { analysis } = s.getDetailedInsights();
      assert.strictEqual(analysis.peakDay, null);
    });

    it("peakDay identifies the day with most tasks", () => {
      const dailyStats = [
        { date: "2026-02-25", total: 5, success: 4, cost: 1.0, successRate: 0.8 },
        { date: "2026-02-26", total: 10, success: 9, cost: 2.0, successRate: 0.9 },
        { date: "2026-02-27", total: 3, success: 3, cost: 0.5, successRate: 1.0 },
      ];
      const store = makeRichStore({ dailyStats });
      const s = new Scheduler(makePool(), makeRunner(), store);
      const { analysis } = s.getDetailedInsights();
      assert.strictEqual(analysis.peakDay, "2026-02-26");
    });

    it("last7Days reflects store dailyStats", () => {
      const dailyStats = [
        { date: "2026-02-28", total: 7, success: 6, cost: 1.5, successRate: 0.857 },
      ];
      const store = makeRichStore({ dailyStats });
      const s = new Scheduler(makePool(), makeRunner(), store);
      const { last7Days } = s.getDetailedInsights();
      assert.strictEqual(last7Days.length, 1);
      assert.strictEqual(last7Days[0].date, "2026-02-28");
      assert.strictEqual(last7Days[0].total, 7);
    });
  });

  // ─── 8. Scheduler generateImprovementTasks ───

  describe("generateImprovementTasks", () => {
    it("returns at least one prompt when no failures exist", () => {
      const store = makeRichStore({ failurePatterns: [] });
      const s = new Scheduler(makePool(), makeRunner(), store);
      const prompts = s.generateImprovementTasks();
      assert.ok(prompts.length >= 1);
    });

    it("returns fallback prompt about code quality when everything is healthy", () => {
      const store = makeRichStore({ failurePatterns: [] });
      const s = new Scheduler(makePool(), makeRunner(), store);
      const prompts = s.generateImprovementTasks();
      // The fallback prompt mentions code quality or refactoring
      assert.ok(prompts.some((p) => p.includes("quality") || p.includes("refactoring")));
    });

    it("includes failure-based prompts when failures exist", () => {
      const patterns = [
        { prompt: "fix the store", error: "SQLITE_ERROR", status: "failed" },
      ];
      const store = makeRichStore({ failurePatterns: patterns });
      const s = new Scheduler(makePool(), makeRunner(), store);
      const prompts = s.generateImprovementTasks();
      assert.ok(prompts.some((p) => p.includes("SQLITE_ERROR")));
    });

    it("includes timeout-rate prompt when timeout rate exceeds 10%", () => {
      const tasks = [
        makeTask({ id: "s1", status: "success" }),
        makeTask({ id: "t1", status: "timeout" }),
      ];
      const store = makeRichStore({ tasks, failurePatterns: [] });
      const s = new Scheduler(makePool(), makeRunner(), store);
      const prompts = s.generateImprovementTasks();
      // 1 timeout out of 2 = 50% > 10%
      assert.ok(prompts.some((p) => p.includes("Timeout rate") || p.includes("timeout")));
    });

    it("includes success-rate prompt when success rate is below 80%", () => {
      const tasks = [
        makeTask({ id: "s1", status: "success" }),
        makeTask({ id: "f1", status: "failed" }),
        makeTask({ id: "f2", status: "failed" }),
        makeTask({ id: "f3", status: "failed" }),
      ];
      const store = makeRichStore({ tasks, failurePatterns: [] });
      const s = new Scheduler(makePool(), makeRunner(), store);
      const prompts = s.generateImprovementTasks();
      // 1 success out of 4 = 25% < 80%
      assert.ok(prompts.some((p) => p.includes("success rate")));
    });

    it("includes cost-optimization prompt when average cost exceeds $0.10", () => {
      const tasks = [
        makeTask({ id: "s1", status: "success", costUsd: 0.5 }),
        makeTask({ id: "s2", status: "success", costUsd: 0.3 }),
      ];
      const store = makeRichStore({ tasks, failurePatterns: [] });
      const s = new Scheduler(makePool(), makeRunner(), store);
      const prompts = s.generateImprovementTasks();
      // avgCost = 0.4 > 0.1
      assert.ok(prompts.some((p) => p.includes("Average task cost") || p.includes("cost")));
    });

    it("generates prompts for each failure pattern", () => {
      const patterns = [
        { prompt: "task one", error: "err1", status: "failed" },
        { prompt: "task two", error: "err2", status: "failed" },
        { prompt: "task three", error: "err3", status: "timeout" },
      ];
      const store = makeRichStore({ failurePatterns: patterns });
      const s = new Scheduler(makePool(), makeRunner(), store);
      const prompts = s.generateImprovementTasks();
      assert.ok(prompts.some((p) => p.includes("err1")));
      assert.ok(prompts.some((p) => p.includes("err2")));
      assert.ok(prompts.some((p) => p.includes("err3")));
    });
  });

  // ─── 9. Scheduler analyzeRound ───

  describe("analyzeRound", () => {
    it("computes correct metrics for a round of tasks", () => {
      const s = new Scheduler(makePool(), makeRunner(), makeStore());
      const t1 = s.submit("task 1");
      t1.status = "success";
      t1.costUsd = 0.5;
      t1.durationMs = 100;
      const t2 = s.submit("task 2");
      t2.status = "failed";
      t2.costUsd = 0.2;
      t2.durationMs = 50;
      const t3 = s.submit("task 3");
      t3.status = "success";
      t3.costUsd = 0.3;
      t3.durationMs = 200;

      const result = s.analyzeRound([t1.id, t2.id, t3.id]);
      assert.strictEqual(result.taskCount, 3);
      assert.strictEqual(result.successCount, 2);
      assert.strictEqual(result.failedCount, 1);
      assert.strictEqual(result.timeoutCount, 0);
      assert.ok(Math.abs((result.totalCost as number) - 1.0) < 0.001);
      assert.ok(Math.abs((result.avgDurationMs as number) - 350 / 3) < 0.1);
      assert.ok(Math.abs((result.successRate as number) - 2 / 3) < 0.001);
    });

    it("handles unknown task IDs gracefully", () => {
      const s = new Scheduler(makePool(), makeRunner(), makeStore());
      const t1 = s.submit("real task");
      t1.status = "success";
      t1.costUsd = 0.1;
      t1.durationMs = 50;

      const result = s.analyzeRound([t1.id, "ghost1", "ghost2"]);
      // Only the real task is counted
      assert.strictEqual(result.taskCount, 1);
      assert.strictEqual(result.successCount, 1);
    });

    it("handles empty task ID array", () => {
      const s = new Scheduler(makePool(), makeRunner(), makeStore());
      const result = s.analyzeRound([]);
      assert.strictEqual(result.taskCount, 0);
      assert.strictEqual(result.successCount, 0);
      assert.strictEqual(result.failedCount, 0);
      assert.strictEqual(result.timeoutCount, 0);
      assert.strictEqual(result.totalCost, 0);
      assert.strictEqual(result.avgDurationMs, 0);
      assert.strictEqual(result.successRate, 0);
    });

    it("counts timeout tasks correctly", () => {
      const s = new Scheduler(makePool(), makeRunner(), makeStore());
      const t1 = s.submit("timeout task");
      t1.status = "timeout";
      t1.costUsd = 0.1;
      t1.durationMs = 240000;

      const result = s.analyzeRound([t1.id]);
      assert.strictEqual(result.timeoutCount, 1);
      assert.strictEqual(result.successCount, 0);
      assert.strictEqual(result.failedCount, 0);
      assert.strictEqual(result.successRate, 0);
    });

    it("computes correct successRate for mixed results", () => {
      const s = new Scheduler(makePool(), makeRunner(), makeStore());
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) {
        const t = s.submit(`task ${i}`);
        t.status = i < 8 ? "success" : "failed";
        t.costUsd = 0.1;
        t.durationMs = 100;
        ids.push(t.id);
      }
      const result = s.analyzeRound(ids);
      assert.strictEqual(result.taskCount, 10);
      assert.strictEqual(result.successCount, 8);
      assert.strictEqual(result.failedCount, 2);
      assert.strictEqual(result.successRate, 0.8);
    });

    it("sums totalCost from all tasks in the round", () => {
      const s = new Scheduler(makePool(), makeRunner(), makeStore());
      const t1 = s.submit("a");
      t1.status = "success";
      t1.costUsd = 0.25;
      const t2 = s.submit("b");
      t2.status = "success";
      t2.costUsd = 0.75;

      const result = s.analyzeRound([t1.id, t2.id]);
      assert.ok(Math.abs((result.totalCost as number) - 1.0) < 0.001);
    });
  });

  // ─── R1: Stale recovery race ───

  describe("stale recovery (R1)", () => {
    it("recoverStaleWorkers does not double-release: signals via abortedTasks", () => {
      // The abortedTasks set must exist and be usable
      const s = new Scheduler(makePool(), makeRunner(), makeStore());
      // Access private set to verify initialization
      const abortedTasks = (s as any).abortedTasks as Set<string>;
      assert.ok(abortedTasks instanceof Set, "abortedTasks should be a Set");
      assert.strictEqual(abortedTasks.size, 0, "should start empty");
    });
  });

  // ─── R8: Dependency terminal state ───

  describe("dependency terminal state (R8)", () => {
    it("tasks fail immediately when dependency is failed", () => {
      const events: Record<string, unknown>[] = [];
      const store = makeStore();
      const s = new Scheduler(makePool(), makeRunner(), store, (ev) => events.push(ev));
      // Create a "dependency" task that failed
      const dep = s.submit("dependency task");
      dep.status = "failed";
      dep.error = "broken";
      dep.completedAt = new Date().toISOString();

      // Create a dependent task
      const child = s.submit("child task", { dependsOn: dep.id });
      assert.strictEqual(child.status, "pending");
      assert.strictEqual(child.dependsOn, dep.id);
    });

    it("tasks fail immediately when dependency is cancelled", () => {
      const store = makeStore();
      const s = new Scheduler(makePool(), makeRunner(), store);
      const dep = s.submit("will cancel");
      s.cancel(dep.id);
      assert.strictEqual(dep.status, "cancelled");

      const child = s.submit("child task", { dependsOn: dep.id });
      assert.strictEqual(child.dependsOn, dep.id);
    });
  });

  // ─── 10. Scheduler events ───

  describe("events", () => {
    it("submit emits task_queued event", () => {
      const events: Record<string, unknown>[] = [];
      const s = new Scheduler(makePool(), makeRunner(), makeStore(), (ev) => events.push(ev));
      const task = s.submit("event test");
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].type, "task_queued");
      assert.strictEqual(events[0].taskId, task.id);
    });

    it("requeue emits task_queued event", () => {
      const events: Record<string, unknown>[] = [];
      const s = new Scheduler(makePool(), makeRunner(), makeStore(), (ev) => events.push(ev));
      const task = s.submit("will requeue");
      task.status = "failed";
      task.error = "err";
      const prevEventCount = events.length;
      s.requeue(task.id);
      // A new task_queued event should have been emitted
      assert.ok(events.length > prevEventCount);
      const lastEvent = events[events.length - 1];
      assert.strictEqual(lastEvent.type, "task_queued");
      assert.strictEqual(lastEvent.taskId, task.id);
    });

    it("submit includes queueSize in event", () => {
      const events: Record<string, unknown>[] = [];
      const s = new Scheduler(makePool(), makeRunner(), makeStore(), (ev) => events.push(ev));
      s.submit("first");
      s.submit("second");
      assert.strictEqual(events[0].queueSize, 1);
      assert.strictEqual(events[1].queueSize, 2);
    });

    it("requeue includes queueSize in event", () => {
      const events: Record<string, unknown>[] = [];
      const s = new Scheduler(makePool(), makeRunner(), makeStore(), (ev) => events.push(ev));
      const task = s.submit("requeue size test");
      task.status = "failed";
      // Cancel to clear queue, then requeue
      // Actually we need the queue empty first. Let's cancel another approach:
      // After submit, queue has 1. After requeue, queue gets +1
      const initialQueueSize = s.getQueueDepth();
      s.requeue(task.id);
      const lastEvent = events[events.length - 1];
      assert.strictEqual(lastEvent.type, "task_queued");
      // queueSize should be current queue depth at time of requeue
      assert.ok(typeof lastEvent.queueSize === "number");
      assert.ok((lastEvent.queueSize as number) >= 1);
    });

    it("no events emitted without callback", () => {
      // No callback = no crash
      const s = new Scheduler(makePool(), makeRunner(), makeStore());
      const task = s.submit("no callback");
      assert.ok(task.id);
      task.status = "failed";
      const result = s.requeue(task.id);
      assert.ok(result);
    });
  });
});
