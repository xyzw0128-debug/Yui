export type ProgressPhase = 'starting' | 'thinking' | 'tool' | 'tool_result' | 'writing' | 'completed' | 'failed';

export interface ProgressTool {
  id: string;
  name: string;
  input: string;
  result?: string;
  error?: boolean;
  startedAt: number;
}

export interface ProgressSnapshot {
  phase: ProgressPhase;
  startedAt: number;
  elapsedSeconds: number;
  tools: ProgressTool[];
  model?: string;
  lastLiveText?: string;
  thinking?: string;
}
