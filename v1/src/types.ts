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

export function createTask(prompt: string, opts?: Partial<Pick<Task, "id" | "timeout" | "maxBudget">>): Task {
  return {
    id: opts?.id ?? crypto.randomUUID().slice(0, 8),
    prompt,
    status: "pending",
    output: "",
    error: "",
    events: [],
    createdAt: new Date().toISOString(),
    timeout: opts?.timeout ?? 300,
    maxBudget: opts?.maxBudget ?? 5,
    costUsd: 0,
    tokenInput: 0,
    tokenOutput: 0,
    durationMs: 0,
    retryCount: 0,
  };
}
