import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../../config.js';
import { log } from '../../log.js';
import { postChannelMessage, editChannelMessage, deleteChannelMessage } from '../../channels/channel-registry.js';
import { ProgressAggregator } from './progress-aggregator.js';
import { ProgressEditGate } from './progress-edit-gate.js';
import { renderProgressCard } from './progress-formatter.js';

interface ActiveProgressCard {
  agentGroupId: string;
  sessionId: string;
  channelType: string;
  platformId: string;
  threadId: string | null;
  instance?: string;
  messageId?: string;
  isPosting: boolean;
  messageIds: string[];
  startedAt: number;
  aggregator: ProgressAggregator;
  gate: ProgressEditGate;
  timer: NodeJS.Timeout;
  fileOffset: number;
  currentFilePath?: string;
  closed: boolean;
}

const activeCards = new Map<string, ActiveProgressCard>();

function findTranscriptFile(agentGroupId: string): string | null {
  const dir = path.join(DATA_DIR, 'v2-sessions', agentGroupId, '.claude-shared', 'projects', '-workspace-agent');
  if (!fs.existsSync(dir)) return null;
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(dir, f));
    if (files.length === 0) return null;
    files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return files[0] ?? null;
  } catch {
    return null;
  }
}

function readNewTranscriptLines(card: ActiveProgressCard): void {
  const filePath = findTranscriptFile(card.agentGroupId);
  if (!filePath || !fs.existsSync(filePath)) return;

  if (card.currentFilePath !== filePath) {
    card.currentFilePath = filePath;
    // On new file, start from beginning
    card.fileOffset = 0;
  }

  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= card.fileOffset) return;

    const fd = fs.openSync(filePath, 'r');
    const bytesToRead = stat.size - card.fileOffset;
    const buffer = Buffer.alloc(bytesToRead);
    fs.readSync(fd, buffer, 0, bytesToRead, card.fileOffset);
    fs.closeSync(fd);

    card.fileOffset = stat.size;
    const text = buffer.toString('utf-8');
    const lines = text.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        card.aggregator.ingestJsonlLine(trimmed);
      }
    }
  } catch (err) {
    log.debug('Failed to read transcript lines for progress card', { err });
  }
}

export function isProgressCardActive(sessionId: string): boolean {
  const card = activeCards.get(sessionId);
  return Boolean(card && !card.closed);
}

export function startProgressCard(
  agentGroupId: string,
  sessionId: string,
  channelType: string,
  platformId: string,
  threadId: string | null,
  instance?: string,
): void {
  // Currently target Discord where live message edits are first-class
  if (channelType !== 'discord') return;

  if (activeCards.has(sessionId)) return;

  const startedAt = Date.now();
  const aggregator = new ProgressAggregator(startedAt);
  const gate = new ProgressEditGate(2000);

  const card: ActiveProgressCard = {
    agentGroupId,
    sessionId,
    channelType,
    platformId,
    threadId,
    instance,
    startedAt,
    aggregator,
    gate,
    fileOffset: 0,
    closed: false,
    isPosting: false,
    messageIds: [],
    timer: null as unknown as NodeJS.Timeout,
  };

  card.timer = setInterval(() => {
    if (card.closed) return;

    readNewTranscriptLines(card);

    const now = Date.now();
    const elapsed = Math.floor((now - card.startedAt) / 1000);

    // If aggregator had new events or second ticked, mark dirty
    if (card.aggregator.consumeDirty() || elapsed > 0) {
      card.gate.markDirty();
    }

    // 1. Post initial card after 1.5s or as soon as a tool is detected (single-flight lock)
    if (!card.messageId && !card.isPosting) {
      const hasTools = card.aggregator.snapshot().tools.length > 0;
      const waitPassed = now - card.startedAt >= 1500;
      if (hasTools || waitPassed) {
        card.isPosting = true;
        const text = renderProgressCard(card.aggregator.snapshot(now));
        const key = card.instance ?? card.channelType;
        postChannelMessage(key, card.platformId, card.threadId, text)
          .then((msgId) => {
            card.isPosting = false;
            if (card.closed) {
              // Closed while post was in-flight, delete immediately
              if (msgId) {
                void deleteChannelMessage(key, card.platformId, card.threadId, msgId);
              }
              return;
            }
            if (msgId) {
              card.messageId = msgId;
              card.messageIds.push(msgId);
              card.gate.recordEdit(Date.now());
            }
          })
          .catch((err) => {
            card.isPosting = false;
            log.warn('Failed to post initial progress card', { sessionId, err });
          });
      }
      return;
    }

    // 2. Throttled edit (2s cadence)
    if (!card.messageId) return;

    const delay = card.gate.scheduleDelay(now);
    if (delay === 0) {
      if (card.gate.beginEdit()) {
        const text = renderProgressCard(card.aggregator.snapshot(now));
        const key = card.instance ?? card.channelType;
        editChannelMessage(key, card.platformId, card.threadId, card.messageId, text)
          .then(() => {
            card.gate.finishEdit(Date.now(), true);
          })
          .catch((err) => {
            log.debug('Progress card edit error', { sessionId, err });
            card.gate.finishEdit(Date.now(), false);
          });
      }
    } else if (delay !== null) {
      card.gate.releaseSchedule();
    }
  }, 500);

  card.timer.unref();
  activeCards.set(sessionId, card);
  log.info('Progress card tracking started', { sessionId, agentGroupId });
}

export async function finishProgressCard(sessionId: string): Promise<void> {
  const card = activeCards.get(sessionId);
  if (!card) return;

  card.closed = true;
  clearInterval(card.timer);
  activeCards.delete(sessionId);

  const key = card.instance ?? card.channelType;
  const toDelete = [...card.messageIds];
  if (card.messageId && !toDelete.includes(card.messageId)) {
    toDelete.push(card.messageId);
  }

  for (const msgId of toDelete) {
    try {
      await deleteChannelMessage(key, card.platformId, card.threadId, msgId);
      log.info('Progress card cleaned up after final delivery', { sessionId, messageId: msgId });
    } catch (err) {
      log.debug('Failed to delete progress card on completion (non-fatal)', { sessionId, messageId: msgId, err });
    }
  }
}

export function stopProgressCard(sessionId: string): void {
  void finishProgressCard(sessionId);
}
