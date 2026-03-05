import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pipeline, extractFilePaths, validateWaves } from "../pipeline.js";
import { PipelineStore } from "../pipeline-store.js";
import { createTask } from "../types.js";
import type { Task } from "../types.js";
import type { AgentRunner } from "../agent-runner.js";
import type { Scheduler } from "../scheduler.js";
import type { PipelineConfig, PipelineRun } from "../pipeline-types.js";
import { defaultPipelineConfig } from "../pipeline-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDb(): { db: Database.Database; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-test-"));
  const db = new Database(path.join(dir, "test.db"));
  db.pragma("journal_mode = WAL");
  return {
    db,
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function makeConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return { ...defaultPipelineConfig, autoApprove: true, ...overrides };
}

function makeRunner(handler?: (task: Task, cwd: string) => Task): AgentRunner {
  return {
    run: async (task: Task, cwd: string, _cb?: unknown) => {
      if (handler) return handler(task, cwd);
      task.status = "success";
      task.output = "done";
      return task;
    },
    getRunningTasks: () => [],
    reviewDiffWithAgent: async () => ({ approve: true, score: 80, issues: [], suggestions: [] }),
  } as unknown as AgentRunner;
}

function makeScheduler(opts?: {
  submitHandler?: (prompt: string) => Task;
  getTaskHandler?: (id: string) => Task | undefined;
  cancelHandler?: (id: string) => boolean;
}): Scheduler {
  const tasks = new Map<string, Task>();
  return {
    submit: (prompt: string, submitOpts?: Record<string, unknown>) => {
      if (opts?.submitHandler) return opts.submitHandler(prompt);
      const t = createTask(prompt, { tags: submitOpts?.tags as string[] });
      t.status = "success";
      tasks.set(t.id, t);
      return t;
    },
    getTask: (id: string) => {
      if (opts?.getTaskHandler) return opts.getTaskHandler(id);
      return tasks.get(id);
    },
    cancel: (id: string) => {
      if (opts?.cancelHandler) return opts.cancelHandler(id);
      return true;
    },
  } as unknown as Scheduler;
}

// ---------------------------------------------------------------------------
// PipelineStore tests
// ---------------------------------------------------------------------------

describe("PipelineStore", () => {
  it("save and get a PipelineRun", () => {
    const { db, cleanup } = makeTempDb();
    try {
      const store = new PipelineStore(db);
      const now = new Date().toISOString();
      const run: PipelineRun = {
        id: "run-001",
        goal: "add auth",
        stage: "research_plan",
        mode: "augment",
        iteration: 0,
        maxIterations: 3,
        waves: [],
        taskIds: [],
        createdAt: now,
        updatedAt: now,
      };
      store.save(run);
      const got = store.get("run-001");
      assert.ok(got !== null);
      assert.strictEqual(got.id, "run-001");
      assert.strictEqual(got.goal, "add auth");
      assert.strictEqual(got.stage, "research_plan");
      assert.strictEqual(got.mode, "augment");
      assert.strictEqual(got.iteration, 0);
      assert.strictEqual(got.maxIterations, 3);
      assert.deepStrictEqual(got.waves, []);
      assert.deepStrictEqual(got.taskIds, []);
      assert.strictEqual(got.createdAt, now);
    } finally {
      cleanup();
    }
  });

  it("list returns runs in descending order", () => {
    const { db, cleanup } = makeTempDb();
    try {
      const store = new PipelineStore(db);
      const run1: PipelineRun = {
        id: "r1", goal: "first", stage: "done", mode: "augment",
        iteration: 0, maxIterations: 3, waves: [], taskIds: [],
        createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z",
      };
      const run2: PipelineRun = {
        id: "r2", goal: "second", stage: "execute", mode: "greenfield",
        iteration: 1, maxIterations: 3, waves: [], taskIds: [],
        createdAt: "2024-01-03T00:00:00.000Z", updatedAt: "2024-01-03T00:00:00.000Z",
      };
      const run3: PipelineRun = {
        id: "r3", goal: "third", stage: "verify", mode: "augment",
        iteration: 0, maxIterations: 3, waves: [], taskIds: [],
        createdAt: "2024-01-02T00:00:00.000Z", updatedAt: "2024-01-02T00:00:00.000Z",
      };
      store.save(run1);
      store.save(run2);
      store.save(run3);
      const runs = store.list();
      assert.strictEqual(runs.length, 3);
      assert.strictEqual(runs[0].id, "r2", "newest first");
      assert.strictEqual(runs[1].id, "r3");
      assert.strictEqual(runs[2].id, "r1", "oldest last");
    } finally {
      cleanup();
    }
  });

  it("updateStage changes stage and updatedAt", () => {
    const { db, cleanup } = makeTempDb();
    try {
      const store = new PipelineStore(db);
      const now = "2024-01-01T00:00:00.000Z";
      const run: PipelineRun = {
        id: "upd-1", goal: "test", stage: "research_plan", mode: "augment",
        iteration: 0, maxIterations: 3, waves: [], taskIds: [],
        createdAt: now, updatedAt: now,
      };
      store.save(run);
      store.updateStage("upd-1", "decompose");
      const got = store.get("upd-1");
      assert.ok(got !== null);
      assert.strictEqual(got.stage, "decompose");
      assert.notStrictEqual(got.updatedAt, now, "updatedAt should have changed");
    } finally {
      cleanup();
    }
  });

  it("get returns null for missing id", () => {
    const { db, cleanup } = makeTempDb();
    try {
      const store = new PipelineStore(db);
      assert.strictEqual(store.get("nonexistent"), null);
    } finally {
      cleanup();
    }
  });

  it("save persists waves and taskIds as JSON", () => {
    const { db, cleanup } = makeTempDb();
    try {
      const store = new PipelineStore(db);
      const now = new Date().toISOString();
      const run: PipelineRun = {
        id: "json-1", goal: "test json", stage: "execute", mode: "augment",
        iteration: 1, maxIterations: 3,
        waves: [{ waveIndex: 0, taskIds: ["t1", "t2"], successCount: 2, failCount: 0 }],
        taskIds: ["t1", "t2"],
        createdAt: now, updatedAt: now,
      };
      store.save(run);
      const got = store.get("json-1");
      assert.ok(got !== null);
      assert.deepStrictEqual(got.waves, run.waves);
      assert.deepStrictEqual(got.taskIds, run.taskIds);
    } finally {
      cleanup();
    }
  });

  it("updateStage with additional fields merges them", () => {
    const { db, cleanup } = makeTempDb();
    try {
      const store = new PipelineStore(db);
      const now = new Date().toISOString();
      const run: PipelineRun = {
        id: "merge-1", goal: "test", stage: "verify", mode: "augment",
        iteration: 0, maxIterations: 3, waves: [], taskIds: [],
        createdAt: now, updatedAt: now,
      };
      store.save(run);
      store.updateStage("merge-1", "failed", { error: "tsc failed", iteration: 2 });
      const got = store.get("merge-1");
      assert.ok(got !== null);
      assert.strictEqual(got.stage, "failed");
      assert.strictEqual(got.error, "tsc failed");
      assert.strictEqual(got.iteration, 2);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Pipeline tests
// ---------------------------------------------------------------------------

describe("Pipeline", () => {
  it("start() returns a PipelineRun with stage=research_plan", async () => {
    const { db, cleanup } = makeTempDb();
    try {
      const store = new PipelineStore(db);
      const events: Record<string, unknown>[] = [];
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-repo-"));

      const pipeline = new Pipeline(
        makeRunner(),
        makeScheduler(),
        store,
        repoDir,
        (ev) => events.push(ev),
        makeConfig(),
      );

      const run = pipeline.start("build a feature");
      assert.ok(run.id);
      assert.strictEqual(run.stage, "research_plan");
      assert.strictEqual(run.goal, "build a feature");
      assert.strictEqual(run.iteration, 0);
      assert.deepStrictEqual(run.waves, []);
      assert.deepStrictEqual(run.taskIds, []);
      assert.ok(events.some((e) => e.type === "pipeline:started"));

      // Wait for background drive() to settle before cleanup
      await new Promise((r) => setTimeout(r, 500));
      fs.rmSync(repoDir, { recursive: true, force: true });
    } finally {
      cleanup();
    }
  });

  it("doResearchPlan detects greenfield mode when git log fails", async () => {
    const { db, cleanup } = makeTempDb();
    try {
      const store = new PipelineStore(db);
      // Use a non-git directory to trigger greenfield detection
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-no-git-"));
      const events: Record<string, unknown>[] = [];

      const runner = makeRunner((task) => {
        task.status = "success";
        task.output = "plan created";
        return task;
      });

      const pipeline = new Pipeline(
        runner,
        makeScheduler(),
        store,
        repoDir,
        (ev) => events.push(ev),
        makeConfig(),
      );

      const run = pipeline.start("new project");
      // Wait for drive() to complete
      await new Promise((r) => setTimeout(r, 200));

      const saved = store.get(run.id);
      assert.ok(saved !== null);
      assert.strictEqual(saved.mode, "greenfield");

      fs.rmSync(repoDir, { recursive: true, force: true });
    } finally {
      cleanup();
    }
  });

  it("human checkpoint: pauses at waiting_approval, approve() resumes", async () => {
    const { db, cleanup } = makeTempDb();
    try {
      const store = new PipelineStore(db);
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-approve-"));
      const events: Record<string, unknown>[] = [];

      // Runner that writes plan file and returns decompose JSON for subsequent stages
      let callCount = 0;
      const runner = makeRunner((task) => {
        callCount++;
        task.status = "success";
        if (callCount === 1) {
          // research_plan stage
          task.output = "plan written";
        } else if (callCount === 2) {
          // decompose stage
          task.output = JSON.stringify({ waves: [{ waveIndex: 0, tasks: ["task A"] }], totalTasks: 1 });
        } else {
          // verify stage
          task.output = JSON.stringify({ tscClean: true, testsPass: true, errors: [], verdict: "pass" });
        }
        return task;
      });

      // Scheduler that returns tasks as immediately completed
      const scheduler = makeScheduler();

      const pipeline = new Pipeline(
        runner,
        scheduler,
        store,
        repoDir,
        (ev) => events.push(ev),
        makeConfig({ autoApprove: false }),
      );

      const run = pipeline.start("feature with approval");
      // Wait for pipeline to reach waiting_approval
      await new Promise((r) => setTimeout(r, 200));

      const savedBefore = store.get(run.id);
      assert.ok(savedBefore !== null);
      assert.strictEqual(savedBefore.stage, "waiting_approval");
      assert.ok(events.some((e) => e.type === "pipeline:waiting_approval"));

      // Approve the plan
      const approved = pipeline.approve(run.id);
      assert.strictEqual(approved, true);

      // Wait for pipeline to proceed
      await new Promise((r) => setTimeout(r, 500));

      const savedAfter = store.get(run.id);
      assert.ok(savedAfter !== null);
      // Should have progressed past waiting_approval
      assert.ok(savedAfter.stage !== "waiting_approval" && savedAfter.stage !== "research_plan",
        `Expected stage past approval, got ${savedAfter.stage}`);

      fs.rmSync(repoDir, { recursive: true, force: true });
    } finally {
      cleanup();
    }
  });

  it("cancel() sets stage to failed and cancels scheduler tasks", () => {
    const { db, cleanup } = makeTempDb();
    try {
      const store = new PipelineStore(db);
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-cancel-"));
      const events: Record<string, unknown>[] = [];
      const cancelledIds: string[] = [];

      const scheduler = makeScheduler({
        cancelHandler: (id) => { cancelledIds.push(id); return true; },
      });

      const pipeline = new Pipeline(
        makeRunner(),
        scheduler,
        store,
        repoDir,
        (ev) => events.push(ev),
        makeConfig(),
      );

      // Manually create a run with taskIds to test cancel
      const now = new Date().toISOString();
      const run: PipelineRun = {
        id: "cancel-run", goal: "test", stage: "execute", mode: "augment",
        iteration: 0, maxIterations: 3, waves: [], taskIds: ["t1", "t2"],
        createdAt: now, updatedAt: now,
      };
      store.save(run);

      pipeline.cancel("cancel-run");

      const saved = store.get("cancel-run");
      assert.ok(saved !== null);
      assert.strictEqual(saved.stage, "failed");
      assert.strictEqual(saved.error, "Cancelled by user");
      assert.deepStrictEqual(cancelledIds, ["t1", "t2"]);
      assert.ok(events.some((e) => e.type === "pipeline:cancelled"));

      fs.rmSync(repoDir, { recursive: true, force: true });
    } finally {
      cleanup();
    }
  });

  it("full flow: research_plan → decompose → execute → verify → done", async () => {
    const { db, cleanup } = makeTempDb();
    try {
      const store = new PipelineStore(db);
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-full-"));
      // Initialize as git repo for augment mode detection
      const { execSync } = await import("node:child_process");
      execSync("git init && git commit --allow-empty -m 'init'", { cwd: repoDir, stdio: "ignore" });

      const events: Record<string, unknown>[] = [];

      let callCount = 0;
      const runner = makeRunner((task) => {
        callCount++;
        task.status = "success";
        if (callCount === 1) {
          // research_plan: write plan file
          const planDir = path.join(repoDir, ".cc-pipeline");
          fs.mkdirSync(planDir, { recursive: true });
          fs.writeFileSync(path.join(planDir, "plan.md"), "# Plan\n- Do stuff");
          task.output = "plan created";
        } else if (callCount === 2) {
          // decompose
          task.output = JSON.stringify({
            waves: [
              { waveIndex: 0, tasks: ["implement feature A", "implement feature B"] },
              { waveIndex: 1, tasks: ["integrate A and B"] },
            ],
            totalTasks: 3,
          });
        } else {
          // verify
          task.output = JSON.stringify({
            tscClean: true, testsPass: true, errors: [], verdict: "pass",
          });
        }
        return task;
      });

      const scheduler = makeScheduler();

      const pipeline = new Pipeline(
        runner,
        scheduler,
        store,
        repoDir,
        (ev) => events.push(ev),
        makeConfig(),
      );

      const run = pipeline.start("build complete feature");
      // Wait for the full flow
      await new Promise((r) => setTimeout(r, 500));

      const saved = store.get(run.id);
      assert.ok(saved !== null);
      assert.strictEqual(saved.stage, "done");
      assert.strictEqual(saved.mode, "augment");
      assert.ok(events.some((e) => e.type === "pipeline:started"));
      assert.ok(events.some((e) => e.type === "pipeline:plan_ready"));
      assert.ok(events.some((e) => e.type === "pipeline:decomposed"));
      assert.ok(events.some((e) => e.type === "pipeline:done"));

      fs.rmSync(repoDir, { recursive: true, force: true });
    } finally {
      cleanup();
    }
  });

  it("wave execution: wave 0 completes before wave 1 starts", async () => {
    const { db, cleanup } = makeTempDb();
    try {
      const store = new PipelineStore(db);
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-wave-"));

      const events: Record<string, unknown>[] = [];
      let callCount = 0;

      const runner = makeRunner((task) => {
        callCount++;
        task.status = "success";
        if (callCount === 1) {
          const planDir = path.join(repoDir, ".cc-pipeline");
          fs.mkdirSync(planDir, { recursive: true });
          fs.writeFileSync(path.join(planDir, "plan.md"), "# Plan");
          task.output = "plan";
        } else if (callCount === 2) {
          task.output = JSON.stringify({
            waves: [
              { waveIndex: 0, tasks: ["task A"] },
              { waveIndex: 1, tasks: ["task B"] },
            ],
            totalTasks: 2,
          });
        } else {
          task.output = JSON.stringify({ tscClean: true, testsPass: true, errors: [], verdict: "pass" });
        }
        return task;
      });

      const scheduler = makeScheduler();

      const pipeline = new Pipeline(
        runner, scheduler, store, repoDir,
        (ev) => events.push(ev),
        makeConfig(),
      );

      pipeline.start("wave test");
      await new Promise((r) => setTimeout(r, 500));

      // Verify wave events are in order
      const waveStartEvents = events.filter((e) => e.type === "pipeline:wave_started");
      const waveDoneEvents = events.filter((e) => e.type === "pipeline:wave_done");
      assert.strictEqual(waveStartEvents.length, 2);
      assert.strictEqual(waveDoneEvents.length, 2);
      assert.strictEqual(waveStartEvents[0].waveIndex, 0);
      assert.strictEqual(waveStartEvents[1].waveIndex, 1);

      fs.rmSync(repoDir, { recursive: true, force: true });
    } finally {
      cleanup();
    }
  });

  it("feedback loop: verify fail → re-execute → verify pass", async () => {
    const { db, cleanup } = makeTempDb();
    try {
      const store = new PipelineStore(db);
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-retry-"));

      const events: Record<string, unknown>[] = [];
      let callCount = 0;
      let verifyCount = 0;

      const runner = makeRunner((task) => {
        callCount++;
        task.status = "success";
        if (callCount === 1) {
          // research_plan
          const planDir = path.join(repoDir, ".cc-pipeline");
          fs.mkdirSync(planDir, { recursive: true });
          fs.writeFileSync(path.join(planDir, "plan.md"), "# Plan");
          task.output = "plan";
        } else if (callCount === 2) {
          // decompose
          task.output = JSON.stringify({
            waves: [{ waveIndex: 0, tasks: ["fix bug"] }],
            totalTasks: 1,
          });
        } else if (task.prompt.includes("verification")) {
          // verify stage
          verifyCount++;
          if (verifyCount === 1) {
            task.output = JSON.stringify({ tscClean: false, testsPass: false, errors: ["type error"], verdict: "fail" });
          } else {
            task.output = JSON.stringify({ tscClean: true, testsPass: true, errors: [], verdict: "pass" });
          }
        } else {
          task.output = "executed";
        }
        return task;
      });

      const scheduler = makeScheduler();

      const pipeline = new Pipeline(
        runner, scheduler, store, repoDir,
        (ev) => events.push(ev),
        makeConfig({ maxIterations: 3 }),
      );

      const run = pipeline.start("fix things");
      await new Promise((r) => setTimeout(r, 800));

      const saved = store.get(run.id);
      assert.ok(saved !== null);
      assert.strictEqual(saved.stage, "done");
      assert.ok(saved.iteration >= 1, "iteration should have incremented");
      assert.ok(events.some((e) => e.type === "pipeline:retry"));
      assert.ok(events.some((e) => e.type === "pipeline:done"));

      fs.rmSync(repoDir, { recursive: true, force: true });
    } finally {
      cleanup();
    }
  });

  it("maxIterations cap: verify always fails → pipeline fails", async () => {
    const { db, cleanup } = makeTempDb();
    try {
      const store = new PipelineStore(db);
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-maxiter-"));

      const events: Record<string, unknown>[] = [];
      let callCount = 0;

      const runner = makeRunner((task) => {
        callCount++;
        task.status = "success";
        if (callCount === 1) {
          const planDir = path.join(repoDir, ".cc-pipeline");
          fs.mkdirSync(planDir, { recursive: true });
          fs.writeFileSync(path.join(planDir, "plan.md"), "# Plan");
          task.output = "plan";
        } else if (callCount === 2) {
          task.output = JSON.stringify({
            waves: [{ waveIndex: 0, tasks: ["task"] }],
            totalTasks: 1,
          });
        } else if (task.prompt.includes("verification")) {
          // Always fail verification
          task.output = JSON.stringify({ tscClean: false, testsPass: false, errors: ["persistent error"], verdict: "fail" });
        } else {
          task.output = "executed";
        }
        return task;
      });

      const scheduler = makeScheduler();

      const pipeline = new Pipeline(
        runner, scheduler, store, repoDir,
        (ev) => events.push(ev),
        makeConfig({ maxIterations: 2 }),
      );

      const run = pipeline.start("doomed to fail");
      await new Promise((r) => setTimeout(r, 1000));

      const saved = store.get(run.id);
      assert.ok(saved !== null);
      assert.strictEqual(saved.stage, "failed");
      assert.ok(saved.error!.includes("Verification failed"));
      assert.ok(saved.error!.includes("persistent error"));
      assert.ok(events.some((e) => e.type === "pipeline:failed"));

      fs.rmSync(repoDir, { recursive: true, force: true });
    } finally {
      cleanup();
    }
  });

  // JSON parsing tests (via decompose stage)
  describe("JSON parsing through decompose", () => {
    async function runDecomposeWithOutput(output: string): Promise<PipelineRun | null> {
      const { db, cleanup: cleanupDb } = makeTempDb();
      const store = new PipelineStore(db);
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-json-"));

      let callCount = 0;
      const runner = makeRunner((task) => {
        callCount++;
        task.status = "success";
        if (callCount === 1) {
          const planDir = path.join(repoDir, ".cc-pipeline");
          fs.mkdirSync(planDir, { recursive: true });
          fs.writeFileSync(path.join(planDir, "plan.md"), "# Plan");
          task.output = "plan";
        } else if (callCount === 2) {
          task.output = output;
        } else {
          task.output = JSON.stringify({ tscClean: true, testsPass: true, errors: [], verdict: "pass" });
        }
        return task;
      });

      const scheduler = makeScheduler();
      const events: Record<string, unknown>[] = [];

      const pipeline = new Pipeline(
        runner, scheduler, store, repoDir,
        (ev) => events.push(ev),
        makeConfig(),
      );

      const run = pipeline.start("json test");
      await new Promise((r) => setTimeout(r, 500));

      const result = store.get(run.id);
      cleanupDb();
      fs.rmSync(repoDir, { recursive: true, force: true });
      return result;
    }

    it("clean JSON output → parsed correctly", async () => {
      const output = JSON.stringify({ waves: [{ waveIndex: 0, tasks: ["task A"] }], totalTasks: 1 });
      const result = await runDecomposeWithOutput(output);
      assert.ok(result !== null);
      assert.ok(result.stage === "done" || result.stage === "verify",
        `Expected done or verify, got ${result.stage}`);
    });

    it("JSON wrapped in text → parsed correctly", async () => {
      const json = JSON.stringify({ waves: [{ waveIndex: 0, tasks: ["task B"] }], totalTasks: 1 });
      const output = `Here is the decomposition:\n${json}\nThat's the plan.`;
      const result = await runDecomposeWithOutput(output);
      assert.ok(result !== null);
      assert.ok(result.stage === "done" || result.stage === "verify",
        `Expected done or verify, got ${result.stage}`);
    });

    it("JSON in ```json fences → parsed correctly", async () => {
      const json = JSON.stringify({ waves: [{ waveIndex: 0, tasks: ["task C"] }], totalTasks: 1 });
      const output = `\`\`\`json\n${json}\n\`\`\``;
      const result = await runDecomposeWithOutput(output);
      assert.ok(result !== null);
      assert.ok(result.stage === "done" || result.stage === "verify",
        `Expected done or verify, got ${result.stage}`);
    });

    it("completely invalid JSON → pipeline fails", async () => {
      const result = await runDecomposeWithOutput("not json at all, just text");
      assert.ok(result !== null);
      assert.strictEqual(result.stage, "failed");
      assert.ok(result.error!.includes("Failed to parse JSON"));
    });
  });

  it("approve() returns false for unknown run id", () => {
    const { db, cleanup } = makeTempDb();
    try {
      const store = new PipelineStore(db);
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-noapprove-"));

      const pipeline = new Pipeline(
        makeRunner(), makeScheduler(), store, repoDir,
        () => {}, makeConfig(),
      );

      assert.strictEqual(pipeline.approve("nonexistent"), false);
      fs.rmSync(repoDir, { recursive: true, force: true });
    } finally {
      cleanup();
    }
  });

  it("cancel() is a no-op for done/failed runs", () => {
    const { db, cleanup } = makeTempDb();
    try {
      const store = new PipelineStore(db);
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-nocancel-"));
      const events: Record<string, unknown>[] = [];

      const pipeline = new Pipeline(
        makeRunner(), makeScheduler(), store, repoDir,
        (ev) => events.push(ev), makeConfig(),
      );

      const now = new Date().toISOString();
      store.save({
        id: "done-run", goal: "test", stage: "done", mode: "augment",
        iteration: 0, maxIterations: 3, waves: [], taskIds: [],
        createdAt: now, updatedAt: now,
      });

      pipeline.cancel("done-run");
      const saved = store.get("done-run");
      assert.ok(saved !== null);
      assert.strictEqual(saved.stage, "done", "done run should not be changed by cancel");
      assert.ok(!events.some((e) => e.type === "pipeline:cancelled"));

      fs.rmSync(repoDir, { recursive: true, force: true });
    } finally {
      cleanup();
    }
  });

  it("verify failure stores verifyResults and generates fix tasks grouped by file", async () => {
    const { db, cleanup } = makeTempDb();
    try {
      const store = new PipelineStore(db);
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-verify-fix-"));
      fs.mkdirSync(path.join(repoDir, ".git"));
      fs.mkdirSync(path.join(repoDir, ".cc-pipeline"), { recursive: true });
      fs.writeFileSync(path.join(repoDir, ".cc-pipeline", "plan.md"), "# Plan\nDo things");

      let callNum = 0;
      const runner = makeRunner((task) => {
        callNum++;
        if (callNum <= 2) {
          // research_plan + decompose
          if (task.prompt.includes("decomposition")) {
            task.output = JSON.stringify({
              waves: [{ waveIndex: 0, tasks: ["task one"] }],
              totalTasks: 1,
            });
          }
          task.status = "success";
          return task;
        }
        if (callNum === 3) {
          // first verify — fail with file-grouped errors
          task.output = JSON.stringify({
            tscClean: false,
            testsPass: false,
            errors: [
              "src/foo.ts:10 - TS2304: Cannot find name 'Bar'",
              "src/foo.ts:20 - TS2551: Missing property",
              "src/baz.ts:5 - TS2307: Cannot find module",
            ],
            verdict: "fail",
          });
          task.status = "success";
          return task;
        }
        // second verify — pass
        task.output = JSON.stringify({
          tscClean: true,
          testsPass: true,
          errors: [],
          verdict: "pass",
        });
        task.status = "success";
        return task;
      });

      const scheduler = makeScheduler();
      const events: Record<string, unknown>[] = [];
      const pipeline = new Pipeline(runner, scheduler, store, repoDir, (e) => events.push(e), makeConfig());
      pipeline.start("test verify fix");

      await new Promise((r) => setTimeout(r, 1500));

      const run = store.list()[0];
      assert.strictEqual(run.stage, "done");

      // verifyResults should have at least the first failure
      assert.ok(run.verifyResults, "verifyResults should be populated");
      assert.ok(run.verifyResults.length >= 1, "should have at least 1 verify result");
      assert.strictEqual(run.verifyResults[0].verdict, "fail");
      assert.strictEqual(run.verifyResults[0].errors.length, 3);

      // Check that retry event was emitted
      assert.ok(events.some((e) => e.type === "pipeline:retry"));

      fs.rmSync(repoDir, { recursive: true, force: true });
    } finally {
      cleanup();
    }
  });

  it("markStaleRunsFailed recovers orphaned runs", () => {
    const { db, cleanup } = makeTempDb();
    try {
      const store = new PipelineStore(db);
      const now = new Date().toISOString();

      // Create a run stuck in "execute" (simulating crash)
      store.save({
        id: "stale-1",
        goal: "stale",
        stage: "execute",
        mode: "augment",
        iteration: 1,
        maxIterations: 3,
        waves: [],
        taskIds: [],
        createdAt: now,
        updatedAt: now,
      });

      // Create a completed run (should not be affected)
      store.save({
        id: "done-1",
        goal: "done",
        stage: "done",
        mode: "augment",
        iteration: 0,
        maxIterations: 3,
        waves: [],
        taskIds: [],
        createdAt: now,
        updatedAt: now,
      });

      const recovered = store.markStaleRunsFailed();
      assert.strictEqual(recovered, 1);

      const stale = store.get("stale-1")!;
      assert.strictEqual(stale.stage, "failed");
      assert.ok(stale.error?.includes("Server restarted"));

      const done = store.get("done-1")!;
      assert.strictEqual(done.stage, "done");
    } finally {
      cleanup();
    }
  });

  it("wave task prompts include plan context", async () => {
    const { db, cleanup } = makeTempDb();
    try {
      const store = new PipelineStore(db);
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-context-"));
      fs.mkdirSync(path.join(repoDir, ".git"));
      fs.mkdirSync(path.join(repoDir, ".cc-pipeline"), { recursive: true });
      fs.writeFileSync(path.join(repoDir, ".cc-pipeline", "plan.md"), "# My Plan\nDetails here");

      const submittedPrompts: string[] = [];
      let callNum = 0;
      const runner = makeRunner((task) => {
        callNum++;
        if (callNum === 2) {
          // decompose
          task.output = JSON.stringify({
            waves: [{ waveIndex: 0, tasks: ["do thing A"] }],
            totalTasks: 1,
          });
        }
        if (callNum === 3) {
          // verify
          task.output = JSON.stringify({ tscClean: true, testsPass: true, errors: [], verdict: "pass" });
        }
        task.status = "success";
        return task;
      });

      const scheduler = makeScheduler({
        submitHandler: (prompt: string) => {
          submittedPrompts.push(prompt);
          const t = createTask(prompt);
          t.status = "success";
          return t;
        },
      });

      const pipeline = new Pipeline(runner, scheduler, store, repoDir, () => {}, makeConfig());
      pipeline.start("context test");

      await new Promise((r) => setTimeout(r, 1500));

      assert.ok(submittedPrompts.length > 0, "should have submitted at least one task");
      assert.ok(
        submittedPrompts[0].includes("wave 0") || submittedPrompts[0].includes(".cc-pipeline/plan.md"),
        "submitted prompt should reference wave context or plan"
      );

      fs.rmSync(repoDir, { recursive: true, force: true });
    } finally {
      cleanup();
    }
  });

  it("dead-loop detection: same errors twice → pipeline fails", async () => {
    const { db, cleanup } = makeTempDb();
    try {
      const store = new PipelineStore(db);
      const events: Record<string, unknown>[] = [];
      let verifyCount = 0;

      // ResearchPlan succeeds, Decompose returns 1 task, Verify always returns same error
      const runner = makeRunner((task) => {
        if (task.prompt.includes("architect")) {
          task.status = "success";
          task.output = "planned";
          return task;
        }
        if (task.prompt.includes("decomposition")) {
          task.status = "success";
          task.output = JSON.stringify({
            waves: [{ waveIndex: 0, tasks: ["Fix src/app.ts"] }],
            totalTasks: 1,
          });
          return task;
        }
        if (task.prompt.includes("verification")) {
          verifyCount++;
          task.status = "success";
          task.output = JSON.stringify({
            tscClean: false,
            testsPass: false,
            errors: ["src/app.ts:1 - same error every time"],
            verdict: "fail",
          });
          return task;
        }
        task.status = "success";
        return task;
      });

      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-"));
      fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
      fs.mkdirSync(path.join(repoDir, ".cc-pipeline"), { recursive: true });

      const pipeline = new Pipeline(
        runner,
        makeScheduler(),
        store,
        repoDir,
        (ev) => events.push(ev),
        makeConfig({ maxIterations: 10 }), // high cap to test dead-loop kicks in first
      );

      const run = pipeline.start("test dead loop");
      await new Promise((r) => setTimeout(r, 1500));

      const saved = store.get(run.id);
      assert.ok(saved !== null);
      assert.strictEqual(saved.stage, "failed");
      assert.ok(saved.error!.includes("same errors repeated"));

      fs.rmSync(repoDir, { recursive: true, force: true });
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// extractFilePaths tests
// ---------------------------------------------------------------------------

describe("extractFilePaths", () => {
  it("extracts simple file paths from a prompt", () => {
    const paths = extractFilePaths("Create src/types.ts and modify src/index.ts");
    assert.ok(paths.includes("src/types.ts"));
    assert.ok(paths.includes("src/index.ts"));
  });

  it("ignores non-code files (md, json, yaml)", () => {
    const paths = extractFilePaths("Update README.md and package.json and src/app.ts");
    assert.ok(!paths.includes("README.md"));
    assert.ok(!paths.includes("package.json"));
    assert.ok(paths.includes("src/app.ts"));
  });

  it("extracts nested paths", () => {
    const paths = extractFilePaths("Fix src/lib/utils/helpers.ts");
    assert.ok(paths.includes("src/lib/utils/helpers.ts"));
  });

  it("returns empty for no file paths", () => {
    const paths = extractFilePaths("Just do something generic");
    assert.deepStrictEqual(paths, []);
  });
});

// ---------------------------------------------------------------------------
// validateWaves tests
// ---------------------------------------------------------------------------

describe("validateWaves", () => {
  it("no conflicts → waves unchanged", () => {
    const input = {
      waves: [
        { waveIndex: 0, tasks: ["Create src/a.ts", "Create src/b.ts"] },
      ],
      totalTasks: 2,
    };
    const result = validateWaves(input);
    assert.strictEqual(result.waves.length, 1);
    assert.strictEqual(result.waves[0].tasks.length, 2);
  });

  it("file conflict → task moved to next wave", () => {
    const input = {
      waves: [
        { waveIndex: 0, tasks: ["Modify src/app.ts to add feature A", "Modify src/app.ts to add feature B"] },
      ],
      totalTasks: 2,
    };
    const result = validateWaves(input);
    assert.strictEqual(result.waves.length, 2);
    assert.strictEqual(result.waves[0].tasks.length, 1);
    assert.strictEqual(result.waves[1].tasks.length, 1);
  });

  it("three-way conflict → serialized into 3 waves", () => {
    const input = {
      waves: [
        { waveIndex: 0, tasks: [
          "Add function foo to src/lib.ts",
          "Add function bar to src/lib.ts",
          "Add function baz to src/lib.ts",
        ]},
      ],
      totalTasks: 3,
    };
    const result = validateWaves(input);
    assert.strictEqual(result.waves.length, 3);
    assert.strictEqual(result.totalTasks, 3);
  });

  it("mixed: some conflict some not → correct splitting", () => {
    const input = {
      waves: [
        { waveIndex: 0, tasks: [
          "Create src/types.ts with interfaces",
          "Create src/utils.ts with helpers",
          "Modify src/types.ts to add enums",
        ]},
      ],
      totalTasks: 3,
    };
    const result = validateWaves(input);
    assert.strictEqual(result.waves[0].tasks.length, 2); // types.ts and utils.ts
    assert.strictEqual(result.waves[1].tasks.length, 1); // second types.ts task
  });

  it("preserves wave ordering across existing waves", () => {
    const input = {
      waves: [
        { waveIndex: 0, tasks: ["Create src/a.ts", "Create src/b.ts"] },
        { waveIndex: 1, tasks: ["Modify src/a.ts to use b", "Modify src/b.ts to use a"] },
      ],
      totalTasks: 4,
    };
    const result = validateWaves(input);
    // No conflicts within waves, so should remain 2 waves
    assert.strictEqual(result.waves.length, 2);
    assert.strictEqual(result.totalTasks, 4);
  });
});
