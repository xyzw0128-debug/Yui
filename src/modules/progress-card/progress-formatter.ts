import type { ProgressSnapshot } from './types.js';

export function formatElapsedKorean(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}초`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s > 0 ? `${m}분 ${s}초` : `${m}분`;
}

export function truncate(text: string, max: number): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, Math.max(0, max - 1))}…`;
}

export function renderProgressCard(snapshot: ProgressSnapshot): string {
  const elapsed = formatElapsedKorean(snapshot.elapsedSeconds);
  const model = snapshot.model ? ` · ${snapshot.model}` : '';
  const header = `⏳ **작업 중** — ${elapsed}${model}`;

  const activities: Array<{ text: string; inFlight: boolean }> = [];

  for (const tool of snapshot.tools) {
    const mark = tool.error ? '⛔' : tool.result != null ? '✅' : '🔧';
    const inputText = tool.input ? ` · \`${truncate(tool.input, 80)}\`` : '';
    const inFlight = !tool.error && tool.result == null;
    activities.push({
      text: `${mark} **${tool.name}**${inputText}`,
      inFlight,
    });
  }

  if (snapshot.thinking) {
    activities.push({
      text: `🧠 ${truncate(snapshot.thinking, 90)}`,
      inFlight: snapshot.phase === 'thinking',
    });
  } else if (snapshot.lastLiveText) {
    activities.push({
      text: `💬 ${truncate(snapshot.lastLiveText, 90)}`,
      inFlight: false,
    });
  }

  if (activities.length === 0) {
    return `${header}\n└ 💭 유이가 생각하고 있어요...`;
  }

  const recent = activities.slice(-4);
  const lines = [header];
  for (let i = 0; i < recent.length; i++) {
    const isLast = i === recent.length - 1;
    const branch = isLast ? '└' : '├';
    const current = recent[i].inFlight ? ' ←' : '';
    lines.push(`${branch} ${recent[i].text}${current}`);
  }

  return lines.join('\n');
}
