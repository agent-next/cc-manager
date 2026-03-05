import type { Task } from "./types.js";
import { createTask } from "./types.js";
import { WorktreePool } from "./worktree-pool.js";
import { AgentRunner } from "./agent-runner.js";
import { Store } from "./store.js";
import { log } from "./logger.js";

type EventCallback = (event: Record<string, unknown>) => void;

export class Scheduler {
  private queue: Task[] = [];
  private activeWorkers = new Set<string>();
  private running = false;
  private tasks = new Map<string, Task>();
  private totalBudgetLimit = 0;
  private metricsInterval?: ReturnType<typeof setInterval>;
  private recoveryInterval?: ReturnType<typeof setInterval>;
  private progressIntervals = new Map<string, ReturnType<typeof setInterval>>();
  private dispatchResolve?: () => void;
  private abortedTasks = new Set<string>();

  setTotalBudgetLimit(usd: number): void {
    this.totalBudgetLimit = usd;
    log("info", "total budget limit set", { totalBudgetLimit: usd });
  }

  constructor(
    private pool: WorktreePool,
    private runner: AgentRunner,
    private store: Store,
    private onEvent?: EventCallback,
  ) {}

  start(): void {
    this.running = true;
    this.loop();
    this.metricsInterval = setInterval(() => this.logMetrics(), 60_000);
    this.recoveryInterval = setInterval(() => void this.recoverStaleWorkers(), 60_000);
    log("info", "scheduler started");
  }

  async stop(): Promise<void> {
    log("info", "scheduler stopping");
    this.running = false;
    clearInterval(this.metricsInterval);
    clearInterval(this.recoveryInterval);
    // Wait for active workers
    while (this.activeWorkers.size > 0) {
      log("info", "waiting for workers", { active: this.activeWorkers.size });
      await new Promise((r) => setTimeout(r, 1000));
    }
    log("info", "scheduler stopped");
  }

  private validateTask(task: Task): void {
    if (typeof task.prompt !== "string" || task.prompt.trim() === "") {
      throw new Error("Task prompt must be a non-empty string");
    }
    if (typeof task.timeout !== "number" || task.timeout <= 0) {
      throw new Error("Task timeout must be a positive number");
    }
    if (typeof task.maxBudget !== "number" || task.maxBudget < 0) {
      throw new Error("Task maxBudget must be a non-negative number");
    }
    const validPriorities: import("./types.js").TaskPriority[] = ["urgent", "high", "normal", "low"];
    if (!validPriorities.includes(task.priority)) {
      throw new Error(`Task priority must be one of: urgent, high, normal, low`);
    }
  }

  submit(prompt: string, opts?: { id?: string; timeout?: number; maxBudget?: number; priority?: import("./types.js").TaskPriority; dependsOn?: string; webhookUrl?: string; tags?: string[]; agent?: string }): Task {
    if (prompt.length > 2000) {
      log("warn", "prompt exceeds context budget, truncating", { originalLength: prompt.length });
      prompt = prompt.slice(0, 2000);
    }
    const task = createTask(prompt, opts);
    this.validateTask(task);
    this.tasks.set(task.id, task);
    this.queue.push(task);
    this.store.save(task);
    this.onEvent?.({ type: "task_queued", taskId: task.id, queueSize: this.queue.length });
    log("info", "task queued", { taskId: task.id, queueSize: this.queue.length });
    this.triggerDispatch();
    return task;
  }

  getTask(id: string): Task | undefined {
    const task = this.tasks.get(id) ?? this.store.get(id) ?? undefined;
    if (task?.status === "running" && task.startedAt) {
      task.durationMs = Date.now() - new Date(task.startedAt).getTime();
      const runningInfo = this.runner.getRunningTasks();
      const live = runningInfo.find(r => r.id === task.id);
      if (live) task.costUsd = live.costUsd;
    }
    return task;
  }

  listTasks(): Task[] {
    const tasks = [...this.tasks.values()];
    const now = Date.now();
    const runningInfo = this.runner.getRunningTasks();
    const runningMap = new Map(runningInfo.map(r => [r.id, r]));
    for (const t of tasks) {
      if (t.status === "running" && t.startedAt) {
        t.durationMs = now - new Date(t.startedAt).getTime();
        const live = runningMap.get(t.id);
        if (live) t.costUsd = live.costUsd;
      }
    }
    return tasks;
  }

  getQueuePosition(taskId: string): number {
    const idx = this.queue.findIndex((t) => t.id === taskId);
    if (idx !== -1) return idx + 1;
    const task = this.tasks.get(taskId);
    if (task?.status === "running") return 0;
    return -1;
  }

  getQueueDepth(): number {
    return this.queue.length;
  }

  cancel(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.status !== "pending") return false;
    task.status = "cancelled";
    task.completedAt = new Date().toISOString();
    this.queue = this.queue.filter((t) => t.id !== id);
    this.store.save(task);
    return true;
  }

  requeue(taskId: string): Task | null {
    const task = this.tasks.get(taskId) ?? this.store.get(taskId) ?? undefined;
    if (!task) return null;
    if (task.status !== "failed" && task.status !== "timeout") return null;

    // Ensure the task is tracked in the in-memory map (may only be in store)
    this.tasks.set(task.id, task);

    task.status = "pending";
    task.error = "";
    task.retryCount += 1;
    task.completedAt = undefined;

    this.queue.push(task);
    this.store.save(task);
    this.onEvent?.({ type: "task_queued", taskId: task.id, queueSize: this.queue.length });
    log("info", "task requeued via API", { taskId: task.id, retryCount: task.retryCount });
    this.triggerDispatch();

    return task;
  }

  getAverageDuration(): number {
    const completed = [...this.tasks.values()].filter((t) => t.durationMs > 0);
    if (completed.length === 0) return 0;
    const total = completed.reduce((sum, t) => sum + t.durationMs, 0);
    return total / completed.length;
  }

  getHistoricalInsights(): { avgDuration: number; successRate: number; avgCost: number; timeoutRate: number } {
    const stats = this.store.stats();
    const successCount = stats.byStatus["success"] ?? 0;
    const failedCount = stats.byStatus["failed"] ?? 0;
    const timeoutCount = stats.byStatus["timeout"] ?? 0;
    const cancelledCount = stats.byStatus["cancelled"] ?? 0;
    const totalCompleted = successCount + failedCount + timeoutCount + cancelledCount;

    const successRate = totalCompleted > 0 ? successCount / totalCompleted : 0;
    const timeoutRate = totalCompleted > 0 ? timeoutCount / totalCompleted : 0;

    const successTasks = this.store.getByStatus("success");
    const avgDuration =
      successTasks.length > 0
        ? successTasks.reduce((sum, t) => sum + t.durationMs, 0) / successTasks.length
        : 0;
    const avgCost =
      successTasks.length > 0
        ? successTasks.reduce((sum, t) => sum + t.costUsd, 0) / successTasks.length
        : 0;

    return { avgDuration, successRate, avgCost, timeoutRate };
  }

  getFailureContext(): string {
    const patterns = this.store.getFailurePatterns(5);
    if (patterns.length === 0) return "Recent failures: none";
    const lines = patterns.map((p) => `- Error: ${p.error} | Prompt: ${p.prompt}`);
    return `Recent failures:\n${lines.join("\n")}`;
  }

  getStats() {
    const dbStats = this.store.stats();
    const avgDurationMs = this.getAverageDuration();
    const queueSize = this.queue.length;
    const activeWorkers = this.activeWorkers.size;
    return {
      ...dbStats,
      queueSize,
      activeWorkers,
      availableWorkers: this.pool.available,
      avgDurationMs,
      estimatedWaitMs: (avgDurationMs * queueSize) / Math.max(activeWorkers, 1),
      totalBudgetLimit: this.totalBudgetLimit,
    };
  }

  getDetailedInsights() {
    const daily = this.store.getDailyStats();
    const overall = this.store.stats();
    const avgDurationMs = this.getAverageDuration();
    const successCount = overall.byStatus["success"] ?? 0;
    const failedCount = overall.byStatus["failed"] ?? 0;
    const timeoutCount = overall.byStatus["timeout"] ?? 0;
    const successRate = overall.total > 0 ? successCount / overall.total : 0;
    return {
      overall: {
        total: overall.total,
        successRate,
        avgDurationMs,
        totalCostUsd: overall.totalCost,
        byStatus: overall.byStatus,
      },
      last7Days: daily,
      analysis: {
        failureRate: overall.total > 0 ? (failedCount + timeoutCount) / overall.total : 0,
        avgCostPerTask: overall.total > 0 ? overall.totalCost / overall.total : 0,
        peakDay: daily.length > 0 ? daily.reduce((a, b) => (a.total >= b.total ? a : b)).date : null,
      },
    };
  }

  generateImprovementTasks(): string[] {
    const prompts: string[] = [];
    const insights = this.getHistoricalInsights();
    const failures = this.store.getFailurePatterns(5);

    // Suggest fixes for recurring failures
    for (const f of failures) {
      prompts.push(
        `Investigate and fix the recurring error seen in recent tasks: "${f.error}". ` +
          `The failing task prompt was: "${f.prompt.slice(0, 120)}"`,
      );
    }

    // Suggest timeout reduction if timeout rate is high
    if (insights.timeoutRate > 0.1) {
      prompts.push(
        `Timeout rate is ${Math.round(insights.timeoutRate * 100)}%. ` +
          `Identify tasks that are timing out and optimize them to complete faster.`,
      );
    }

    // Suggest reliability improvements if success rate is low
    if (insights.successRate < 0.8 && insights.successRate > 0) {
      prompts.push(
        `Task success rate is ${Math.round(insights.successRate * 100)}%. ` +
          `Analyze failure patterns and improve task prompts or code to increase reliability.`,
      );
    }

    // Suggest cost optimization if average cost is high
    if (insights.avgCost > 0.1) {
      prompts.push(
        `Average task cost is $${insights.avgCost.toFixed(3)}. ` +
          `Review long-running tasks and optimize prompts to reduce token usage.`,
      );
    }

    // Fallback: always return at least one prompt
    if (prompts.length === 0) {
      prompts.push(
        "Review recent successful task outputs for code quality improvements and refactoring opportunities.",
      );
    }

    return prompts;
  }

  analyzeRound(taskIds: string[]): Record<string, unknown> {
    const tasks = taskIds.map((id) => this.getTask(id)).filter((t): t is Task => t !== undefined);
    const successCount = tasks.filter((t) => t.status === "success").length;
    const failedCount = tasks.filter((t) => t.status === "failed").length;
    const timeoutCount = tasks.filter((t) => t.status === "timeout").length;
    const totalCost = tasks.reduce((sum, t) => sum + t.costUsd, 0);
    const avgDurationMs = tasks.length > 0 ? tasks.reduce((sum, t) => sum + t.durationMs, 0) / tasks.length : 0;
    return {
      taskCount: tasks.length,
      successCount,
      failedCount,
      timeoutCount,
      totalCost,
      avgDurationMs,
      successRate: tasks.length > 0 ? successCount / tasks.length : 0,
    };
  }

  /**
   * Scan all active workers for tasks that have exceeded their timeout plus a
   * 30-second grace period.  Any stuck task is forcefully marked as "timeout",
   * its worker is released, and a task_final event is emitted so downstream
   * consumers are notified.  Called automatically every 60 seconds.
   */
  private async recoverStaleWorkers(): Promise<void> {
    const now = Date.now();
    for (const [, task] of this.tasks) {
      if (task.status !== "running") continue;
      if (!task.startedAt) continue;

      const startedAt = new Date(task.startedAt).getTime();
      const gracePeriodMs = (task.timeout + 30) * 1_000;
      if (now - startedAt < gracePeriodMs) continue;

      const workerName = task.worktree;
      if (!workerName) continue;

      log("warn", "recovering stale worker", {
        taskId: task.id,
        workerName,
        elapsedMs: now - startedAt,
        timeoutS: task.timeout,
      });

      // Signal executeAndRelease() to treat this task as timed-out.
      // Do NOT release the pool here — executeAndRelease owns that lifecycle.
      this.abortedTasks.add(task.id);
      this.runner.abort(task.id);
    }
  }

  logMetrics(): void {
    const stats = this.getStats();
    const successCount = stats.byStatus["success"] ?? 0;
    const successRate = stats.total > 0 ? successCount / stats.total : 0;
    log("info", "scheduler metrics", {
      totalTasks: stats.total,
      successRate: Math.round(successRate * 10000) / 100, // percentage, 2 dp
      avgDurationMs: Math.round(stats.avgDurationMs),
      activeWorkers: stats.activeWorkers,
      queueSize: stats.queueSize,
      totalCostUsd: Math.round(stats.totalCost * 1e6) / 1e6,
    });
  }

  /**
   * Emit a task_progress event for the given running task with elapsed time,
   * current cost, and token counts.
   */
  private emitProgress(task: Task): void {
    const startedAt = task.startedAt ? new Date(task.startedAt).getTime() : Date.now();
    const elapsedMs = Date.now() - startedAt;
    this.onEvent?.({
      type: "task_progress",
      taskId: task.id,
      elapsedMs,
      costUsd: task.costUsd,
      tokenInput: task.tokenInput,
      tokenOutput: task.tokenOutput,
    });
  }

  /**
   * Wake the dispatch loop early, cancelling any pending wait.
   * Called when a new task is submitted or a worker is released.
   */
  private triggerDispatch(): void {
    const resolve = this.dispatchResolve;
    this.dispatchResolve = undefined;
    resolve?.();
  }

  /**
   * Sleep for up to `ms` milliseconds, but resolve immediately if
   * triggerDispatch() is called before the timeout expires.
   */
  private waitForDispatch(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.dispatchResolve = undefined;
        resolve();
      }, ms);
      this.dispatchResolve = () => {
        clearTimeout(timer);
        this.dispatchResolve = undefined;
        resolve();
      };
    });
  }

  private sortQueue(): void {
    const priorityOrder: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
    this.queue.sort((a, b) => (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2));
  }

  private async loop(): Promise<void> {
    while (this.running) {
      // Queue empty — nothing to dispatch; sleep long and wait for a submission.
      if (this.queue.length === 0) {
        await this.waitForDispatch(5_000);
        continue;
      }

      // Tasks pending but no free workers — sleep short and wait for a release.
      if (this.pool.available === 0) {
        await this.waitForDispatch(1_000);
        continue;
      }

      // Budget guard: halt dispatch if total spend has reached the limit
      if (this.totalBudgetLimit > 0) {
        const { totalCost } = this.getStats();
        if (totalCost >= this.totalBudgetLimit) {
          log("warn", "total budget limit reached, not dispatching", {
            totalCost,
            totalBudgetLimit: this.totalBudgetLimit,
          });
          await this.waitForDispatch(1_000);
          continue;
        }
      }

      this.sortQueue();

      const task = this.queue.shift()!;

      // Dependency check: skip if dependency hasn't completed successfully yet
      if (task.dependsOn) {
        const dep = this.tasks.get(task.dependsOn) ?? this.store.get(task.dependsOn) ?? undefined;
        if (dep?.status !== "success") {
          // If dependency is in a terminal failure state (or missing), fail this task
          if (!dep || dep.status === "failed" || dep.status === "timeout" || dep.status === "cancelled") {
            task.status = "failed";
            task.error = `dependency ${task.dependsOn} is ${dep?.status ?? "missing"}`;
            task.completedAt = new Date().toISOString();
            this.store.save(task);
            this.onEvent?.({ type: "task_final", taskId: task.id, status: task.status });
            continue;
          }
          // Still pending/running — re-queue and wait
          log("info", "task waiting on dependency", { taskId: task.id, dependsOn: task.dependsOn });
          this.queue.push(task);
          await this.waitForDispatch(1_000);
          continue;
        }
      }

      const worker = await this.pool.acquire();
      if (!worker) {
        this.queue.unshift(task);
        await this.waitForDispatch(1_000);
        continue;
      }

      worker.currentTask = task.id;
      task.worktree = worker.name;
      this.activeWorkers.add(worker.name);

      // Fire and forget — don't block the loop
      this.executeAndRelease(task, worker.name, worker.path);
    }
  }

  private async executeAndRelease(task: Task, workerName: string, workerPath: string): Promise<void> {
    let shouldRetry = false;
    const progressInterval = setInterval(() => this.emitProgress(task), 10_000);
    this.progressIntervals.set(task.id, progressInterval);
    try {
      log("info", "task started", { taskId: task.id, worker: workerName });
      await this.runner.run(task, workerPath, this.onEvent);

      const shouldMerge = task.status === "success";
      const mergeResult = await this.pool.release(workerName, shouldMerge, task.id);

      if (shouldMerge && !mergeResult.merged) {
        const fileList = mergeResult.conflictFiles?.length
          ? `: ${mergeResult.conflictFiles.join(", ")}`
          : "";
        task.error = (task.error ?? "") + `\nMerge conflict${fileList}`;
        log("warn", "task merge conflict", { taskId: task.id, files: mergeResult.conflictFiles ?? [] });
      }
    } catch (err: any) {
      log("error", "task error", { taskId: task.id, error: err.message });
      task.status = "failed";
      task.error = err.message;
      task.completedAt = new Date().toISOString();
      await this.pool.release(workerName, false);
    } finally {
      // Clear the progress reporting interval now that the task is done
      const interval = this.progressIntervals.get(task.id);
      if (interval !== undefined) {
        clearInterval(interval);
        this.progressIntervals.delete(task.id);
      }
      // If stale recovery flagged this task, force timeout status and skip retry
      if (this.abortedTasks.has(task.id)) {
        this.abortedTasks.delete(task.id);
        task.status = "timeout";
        task.error = "Task exceeded timeout + grace period and was forcefully recovered";
        task.completedAt = new Date().toISOString();
      }
      // Retry logic: re-queue failed tasks (not timeout/cancelled) up to maxRetries times
      if (task.status === "failed" && task.retryCount < task.maxRetries) {
        shouldRetry = true;
        task.retryCount++;
        task.status = "pending";
        task.error = "";
        task.completedAt = undefined;
        log("info", "task retrying", { taskId: task.id, attempt: task.retryCount, maxRetries: task.maxRetries });
      }
      this.activeWorkers.delete(workerName);
      this.triggerDispatch(); // wake the loop now that a worker slot is free
      this.store.save(task);
      if (!shouldRetry) {
        if (task.webhookUrl) {
          try {
            await fetch(task.webhookUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                taskId: task.id,
                status: task.status,
                costUsd: task.costUsd,
                durationMs: task.durationMs,
                output: task.output,
              }),
            });
          } catch (webhookErr: any) {
            log("warn", "webhook delivery failed", { taskId: task.id, url: task.webhookUrl, error: webhookErr.message });
          }
        }
        this.onEvent?.({ type: "task_final", taskId: task.id, status: task.status });
      }
    }
    if (shouldRetry) {
      this.queue.push(task);
      this.onEvent?.({ type: "task_queued", taskId: task.id, queueSize: this.queue.length });
      this.triggerDispatch();
    }
  }
}
