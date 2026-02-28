import type { Task, TaskEvent } from "./types.js";

type EventCallback = (event: Record<string, unknown>) => void;

export class AgentRunner {
  constructor(
    private model: string = "claude-sonnet-4-6",
    private systemPrompt: string = "",
  ) {}

  async run(task: Task, cwd: string, onEvent?: EventCallback): Promise<Task> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk").catch(() => {
      throw new Error(
        "missing dependency: @anthropic-ai/claude-agent-sdk is not installed – run: npm install @anthropic-ai/claude-agent-sdk",
      );
    });

    task.status = "running";
    task.startedAt = new Date().toISOString();
    const startMs = Date.now();

    onEvent?.({ type: "task_started", taskId: task.id, worker: task.worktree });

    const prompt = `${task.prompt}

---

## Instructions

- **Scope**: Only modify the specific files mentioned in the prompt. Do not refactor, reformat, or touch unrelated code.
- **TypeScript imports**: Always use \`.js\` extensions in TypeScript import paths (e.g. \`import { foo } from "./bar.js"\`).
- **Before committing**: Run \`npx tsc\` to verify the project compiles without errors. Fix any type errors introduced by your changes before proceeding.
- **When done**, stage and commit your changes:
  \`git add -A && git commit -m "feat: <brief summary>"\``;

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
          }
        }

        if (msg.type === "result") {
          task.durationMs = Date.now() - startMs;
          task.costUsd = msg.total_cost_usd ?? 0;
          task.tokenInput = msg.usage?.input_tokens ?? 0;
          task.tokenOutput = msg.usage?.output_tokens ?? 0;

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
    }

    task.completedAt = new Date().toISOString();
    onEvent?.({ type: "task_completed", taskId: task.id, status: task.status });
    return task;
  }
}
