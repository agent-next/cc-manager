export type TaskStatus = "pending" | "running" | "success" | "failed" | "timeout" | "cancelled";
export interface Task {
    id: string;
    prompt: string;
    status: TaskStatus;
    worktree?: string;
    output: string;
    error: string;
    events: TaskEvent[];
    createdAt: string;
    startedAt?: string;
    completedAt?: string;
    timeout: number;
    maxBudget: number;
    costUsd: number;
    tokenInput: number;
    tokenOutput: number;
    durationMs: number;
    retryCount: number;
}
export interface TaskEvent {
    type: string;
    timestamp: string;
    data?: Record<string, unknown>;
}
export interface WorkerInfo {
    name: string;
    path: string;
    branch: string;
    busy: boolean;
    currentTask?: string;
}
export interface Config {
    repo: string;
    workers: number;
    port: number;
    timeout: number;
    maxBudget: number;
    model: string;
    systemPrompt: string;
}
export declare function createTask(prompt: string, opts?: Partial<Pick<Task, "id" | "timeout" | "maxBudget">>): Task;
