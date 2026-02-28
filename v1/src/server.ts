import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { streamSSE } from "hono/streaming";
import { cors } from "hono/cors";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Scheduler } from "./scheduler.js";
import type { Store } from "./store.js";
import type { WorktreePool } from "./worktree-pool.js";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_CLEANUP_MS = 5 * 60_000; // 5 minutes

export class WebServer {
  private app = new Hono();
  private sseClients = new Set<(data: string) => void>();
  private _scheduler!: Scheduler;
  private rateLimitStore = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private pool: WorktreePool,
    private port: number,
  ) {
    this.setupRoutes();
    // Periodically remove expired rate-limit entries
    setInterval(() => this.cleanupRateLimit(), RATE_LIMIT_CLEANUP_MS).unref();
  }

  private cleanupRateLimit(): void {
    const now = Date.now();
    for (const [ip, entry] of this.rateLimitStore) {
      if (entry.resetAt <= now) {
        this.rateLimitStore.delete(ip);
      }
    }
  }

  private checkRateLimit(ip: string): { allowed: boolean; retryAfterSecs: number } {
    const now = Date.now();
    let entry = this.rateLimitStore.get(ip);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS };
      this.rateLimitStore.set(ip, entry);
      return { allowed: true, retryAfterSecs: 0 };
    }
    entry.count += 1;
    if (entry.count > RATE_LIMIT_MAX) {
      const retryAfterSecs = Math.ceil((entry.resetAt - now) / 1000);
      return { allowed: false, retryAfterSecs };
    }
    return { allowed: true, retryAfterSecs: 0 };
  }

  setScheduler(scheduler: Scheduler): void {
    this._scheduler = scheduler;
  }

  private get store(): Store {
    return (this._scheduler as any).store as Store;
  }

  private setupRoutes(): void {
    const app = this.app;

    // Enable CORS for all routes (allows external frontends and tools to access the API)
    app.use(cors());

    // Global error handler: catches any unhandled error thrown by a route handler
    app.onError((err, c) => {
      log("error", "unhandled error", {
        message: err.message,
        stack: err.stack,
        method: c.req.method,
        path: c.req.path,
      });
      return c.json({ error: err.message, status: 500 }, 500);
    });

    // Request logging middleware
    app.use(async (c, next) => {
      const start = Date.now();
      await next();
      const reqPath = c.req.path;
      // Skip SSE endpoint and static file requests
      if (reqPath === "/api/events" || /\.\w+$/.test(reqPath)) return;
      log("info", "request", {
        method: c.req.method,
        path: reqPath,
        status: c.res.status,
        durationMs: Date.now() - start,
      });
    });

    // Dashboard
    app.get("/", (c) => {
      const html = readFileSync(path.join(__dirname, "web", "index.html"), "utf-8");
      return c.html(html);
    });

    // API: health check
    app.get("/api/health", (c) => {
      const stats = this._scheduler.getStats();
      const workerList = this.pool.getStatus();
      return c.json({
        status: "ok",
        uptime: process.uptime(),
        version: "1.0.0",
        workers: {
          total: workerList.length,
          busy: this.pool.busy,
          available: this.pool.available,
        },
        tasks: {
          total: stats.total,
          running: stats.byStatus["running"] ?? 0,
          queued: stats.queueSize,
          success: stats.byStatus["success"] ?? 0,
          failed: stats.byStatus["failed"] ?? 0,
        },
        totalCost: stats.totalCost,
      });
    });

    // API: stats
    app.get("/api/stats", (c) => c.json(this._scheduler.getStats()));

    // API: daily stats (7-day breakdown from store)
    app.get("/api/stats/daily", (c) => {
      const daily = this.store.getDailyStats();
      return c.json(daily);
    });

    // API: budget summary
    app.get("/api/budget", (c) => {
      const stats = this._scheduler.getStats();
      const spent = stats.totalCost;
      const limit = stats.totalBudgetLimit;
      const remaining = limit === 0 ? null : Math.max(0, limit - spent);
      return c.json({ spent, limit, remaining });
    });

    // API: list tasks
    // Query params: ?status=running, ?q=keyword, ?limit=10, ?tag=name
    app.get("/api/tasks", (c) => {
      const statusFilter = c.req.query("status");
      const keyword = c.req.query("q");
      const limitParam = c.req.query("limit");
      const tagFilter = c.req.query("tag");

      let tasks = this._scheduler.listTasks();

      if (statusFilter) {
        tasks = tasks.filter((t) => t.status === statusFilter);
      }

      if (keyword) {
        const lower = keyword.toLowerCase();
        tasks = tasks.filter((t) => t.prompt.toLowerCase().includes(lower));
      }

      if (tagFilter) {
        tasks = tasks.filter((t) => t.tags?.includes(tagFilter));
      }

      if (limitParam !== undefined) {
        const limit = parseInt(limitParam, 10);
        if (!isNaN(limit) && limit > 0) {
          tasks = tasks.slice(0, limit);
        }
      }

      const result = tasks.map((t) => ({
        id: t.id,
        prompt: t.prompt.slice(0, 200),
        status: t.status,
        worktree: t.worktree,
        costUsd: t.costUsd,
        createdAt: t.createdAt,
        completedAt: t.completedAt,
        durationMs: t.durationMs,
        tags: t.tags,
      }));
      return c.json(result);
    });

    // API: recent task errors (failed / timeout)
    app.get("/api/tasks/errors", (c) => {
      const errors = this.store.getRecentErrors(10);
      return c.json(errors);
    });

    // API: search tasks by keyword
    app.get("/api/tasks/search", (c) => {
      const query = c.req.query("q") ?? "";
      const tasks = this.store.search(query);
      return c.json(tasks);
    });

    // API: task detail
    app.get("/api/tasks/:id", (c) => {
      const id = c.req.param("id");
      const task = this._scheduler.getTask(id);
      if (!task) return c.json({ error: "not found" }, 404);
      const queuePosition = this._scheduler.getQueuePosition(id);
      return c.json({ ...task, queuePosition });
    });

    // API: task output (plain text for easy curl consumption)
    app.get("/api/tasks/:id/output", (c) => {
      const task = this._scheduler.getTask(c.req.param("id"));
      if (!task) return c.text("not found", 404);
      return c.text(task.output);
    });

    // API: task diff (git diff HEAD~1..HEAD in the task's worktree)
    app.get("/api/tasks/:id/diff", (c) => {
      const task = this._scheduler.getTask(c.req.param("id"));
      if (!task) return c.json({ error: "not found" }, 404);
      if (!task.worktree) return c.json({ error: "no worktree assigned to this task" }, 404);

      let commit: string;
      let diff: string;
      try {
        commit = execSync("git log --oneline -1", { cwd: task.worktree }).toString().trim();
      } catch {
        return c.json({ error: "no commits in worktree" }, 404);
      }

      if (!commit) {
        return c.json({ error: "no commits in worktree" }, 404);
      }

      try {
        diff = execSync("git diff HEAD~1..HEAD", { cwd: task.worktree }).toString();
      } catch {
        return c.json({ error: "no commits in worktree" }, 404);
      }

      return c.json({ taskId: task.id, commit, diff });
    });

    // API: batch submit tasks
    app.post("/api/tasks/batch", async (c) => {
      let body: { prompts?: unknown; timeout?: unknown; maxBudget?: unknown };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "bad json" }, 400);
      }
      if (!Array.isArray(body.prompts) || body.prompts.length === 0) {
        return c.json({ error: "prompts must be a non-empty array" }, 400);
      }
      if (body.prompts.length > 20) {
        return c.json({ error: "batch size cannot exceed 20 prompts" }, 400);
      }
      for (let i = 0; i < body.prompts.length; i++) {
        if (typeof body.prompts[i] !== "string" || (body.prompts[i] as string).trim() === "") {
          return c.json({ error: `prompts[${i}] must be a non-empty string` }, 400);
        }
      }
      if (body.timeout !== undefined && (typeof body.timeout !== "number" || body.timeout <= 0)) {
        return c.json({ error: "timeout must be a positive number" }, 400);
      }
      if (body.maxBudget !== undefined && (typeof body.maxBudget !== "number" || body.maxBudget <= 0)) {
        return c.json({ error: "maxBudget must be a positive number" }, 400);
      }
      const results = (body.prompts as string[]).map((prompt) => {
        const task = this._scheduler.submit(prompt, {
          timeout: body.timeout as number | undefined,
          maxBudget: body.maxBudget as number | undefined,
        });
        return { id: task.id, status: task.status };
      });
      return c.json(results, 201);
    });

    // API: submit task
    app.post("/api/tasks", async (c) => {
      const ip =
        c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
        c.req.header("x-real-ip") ??
        "unknown";
      const { allowed, retryAfterSecs } = this.checkRateLimit(ip);
      if (!allowed) {
        return c.json(
          { error: "Too Many Requests" },
          429,
          { "Retry-After": String(retryAfterSecs) },
        );
      }

      let body: { prompt?: unknown; timeout?: unknown; maxBudget?: unknown; priority?: unknown; tags?: unknown; webhookUrl?: unknown };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "bad json" }, 400);
      }
      if (typeof body.prompt !== "string" || body.prompt.trim() === "") {
        return c.json({ error: "prompt must be a non-empty string" }, 400);
      }
      if (body.timeout !== undefined && (typeof body.timeout !== "number" || body.timeout <= 0)) {
        return c.json({ error: "timeout must be a positive number" }, 400);
      }
      if (body.maxBudget !== undefined && (typeof body.maxBudget !== "number" || body.maxBudget <= 0)) {
        return c.json({ error: "maxBudget must be a positive number" }, 400);
      }
      if (body.priority !== undefined && !["low", "normal", "high"].includes(body.priority as string)) {
        return c.json({ error: 'priority must be "low", "normal", or "high"' }, 400);
      }
      if (body.webhookUrl !== undefined && (typeof body.webhookUrl !== "string" || !body.webhookUrl.startsWith("http"))) {
        return c.json({ error: "webhookUrl must be a URL starting with http" }, 400);
      }
      if (body.tags !== undefined) {
        if (!Array.isArray(body.tags)) {
          return c.json({ error: "tags must be an array of strings" }, 400);
        }
        if (body.tags.length > 10) {
          return c.json({ error: "tags cannot exceed 10 items" }, 400);
        }
        for (let i = 0; i < body.tags.length; i++) {
          if (typeof body.tags[i] !== "string") {
            return c.json({ error: `tags[${i}] must be a string` }, 400);
          }
          if ((body.tags[i] as string).length > 50) {
            return c.json({ error: `tags[${i}] must be 50 characters or fewer` }, 400);
          }
        }
      }
      const task = this._scheduler.submit(body.prompt, {
        timeout: body.timeout as number | undefined,
        maxBudget: body.maxBudget as number | undefined,
        priority: body.priority as "low" | "normal" | "high" | undefined,
        tags: body.tags as string[] | undefined,
        webhookUrl: body.webhookUrl as string | undefined,
      });
      return c.json({ id: task.id, status: task.status }, 201);
    });

    // API: cleanup old tasks
    app.delete("/api/tasks/cleanup", (c) => {
      const daysParam = c.req.query("days");
      const days = daysParam !== undefined ? parseInt(daysParam, 10) : 30;
      if (isNaN(days) || days <= 0) {
        return c.json({ error: "days must be a positive integer" }, 400);
      }
      const deleted = this.store.deleteOlderThan(days);
      return c.json({ deleted });
    });

    // API: cancel task
    app.delete("/api/tasks/:id", (c) => {
      const ok = this._scheduler.cancel(c.req.param("id"));
      return ok ? c.json({ ok: true }) : c.json({ error: "cannot cancel" }, 400);
    });

    // API: retry task (reset failed/timeout task back to pending and re-queue)
    app.post("/api/tasks/:id/retry", (c) => {
      const id = c.req.param("id");
      const task = this._scheduler.getTask(id);
      if (!task) return c.json({ error: "not found" }, 404);
      const retried = this._scheduler.requeue(id);
      if (!retried) {
        return c.json(
          { error: `task is not in a retryable state (current status: ${task.status})` },
          400,
        );
      }
      return c.json({ id: retried.id, status: retried.status, retryCount: retried.retryCount });
    });

    // API: workers
    app.get("/api/workers", (c) => c.json(this.pool.getStatus()));

    // SSE: real-time event stream
    app.get("/api/events", (c) => {
      return streamSSE(c, async (stream) => {
        const send = (data: string) => {
          stream.writeSSE({ data }).catch(() => {});
        };
        this.sseClients.add(send);
        stream.onAbort(() => {
          this.sseClients.delete(send);
        });
        // Keep alive
        while (true) {
          await stream.writeSSE({ data: "" });
          await stream.sleep(15000);
        }
      });
    });

    // API: self-documenting endpoint listing
    app.get("/api/docs", (c) => {
      const docs = {
        version: "1.0.0",
        description: "cc-manager API – schedule and manage Claude agent tasks across git worktrees",
        endpoints: [
          {
            method: "GET",
            path: "/api/health",
            description: "Health check. Returns server uptime, version, worker pool summary, and aggregate task counts.",
            exampleRequest: {
              method: "GET",
              url: "/api/health",
            },
            exampleResponse: {
              status: "ok",
              uptime: 3600,
              version: "1.0.0",
              workers: { total: 4, busy: 1, available: 3 },
              tasks: { total: 42, running: 1, queued: 2, success: 38, failed: 1 },
              totalCost: 0.27,
            },
          },
          {
            method: "GET",
            path: "/api/stats",
            description: "Detailed scheduler statistics including per-status counts, queue depth, average duration, and budget usage.",
            exampleRequest: {
              method: "GET",
              url: "/api/stats",
            },
            exampleResponse: {
              total: 42,
              byStatus: { pending: 2, running: 1, success: 38, failed: 1 },
              totalCost: 0.27,
              queueSize: 2,
              activeWorkers: 1,
              avgDurationMs: 18500,
              totalBudgetLimit: 10,
            },
          },
          {
            method: "GET",
            path: "/api/budget",
            description: "Budget summary showing total USD spent, the configured limit (0 = unlimited), and remaining allowance.",
            exampleRequest: {
              method: "GET",
              url: "/api/budget",
            },
            exampleResponse: {
              spent: 0.27,
              limit: 10,
              remaining: 9.73,
            },
          },
          {
            method: "GET",
            path: "/api/tasks",
            description: "List tasks. Supports optional query filters: status, q (keyword search in prompt), limit, and tag.",
            queryParams: {
              status: "Filter by task status: pending | running | success | failed | timeout | cancelled",
              q: "Keyword to search within task prompts (case-insensitive)",
              limit: "Maximum number of tasks to return (positive integer)",
              tag: "Filter tasks that include this tag",
            },
            exampleRequest: {
              method: "GET",
              url: "/api/tasks?status=success&limit=5",
            },
            exampleResponse: [
              {
                id: "abc123",
                prompt: "Refactor the auth module to use JWT…",
                status: "success",
                worktree: "worker-1",
                costUsd: 0.04,
                createdAt: "2024-01-15T10:00:00.000Z",
                completedAt: "2024-01-15T10:00:22.000Z",
                durationMs: 22000,
                tags: ["auth", "refactor"],
              },
            ],
          },
          {
            method: "GET",
            path: "/api/tasks/:id",
            description: "Get full details of a single task by its ID, including output, events, token counts, and timing.",
            exampleRequest: {
              method: "GET",
              url: "/api/tasks/abc123",
            },
            exampleResponse: {
              id: "abc123",
              prompt: "Refactor the auth module to use JWT",
              status: "success",
              priority: "normal",
              worktree: "worker-1",
              output: "Done. Updated src/auth.ts and added tests.",
              error: "",
              events: [
                { type: "start", timestamp: "2024-01-15T10:00:00.000Z" },
                { type: "complete", timestamp: "2024-01-15T10:00:22.000Z" },
              ],
              createdAt: "2024-01-15T10:00:00.000Z",
              startedAt: "2024-01-15T10:00:01.000Z",
              completedAt: "2024-01-15T10:00:22.000Z",
              timeout: 300000,
              maxBudget: 1,
              costUsd: 0.04,
              tokenInput: 1200,
              tokenOutput: 340,
              durationMs: 22000,
              retryCount: 0,
              maxRetries: 2,
              tags: ["auth", "refactor"],
            },
          },
          {
            method: "GET",
            path: "/api/tasks/:id/output",
            description: "Return the raw text output of a completed task. Useful for piping into other tools via curl.",
            exampleRequest: {
              method: "GET",
              url: "/api/tasks/abc123/output",
            },
            exampleResponse: "Done. Updated src/auth.ts and added tests.",
          },
          {
            method: "POST",
            path: "/api/tasks",
            description: "Submit a single task. Rate-limited to 30 requests per minute per IP. Returns the new task ID and initial status.",
            rateLimit: "30 requests / 60 s per IP",
            requestBody: {
              prompt: "string – required, non-empty",
              timeout: "number – optional, milliseconds (must be > 0)",
              maxBudget: "number – optional, USD spend cap per task (must be > 0)",
              priority: "string – optional: low | normal | high (default: normal)",
              tags: "string[] – optional, up to 10 items each ≤ 50 chars",
              webhookUrl: "string – optional, must start with 'http'",
            },
            exampleRequest: {
              method: "POST",
              url: "/api/tasks",
              body: {
                prompt: "Add input validation to the signup form",
                priority: "high",
                maxBudget: 0.5,
                tags: ["frontend", "validation"],
              },
            },
            exampleResponse: { id: "def456", status: "pending" },
          },
          {
            method: "GET",
            path: "/api/tasks/:id/diff",
            description: "Return the git diff (HEAD~1..HEAD) from the worktree assigned to a task. Returns 404 if the task has no worktree or the worktree has fewer than two commits.",
            exampleRequest: {
              method: "GET",
              url: "/api/tasks/abc123/diff",
            },
            exampleResponse: {
              taskId: "abc123",
              commit: "a1b2c3d Add input validation to signup form",
              diff: "diff --git a/src/signup.ts b/src/signup.ts\n...",
            },
          },
          {
            method: "POST",
            path: "/api/tasks/batch",
            description: "Submit up to 20 tasks in a single request. All tasks share the same optional timeout and maxBudget overrides.",
            requestBody: {
              prompts: "string[] – required, 1–20 non-empty strings",
              timeout: "number – optional, milliseconds applied to every task",
              maxBudget: "number – optional, USD cap applied to every task",
            },
            exampleRequest: {
              method: "POST",
              url: "/api/tasks/batch",
              body: {
                prompts: [
                  "Write unit tests for the payment module",
                  "Add JSDoc comments to src/utils.ts",
                ],
                maxBudget: 1,
              },
            },
            exampleResponse: [
              { id: "ghi789", status: "pending" },
              { id: "jkl012", status: "pending" },
            ],
          },
          {
            method: "DELETE",
            path: "/api/tasks/:id",
            description: "Cancel a pending or running task. Returns 400 if the task cannot be cancelled (e.g. already completed).",
            exampleRequest: {
              method: "DELETE",
              url: "/api/tasks/abc123",
            },
            exampleResponse: { ok: true },
          },
          {
            method: "GET",
            path: "/api/workers",
            description: "List all worker slots in the pool with their name, worktree path, git branch, busy status, and current task ID.",
            exampleRequest: {
              method: "GET",
              url: "/api/workers",
            },
            exampleResponse: [
              { name: "worker-1", path: "/repo/.claude/worktrees/worker-1", branch: "worker-1", busy: true, currentTask: "abc123" },
              { name: "worker-2", path: "/repo/.claude/worktrees/worker-2", branch: "worker-2", busy: false },
            ],
          },
          {
            method: "GET",
            path: "/api/events",
            description: "Server-Sent Events stream for real-time task lifecycle notifications. Emits task_queued and task_final events. Sends a keep-alive ping every 15 s.",
            exampleRequest: {
              method: "GET",
              url: "/api/events",
              note: "Use EventSource in the browser or curl --no-buffer",
            },
            exampleResponse: {
              note: "Stream of SSE messages",
              events: [
                { type: "task_queued", id: "abc123", prompt: "…" },
                { type: "task_final", id: "abc123", status: "success", costUsd: 0.04 },
              ],
            },
          },
          {
            method: "GET",
            path: "/api/docs",
            description: "This endpoint. Returns a self-describing JSON object listing every available API endpoint with method, path, description, and example request/response.",
            exampleRequest: {
              method: "GET",
              url: "/api/docs",
            },
            exampleResponse: { version: "1.0.0", description: "…", endpoints: ["…"] },
          },
        ],
      };
      return c.json(docs);
    });
  }

  broadcast(event: Record<string, unknown>): void {
    const data = JSON.stringify(event);
    for (const send of this.sseClients) {
      try {
        send(data);
      } catch {
        this.sseClients.delete(send);
      }
    }
  }

  start(): void {
    serve({ fetch: this.app.fetch, port: this.port }, (info) => {
      log("info", "[server] listening", { url: `http://localhost:${info.port}` });
    });
  }
}
