export function enhancePrompt(
  prompt: string,
  opts: {
    addCommitInstruction?: boolean;
    addTscCheck?: boolean;
    addLintCheck?: boolean;
    context?: string;
  } = {}
): string {
  const {
    addCommitInstruction = true,
    addTscCheck = true,
    addLintCheck = false,
    context,
  } = opts;

  const parts: string[] = [];

  if (context) parts.push(context);
  parts.push(prompt);

  const instructions: string[] = [];
  if (addTscCheck) instructions.push("Run `npx tsc` to verify.");
  if (addLintCheck) instructions.push("Run lint checks.");
  if (addCommitInstruction)
    instructions.push("Stage and commit: `git add -A && git commit`.");

  if (instructions.length > 0) parts.push(instructions.join(" "));

  return parts.join("\n\n");
}

export function addFileContext(prompt: string, filePaths: string[]): string {
  const header = `Read these files first:\n${filePaths.join("\n")}`;
  return `${header}\n\n${prompt}`;
}
