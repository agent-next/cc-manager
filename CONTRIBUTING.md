# Contributing to CC-Manager

Thank you for your interest in contributing! This document covers everything you need to get started.

---

## Setting Up the Development Environment

```bash
# 1. Clone the repository
git clone https://github.com/agent-next/cc-manager.git
cd cc-manager

# 2. Install dependencies (also sets up pre-commit hooks)
npm install

# 4. Start the development server
npm run dev
```

> **Note:** Node.js 20+ is required. The `npm install` step also configures git pre-commit hooks via the `prepare` script.

---

## Project Structure

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full module dependency graph.

---

## Running Tests

```bash
# Run all tests (71 BDD-style tests across 5 suites)
npm test

# Type-check only
npx tsc --noEmit
```

Pre-commit hooks run both `tsc` and `npm test` automatically. All type errors and test failures must be resolved before committing.

---

## Submitting a Pull Request

1. **Fork** the repository and create your branch from `main`:
   ```bash
   git checkout -b feat/your-feature-name
   ```

2. **Make your changes.** Keep commits focused and atomic.

3. **Commit** with a clear message following the format:
   ```
   feat: add task priority filtering
   fix: handle merge conflict in worktree-pool
   docs: update API reference in README
   ```

4. **Push** your branch and **open a PR** against `main`:
   ```bash
   git push origin feat/your-feature-name
   ```
   Then open a pull request on GitHub with a description of what changed and why.

5. **Address review feedback** by pushing additional commits to the same branch.

---

## Code Style

- **Language:** All application code is written in **TypeScript**. Do not add plain `.js` source files under `src/`.
- **Imports:** Always use `.js` extensions in import paths, even when importing `.ts` files:
  ```ts
  // correct
  import { Store } from "./store.js";

  // incorrect
  import { Store } from "./store";
  ```
  This is required for Node.js ESM compatibility.
- **Dashboard:** `web/index.html` is a self-contained file with no build step. Do **not** introduce frontend frameworks (React, Vue, etc.) or bundlers. Vanilla JS and inline `<style>` only.
- **Formatting:** Follow the conventions already present in each file — consistent indentation (2 spaces), single quotes for strings, and trailing semicolons.
- **Type safety:** Avoid `any`. Prefer explicit types and extend the interfaces in `types.ts` when adding new shapes.

---

## Code of Conduct

This project follows a simple standard: **be kind and constructive**.

- Treat all contributors with respect regardless of experience level.
- Provide clear, actionable feedback in code reviews.
- Assume good intent; ask clarifying questions before escalating disagreements.
- Harassment, discrimination, or personal attacks of any kind will not be tolerated.

If you experience or witness unacceptable behaviour, please open a private issue or contact a maintainer directly.
