import type { WorkerInfo } from "./types.js";
export declare class WorktreePool {
    private repoPath;
    private poolSize;
    private workers;
    private lock;
    constructor(repoPath: string, poolSize: number);
    init(): Promise<void>;
    acquire(): Promise<WorkerInfo | null>;
    release(name: string, merge: boolean): Promise<boolean>;
    private mergeToMain;
    get available(): number;
    get busy(): number;
    getStatus(): WorkerInfo[];
    private git;
    private gitIn;
    private waitLock;
}
