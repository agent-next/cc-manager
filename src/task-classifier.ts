export function classifyTask(prompt: string): {
  category: 'quick' | 'standard' | 'deep';
  model: string;
  timeout: number;
  maxBudget: number;
} {
  const fileTokens = prompt.match(/\b[\w./\\-]+\.(ts|js|tsx|jsx|py|html|css|json|md|sh)\b/g) || [];
  const uniqueFiles = new Set(fileTokens.map(t => t.toLowerCase()));
  const fileCount = uniqueFiles.size;

  if (prompt.length < 200 && fileCount <= 1) {
    return { category: 'quick', model: 'claude-haiku-4-5-20251001', timeout: 120, maxBudget: 1 };
  }

  if (/\b(refactor|redesign|architect)\b/i.test(prompt) || fileCount >= 3) {
    return { category: 'deep', model: 'claude-opus-4-6', timeout: 600, maxBudget: 10 };
  }

  return { category: 'standard', model: 'claude-sonnet-4-6', timeout: 300, maxBudget: 5 };
}
