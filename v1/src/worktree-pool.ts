import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { WorkerInfo } from "./types.js";

const exec = promisify(execFile);

export class WorktreePool {
  private workers: Map<string, WorkerInfo> = new Map();
  private lock = false;

  constructor(
    private repoPath: string,
    private poolSize: number,
  ) {
    this.repoPath = path.resolve(repoPath);
  }

  async init(): Promise<void> {
    const wtDir = path.join(this.repoPath, ".worktrees");
    mkdirSync(wtDir, { recursive: true });

    await this.git("checkout", "main").catch(() => {});

    for (let i = 0; i < this.poolSize; i++) {
      const name = `worker-${i}`;
      const workerPath = path.join(wtDir, name);
      const branch = `worker/${name}`;

      if (existsSync(workerPath)) {
        await this.gitIn(workerPath, "checkout", branch).catch(() => {});
        await this.gitIn(workerPath, "reset", "--hard", "main").catch(() => {});
      } else {
        await this.git("branch", "-D", branch).catch(() => {});
        const r = await this.git("worktree", "add", "-b", branch, workerPath, "main").catch(() => null);
        if (!r) {
          await this.git("worktree", "add", workerPath, branch).catch(() => {});
        }
      }

      this.workers.set(name, { name, path: workerPath, branch, busy: false });
    }

    console.log(`[pool] ${this.workers.size} worktrees ready`);
  }

  async acquire(): Promise<WorkerInfo | null> {
    await this.waitLock();
    this.lock = true;
    try {
      for (const w of this.workers.values()) {
        if (!w.busy) {
          w.busy = true;
          await this.gitIn(w.path, "reset", "--hard", "main").catch(() => {});
          return w;
        }
      }
      return null;
    } finally {
      this.lock = false;
    }
  }

  async release(name: string, merge: boolean): Promise<boolean> {
    await this.waitLock();
    this.lock = true;
    try {
      const w = this.workers.get(name);
      if (!w) return false;

      let merged = true;
      if (merge) {
        merged = await this.mergeToMain(w);
      }

      w.busy = false;
      w.currentTask = undefined;
      return merged;
    } finally {
      this.lock = false;
    }
  }

  private async mergeToMain(w: WorkerInfo): Promise<boolean> {
    // Check if branch has new commits vs main
    const { stdout: diff } = await this.git("log", `main..${w.branch}`, "--oneline");
    if (!diff.trim()) return true;

    console.log(`[pool] merging ${w.branch} → main`);

    // Merge without checking out — stay on main
    const r = await this.git("merge", w.branch, "--no-edit").catch(() => null);
    if (!r) {
      console.warn(`[pool] merge conflict on ${w.branch}, aborting`);
      await this.git("merge", "--abort").catch(() => {});
      return false;
    }

    // Reset worktree to latest main
    await this.gitIn(w.path, "reset", "--hard", "main").catch(() => {});
    return true;
  }

  get available(): number {
    let n = 0;
    for (const w of this.workers.values()) if (!w.busy) n++;
    return n;
  }

  get busy(): number {
    return this.workers.size - this.available;
  }

  getStatus(): WorkerInfo[] {
    return [...this.workers.values()];
  }

  private async git(...args: string[]) {
    return exec("git", args, { cwd: this.repoPath });
  }

  private async gitIn(dir: string, ...args: string[]) {
    return exec("git", args, { cwd: dir });
  }

  private async waitLock(): Promise<void> {
    while (this.lock) await new Promise((r) => setTimeout(r, 10));
  }
}
