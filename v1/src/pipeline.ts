import { CCManagerClient } from "./api-client.js";
import type { Task } from "./api-client.js";

interface StepConfig {
  prompt: string;
  opts?: { timeout?: number };
}

interface StepResult {
  taskId: string;
  status: string;
  output: string;
}

const TERMINAL_STATES = new Set(["success", "failed", "timeout", "cancelled"]);

async function pollTask(client: CCManagerClient, id: string): Promise<Task> {
  for (;;) {
    const task = await client.getTask(id);
    if (TERMINAL_STATES.has(task.status)) return task;
    await new Promise<void>((r) => setTimeout(r, 1000));
  }
}

export class Pipeline {
  private steps: StepConfig[] = [];

  constructor(private client: CCManagerClient) {}

  addStep(prompt: string, opts?: { timeout?: number }): Pipeline {
    this.steps.push({ prompt, opts });
    return this;
  }

  async run(): Promise<{ steps: StepResult[]; totalCost: number }> {
    const results: StepResult[] = [];
    let totalCost = 0;

    for (const step of this.steps) {
      const { id } = await this.client.submitTask(step.prompt, step.opts);
      const task = await pollTask(this.client, id);

      results.push({ taskId: id, status: task.status, output: task.output });
      totalCost += task.costUsd;

      if (task.status !== "success") break;
    }

    return { steps: results, totalCost };
  }
}
