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

  submit(prompt: string, opts?: { id?: string; timeout?: number; maxBudget?: number; priority?: import("./types.js").TaskPriority; dependsOn?: string; webhookUrl?: string; tags?: string[] }): Task {
    const task = createTask(prompt, opts);
    this.tasks.set(task.id, task);
    this.queue.push(task);
    this.store.save(task);
    this.onEvent?.({ type: "task_queued", taskId: task.id, queueSize: this.queue.length });
    log("info", "task queued", { taskId: task.id, queueSize: this.queue.length });
    this.triggerDispatch();
    return task;
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id) ?? this.store.get(id) ?? undefined;
  }

  listTasks(): Task[] {
    return [...this.tasks.values()];
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

      // Mark the task as timed out
      task.status = "timeout";
      task.error = "Task exceeded timeout + grace period and was forcefully recovered";
      task.completedAt = new Date().toISOString();

      // Clear any outstanding progress-reporting interval for this task
      const interval = this.progressIntervals.get(task.id);
      if (interval !== undefined) {
        clearInterval(interval);
        this.progressIntervals.delete(task.id);
      }

      // Release the worker back to the pool without merging
      this.activeWorkers.delete(workerName);
      await this.pool.release(workerName, false);

      // Persist, notify, and wake the dispatch loop
      this.store.save(task);
      this.onEvent?.({ type: "task_final", taskId: task.id, status: task.status });
      this.triggerDispatch();
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

      // Sort queue: high → normal → low before picking the next task
      const priorityOrder: Record<string, number> = { high: 0, normal: 1, low: 2 };
      this.queue.sort((a, b) => (priorityOrder[a.priority] ?? 1) - (priorityOrder[b.priority] ?? 1));

      const task = this.queue.shift()!;

      // Dependency check: skip if dependency hasn't completed successfully yet
      if (task.dependsOn) {
        const dep = this.tasks.get(task.dependsOn) ?? this.store.get(task.dependsOn) ?? undefined;
        if (dep?.status !== "success") {
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
      const mergeResult = await this.pool.release(workerName, shouldMerge);

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
