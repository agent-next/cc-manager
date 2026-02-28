export class AgentRunner {
    model;
    systemPrompt;
    constructor(model = "claude-sonnet-4-6", systemPrompt = "") {
        this.model = model;
        this.systemPrompt = systemPrompt;
    }
    async run(task, cwd, onEvent) {
        const { query } = await import("@anthropic-ai/claude-agent-sdk");
        task.status = "running";
        task.startedAt = new Date().toISOString();
        const startMs = Date.now();
        onEvent?.({ type: "task_started", taskId: task.id, worker: task.worktree });
        const prompt = `${task.prompt}

When done, stage and commit your changes:
  git add -A && git commit -m "feat: <brief summary>"`;
        const abortController = new AbortController();
        let timer;
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
                                type: "preset",
                                preset: "claude_code",
                                append: this.systemPrompt,
                            },
                        }
                        : {}),
                    abortController,
                },
            });
            for await (const msg of q) {
                const evt = {
                    type: msg.type,
                    timestamp: new Date().toISOString(),
                };
                if (msg.type === "result") {
                    task.durationMs = Date.now() - startMs;
                    task.costUsd = msg.total_cost_usd ?? 0;
                    task.tokenInput = msg.usage?.input_tokens ?? 0;
                    task.tokenOutput = msg.usage?.output_tokens ?? 0;
                    if (msg.subtype === "success") {
                        task.status = "success";
                        task.output = msg.result ?? "";
                    }
                    else {
                        task.status = "failed";
                        task.error = msg.subtype ?? "unknown error";
                    }
                    evt.data = { status: task.status, cost: task.costUsd };
                }
                task.events.push(evt);
                onEvent?.({ type: "task_event", taskId: task.id, event: evt });
            }
        }
        catch (err) {
            if (task.status !== "timeout") {
                task.status = "failed";
            }
            task.error = err.message ?? String(err);
            task.durationMs = Date.now() - startMs;
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
        task.completedAt = new Date().toISOString();
        onEvent?.({ type: "task_completed", taskId: task.id, status: task.status });
        return task;
    }
}
//# sourceMappingURL=agent-runner.js.map