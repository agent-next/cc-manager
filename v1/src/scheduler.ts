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

  constructor(
    private pool: WorktreePool,
    private runner: AgentRunner,
    private store: Store,
    private onEvent?: EventCallback,
  ) {}

  start(): void {
    this.running = true;
    this.loop();
    log("info", "scheduler started");
  }

  async stop(): Promise<void> {
    log("info", "scheduler stopping");
    this.running = false;
    // Wait for active workers
    while (this.activeWorkers.size > 0) {
      log("info", "waiting for workers", { active: this.activeWorkers.size });
      await new Promise((r) => setTimeout(r, 1000));
    }
    log("info", "scheduler stopped");
  }

  submit(prompt: string, opts?: { id?: string; timeout?: number; maxBudget?: number; priority?: import("./types.js").TaskPriority; dependsOn?: string }): Task {
    const task = createTask(prompt, opts);
    this.tasks.set(task.id, task);
    this.queue.push(task);
    this.store.save(task);
    this.onEvent?.({ type: "task_queued", taskId: task.id, queueSize: this.queue.length });
    log("info", "task queued", { taskId: task.id, queueSize: this.queue.length });
    return task;
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id) ?? this.store.get(id) ?? undefined;
  }

  listTasks(): Task[] {
    return [...this.tasks.values()];
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
    };
  }

  private async loop(): Promise<void> {
    while (this.running) {
      if (this.queue.length === 0 || this.pool.available === 0) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
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
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
      }

      const worker = await this.pool.acquire();
      if (!worker) {
        this.queue.unshift(task);
        await new Promise((r) => setTimeout(r, 1000));
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
      this.store.save(task);
      if (!shouldRetry) {
        this.onEvent?.({ type: "task_final", taskId: task.id, status: task.status });
      }
    }
    if (shouldRetry) {
      this.queue.push(task);
      this.onEvent?.({ type: "task_queued", taskId: task.id, queueSize: this.queue.length });
    }
  }
}
