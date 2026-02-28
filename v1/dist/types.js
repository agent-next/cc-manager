export function createTask(prompt, opts) {
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
//# sourceMappingURL=types.js.map