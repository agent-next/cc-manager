#!/usr/bin/env node
import { Command } from "commander";
import { existsSync, readFileSync } from "fs";
import { WorktreePool } from "./worktree-pool.js";
import { AgentRunner } from "./agent-runner.js";
import { Store } from "./store.js";
import { Scheduler } from "./scheduler.js";
import { WebServer } from "./server.js";
import { setLogLevel } from "./logger.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const program = new Command()
  .name("cc-manager")
  .description("Claude Code multi-agent orchestrator")
  .version(version)
  .requiredOption("--repo <path>", "Git repository path")
  .option("--workers <n>", "Number of parallel workers", "10")
  .option("--port <n>", "HTTP server port", "8080")
  .option("--timeout <s>", "Task timeout in seconds", "600")
  .option("--budget <usd>", "Max budget per task in USD", "5")
  .option("--model <id>", "Claude model ID", "claude-sonnet-4-6")
  .option("--system-prompt <text>", "System prompt for all agents", "")
  .option("--system-prompt-file <path>", "Path to a file containing the system prompt (takes precedence over --system-prompt)")
  .option("--total-budget <usd>", "Total spend limit in USD across all tasks (0 = unlimited)", "0")
  .option("--agent <cmd>", "Default agent CLI (claude, codex, or any CLI command)", "claude")
  .option("--verbose", "Enable debug-level logging")
  .option("--quiet", "Only show errors")
  .parse();

const opts = program.opts();

// Configure log level
if (opts.verbose) setLogLevel("debug");
else if (opts.quiet) setLogLevel("error");

// Resolve system prompt: file takes precedence over inline text
let systemPrompt: string = opts.systemPrompt ?? "";
if (opts.systemPromptFile) {
  systemPrompt = readFileSync(opts.systemPromptFile, "utf8");
}

// Global error handlers for graceful exit
process.on("uncaughtException", (err: Error) => {
  console.error("Uncaught exception:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason: unknown) => {
  console.error("Unhandled rejection:", reason);
  process.exit(1);
});

async function main() {
  // Validate --repo: must exist and be a git repository
  if (!existsSync(opts.repo) || !existsSync(`${opts.repo}/.git`)) {
    console.error(`Error: ${opts.repo} is not a git repository`);
    process.exit(1);
  }

  // Validate --workers: must be between 1 and 20
  const workers = parseInt(opts.workers);
  if (isNaN(workers) || workers < 1 || workers > 20) {
    console.error(`Error: --workers must be between 1 and 20`);
    process.exit(1);
  }

  // Validate --port: must be between 1024 and 65535
  const port = parseInt(opts.port);
  if (isNaN(port) || port < 1024 || port > 65535) {
    console.error(`Error: --port must be between 1024 and 65535`);
    process.exit(1);
  }

  const pool = new WorktreePool(opts.repo, parseInt(opts.workers));
  await pool.init();

  const runner = new AgentRunner(opts.model, systemPrompt, opts.agent);
  const store = new Store(opts.repo);

  const server = new WebServer(pool, parseInt(opts.port));

  const scheduler = new Scheduler(pool, runner, store, (event) => {
    server.broadcast(event);
  });

  server.setScheduler(scheduler);

  const totalBudget = parseFloat(opts.totalBudget);
  if (totalBudget > 0) {
    scheduler.setTotalBudgetLimit(totalBudget);
  }

  scheduler.start();
  server.start();

  // Print formatted startup banner
  const col = 16;
  const dashboardUrl = `http://localhost:${port}`;
  console.log("");
  console.log(`  ${"Version".padEnd(col)}${version}`);
  console.log(`  ${"Repo".padEnd(col)}${opts.repo}`);
  console.log(`  ${"Workers".padEnd(col)}${workers}`);
  console.log(`  ${"Port".padEnd(col)}${port}`);
  console.log(`  ${"Model".padEnd(col)}${opts.model}`);
  console.log(`  ${"Agent".padEnd(col)}${opts.agent}`);
  console.log(`  ${"Dashboard URL".padEnd(col)}${dashboardUrl}`);
  console.log("");

  const shutdown = async () => {
    console.log("shutting down gracefully");
    try {
      await scheduler.stop();
      console.log("scheduler stopped");
      store.close();
      process.exit(0);
    } catch (err) {
      console.error(err);
      process.exit(1);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
