#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "fs";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const BASE_URL = process.env.CC_MANAGER_URL ?? "http://localhost:8080";

// ── Helpers ──

async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return res.json() as Promise<T>;
}

function out(data: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (Array.isArray(data)) {
    for (const item of data) printRow(item);
  } else if (data && typeof data === "object") {
    printRow(data as Record<string, unknown>);
  } else {
    console.log(data);
  }
}

function printRow(obj: Record<string, unknown>): void {
  const id = obj.id ?? "";
  const status = obj.status ?? "";
  const prompt = String(obj.prompt ?? "").slice(0, 80).replace(/\n/g, " ");
  const cost = obj.costUsd != null ? `$${Number(obj.costUsd).toFixed(2)}` : "";
  const duration = obj.durationMs != null ? `${(Number(obj.durationMs) / 1000).toFixed(1)}s` : "";
  console.log(`${String(id).padEnd(10)} ${String(status).padEnd(10)} ${cost.padEnd(8)} ${duration.padEnd(8)} ${prompt}`);
}

function statusColor(s: string): string {
  const colors: Record<string, string> = {
    pending: "\x1b[33m",   // yellow
    running: "\x1b[36m",   // cyan
    success: "\x1b[32m",   // green
    failed: "\x1b[31m",    // red
    timeout: "\x1b[35m",   // magenta
    cancelled: "\x1b[90m", // gray
  };
  return `${colors[s] ?? ""}${s}\x1b[0m`;
}

function printTask(t: Record<string, unknown>): void {
  const col = 16;
  console.log(`  ${"ID".padEnd(col)}${t.id}`);
  console.log(`  ${"Status".padEnd(col)}${statusColor(String(t.status))}`);
  console.log(`  ${"Prompt".padEnd(col)}${String(t.prompt ?? "").slice(0, 120)}`);
  if (t.agent) console.log(`  ${"Agent".padEnd(col)}${t.agent}`);
  if (t.priority && t.priority !== "normal") console.log(`  ${"Priority".padEnd(col)}${t.priority}`);
  if (t.costUsd) console.log(`  ${"Cost".padEnd(col)}$${Number(t.costUsd).toFixed(4)}`);
  if (t.durationMs) console.log(`  ${"Duration".padEnd(col)}${(Number(t.durationMs) / 1000).toFixed(1)}s`);
  if (t.tokenInput) console.log(`  ${"Tokens".padEnd(col)}${t.tokenInput} in / ${t.tokenOutput} out`);
  if (t.worktree) console.log(`  ${"Worker".padEnd(col)}${t.worktree}`);
  if (t.error) console.log(`  ${"Error".padEnd(col)}\x1b[31m${String(t.error).slice(0, 200)}\x1b[0m`);
  if (t.output) console.log(`  ${"Output".padEnd(col)}${String(t.output).slice(0, 300)}`);
  if (t.tags) console.log(`  ${"Tags".padEnd(col)}${(t.tags as string[]).join(", ")}`);
  console.log("");
}

// ── CLI ──

const program = new Command()
  .name("cc-m")
  .description("CLI client for cc-manager")
  .version(version)
  .option("--url <url>", "cc-manager server URL", BASE_URL)
  .option("--json", "Output raw JSON");

// ── submit ──
program
  .command("submit <prompt>")
  .description("Submit a task")
  .option("-t, --timeout <s>", "Timeout in seconds")
  .option("-b, --budget <usd>", "Max budget per task")
  .option("-p, --priority <level>", "Priority: urgent|high|normal|low")
  .option("-a, --agent <cmd>", "Agent: claude|claude-sdk|codex|<any cli>")
  .option("--tags <tags>", "Comma-separated tags")
  .action(async (prompt: string, opts: Record<string, string>) => {
    const body: Record<string, unknown> = { prompt };
    if (opts.timeout) body.timeout = Number(opts.timeout);
    if (opts.budget) body.maxBudget = Number(opts.budget);
    if (opts.priority) body.priority = opts.priority;
    if (opts.agent) body.agent = opts.agent;
    if (opts.tags) body.tags = opts.tags.split(",").map((t: string) => t.trim());
    const result = await api("/api/tasks", { method: "POST", body: JSON.stringify(body) });
    out(result, !!program.opts().json);
  });

// ── batch ──
program
  .command("batch <prompts...>")
  .description("Submit multiple tasks")
  .option("-t, --timeout <s>", "Timeout in seconds")
  .option("-b, --budget <usd>", "Max budget per task")
  .action(async (prompts: string[], opts: Record<string, string>) => {
    const body: Record<string, unknown> = { prompts };
    if (opts.timeout) body.timeout = Number(opts.timeout);
    if (opts.budget) body.maxBudget = Number(opts.budget);
    const result = await api("/api/tasks/batch", { method: "POST", body: JSON.stringify(body) });
    out(result, !!program.opts().json);
  });

// ── list ──
program
  .command("list")
  .alias("ls")
  .description("List tasks")
  .option("-s, --status <status>", "Filter by status")
  .option("-n, --limit <n>", "Max results", "20")
  .option("--tag <tag>", "Filter by tag")
  .action(async (opts: Record<string, string>) => {
    const params = new URLSearchParams();
    if (opts.status) params.set("status", opts.status);
    if (opts.limit) params.set("limit", opts.limit);
    if (opts.tag) params.set("tag", opts.tag);
    const tasks = await api<Array<Record<string, unknown>>>(`/api/tasks?${params}`);
    if (program.opts().json) {
      console.log(JSON.stringify(tasks, null, 2));
    } else {
      console.log(`${"ID".padEnd(10)} ${"STATUS".padEnd(10)} ${"COST".padEnd(8)} ${"TIME".padEnd(8)} PROMPT`);
      console.log("─".repeat(80));
      for (const t of tasks) printRow(t);
      console.log(`\n${tasks.length} tasks`);
    }
  });

// ── status (single task) ──
program
  .command("status <id>")
  .alias("get")
  .description("Get task details")
  .action(async (id: string) => {
    const task = await api<Record<string, unknown>>(`/api/tasks/${id}`);
    if (program.opts().json) {
      console.log(JSON.stringify(task, null, 2));
    } else {
      printTask(task);
    }
  });

// ── logs (task output) ──
program
  .command("logs <id>")
  .description("Get task output")
  .action(async (id: string) => {
    const task = await api<Record<string, unknown>>(`/api/tasks/${id}`);
    console.log(task.output ?? "(no output)");
  });

// ── diff ──
program
  .command("diff <id>")
  .description("Get git diff for a completed task")
  .action(async (id: string) => {
    const result = await api<Record<string, unknown>>(`/api/tasks/${id}/diff`);
    console.log(result.diff ?? "(no diff)");
  });

// ── cancel ──
program
  .command("cancel <id>")
  .description("Cancel a pending task")
  .action(async (id: string) => {
    const result = await api(`/api/tasks/${id}`, { method: "DELETE" });
    out(result, !!program.opts().json);
  });

// ── retry ──
program
  .command("retry <id>")
  .description("Retry a failed task")
  .action(async (id: string) => {
    const result = await api(`/api/tasks/${id}/retry`, { method: "POST" });
    out(result, !!program.opts().json);
  });

// ── workers ──
program
  .command("workers")
  .alias("w")
  .description("Show worker pool status")
  .action(async () => {
    const workers = await api<Array<Record<string, unknown>>>("/api/workers");
    if (program.opts().json) {
      console.log(JSON.stringify(workers, null, 2));
    } else {
      for (const w of workers) {
        const status = w.busy ? "\x1b[36mbusy\x1b[0m" : "\x1b[32midle\x1b[0m";
        const task = w.currentTask ? ` → ${w.currentTask}` : "";
        console.log(`  ${String(w.name).padEnd(14)} ${status}${task}`);
      }
    }
  });

// ── stats ──
program
  .command("stats")
  .description("Show queue stats and cost summary")
  .action(async () => {
    const stats = await api<Record<string, unknown>>("/api/stats");
    if (program.opts().json) {
      console.log(JSON.stringify(stats, null, 2));
    } else {
      const col = 20;
      const by = stats.byStatus as Record<string, number> | undefined;
      console.log(`  ${"Total tasks".padEnd(col)}${stats.total}`);
      if (by) {
        console.log(`  ${"Success".padEnd(col)}\x1b[32m${by.success ?? 0}\x1b[0m`);
        console.log(`  ${"Failed".padEnd(col)}\x1b[31m${by.failed ?? 0}\x1b[0m`);
        console.log(`  ${"Running".padEnd(col)}\x1b[36m${by.running ?? 0}\x1b[0m`);
        console.log(`  ${"Pending".padEnd(col)}\x1b[33m${by.pending ?? 0}\x1b[0m`);
        console.log(`  ${"Timeout".padEnd(col)}\x1b[35m${by.timeout ?? 0}\x1b[0m`);
      }
      console.log(`  ${"Total cost".padEnd(col)}$${Number(stats.totalCost ?? 0).toFixed(2)}`);
      console.log(`  ${"Queue size".padEnd(col)}${stats.queueSize}`);
      console.log(`  ${"Active workers".padEnd(col)}${stats.activeWorkers}`);
    }
  });

// ── watch (SSE stream) ──
program
  .command("watch")
  .description("Watch real-time task events (SSE)")
  .action(async () => {
    const url = `${program.opts().url ?? BASE_URL}/api/events`;
    console.log(`Watching events at ${url} (Ctrl+C to stop)\n`);

    const res = await fetch(url);
    if (!res.body) {
      console.error("No response body");
      process.exit(1);
    }
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      for (const line of text.split("\n")) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6).trim();
          if (!data) continue;
          try {
            const event = JSON.parse(data);
            const ts = new Date().toLocaleTimeString();
            const type = event.type ?? "unknown";
            const taskId = event.taskId ?? "";
            const extra = event.status ? ` [${statusColor(event.status)}]` : "";
            console.log(`${ts}  ${type.padEnd(18)} ${taskId}${extra}`);
          } catch {
            // keep-alive ping or malformed
          }
        }
      }
    }
  });

// ── search ──
program
  .command("search <query>")
  .description("Search tasks by keyword")
  .action(async (query: string) => {
    const tasks = await api<Array<Record<string, unknown>>>(`/api/tasks/search?q=${encodeURIComponent(query)}`);
    if (program.opts().json) {
      console.log(JSON.stringify(tasks, null, 2));
    } else {
      console.log(`${"ID".padEnd(10)} ${"STATUS".padEnd(10)} ${"COST".padEnd(8)} ${"TIME".padEnd(8)} PROMPT`);
      console.log("─".repeat(80));
      for (const t of tasks) printRow(t);
      console.log(`\n${tasks.length} results`);
    }
  });

program.parseAsync().catch((err: Error) => {
  console.error(`\x1b[31mError:\x1b[0m ${err.message}`);
  process.exit(1);
});
