export type TaskStatus = "pending" | "running" | "success" | "failed" | "timeout" | "cancelled";
export type TaskPriority = "low" | "normal" | "high";

export interface Task {
  id: string;
  prompt: string;
  status: TaskStatus;
  priority: TaskPriority;
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
  maxRetries: number;
  dependsOn?: string;
  tags?: string[];
  webhookUrl?: string;
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

export function createTask(prompt: string, opts?: Partial<Pick<Task, "id" | "timeout" | "maxBudget" | "maxRetries" | "priority" | "dependsOn" | "tags" | "webhookUrl">>): Task {
  return {
    id: opts?.id ?? crypto.randomUUID().slice(0, 8),
    prompt,
    status: "pending",
    priority: opts?.priority ?? "normal",
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
    maxRetries: opts?.maxRetries ?? 2,
    dependsOn: opts?.dependsOn,
    tags: opts?.tags,
    webhookUrl: opts?.webhookUrl,
  };
}
