import { describe, expect, it } from 'vitest';
import { ProgressAggregator } from './progress-aggregator.js';
import { ProgressEditGate } from './progress-edit-gate.js';
import { renderProgressCard } from './progress-formatter.js';

describe('ProgressEditGate', () => {
  it('enforces interval between edits and tracks dirty state', () => {
    const gate = new ProgressEditGate(2000);
    expect(gate.isDirty()).toBe(false);

    gate.markDirty();
    expect(gate.isDirty()).toBe(true);

    // Initial edit with lastEditAt = 0 should have delay 0
    const delay0 = gate.scheduleDelay(1000);
    expect(delay0).toBe(0);
    expect(gate.beginEdit()).toBe(true);

    gate.finishEdit(1000, true);
    expect(gate.isDirty()).toBe(false);

    // Mark dirty again at t = 1500 (500ms after last edit)
    gate.markDirty();
    const delay1 = gate.scheduleDelay(1500);
    expect(delay1).toBe(1500); // 2000 - (1500 - 1000) = 1500ms remaining
  });
});

describe('ProgressAggregator & renderProgressCard', () => {
  it('ingests tool_use, tool_result, and renders progress card tree', () => {
    const agg = new ProgressAggregator(Date.now() - 15000); // 15s ago
    agg.setModel('gemini-3.5-flash');

    // Assistant tool use
    agg.ingestJsonlLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'gemini-3.5-flash',
          content: [
            {
              type: 'tool_use',
              id: 'bash-1',
              name: 'Bash',
              input: { command: '/workspace/agent/yui-agy.sh -p "오늘 날씨"' },
            },
          ],
        },
      }),
    );

    const snap1 = agg.snapshot(agg.snapshot().startedAt + 15000);
    expect(snap1.tools.length).toBe(1);
    expect(snap1.tools[0].name).toBe('Bash');
    expect(snap1.tools[0].input).toBe('yui-agy.sh -p "오늘 날씨"');

    const card1 = renderProgressCard(snap1);
    expect(card1).toContain('⏳ **작업 중** — 15초 · gemini-3.5-flash');
    expect(card1).toContain('└ 🔧 **Bash** · `yui-agy.sh -p "오늘 날씨"` ←');

    // Tool result completes
    agg.ingestJsonlLine(
      JSON.stringify({
        type: 'user',
        toolUseResult: { stdout: '서울 맑음, 기온 25도' },
      }),
    );

    // Second tool starts
    agg.ingestJsonlLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'react-1',
              name: 'mcp__nanoclaw__add_reaction',
              input: { emoji: 'blue_heart' },
            },
          ],
        },
      }),
    );

    const snap2 = agg.snapshot(agg.snapshot().startedAt + 18000);
    expect(snap2.tools.length).toBe(2);
    expect(snap2.tools[0].result).toBe('서울 맑음, 기온 25도');

    const card2 = renderProgressCard(snap2);
    expect(card2).toContain('├ ✅ **Bash** · `yui-agy.sh -p "오늘 날씨"`');
    expect(card2).toContain('└ 🔧 **add_reaction** · `:blue_heart:` ←');
  });

  it('renders initial thinking state when no tools have run yet', () => {
    const agg = new ProgressAggregator(Date.now() - 2000);
    const snap = agg.snapshot(agg.snapshot().startedAt + 2000);
    const card = renderProgressCard(snap);
    expect(card).toContain('⏳ **작업 중** — 2초');
    expect(card).toContain('└ 💭 유이가 생각하고 있어요...');
  });
});
