export function classifyTask(prompt: string): {
  category: 'quick' | 'standard' | 'deep';
  model: string;
  timeout: number;
  maxBudget: number;
} {
  // Extract file paths: must contain a directory separator (e.g., src/foo.ts, ./bar.js)
  const fileTokens = prompt.match(/((?:\.\/|[\w-]+\/)+[\w.-]+\.(?:ts|js|tsx|jsx|py|rs|go|java|rb|sh|css|html))(?=[^a-zA-Z]|$)/gm) || [];
  const uniqueFiles = new Set(fileTokens.map(t => t.toLowerCase()));
  const fileCount = uniqueFiles.size;

  // Deep check first: keywords or many files
  if (/\b(refactor|redesign|architect)\b/i.test(prompt) || fileCount >= 3) {
    return { category: 'deep', model: 'claude-opus-4-6', timeout: 600, maxBudget: 10 };
  }

  // Quick: short prompt with at most 1 file
  if (prompt.length < 200 && fileCount <= 1) {
    return { category: 'quick', model: 'claude-haiku-4-5-20251001', timeout: 120, maxBudget: 1 };
  }

  return { category: 'standard', model: 'claude-sonnet-4-6', timeout: 300, maxBudget: 5 };
}
