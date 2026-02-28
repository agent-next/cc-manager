import type { Task } from "./types.js";
export declare class Store {
    private db;
    constructor(repoPath: string);
    private migrate;
    save(task: Task): void;
    get(id: string): Task | null;
    list(limit?: number): Task[];
    stats(): {
        total: number;
        byStatus: Record<string, number>;
        totalCost: number;
    };
    private rowToTask;
    close(): void;
}
