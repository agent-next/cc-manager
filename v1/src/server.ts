import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { streamSSE } from "hono/streaming";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Scheduler } from "./scheduler.js";
import type { WorktreePool } from "./worktree-pool.js";

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

  private setupRoutes(): void {
    const app = this.app;

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

    // API: task detail
    app.get("/api/tasks/:id", (c) => {
      const task = this._scheduler.getTask(c.req.param("id"));
      if (!task) return c.json({ error: "not found" }, 404);
      return c.json(task);
    });

    // API: task output (plain text for easy curl consumption)
    app.get("/api/tasks/:id/output", (c) => {
      const task = this._scheduler.getTask(c.req.param("id"));
      if (!task) return c.text("not found", 404);
      return c.text(task.output);
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

    // API: cancel task
    app.delete("/api/tasks/:id", (c) => {
      const ok = this._scheduler.cancel(c.req.param("id"));
      return ok ? c.json({ ok: true }) : c.json({ error: "cannot cancel" }, 400);
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
      console.log(`[server] http://localhost:${info.port}`);
    });
  }
}
