export type PipelineStage = "research_plan" | "decompose" | "execute" | "verify" | "done" | "failed" | "waiting_approval";

export interface PipelineRun {
  id: string;
  goal: string;
  stage: PipelineStage;
  mode: "greenfield" | "augment";
  iteration: number;
  maxIterations: number;
  waves: WaveResult[];
  taskIds: string[];
  verifyResults?: VerifyOutput[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WaveResult {
  waveIndex: number;
  taskIds: string[];
  successCount: number;
  failCount: number;
}

export interface DecomposeOutput {
  waves: { waveIndex: number; tasks: string[] }[];
  totalTasks: number;
}

export interface VerifyOutput {
  tscClean: boolean;
  testsPass: boolean;
  errors: string[];
  verdict: "pass" | "fail";
}

export interface PipelineConfig {
  maxIterations: number;
  metaTaskTimeout: number;
  codeTaskTimeout: number;
  codeTaskBudget: number;
  totalBudget: number;
  autoApprove: boolean;
}

export const defaultPipelineConfig: PipelineConfig = {
  maxIterations: 3,
  metaTaskTimeout: 600,
  codeTaskTimeout: 600,
  codeTaskBudget: 5,
  totalBudget: 50,
  autoApprove: false,
};
