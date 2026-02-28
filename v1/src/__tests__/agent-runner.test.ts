import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentRunner } from "../agent-runner.js";
import { createTask } from "../types.js";

describe("AgentRunner", () => {
  // ── estimateCost ──

  it("estimateCost returns correct values for sonnet model", () => {
    const cost = AgentRunner.estimateCost(1_000_000, 1_000_000, "claude-sonnet-4-6");
    assert.strictEqual(cost, 18);
  });

  it("estimateCost returns correct values for unknown model (defaults to sonnet rates)", () => {
    const cost = AgentRunner.estimateCost(1_000_000, 1_000_000, "unknown-model-xyz");
    assert.strictEqual(cost, 18);
  });

  it("estimateCost returns correct values for opus model", () => {
    const cost = AgentRunner.estimateCost(1_000_000, 1_000_000, "claude-opus-4-5");
    assert.strictEqual(cost, 90); // 15 + 75
  });

  it("estimateCost returns 0 for zero tokens", () => {
    assert.strictEqual(AgentRunner.estimateCost(0, 0, "claude-sonnet-4-6"), 0);
  });

  // ── reviewDiff ──

  it("reviewDiff returns a ReviewResult with score, issues, and suggestions arrays", () => {
    const runner = new AgentRunner();
    const result = runner.reviewDiff("diff --git a/foo.ts b/foo.ts\n+const x = 1;");
    assert.ok(typeof result.score === "number", "score should be a number");
    assert.ok(Array.isArray(result.issues), "issues should be an array");
    assert.ok(Array.isArray(result.suggestions), "suggestions should be an array");
  });

  it("reviewDiff gives higher score when diff includes test files", () => {
    const runner = new AgentRunner();
    const withTests = runner.reviewDiff(
      "diff --git a/foo.test.ts b/foo.test.ts\n+it('works', () => {});"
    );
    const withoutTests = runner.reviewDiff(
      "diff --git a/foo.ts b/foo.ts\n+const x = 1;"
    );
    assert.ok(withTests.score > withoutTests.score, "test-including diff should score higher");
  });

  it("reviewDiff penalizes console.log in diff", () => {
    const runner = new AgentRunner();
    const result = runner.reviewDiff("diff --git a/foo.ts\n+console.log('debug');");
    assert.ok(result.score < 50, "console.log should lower score below baseline");
    assert.ok(result.issues.length > 0, "should flag console.log as an issue");
  });

  // ── buildSystemPrompt ──

  it("buildSystemPrompt includes tsc instruction", () => {
    const runner = new AgentRunner();
    const task = createTask("fix the bug");
    const prompt = runner.buildSystemPrompt(task, "/nonexistent-path-xyz");
    assert.ok(prompt.includes("npx tsc"), "prompt should include npx tsc instruction");
  });

  it("buildSystemPrompt includes test runner hints for test-related tasks", () => {
    const runner = new AgentRunner();
    const task = createTask("add unit test for parser");
    const prompt = runner.buildSystemPrompt(task, "/nonexistent-path-xyz");
    assert.ok(prompt.includes("node:test"), "should mention node:test for test tasks");
  });

  it("buildSystemPrompt includes dashboard hints for html-related tasks", () => {
    const runner = new AgentRunner();
    const task = createTask("fix dashboard layout issue");
    const prompt = runner.buildSystemPrompt(task, "/nonexistent-path-xyz");
    assert.ok(prompt.includes("vanilla"), "should mention vanilla JS for dashboard tasks");
  });

  it("buildSystemPrompt detects file mentions and restricts scope", () => {
    const runner = new AgentRunner();
    const task = createTask("refactor store.ts to improve error handling");
    const prompt = runner.buildSystemPrompt(task, "/nonexistent-path-xyz");
    assert.ok(prompt.includes("store.ts"), "should mention the specific file");
    assert.ok(prompt.includes("Only modify"), "should restrict to single file");
  });

  // ── Constructor defaults ──

  it("constructor uses sensible defaults", () => {
    const runner = new AgentRunner();
    // Should not throw when accessing public methods
    assert.deepStrictEqual(runner.getRunningTasks(), []);
  });

  it("constructor accepts custom parameters", () => {
    const runner = new AgentRunner("claude-opus-4-5", "be concise", "codex");
    assert.deepStrictEqual(runner.getRunningTasks(), []);
  });

  // ── getRunningTasks / abort ──

  it("getRunningTasks returns empty array when no tasks running", () => {
    const runner = new AgentRunner();
    assert.deepStrictEqual(runner.getRunningTasks(), []);
  });

  it("abort returns false for non-existent task", () => {
    const runner = new AgentRunner();
    assert.strictEqual(runner.abort("nonexistent-id"), false);
  });

  // ── createTask with agent field ──

  it("createTask defaults agent to 'claude'", () => {
    const task = createTask("do something");
    assert.strictEqual(task.agent, "claude");
  });

  it("createTask accepts custom agent", () => {
    const task = createTask("do something", { agent: "codex" });
    assert.strictEqual(task.agent, "codex");
  });

  it("createTask accepts generic agent command", () => {
    const task = createTask("do something", { agent: "aider --yes" });
    assert.strictEqual(task.agent, "aider --yes");
  });

  it("createTask accepts claude-sdk agent", () => {
    const task = createTask("do something", { agent: "claude-sdk" });
    assert.strictEqual(task.agent, "claude-sdk");
  });

  // ── Agent dispatch routing ──

  it("run dispatches claude-sdk agent to SDK path", async () => {
    const runner = new AgentRunner();
    const task = createTask("test prompt", { agent: "claude-sdk", timeout: 1 });
    // SDK not available in test env — should fail with import error, not crash
    try {
      await runner.run(task, "/tmp");
    } catch {
      // Expected — SDK binary not available in test
    }
    // Task should have been marked as running then failed/errored
    assert.ok(["failed", "timeout"].includes(task.status), `status should be failed or timeout, got ${task.status}`);
  });

  it("run dispatches codex agent to Codex CLI path", async () => {
    const runner = new AgentRunner();
    const task = createTask("test prompt", { agent: "codex", timeout: 1 });
    try {
      await runner.run(task, "/tmp");
    } catch {
      // Expected — codex CLI not in path during tests
    }
    assert.ok(["failed", "timeout"].includes(task.status), `status should be failed or timeout, got ${task.status}`);
  });

  it("handleClaudeEvent does not overwrite timeout status", () => {
    const runner = new AgentRunner();
    const task = createTask("test prompt");
    task.status = "timeout";
    task.error = "timeout: task exceeded 5s";

    // Simulate a late result message arriving after timeout
    const resultMsg = {
      type: "result",
      subtype: "success",
      result: "I completed the task",
      total_cost_usd: 0.5,
      usage: { input_tokens: 1000, output_tokens: 500 },
      duration_ms: 3000,
    };

    // Access private method via prototype for testing
    (runner as unknown as { handleClaudeEvent: Function }).handleClaudeEvent(resultMsg, task, Date.now() - 3000);

    // Status must remain "timeout" — not overwritten to "success"
    assert.strictEqual(task.status, "timeout", "timeout status should not be overwritten by late result");
    assert.ok(task.error.includes("timeout"), "error should still mention timeout");
    // But metrics should still be captured
    assert.strictEqual(task.costUsd, 0.5, "cost should be captured even after timeout");
    assert.strictEqual(task.tokenInput, 1000, "input tokens should be captured even after timeout");
  });

  it("run dispatches generic agent to generic CLI path", async () => {
    const runner = new AgentRunner();
    const task = createTask("hello", { agent: "echo", timeout: 5 });
    await runner.run(task, "/tmp");
    // echo succeeds → output captured; verifyBuild fails (no tsconfig in /tmp) → status "failed" with [TSC_FAILED]
    // Validates: (1) generic agent runs and captures output, (2) build verification is enforced
    assert.ok(task.output.includes("hello"), "output should contain the prompt text from echo");
    assert.strictEqual(task.status, "failed", "should fail due to tsc verification in /tmp");
    assert.ok(task.output.startsWith("[TSC_FAILED]"), "output should be prefixed with [TSC_FAILED]");
    assert.ok(task.durationMs > 0, "durationMs should be recorded");
  });
});
