import type { Task } from "./types.js";
type EventCallback = (event: Record<string, unknown>) => void;
export declare class AgentRunner {
    private model;
    private systemPrompt;
    constructor(model?: string, systemPrompt?: string);
    run(task: Task, cwd: string, onEvent?: EventCallback): Promise<Task>;
}
export {};
