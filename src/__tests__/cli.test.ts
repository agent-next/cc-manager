import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { program } from "../cli.js";

// =============================================================================
// CLI tests — mock fetch to verify HTTP calls, capture console for output
// =============================================================================

// ── Fetch Mock ──

let fetchCalls: { url: string; init?: RequestInit }[] = [];
let fetchResponse: { status: number; body: unknown; ok: boolean };
const originalFetch = globalThis.fetch;

function mockFetch(status: number, body: unknown) {
  fetchCalls = [];
  fetchResponse = { status, ok: status < 400, body };
  (globalThis as any).fetch = async (url: string | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init });
    return {
      ok: fetchResponse.ok,
      status: fetchResponse.status,
      statusText: status < 400 ? "OK" : "Error",
      json: async () => fetchResponse.body,
      text: async () =>
        typeof fetchResponse.body === "string"
          ? fetchResponse.body
          : JSON.stringify(fetchResponse.body),
    };
  };
}

// ── Console Capture ──

let logs: string[] = [];
const originalLog = console.log;
const originalError = console.error;

function captureOutput() {
  logs = [];
  console.log = (...args: any[]) => logs.push(args.join(" "));
  console.error = (...args: any[]) => logs.push(args.join(" "));
}

function restoreOutput() {
  console.log = originalLog;
  console.error = originalError;
}

// Prevent Commander from calling process.exit
program.exitOverride();
// Suppress Commander's own help/error output during tests
program.configureOutput({ writeOut: () => {}, writeErr: () => {} });

// ── Helper ──

async function run(...args: string[]) {
  await program.parseAsync(["node", "cc-m", ...args]);
}

// =============================================================================

describe("cli", () => {
  beforeEach(() => {
    // Reset Commander option state to avoid leaking between tests
    program.setOptionValue("json", undefined);
    program.setOptionValue("url", undefined);
    fetchCalls = [];
    captureOutput();
  });

  afterEach(() => {
    restoreOutput();
    globalThis.fetch = originalFetch;
  });

  // ─── submit ─────────────────────────────────────────────────────────────────

  describe("submit command", () => {
    it("sends POST /api/tasks with prompt", async () => {
      mockFetch(200, { id: "abc123", status: "pending" });
      await run("submit", "fix the bug");

      assert.strictEqual(fetchCalls.length, 1);
      assert.strictEqual(fetchCalls[0].url, "http://localhost:8080/api/tasks");
      assert.strictEqual(fetchCalls[0].init?.method, "POST");
      const body = JSON.parse(fetchCalls[0].init!.body as string);
      assert.strictEqual(body.prompt, "fix the bug");
    });

    it("includes timeout, budget, priority, agent, and tags when provided", async () => {
      mockFetch(200, { id: "abc123", status: "pending" });
      await run(
        "submit", "refactor code",
        "-t", "120",
        "-b", "2.5",
        "-p", "high",
        "-a", "codex",
        "--tags", "ui,refactor"
      );

      const body = JSON.parse(fetchCalls[0].init!.body as string);
      assert.strictEqual(body.prompt, "refactor code");
      assert.strictEqual(body.timeout, 120);
      assert.strictEqual(body.maxBudget, 2.5);
      assert.strictEqual(body.priority, "high");
      assert.strictEqual(body.agent, "codex");
      assert.deepStrictEqual(body.tags, ["ui", "refactor"]);
    });

    it("displays task info on success", async () => {
      mockFetch(200, { id: "task-001", status: "pending", prompt: "do thing" });
      await run("submit", "do thing");

      // Should print formatted row via out() → printRow()
      const output = logs.join("\n");
      assert.ok(output.includes("task-001"), "should display task ID");
    });
  });

  // ─── batch ──────────────────────────────────────────────────────────────────

  describe("batch command", () => {
    it("sends POST /api/tasks/batch with prompts array", async () => {
      mockFetch(200, [
        { id: "t1", status: "pending" },
        { id: "t2", status: "pending" },
      ]);
      await run("batch", "task one", "task two");

      assert.strictEqual(fetchCalls[0].url, "http://localhost:8080/api/tasks/batch");
      assert.strictEqual(fetchCalls[0].init?.method, "POST");
      const body = JSON.parse(fetchCalls[0].init!.body as string);
      assert.deepStrictEqual(body.prompts, ["task one", "task two"]);
    });

    it("includes shared timeout and budget", async () => {
      mockFetch(200, [{ id: "t1", status: "pending" }]);
      await run("batch", "prompt1", "-t", "60", "-b", "1.0");

      const body = JSON.parse(fetchCalls[0].init!.body as string);
      assert.strictEqual(body.timeout, 60);
      assert.strictEqual(body.maxBudget, 1.0);
    });
  });

  // ─── list ───────────────────────────────────────────────────────────────────

  describe("list command", () => {
    it("sends GET /api/tasks with default limit", async () => {
      mockFetch(200, []);
      await run("list");

      assert.strictEqual(fetchCalls.length, 1);
      const url = fetchCalls[0].url;
      assert.ok(url.startsWith("http://localhost:8080/api/tasks?"));
      assert.ok(url.includes("limit=20"), "default limit should be 20");
    });

    it("appends ?status filter", async () => {
      mockFetch(200, []);
      await run("list", "-s", "failed");

      assert.ok(fetchCalls[0].url.includes("status=failed"));
    });

    it("appends ?tag filter", async () => {
      mockFetch(200, []);
      await run("list", "--tag", "ui");

      assert.ok(fetchCalls[0].url.includes("tag=ui"));
    });

    it("appends custom limit", async () => {
      mockFetch(200, []);
      await run("list", "-n", "5");

      assert.ok(fetchCalls[0].url.includes("limit=5"));
    });

    it("formats output as table rows", async () => {
      mockFetch(200, [
        { id: "aaa111", status: "success", prompt: "do stuff", costUsd: 0.42, durationMs: 5000 },
        { id: "bbb222", status: "failed", prompt: "other", costUsd: 0.10, durationMs: 2000 },
      ]);
      await run("list");

      const output = logs.join("\n");
      assert.ok(output.includes("ID"), "should have table header");
      assert.ok(output.includes("STATUS"), "should have table header");
      assert.ok(output.includes("aaa111"), "should show first task ID");
      assert.ok(output.includes("bbb222"), "should show second task ID");
      assert.ok(output.includes("2 tasks"), "should show task count");
    });
  });

  // ─── status ─────────────────────────────────────────────────────────────────

  describe("status command", () => {
    it("sends GET /api/tasks/:id", async () => {
      mockFetch(200, { id: "xyz789", status: "running", prompt: "hello" });
      await run("status", "xyz789");

      assert.strictEqual(fetchCalls[0].url, "http://localhost:8080/api/tasks/xyz789");
      // api() always sends Content-Type header, even on GET
      const headers = fetchCalls[0].init?.headers as Record<string, string>;
      assert.strictEqual(headers["Content-Type"], "application/json");
    });

    it("displays verbose task details", async () => {
      mockFetch(200, {
        id: "xyz789",
        status: "success",
        prompt: "refactor auth",
        costUsd: 0.35,
        durationMs: 12000,
        agent: "claude-sdk",
        tags: ["auth", "refactor"],
      });
      await run("status", "xyz789");

      const output = logs.join("\n");
      assert.ok(output.includes("xyz789"), "should show ID");
      assert.ok(output.includes("refactor auth"), "should show prompt");
      assert.ok(output.includes("$0.3500"), "should show cost");
      assert.ok(output.includes("12.0s"), "should show duration");
      assert.ok(output.includes("claude-sdk"), "should show agent");
      assert.ok(output.includes("auth, refactor"), "should show tags");
    });
  });

  // ─── cancel ─────────────────────────────────────────────────────────────────

  describe("cancel command", () => {
    it("sends DELETE /api/tasks/:id", async () => {
      mockFetch(200, { ok: true });
      await run("cancel", "task-to-cancel");

      assert.strictEqual(fetchCalls[0].url, "http://localhost:8080/api/tasks/task-to-cancel");
      assert.strictEqual(fetchCalls[0].init?.method, "DELETE");
    });
  });

  // ─── retry ──────────────────────────────────────────────────────────────────

  describe("retry command", () => {
    it("sends POST /api/tasks/:id/retry", async () => {
      mockFetch(200, { id: "failed-task", status: "pending", retryCount: 1 });
      await run("retry", "failed-task");

      assert.strictEqual(fetchCalls[0].url, "http://localhost:8080/api/tasks/failed-task/retry");
      assert.strictEqual(fetchCalls[0].init?.method, "POST");
    });
  });

  // ─── diff ───────────────────────────────────────────────────────────────────

  describe("diff command", () => {
    it("sends GET /api/tasks/:id/diff", async () => {
      mockFetch(200, { diff: "--- a/file\n+++ b/file\n+new line" });
      await run("diff", "diff-task");

      assert.strictEqual(fetchCalls[0].url, "http://localhost:8080/api/tasks/diff-task/diff");
    });

    it("outputs raw diff text", async () => {
      const diffText = "--- a/src/cli.ts\n+++ b/src/cli.ts\n+export { program };";
      mockFetch(200, { diff: diffText });
      await run("diff", "diff-task");

      const output = logs.join("\n");
      assert.ok(output.includes(diffText), "should output the diff");
    });

    it("outputs fallback when no diff", async () => {
      mockFetch(200, {});
      await run("diff", "no-diff-task");

      const output = logs.join("\n");
      assert.ok(output.includes("(no diff)"), "should show no diff message");
    });
  });

  // ─── logs ───────────────────────────────────────────────────────────────────

  describe("logs command", () => {
    it("sends GET /api/tasks/:id", async () => {
      mockFetch(200, { id: "log-task", output: "task output here" });
      await run("logs", "log-task");

      assert.strictEqual(fetchCalls[0].url, "http://localhost:8080/api/tasks/log-task");
    });

    it("outputs task output text", async () => {
      mockFetch(200, { output: "Agent completed successfully" });
      await run("logs", "log-task");

      const output = logs.join("\n");
      assert.ok(output.includes("Agent completed successfully"));
    });

    it("outputs fallback when no output", async () => {
      mockFetch(200, {});
      await run("logs", "empty-task");

      const output = logs.join("\n");
      assert.ok(output.includes("(no output)"));
    });
  });

  // ─── stats ──────────────────────────────────────────────────────────────────

  describe("stats command", () => {
    it("sends GET /api/stats", async () => {
      mockFetch(200, {
        total: 50,
        byStatus: { success: 40, failed: 5, running: 3, pending: 2 },
        totalCost: 18.5,
        queueSize: 2,
        activeWorkers: 3,
      });
      await run("stats");

      assert.strictEqual(fetchCalls[0].url, "http://localhost:8080/api/stats");
    });

    it("formats queue depth and cost summary", async () => {
      mockFetch(200, {
        total: 50,
        byStatus: { success: 40, failed: 5, running: 3, pending: 2, timeout: 0 },
        totalCost: 18.5,
        queueSize: 2,
        activeWorkers: 3,
      });
      await run("stats");

      const output = logs.join("\n");
      assert.ok(output.includes("50"), "should show total tasks");
      assert.ok(output.includes("$18.50"), "should show total cost");
      assert.ok(output.includes("2"), "should show queue size");
      assert.ok(output.includes("3"), "should show active workers");
    });
  });

  // ─── workers ────────────────────────────────────────────────────────────────

  describe("workers command", () => {
    it("sends GET /api/workers", async () => {
      mockFetch(200, []);
      await run("workers");

      assert.strictEqual(fetchCalls[0].url, "http://localhost:8080/api/workers");
    });

    it("formats worker table", async () => {
      mockFetch(200, [
        { name: "worker-0", busy: true, currentTask: "task-abc" },
        { name: "worker-1", busy: false, currentTask: null },
      ]);
      await run("workers");

      const output = logs.join("\n");
      assert.ok(output.includes("worker-0"), "should show worker name");
      assert.ok(output.includes("worker-1"), "should show worker name");
      assert.ok(output.includes("task-abc"), "should show current task");
    });
  });

  // ─── search ─────────────────────────────────────────────────────────────────

  describe("search command", () => {
    it("sends GET /api/tasks/search?q=keyword", async () => {
      mockFetch(200, []);
      await run("search", "refactor");

      assert.ok(fetchCalls[0].url.includes("/api/tasks/search?q=refactor"));
    });

    it("encodes special characters in query", async () => {
      mockFetch(200, []);
      await run("search", "fix bug & test");

      assert.ok(fetchCalls[0].url.includes(encodeURIComponent("fix bug & test")));
    });

    it("formats results as table", async () => {
      mockFetch(200, [
        { id: "s1", status: "success", prompt: "refactor auth", costUsd: 0.2, durationMs: 3000 },
      ]);
      await run("search", "refactor");

      const output = logs.join("\n");
      assert.ok(output.includes("ID"), "should have header");
      assert.ok(output.includes("s1"), "should show result");
      assert.ok(output.includes("1 results"), "should show result count");
    });
  });

  // ─── --json flag ────────────────────────────────────────────────────────────

  describe("--json flag", () => {
    const jsonCases: { cmd: string[]; data: unknown }[] = [
      { cmd: ["list"], data: [{ id: "j1", status: "pending", prompt: "test" }] },
      { cmd: ["status", "j2"], data: { id: "j2", status: "success", prompt: "test" } },
      { cmd: ["stats"], data: { total: 10, byStatus: { success: 8 }, totalCost: 3.0, queueSize: 1, activeWorkers: 2 } },
      { cmd: ["workers"], data: [{ name: "w0", busy: true }] },
      { cmd: ["search", "keyword"], data: [{ id: "s1", status: "success" }] },
      { cmd: ["submit", "test prompt"], data: { id: "new1", status: "pending" } },
    ];

    for (const { cmd, data } of jsonCases) {
      it(`outputs raw JSON for ${cmd[0]} command`, async () => {
        mockFetch(200, data);
        await run("--json", ...cmd);

        const parsed = JSON.parse(logs.join("\n"));
        assert.deepStrictEqual(parsed, data);
      });
    }
  });

  // ─── --url flag ─────────────────────────────────────────────────────────────

  describe("--url flag", () => {
    it("uses custom server URL", async () => {
      mockFetch(200, []);
      await run("--url", "http://remote:9090", "list");

      assert.ok(fetchCalls[0].url.startsWith("http://remote:9090/api/tasks"));
    });
  });

  // ─── error handling ─────────────────────────────────────────────────────────

  describe("error handling", () => {
    it("throws on non-2xx with status and body", async () => {
      mockFetch(404, { error: "not found" });

      await assert.rejects(
        () => run("status", "missing-id"),
        (err: Error) => {
          assert.ok(err.message.includes("404"), "should include status code");
          assert.ok(err.message.includes("not found"), "should include response body");
          return true;
        }
      );
    });

    it("throws on 500 server error", async () => {
      mockFetch(500, "Internal Server Error");

      await assert.rejects(
        () => run("list"),
        (err: Error) => {
          assert.ok(err.message.includes("500"));
          return true;
        }
      );
    });

    it("propagates network errors", async () => {
      (globalThis as any).fetch = async () => {
        throw new Error("ECONNREFUSED");
      };

      await assert.rejects(
        () => run("stats"),
        (err: Error) => {
          assert.ok(err.message.includes("ECONNREFUSED"));
          return true;
        }
      );
    });
  });

  // ─── watch ───────────────────────────────────────────────────────────────────

  describe("watch command", () => {
    function mockSSEFetch(chunks: string[]) {
      fetchCalls = [];
      let chunkIndex = 0;
      (globalThis as any).fetch = async (url: string | URL, init?: RequestInit) => {
        fetchCalls.push({ url: String(url), init });
        return {
          ok: true,
          status: 200,
          body: {
            getReader: () => ({
              read: async () => {
                if (chunkIndex < chunks.length) {
                  const encoder = new TextEncoder();
                  return { done: false, value: encoder.encode(chunks[chunkIndex++]) };
                }
                return { done: true, value: undefined };
              },
            }),
          },
        };
      };
    }

    it("connects to /api/events", async () => {
      mockSSEFetch([]);
      await run("watch");

      assert.ok(fetchCalls[0].url.includes("/api/events"));
    });

    it("parses SSE data lines and logs events", async () => {
      const event = JSON.stringify({ type: "task_started", taskId: "t1", status: "running" });
      mockSSEFetch([`data: ${event}\n\n`]);
      await run("watch");

      const output = logs.join("\n");
      assert.ok(output.includes("task_started"), "should log event type");
      assert.ok(output.includes("t1"), "should log task ID");
    });

    it("skips malformed SSE data", async () => {
      mockSSEFetch(["data: not-valid-json\n\n"]);
      await run("watch");

      // Should not throw, just silently skip
      assert.ok(true);
    });

    it("prints connection message", async () => {
      mockSSEFetch([]);
      await run("watch");

      const output = logs.join("\n");
      assert.ok(output.includes("Watching events"), "should show connection message");
    });
  });

  // ─── api() Content-Type header ──────────────────────────────────────────────

  describe("api() helper behavior", () => {
    it("adds Content-Type: application/json header to all requests", async () => {
      mockFetch(200, []);
      await run("list");

      const headers = fetchCalls[0].init?.headers as Record<string, string> | undefined;
      assert.strictEqual(headers?.["Content-Type"], "application/json");
    });

    it("sends Content-Type on POST requests", async () => {
      mockFetch(200, { id: "t1", status: "pending" });
      await run("submit", "test");

      const headers = fetchCalls[0].init?.headers as Record<string, string>;
      assert.strictEqual(headers["Content-Type"], "application/json");
    });
  });
});
