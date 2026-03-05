import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WorktreePool } from "../worktree-pool.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Spin up a real git repo on `main` with one commit, return path + cleanup. */
async function makeTempRepo(): Promise<{ repoPath: string; cleanup: () => void }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-wt-test-"));
  const git = (...args: string[]) => execFileAsync("git", args, { cwd: dir });

  await git("init", "-b", "main");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
  await git("add", ".");
  await git("commit", "-m", "initial commit");

  return {
    repoPath: dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WorktreePool", () => {
  it("init() creates the right number of worktrees", async () => {
    const { repoPath, cleanup } = await makeTempRepo();
    try {
      const pool = new WorktreePool(repoPath, 2);
      await pool.init();

      const status = pool.getStatus();
      assert.strictEqual(status.length, 2, "should have 2 workers");
      assert.ok(
        fs.existsSync(path.join(repoPath, ".worktrees", "worker-0")),
        "worker-0 directory should exist",
      );
      assert.ok(
        fs.existsSync(path.join(repoPath, ".worktrees", "worker-1")),
        "worker-1 directory should exist",
      );
      assert.strictEqual(pool.available, 2, "all workers should start available");
      assert.strictEqual(pool.busy, 0, "no workers should start busy");
    } finally {
      cleanup();
    }
  });

  it("acquire() returns a worker and marks it busy", async () => {
    const { repoPath, cleanup } = await makeTempRepo();
    try {
      const pool = new WorktreePool(repoPath, 2);
      await pool.init();

      const worker = await pool.acquire();

      assert.ok(worker !== null, "should return a worker when one is free");
      assert.strictEqual(worker.busy, true, "returned worker should be marked busy");
      assert.ok(worker.name.startsWith("worker-"), "worker name should follow naming convention");
      assert.ok(typeof worker.path === "string" && worker.path.length > 0, "worker path should be set");
      assert.ok(worker.branch.startsWith("worker/"), "worker branch should follow naming convention");
      assert.strictEqual(pool.available, 1, "one worker should remain available");
      assert.strictEqual(pool.busy, 1, "one worker should be busy");
    } finally {
      cleanup();
    }
  });

  it("acquire() returns null when all workers are busy", async () => {
    const { repoPath, cleanup } = await makeTempRepo();
    try {
      const pool = new WorktreePool(repoPath, 1);
      await pool.init();

      const first = await pool.acquire();
      assert.ok(first !== null, "first acquire should succeed");

      const second = await pool.acquire();
      assert.strictEqual(second, null, "should return null when pool is exhausted");
    } finally {
      cleanup();
    }
  });

  it("release() makes worker available again", async () => {
    const { repoPath, cleanup } = await makeTempRepo();
    try {
      const pool = new WorktreePool(repoPath, 2);
      await pool.init();

      const worker = await pool.acquire();
      assert.ok(worker !== null);
      assert.strictEqual(pool.available, 1);

      await pool.release(worker.name, false);

      assert.strictEqual(pool.available, 2, "released worker should be available again");
      assert.strictEqual(pool.busy, 0, "no workers should remain busy");

      // Verify the worker is genuinely re-acquirable
      const reacquired = await pool.acquire();
      assert.ok(reacquired !== null, "worker should be acquirable after release");
    } finally {
      cleanup();
    }
  });

  it("getStatus() reflects current busy/idle state accurately", async () => {
    const { repoPath, cleanup } = await makeTempRepo();
    try {
      const pool = new WorktreePool(repoPath, 3);
      await pool.init();

      // Acquire two of the three workers
      const w1 = await pool.acquire();
      const w2 = await pool.acquire();
      assert.ok(w1 !== null && w2 !== null);

      const status = pool.getStatus();
      assert.strictEqual(status.length, 3, "status should list all workers");

      const busyWorkers = status.filter((w) => w.busy);
      const idleWorkers = status.filter((w) => !w.busy);
      assert.strictEqual(busyWorkers.length, 2, "two workers should be busy");
      assert.strictEqual(idleWorkers.length, 1, "one worker should be idle");

      // Every entry must have the required WorkerInfo shape
      for (const w of status) {
        assert.strictEqual(typeof w.name, "string");
        assert.strictEqual(typeof w.path, "string");
        assert.strictEqual(typeof w.branch, "string");
        assert.strictEqual(typeof w.busy, "boolean");
      }
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Health checks
// ---------------------------------------------------------------------------

describe("WorktreePool health", () => {
  it("isHealthy returns true for valid worktree", async () => {
    const { repoPath, cleanup } = await makeTempRepo();
    try {
      const pool = new WorktreePool(repoPath, 1);
      await pool.init();

      const healthy = await pool.isHealthy("worker-0");
      assert.strictEqual(healthy, true, "existing worktree should be healthy");
    } finally {
      cleanup();
    }
  });

  it("isHealthy returns false for unknown worker name", async () => {
    const { repoPath, cleanup } = await makeTempRepo();
    try {
      const pool = new WorktreePool(repoPath, 1);
      await pool.init();

      const healthy = await pool.isHealthy("nonexistent-worker");
      assert.strictEqual(healthy, false, "unknown worker should not be healthy");
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Stale detection
// ---------------------------------------------------------------------------

describe("WorktreePool stale detection", () => {
  it("isStale returns false for idle worker", async () => {
    const { repoPath, cleanup } = await makeTempRepo();
    try {
      const pool = new WorktreePool(repoPath, 1);
      await pool.init();

      const worker = pool.getWorker("worker-0");
      assert.ok(worker, "worker-0 should exist");
      assert.strictEqual(worker.busy, false, "worker should be idle");

      const stale = pool.isStale(worker, 1);
      assert.strictEqual(stale, false, "idle worker should never be stale");
    } finally {
      cleanup();
    }
  });

  it("isStale returns true when busy beyond threshold", async () => {
    const { repoPath, cleanup } = await makeTempRepo();
    try {
      const pool = new WorktreePool(repoPath, 1);
      await pool.init();

      const worker = await pool.acquire();
      assert.ok(worker !== null, "should acquire a worker");

      // Wait just long enough so busySince is older than 1ms threshold
      await new Promise((r) => setTimeout(r, 10));

      const stale = pool.isStale(worker, 1);
      assert.strictEqual(stale, true, "worker busy longer than threshold should be stale");
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Force release
// ---------------------------------------------------------------------------

describe("WorktreePool force release", () => {
  it("forceRelease marks worker as not busy", async () => {
    const { repoPath, cleanup } = await makeTempRepo();
    try {
      const pool = new WorktreePool(repoPath, 2);
      await pool.init();

      const worker = await pool.acquire();
      assert.ok(worker !== null, "should acquire a worker");
      assert.strictEqual(pool.busy, 1, "one worker should be busy before forceRelease");

      await pool.forceRelease(worker.name);

      assert.strictEqual(pool.busy, 0, "no workers should be busy after forceRelease");
      assert.strictEqual(pool.available, 2, "all workers should be available after forceRelease");

      // Verify the worker is re-acquirable after force release
      const reacquired = await pool.acquire();
      assert.ok(reacquired !== null, "worker should be acquirable after forceRelease");
    } finally {
      cleanup();
    }
  });

  it("forceRelease handles unknown worker gracefully", async () => {
    const { repoPath, cleanup } = await makeTempRepo();
    try {
      const pool = new WorktreePool(repoPath, 1);
      await pool.init();

      // Should not throw for a non-existent worker name
      await pool.forceRelease("nonexistent-worker");

      // Pool state should remain unchanged
      assert.strictEqual(pool.available, 1, "pool should still have its worker available");
      assert.strictEqual(pool.busy, 0, "no workers should be busy");
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Worker lookup
// ---------------------------------------------------------------------------

describe("WorktreePool lookup", () => {
  it("getWorker finds worker by name", async () => {
    const { repoPath, cleanup } = await makeTempRepo();
    try {
      const pool = new WorktreePool(repoPath, 2);
      await pool.init();

      const worker = pool.getWorker("worker-0");
      assert.ok(worker, "should find worker-0");
      assert.strictEqual(worker.name, "worker-0");
      assert.strictEqual(typeof worker.path, "string");
      assert.strictEqual(typeof worker.branch, "string");

      const worker1 = pool.getWorker("worker-1");
      assert.ok(worker1, "should find worker-1");
      assert.strictEqual(worker1.name, "worker-1");
    } finally {
      cleanup();
    }
  });

  it("getWorker returns undefined for unknown name", async () => {
    const { repoPath, cleanup } = await makeTempRepo();
    try {
      const pool = new WorktreePool(repoPath, 1);
      await pool.init();

      const worker = pool.getWorker("does-not-exist");
      assert.strictEqual(worker, undefined, "unknown name should return undefined");
    } finally {
      cleanup();
    }
  });

  it("getWorkerByTask finds worker by current task ID", async () => {
    const { repoPath, cleanup } = await makeTempRepo();
    try {
      const pool = new WorktreePool(repoPath, 2);
      await pool.init();

      const worker = await pool.acquire();
      assert.ok(worker !== null, "should acquire a worker");

      // Simulate scheduler assigning a task to the worker
      worker.currentTask = "task-abc-123";

      const found = pool.getWorkerByTask("task-abc-123");
      assert.ok(found, "should find worker by task ID");
      assert.strictEqual(found.name, worker.name, "found worker should match acquired worker");
      assert.strictEqual(found.currentTask, "task-abc-123");
    } finally {
      cleanup();
    }
  });

  it("getWorkerByTask returns undefined for unknown task", async () => {
    const { repoPath, cleanup } = await makeTempRepo();
    try {
      const pool = new WorktreePool(repoPath, 2);
      await pool.init();

      // Acquire a worker with a different task
      const worker = await pool.acquire();
      assert.ok(worker !== null);
      worker.currentTask = "task-known";

      const found = pool.getWorkerByTask("task-unknown");
      assert.strictEqual(found, undefined, "unknown task ID should return undefined");
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Squash merge
// ---------------------------------------------------------------------------

describe("WorktreePool squash merge", () => {
  it("release(name, true, taskId) squash-merges to single commit", async () => {
    const { repoPath, cleanup } = await makeTempRepo();
    try {
      const pool = new WorktreePool(repoPath, 1);
      await pool.init();

      const worker = await pool.acquire();
      assert.ok(worker !== null, "should acquire a worker");

      const git = (...args: string[]) => execFileAsync("git", args, { cwd: worker.path });

      // Count commits on main before
      const { stdout: mainLogBefore } = await execFileAsync("git", ["log", "--oneline", "main"], { cwd: repoPath });
      const mainCommitsBefore = mainLogBefore.trim().split("\n").length;

      // Make 3 commits in the worktree (simulating agent work)
      fs.writeFileSync(path.join(worker.path, "file1.txt"), "hello\n");
      await git("add", "file1.txt");
      await git("commit", "-m", "agent commit 1");

      fs.writeFileSync(path.join(worker.path, "file2.txt"), "world\n");
      await git("add", "file2.txt");
      await git("commit", "-m", "agent commit 2");

      fs.writeFileSync(path.join(worker.path, "file3.txt"), "!\n");
      await git("add", "file3.txt");
      await git("commit", "-m", "agent commit 3");

      // Release with squash merge
      const result = await pool.release(worker.name, true, "test123");
      assert.strictEqual(result.merged, true, "merge should succeed");

      // Assert: main has exactly 1 new commit (squashed)
      const { stdout: mainLogAfter } = await execFileAsync("git", ["log", "--oneline", "main"], { cwd: repoPath });
      const mainCommitsAfter = mainLogAfter.trim().split("\n").length;
      assert.strictEqual(mainCommitsAfter, mainCommitsBefore + 1, "main should have exactly 1 new commit");

      // Assert: the squash commit message contains the taskId
      const { stdout: lastCommit } = await execFileAsync("git", ["log", "-1", "--format=%s", "main"], { cwd: repoPath });
      assert.ok(lastCommit.includes("task(test123)"), `commit msg should contain task(test123), got: ${lastCommit.trim()}`);

      // Assert: refs/tasks/test123 exists
      const { stdout: refOut } = await execFileAsync("git", ["show-ref", "refs/tasks/test123"], { cwd: repoPath });
      assert.ok(refOut.trim().length > 0, "refs/tasks/test123 should exist");

      // Assert: the ref preserves all 3 original commits
      const { stdout: refLog } = await execFileAsync("git", ["log", "--oneline", "refs/tasks/test123"], { cwd: repoPath });
      const refCommits = refLog.trim().split("\n");
      // 3 agent commits + 1 initial commit = 4 total
      assert.strictEqual(refCommits.length, 4, "ref should show all 3 agent commits + initial");
    } finally {
      cleanup();
    }
  });

  it("release(name, true) without taskId falls back to legacy merge", async () => {
    const { repoPath, cleanup } = await makeTempRepo();
    try {
      const pool = new WorktreePool(repoPath, 1);
      await pool.init();

      const worker = await pool.acquire();
      assert.ok(worker !== null);

      const git = (...args: string[]) => execFileAsync("git", args, { cwd: worker.path });

      // Make 2 commits
      fs.writeFileSync(path.join(worker.path, "a.txt"), "a\n");
      await git("add", "a.txt");
      await git("commit", "-m", "commit a");

      fs.writeFileSync(path.join(worker.path, "b.txt"), "b\n");
      await git("add", "b.txt");
      await git("commit", "-m", "commit b");

      // Release WITHOUT taskId — should use legacy ff/merge
      const result = await pool.release(worker.name, true);
      assert.strictEqual(result.merged, true, "merge should succeed");

      // Main should have all individual commits (not squashed)
      const { stdout: mainLog } = await execFileAsync("git", ["log", "--oneline", "main"], { cwd: repoPath });
      const commits = mainLog.trim().split("\n");
      // initial + 2 agent commits = 3 (ff merge preserves all)
      assert.ok(commits.length >= 3, `expected >= 3 commits on main, got ${commits.length}`);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Worker stats
// ---------------------------------------------------------------------------

describe("WorktreePool stats", () => {
  it("getWorkerStats returns correct counts", async () => {
    const { repoPath, cleanup } = await makeTempRepo();
    try {
      const pool = new WorktreePool(repoPath, 3);
      await pool.init();

      // All idle initially
      let stats = pool.getWorkerStats();
      assert.strictEqual(stats.total, 3, "total should be 3");
      assert.strictEqual(stats.busy, 0, "no workers busy initially");
      assert.strictEqual(stats.available, 3, "all workers available initially");
      assert.strictEqual(stats.stale, 0, "no stale workers initially");

      // Acquire two workers
      const w1 = await pool.acquire();
      const w2 = await pool.acquire();
      assert.ok(w1 !== null && w2 !== null);

      stats = pool.getWorkerStats();
      assert.strictEqual(stats.total, 3, "total should still be 3");
      assert.strictEqual(stats.busy, 2, "two workers should be busy");
      assert.strictEqual(stats.available, 1, "one worker should be available");
      assert.strictEqual(stats.stale, 0, "recently acquired workers should not be stale");
    } finally {
      cleanup();
    }
  });

  it("getWorkerStats reflects stale workers", async () => {
    const { repoPath, cleanup } = await makeTempRepo();
    try {
      const pool = new WorktreePool(repoPath, 2);
      await pool.init();

      const worker = await pool.acquire();
      assert.ok(worker !== null, "should acquire a worker");

      // getWorkerStats uses a 5-minute threshold internally.
      // The worker was just acquired, so it should not be stale.
      let stats = pool.getWorkerStats();
      assert.strictEqual(stats.stale, 0, "freshly acquired worker should not be stale");
      assert.strictEqual(stats.busy, 1, "one worker should be busy");

      // Verify that isStale with a very small threshold would detect it
      await new Promise((r) => setTimeout(r, 10));
      const stale = pool.isStale(worker, 1);
      assert.strictEqual(stale, true, "worker should be stale with 1ms threshold");

      // But getWorkerStats still reports 0 stale because it uses 5-minute threshold
      stats = pool.getWorkerStats();
      assert.strictEqual(stats.stale, 0, "worker should not be stale under 5-minute threshold");
    } finally {
      cleanup();
    }
  });
});
