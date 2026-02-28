import type { Scheduler } from "./scheduler.js";
import type { WorktreePool } from "./worktree-pool.js";
export declare class WebServer {
    private pool;
    private port;
    private app;
    private sseClients;
    private _scheduler;
    constructor(pool: WorktreePool, port: number);
    setScheduler(scheduler: Scheduler): void;
    private setupRoutes;
    broadcast(event: Record<string, unknown>): void;
    start(): void;
}
