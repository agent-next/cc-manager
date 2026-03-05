import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyTask } from "../task-classifier.js";
import { AgentRunner } from "../agent-runner.js";

describe("classifyTask", () => {
  it("quick: short prompt with one file", () => {
    const r = classifyTask("Fix typo in src/index.ts");
    assert.strictEqual(r.category, "quick");
    assert.ok(r.model.includes("haiku"));
    assert.strictEqual(r.timeout, 120);
    assert.strictEqual(r.maxBudget, 1);
  });

  it("quick: short prompt with no files", () => {
    const r = classifyTask("Update the version number");
    assert.strictEqual(r.category, "quick");
  });

  it("standard: longer prompt without deep keywords", () => {
    const r = classifyTask("Add a new endpoint to handle user authentication in src/server.ts. The endpoint should validate JWT tokens and refresh them automatically when expired. Also handle rate limiting and error responses properly for all edge cases.");
    assert.strictEqual(r.category, "standard");
    assert.ok(r.model.includes("sonnet"));
    assert.strictEqual(r.timeout, 300);
    assert.strictEqual(r.maxBudget, 5);
  });

  it("deep: contains refactor keyword", () => {
    const r = classifyTask("Refactor the authentication module to use OAuth2 instead of basic auth");
    assert.strictEqual(r.category, "deep");
    assert.ok(r.model.includes("opus"));
    assert.strictEqual(r.timeout, 600);
    assert.strictEqual(r.maxBudget, 10);
  });

  it("deep: contains architect keyword", () => {
    const r = classifyTask("Architect the new microservices layer for the payment system");
    assert.strictEqual(r.category, "deep");
  });

  it("deep: contains redesign keyword", () => {
    const r = classifyTask("Redesign the database schema for better performance");
    assert.strictEqual(r.category, "deep");
  });

  it("deep: 3+ unique file mentions", () => {
    const r = classifyTask("Update src/types.ts, src/server.ts, and src/scheduler.ts to add the new field");
    assert.strictEqual(r.category, "deep");
  });

  it("standard: 2 file mentions (below threshold)", () => {
    const r = classifyTask("Update src/types.ts and src/server.ts to add a new status field");
    assert.strictEqual(r.category, "standard");
  });

  it("quick: long prompt but only 1 file → standard (length overrides)", () => {
    const longPrompt = "Fix the bug in src/app.ts " + "x".repeat(200);
    const r = classifyTask(longPrompt);
    assert.strictEqual(r.category, "standard"); // > 200 chars so not quick
  });

  it("deep: case insensitive keyword match", () => {
    const r = classifyTask("REFACTOR the entire codebase");
    assert.strictEqual(r.category, "deep");
  });

  it("standard: longer single-file task without deep keywords", () => {
    const r = classifyTask("Restructure the imports in src/app.ts to use barrel exports, update all relative imports to use the new pattern, and ensure backward compatibility with existing consumers of the module across the application.");
    assert.strictEqual(r.category, "standard");
  });

  it("deduplicates file mentions", () => {
    // Same file mentioned twice should count as 1
    const r = classifyTask("Fix src/app.ts line 10 and src/app.ts line 20");
    assert.strictEqual(r.category, "quick"); // short + 1 unique file
  });
});

describe("AgentRunner.pickFallbackAgent", () => {
  it("returns codex for claude", () => {
    assert.strictEqual(AgentRunner.pickFallbackAgent("claude"), "codex");
  });

  it("returns codex for claude-sdk", () => {
    assert.strictEqual(AgentRunner.pickFallbackAgent("claude-sdk"), "codex");
  });

  it("returns claude for codex", () => {
    assert.strictEqual(AgentRunner.pickFallbackAgent("codex"), "claude");
  });

  it("returns codex for unknown agent", () => {
    assert.strictEqual(AgentRunner.pickFallbackAgent("custom-agent"), "codex");
  });
});
