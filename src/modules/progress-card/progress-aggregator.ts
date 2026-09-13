import type { ProgressPhase, ProgressSnapshot, ProgressTool } from './types.js';

function cleanBashCommand(cmd: string): string {
  return cmd
    .replace(/^\/workspace\/agent\//, '')
    .replace(/^\/workspace\//, '')
    .trim();
}

export class ProgressAggregator {
  private readonly startedAt: number;
  private phase: ProgressPhase = 'starting';
  private tools: Map<string, ProgressTool> = new Map();
  private model?: string;
  private thinking?: string;
  private lastLiveText?: string;
  private dirty = false;

  constructor(startedAt = Date.now()) {
    this.startedAt = startedAt;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  consumeDirty(): boolean {
    const d = this.dirty;
    this.dirty = false;
    return d;
  }

  markDirty(): void {
    this.dirty = true;
  }

  setModel(model: string): void {
    if (this.model !== model) {
      this.model = model;
      this.dirty = true;
    }
  }

  ingestJsonlLine(line: string): void {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line);
    } catch {
      return;
    }

    const type = row.type as string;

    if (type === 'assistant') {
      const msg = (row.message as Record<string, unknown>) || {};
      if (typeof msg.model === 'string') {
        this.setModel(msg.model);
      }

      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const item of content) {
        if (!item || typeof item !== 'object') continue;
        const c = item as Record<string, unknown>;
        if (c.type === 'tool_use') {
          const id = String(c.id || Math.random().toString(36).slice(2));
          const name = String(c.name || 'tool');
          const inp = (c.input as Record<string, unknown>) || {};
          let inputSummary = '';

          if (name === 'Bash' && typeof inp.command === 'string') {
            inputSummary = cleanBashCommand(inp.command);
          } else if (name.includes('add_reaction')) {
            inputSummary = `:${inp.emoji || 'blue_heart'}:`;
          } else if (typeof inp.prompt === 'string') {
            inputSummary = inp.prompt;
          } else if (typeof inp.query === 'string') {
            inputSummary = inp.query;
          } else if (typeof inp.path === 'string' || typeof inp.file_path === 'string') {
            inputSummary = String(inp.path || inp.file_path);
          }

          if (!this.tools.has(id)) {
            this.tools.set(id, {
              id,
              name: name.replace(/^mcp__nanoclaw__/, ''),
              input: inputSummary,
              startedAt: Date.now(),
            });
            this.phase = 'tool';
            this.dirty = true;
          }
        } else if (c.type === 'text' && typeof c.text === 'string') {
          const text = c.text.trim();
          if (!text) continue;
          if (text.includes('<internal>')) {
            this.thinking = text
              .replace(/<\/?internal>/g, '')
              .trim()
              .split('\n')[0];
            this.phase = 'thinking';
            this.dirty = true;
          } else if (text.includes('<message')) {
            const clean = text
              .replace(/<[^>]+>/g, '')
              .trim()
              .split('\n')[0];
            if (clean) {
              this.lastLiveText = clean;
              this.phase = 'writing';
              this.dirty = true;
            }
          }
        }
      }
    } else if (type === 'user' && row.toolUseResult !== undefined) {
      // Find the last tool that doesn't have a result
      const toolList = Array.from(this.tools.values());
      const pendingTool = toolList.reverse().find((t) => t.result === undefined);
      if (pendingTool) {
        const res = row.toolUseResult;
        const out =
          typeof res === 'object' && res !== null && 'stdout' in res ? (res as { stdout: unknown }).stdout : res;
        const outStr = String(out || '');
        pendingTool.result = outStr.slice(0, 100);
        pendingTool.error = Boolean(
          typeof res === 'object' && res !== null && 'stderr' in res && (res as { stderr: string }).stderr,
        );
        this.phase = 'tool_result';
        this.dirty = true;
      }
    }
  }

  snapshot(now = Date.now()): ProgressSnapshot {
    return {
      phase: this.phase,
      startedAt: this.startedAt,
      elapsedSeconds: Math.max(0, (now - this.startedAt) / 1000),
      tools: Array.from(this.tools.values()),
      model: this.model,
      lastLiveText: this.lastLiveText,
      thinking: this.thinking,
    };
  }
}
