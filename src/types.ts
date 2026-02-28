export type TaskStatus = "pending" | "running" | "success" | "failed" | "timeout" | "cancelled";
export type TaskPriority = "urgent" | "high" | "normal" | "low";
/** Built-in agent types with known output parsing. Any string is accepted for generic CLI agents. */
export type AgentType = "claude" | "claude-sdk" | "codex";

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
  summary?: string;
  agent?: string;
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

export interface WorkerStatus {
  name: string;
  path: string;
  branch: string;
  busy: boolean;
  currentTask: string | null;
  uptime?: number;
  taskCount?: number;
}

export interface Stats {
  total: number;
  byStatus: Record<string, number>;
  totalCost: number;
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

export interface HistoricalInsights {
  avgDuration: number;
  successRate: number;
  avgCost: number;
  timeoutRate: number;
}

export interface PerformanceMetrics {
  totalTasks: number;
  successCount: number;
  failedCount: number;
  timeoutCount: number;
  avgDurationMs: number;
  avgCostUsd: number;
  totalCostUsd: number;
  p50DurationMs: number;
  p90DurationMs: number;
}

export interface EvolutionEntry {
  id: string;
  roundNumber: number;
  taskIds: string[];
  analysis: Record<string, unknown>;
  createdAt: string;
}

export interface TaskCreateInput {
  prompt: string;
  timeout?: number;
  maxBudget?: number;
  priority?: Task["priority"];
  agent?: string;
}

export interface HarnessConfig {
  maxPromptLength: number;
  maxTokenBudget: number;
  enableAutoReview: boolean;
  enableErrorInjection: boolean;
  systemPromptSource: string;
}

export const defaultHarnessConfig: HarnessConfig = {
  maxPromptLength: 2000,
  maxTokenBudget: 100000,
  enableAutoReview: false,
  enableErrorInjection: true,
  systemPromptSource: 'claude.md',
};

export interface RoundSummary {
  roundNumber: number;
  taskIds: string[];
  successRate: number;
  totalCost: number;
  totalDuration: number;
  patternsDetected: string[];
}

export interface AutoFlywheelConfig {
  enabled: boolean;
  maxTasksPerRound: number;
  minSuccessRate: number;
  cooldownMinutes: number;
  targetFiles: string[];
}

export const defaultAutoFlywheelConfig: AutoFlywheelConfig = {
  enabled: false,
  maxTasksPerRound: 5,
  minSuccessRate: 0.8,
  cooldownMinutes: 30,
  targetFiles: [
    "v1/src/types.ts",
    "v1/src/queue.ts",
    "v1/src/server.ts",
    "v1/src/worker.ts",
    "v1/src/routes.ts",
  ],
};

export interface FlywheelState {
  lastRunAt: string | undefined;
  roundsCompleted: number;
  totalTasksGenerated: number;
  lastAnalysis: EvolutionEntry | undefined;
}

export function createTask(prompt: string, opts?: Partial<Pick<Task, "id" | "timeout" | "maxBudget" | "maxRetries" | "priority" | "dependsOn" | "tags" | "webhookUrl" | "agent">>): Task {
  return {
    id: opts?.id ?? crypto.randomUUID().replace(/-/g, "").slice(0, 16),
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
    agent: opts?.agent ?? "claude",
  };
}
