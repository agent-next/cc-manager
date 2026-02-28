import type { Task, TaskEvent } from "./types.js";
import { log } from "./logger.js";
import { execSync } from "child_process";

type EventCallback = (event: Record<string, unknown>) => void;

interface RunningTaskEntry {
  id: string;
  startMs: number;
  costUsd: number;
}

export interface RunningTaskInfo {
  id: string;
  elapsedMs: number;
  costUsd: number;
}

export class AgentRunner {
  private readonly _runningTasks = new Map<string, RunningTaskEntry>();

  constructor(
    private model: string = "claude-sonnet-4-6",
    private systemPrompt: string = "",
  ) {}

  /** Returns info about all tasks currently being executed by this runner. */
  getRunningTasks(): RunningTaskInfo[] {
    const now = Date.now();
    return Array.from(this._runningTasks.values()).map((entry) => ({
      id: entry.id,
      elapsedMs: now - entry.startMs,
      costUsd: entry.costUsd,
    }));
  }

  async run(task: Task, cwd: string, onEvent?: EventCallback): Promise<Task> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk").catch(() => {
      throw new Error(
        "missing dependency: @anthropic-ai/claude-agent-sdk is not installed – run: npm install @anthropic-ai/claude-agent-sdk",
      );
    });

    task.status = "running";
    task.startedAt = new Date().toISOString();
    const startMs = Date.now();

    this._runningTasks.set(task.id, { id: task.id, startMs, costUsd: 0 });

    log("info", "task start", { taskId: task.id, worker: task.worktree });
    onEvent?.({ type: "task_started", taskId: task.id, worker: task.worktree });

    const prompt = `${task.prompt}

---

## Instructions

- **Minimal changes**: Only modify what is necessary to complete the task. Do not refactor, reformat, or touch unrelated code.
- **TypeScript imports**: Always use \`.js\` extensions in import paths (e.g. \`import { foo } from "./bar.js"\`).
- **Type checking**: After making changes, run \`npx tsc\` to catch type errors.
- **Fix before committing**: If \`npx tsc\` fails, fix all errors before proceeding to commit.
- **Commit when done**: Stage and commit all changes with \`git add -A && git commit -m "feat: <brief summary>"\`.`;

    const abortController = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (task.timeout > 0) {
      timer = setTimeout(() => {
        abortController.abort();
        task.status = "timeout";
      }, task.timeout * 1000);
    }

    try {
      const q = query({
        prompt,
        options: {
          cwd,
          model: this.model,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          maxTurns: 50,
          ...(task.maxBudget > 0 ? { maxBudgetUsd: task.maxBudget } : {}),
          ...(this.systemPrompt
            ? {
                systemPrompt: {
                  type: "preset" as const,
                  preset: "claude_code" as const,
                  append: this.systemPrompt,
                },
              }
            : {}),
          abortController,
        },
      });

      let messageCount = 0;

      for await (const msg of q) {
        messageCount++;

        if (messageCount % 10 === 0) {
          onEvent?.({
            type: "task_progress",
            taskId: task.id,
            messageCount,
            elapsedMs: Date.now() - startMs,
          });
        }

        const evt: TaskEvent = {
          type: msg.type,
          timestamp: new Date().toISOString(),
        };

        if (msg.type === "assistant" && msg.message?.content) {
          const text = (msg.message.content as Array<{ type: string; text?: string }>)
            .filter((b) => b.type === "text" && b.text)
            .map((b) => b.text as string)
            .join("");
          if (text) {
            onEvent?.({ type: "task_log", taskId: task.id, text });

            // Detect compilation errors mentioned in agent output
            if (/error TS\d+|compilation (failed|error)|tsc.*error|\berror\b.*\.ts\(\d+/i.test(text)) {
              const compileErrEvt: TaskEvent = {
                type: "compilation_error",
                timestamp: new Date().toISOString(),
                data: { snippet: text.slice(0, 500) },
              };
              task.events.push(compileErrEvt);
              onEvent?.({ type: "task_event", taskId: task.id, event: compileErrEvt });
            }
          }
        }

        if (msg.type === "result") {
          task.durationMs = Date.now() - startMs;
          task.costUsd = msg.total_cost_usd ?? 0;
          task.tokenInput = msg.usage?.input_tokens ?? 0;
          task.tokenOutput = msg.usage?.output_tokens ?? 0;

          // Update live cost in running-task tracker
          const entry = this._runningTasks.get(task.id);
          if (entry) entry.costUsd = task.costUsd;

          if (msg.subtype === "success") {
            task.status = "success";
            task.output = msg.result ?? "";
            task.summary = task.output.slice(-500);
          } else {
            task.status = "failed";
            task.error = msg.subtype ?? "unknown error";
          }
          evt.data = { status: task.status, cost: task.costUsd };
        }

        task.events.push(evt);
        onEvent?.({ type: "task_event", taskId: task.id, event: evt });
      }
    } catch (err: unknown) {
      const e = err as { name?: string; message?: string; code?: string };
      const msg = e.message ?? String(err);

      if (e.name === "AbortError") {
        // Triggered by our timeout timer via abortController.abort()
        task.status = "timeout";
        task.error = `timeout: task exceeded ${task.timeout}s`;
      } else {
        if ((task.status as string) !== "timeout") {
          task.status = "failed";
        }
        if (
          e.code === "ECONNREFUSED" ||
          e.code === "ENOTFOUND" ||
          e.code === "ETIMEDOUT" ||
          e.code === "ECONNRESET" ||
          (e.name === "TypeError" && /fetch|network/i.test(msg))
        ) {
          task.error = `network: ${msg}`;
        } else {
          task.error = `sdk: ${msg}`;
        }
      }

      task.durationMs = Date.now() - startMs;
    } finally {
      if (timer) clearTimeout(timer);
      this._runningTasks.delete(task.id);
    }

    // Capture git diff for any commits made by the agent in this worktree
    try {
      const diff = execSync("git diff HEAD~1..HEAD", { cwd, encoding: "utf8" });
      if (diff.trim()) {
        const diffEvt: TaskEvent = {
          type: "git_diff",
          timestamp: new Date().toISOString(),
          data: { diff },
        };
        task.events.push(diffEvt);
        onEvent?.({ type: "task_event", taskId: task.id, event: diffEvt });
      }
    } catch (_e: unknown) {
      // No commits made, insufficient history, or git unavailable – skip silently
    }

    task.completedAt = new Date().toISOString();
    log("info", "task complete", {
      taskId: task.id,
      status: task.status,
      costUsd: task.costUsd,
      durationMs: task.durationMs,
    });
    onEvent?.({ type: "task_completed", taskId: task.id, status: task.status });
    return task;
  }
}
