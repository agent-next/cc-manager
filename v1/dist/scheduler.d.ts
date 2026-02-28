import type { Task } from "./types.js";
import { WorktreePool } from "./worktree-pool.js";
import { AgentRunner } from "./agent-runner.js";
import { Store } from "./store.js";
type EventCallback = (event: Record<string, unknown>) => void;
export declare class Scheduler {
    private pool;
    private runner;
    private store;
    private onEvent?;
    private queue;
    private activeWorkers;
    private running;
    private tasks;
    constructor(pool: WorktreePool, runner: AgentRunner, store: Store, onEvent?: EventCallback | undefined);
    start(): void;
    stop(): Promise<void>;
    submit(prompt: string, opts?: {
        id?: string;
        timeout?: number;
        maxBudget?: number;
    }): Task;
    getTask(id: string): Task | undefined;
    listTasks(): Task[];
    cancel(id: string): boolean;
    getStats(): {
        queueSize: number;
        activeWorkers: number;
        availableWorkers: number;
        total: number;
        byStatus: Record<string, number>;
        totalCost: number;
    };
    private loop;
    private executeAndRelease;
}
export {};
