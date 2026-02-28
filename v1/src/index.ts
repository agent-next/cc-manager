import { Command } from "commander";
import { readFileSync } from "fs";
import { WorktreePool } from "./worktree-pool.js";
import { AgentRunner } from "./agent-runner.js";
import { Store } from "./store.js";
import { Scheduler } from "./scheduler.js";
import { WebServer } from "./server.js";

const program = new Command()
  .name("cc-manager")
  .description("Claude Code multi-agent orchestrator")
  .requiredOption("--repo <path>", "Git repository path")
  .option("--workers <n>", "Number of parallel workers", "10")
  .option("--port <n>", "HTTP server port", "8080")
  .option("--timeout <s>", "Task timeout in seconds", "300")
  .option("--budget <usd>", "Max budget per task in USD", "5")
  .option("--model <id>", "Claude model ID", "claude-sonnet-4-6")
  .option("--system-prompt <text>", "System prompt for all agents", "")
  .option("--system-prompt-file <path>", "Path to a file containing the system prompt (takes precedence over --system-prompt)")
  .option("--total-budget <usd>", "Total spend limit in USD across all tasks (0 = unlimited)", "0")
  .parse();

const opts = program.opts();

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
  const pool = new WorktreePool(opts.repo, parseInt(opts.workers));
  await pool.init();

  const runner = new AgentRunner(opts.model, systemPrompt);
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
  const url = `http://localhost:${opts.port}`;
  console.log("");
  console.log("  CC-Manager V1  •  Ready");
  console.log("  " + "─".repeat(44));
  console.log(`  ${"Server URL".padEnd(col)}${url}`);
  console.log(`  ${"Repo".padEnd(col)}${opts.repo}`);
  console.log(`  ${"Workers".padEnd(col)}${opts.workers}`);
  console.log(`  ${"Model".padEnd(col)}${opts.model}`);
  console.log(`  ${"Timeout".padEnd(col)}${opts.timeout}s`);
  console.log(`  ${"Budget".padEnd(col)}$${opts.budget} per task`);
  if (totalBudget > 0) {
    console.log(`  ${"Total Budget".padEnd(col)}$${totalBudget}`);
  }
  console.log("  " + "─".repeat(44));
  console.log("");

  const shutdown = async () => {
    console.log("\nShutting down...");
    await scheduler.stop();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
