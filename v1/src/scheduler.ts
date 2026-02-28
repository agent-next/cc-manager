import type { Task } from "./types.js";
import { createTask } from "./types.js";
import { WorktreePool } from "./worktree-pool.js";
import { AgentRunner } from "./agent-runner.js";
import { Store } from "./store.js";

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
    console.log("[scheduler] started");
  }

  async stop(): Promise<void> {
    console.log("[scheduler] stopping...");
    this.running = false;
    // Wait for active workers
    while (this.activeWorkers.size > 0) {
      console.log(`[scheduler] waiting for ${this.activeWorkers.size} workers...`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.log("[scheduler] stopped");
  }

  submit(prompt: string, opts?: { id?: string; timeout?: number; maxBudget?: number }): Task {
    const task = createTask(prompt, opts);
    this.tasks.set(task.id, task);
    this.queue.push(task);
    this.store.save(task);
    this.onEvent?.({ type: "task_queued", taskId: task.id, queueSize: this.queue.length });
    console.log(`[scheduler] queued: ${task.id}`);
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

  getStats() {
    const dbStats = this.store.stats();
    return {
      ...dbStats,
      queueSize: this.queue.length,
      activeWorkers: this.activeWorkers.size,
      availableWorkers: this.pool.available,
    };
  }

  private async loop(): Promise<void> {
    while (this.running) {
      if (this.queue.length === 0 || this.pool.available === 0) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }

      const task = this.queue.shift()!;
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
    try {
      console.log(`[scheduler] ${task.id} → ${workerName}`);
      await this.runner.run(task, workerPath, this.onEvent);

      const shouldMerge = task.status === "success";
      const merged = await this.pool.release(workerName, shouldMerge);

      if (shouldMerge && !merged) {
        task.error += "\nMerge conflict";
        console.warn(`[scheduler] ${task.id} merge conflict`);
      }
    } catch (err: any) {
      console.error(`[scheduler] ${task.id} error:`, err.message);
      task.status = "failed";
      task.error = err.message;
      task.completedAt = new Date().toISOString();
      await this.pool.release(workerName, false);
    } finally {
      this.activeWorkers.delete(workerName);
      this.store.save(task);
      this.onEvent?.({ type: "task_final", taskId: task.id, status: task.status });
    }
  }
}
