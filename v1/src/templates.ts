export interface TaskTemplate {
  name: string;
  prompt: string;
  timeout?: number;
  maxBudget?: number;
  priority?: string;
}

export const TEMPLATES: TaskTemplate[] = [
  {
    name: "refactor",
    prompt:
      "Refactor {{file}} to improve code quality. Focus on: reducing complexity, improving naming, eliminating duplication, and following best practices. Preserve all existing behavior and tests.",
    timeout: 300,
    maxBudget: 2,
    priority: "normal",
  },
  {
    name: "test",
    prompt:
      "Create comprehensive tests for {{module}}. Include unit tests for all exported functions, edge cases, and error conditions. Use the existing test framework and conventions in the project.",
    timeout: 300,
    maxBudget: 2,
    priority: "normal",
  },
  {
    name: "docs",
    prompt:
      "Add JSDoc comments to all exported functions, classes, and interfaces in {{file}}. Include @param, @returns, and @throws tags where applicable. Do not change any logic.",
    timeout: 180,
    maxBudget: 1,
    priority: "low",
  },
  {
    name: "lint-fix",
    prompt:
      "Fix all lint issues in {{file}}. Run the project linter, resolve every reported error and warning, and ensure the file passes lint checks without disabling rules.",
    timeout: 120,
    maxBudget: 1,
    priority: "high",
  },
  {
    name: "optimize",
    prompt:
      "Optimize the performance of {{file}}. Profile hotspots, reduce unnecessary allocations, improve algorithmic complexity where possible, and add a brief comment explaining each optimization.",
    timeout: 360,
    maxBudget: 3,
    priority: "normal",
  },
];

export function applyTemplate(name: string, args: Record<string, string>): string {
  const template = TEMPLATES.find((t) => t.name === name);
  if (!template) throw new Error(`Template "${name}" not found`);
  return template.prompt.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in args)) throw new Error(`Missing argument "{{${key}}}" for template "${name}"`);
    return args[key];
  });
}
