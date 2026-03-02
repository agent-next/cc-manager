import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// =============================================================================
// index.ts entry point tests — subprocess validation of CLI args and startup
// =============================================================================

const exec = promisify(execFile);

async function runServer(...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await exec("node", ["--import", "tsx", "src/index.ts", ...args], {
      timeout: 5000,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: any) {
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", exitCode: err.code ?? 1 };
  }
}

describe("index.ts entry point", () => {

  // ─── required options ───────────────────────────────────────────────────────

  describe("required options", () => {
    it("exits with error when --repo is missing", async () => {
      const result = await runServer();
      assert.notStrictEqual(result.exitCode, 0);
      assert.ok(result.stderr.includes("--repo"), "should mention --repo in error");
    });
  });

  // ─── repo validation ────────────────────────────────────────────────────────

  describe("repo validation", () => {
    it("exits with error for nonexistent repo path", async () => {
      const result = await runServer("--repo", "/nonexistent/path/to/repo");
      assert.notStrictEqual(result.exitCode, 0);
      assert.ok(result.stderr.includes("not a git repository"), "should report invalid repo");
    });

    it("exits with error for directory without .git", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "cc-test-"));
      try {
        const result = await runServer("--repo", tmp);
        assert.notStrictEqual(result.exitCode, 0);
        assert.ok(result.stderr.includes("not a git repository"));
      } finally {
        rmSync(tmp, { recursive: true });
      }
    });
  });

  // ─── workers validation ─────────────────────────────────────────────────────

  describe("workers validation", () => {
    let fakeRepo: string;

    // Create a minimal fake git repo for validation tests that pass repo check
    fakeRepo = mkdtempSync(join(tmpdir(), "cc-test-repo-"));
    mkdirSync(join(fakeRepo, ".git"), { recursive: true });

    it("exits with error for --workers 0", async () => {
      const result = await runServer("--repo", fakeRepo, "--workers", "0");
      assert.notStrictEqual(result.exitCode, 0);
      assert.ok(result.stderr.includes("--workers must be between 1 and 20"));
    });

    it("exits with error for --workers 25", async () => {
      const result = await runServer("--repo", fakeRepo, "--workers", "25");
      assert.notStrictEqual(result.exitCode, 0);
      assert.ok(result.stderr.includes("--workers must be between 1 and 20"));
    });

    it("exits with error for --workers abc", async () => {
      const result = await runServer("--repo", fakeRepo, "--workers", "abc");
      assert.notStrictEqual(result.exitCode, 0);
      assert.ok(result.stderr.includes("--workers must be between 1 and 20"));
    });
  });

  // ─── port validation ────────────────────────────────────────────────────────

  describe("port validation", () => {
    let fakeRepo: string;
    fakeRepo = mkdtempSync(join(tmpdir(), "cc-test-repo-"));
    mkdirSync(join(fakeRepo, ".git"), { recursive: true });

    it("exits with error for --port 80", async () => {
      const result = await runServer("--repo", fakeRepo, "--port", "80");
      assert.notStrictEqual(result.exitCode, 0);
      assert.ok(result.stderr.includes("--port must be between 1024 and 65535"));
    });

    it("exits with error for --port 99999", async () => {
      const result = await runServer("--repo", fakeRepo, "--port", "99999");
      assert.notStrictEqual(result.exitCode, 0);
      assert.ok(result.stderr.includes("--port must be between 1024 and 65535"));
    });
  });

  // ─── system prompt file ─────────────────────────────────────────────────────

  describe("system prompt file", () => {
    it("exits with error for nonexistent --system-prompt-file", async () => {
      const fakeRepo = mkdtempSync(join(tmpdir(), "cc-test-repo-"));
      mkdirSync(join(fakeRepo, ".git"), { recursive: true });
      try {
        const result = await runServer("--repo", fakeRepo, "--system-prompt-file", "/nonexistent/file.txt");
        assert.notStrictEqual(result.exitCode, 0);
      } finally {
        rmSync(fakeRepo, { recursive: true });
      }
    });
  });
});
