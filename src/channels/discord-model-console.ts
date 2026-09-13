import fs from 'fs';
import path from 'path';
import { exec, spawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import { log } from '../log.js';

const execAsync = promisify(exec);

export function getCliproxyConfigPath(): string {
  if (process.env.CLIPROXY_CONFIG_PATH) return process.env.CLIPROXY_CONFIG_PATH;
  if (process.env.HOME) return path.join(process.env.HOME, 'cliproxyapi/config.yaml');
  return path.resolve('cliproxyapi/config.yaml');
}

export const CONFIG_PATH = getCliproxyConfigPath();
const CLIPROXY_PING_URL = 'http://172.17.0.1:8317/v1/models';
const OWNER_DISCORD_ID = process.env.DISCORD_OWNER_ID || '';

let isActionInProgress = false;

const SONNET_ALIASES = [
  'claude-3-5-sonnet-20241022',
  'claude-3-7-sonnet-20250219',
  'claude-opus-4-6-thinking',
  'claude-opus-5',
];

export interface ModelOption {
  key: string;
  id: string;
  name: string;
  badge: string;
  quotaPerKey: number;
  rpmPerKey: number;
}

export const SUPPORTED_MODELS: Record<string, ModelOption> = {
  '3.1-flash-lite': {
    key: '3.1-flash-lite',
    id: 'gemini-3.1-flash-lite',
    name: '3.1 Flash-Lite',
    badge: '⚡ 초경량/초고속',
    quotaPerKey: 500,
    rpmPerKey: 15,
  },
  '3.5-flash-lite': {
    key: '3.5-flash-lite',
    id: 'gemini-3.5-flash-lite',
    name: '3.5 Flash-Lite',
    badge: '🛡️ 일상 추천/안전',
    quotaPerKey: 500,
    rpmPerKey: 15,
  },
  '3.5-flash': {
    key: '3.5-flash',
    id: 'gemini-3.5-flash',
    name: '3.5 Flash',
    badge: '🚀 표준 고성능',
    quotaPerKey: 20,
    rpmPerKey: 5,
  },
  '3.6-flash': {
    key: '3.6-flash',
    id: 'gemini-3.6-flash',
    name: '3.6 Flash',
    badge: '🚀 최신 고성능',
    quotaPerKey: 20,
    rpmPerKey: 5,
  },
  '3.7-flash': {
    key: '3.7-flash',
    id: 'gemini-3.7-flash',
    name: '3.7 Flash',
    badge: '🧠 심층 추론(Thinking)',
    quotaPerKey: 20,
    rpmPerKey: 5,
  },
  '3.8-flash': {
    key: '3.8-flash',
    id: 'gemini-3.8-flash',
    name: '3.8 Flash',
    badge: '⚡ 초고속 심층 코딩/Agentic',
    quotaPerKey: 20,
    rpmPerKey: 5,
  },
};

export function formatModelQuota(model: ModelOption, keyCount: number): string {
  const count = Math.max(1, keyCount);
  const totalRpd = (model.quotaPerKey * count).toLocaleString();
  const prefix = model.quotaPerKey >= 500 ? '~' : '';
  return `일 ${prefix}${totalRpd}회 (${model.quotaPerKey}회/키, ${model.rpmPerKey} RPM)`;
}

export interface ModelStatus {
  activeModel: string;
  keyCount: number;
  dockerStatus: string;
  httpOk: boolean;
  pingMs: number;
  lastActionMessage?: string;
}

export function isAuthorizedUser(userId?: string): boolean {
  if (!userId) return false;
  const ownerId = process.env.DISCORD_OWNER_ID || OWNER_DISCORD_ID;
  if (userId === ownerId) return true;
  const adminList = process.env.MODEL_CONSOLE_ADMINS?.split(',').map((s) => s.trim()) || [];
  return adminList.includes(userId);
}

export async function probeAllKeys(): Promise<{ healthy: number; total: number; latencyMs: number }> {
  try {
    const config = fs.readFileSync(CONFIG_PATH, 'utf8');
    const keys = [...config.matchAll(/api-key:\s*"([^"]+)"/g)].map((m) => m[1]);
    if (keys.length === 0) return { healthy: 0, total: 0, latencyMs: -1 };

    const t0 = Date.now();
    const results = await Promise.all(
      keys.map(async (k) => {
        try {
          const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${k}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ contents: [{ parts: [{ text: 'p' }] }] }),
              signal: AbortSignal.timeout(4000),
            },
          );
          return res.status === 200 ? 1 : 0;
        } catch {
          return 0;
        }
      }),
    );
    const healthy = results.filter((s) => s === 1).length;
    return { healthy, total: keys.length, latencyMs: Date.now() - t0 };
  } catch {
    return { healthy: 0, total: 0, latencyMs: -1 };
  }
}

export async function getModelStatus(actionMessage?: string): Promise<ModelStatus> {
  let activeModel = 'unknown';
  let keyCount = 0;

  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const config = fs.readFileSync(CONFIG_PATH, 'utf8');
      const match = config.match(/- name:\s*"([^"]+)"\s*\n\s*alias:\s*"claude-3-7-sonnet-20250219"/);
      if (match) {
        activeModel = match[1];
      }
      keyCount = (config.match(/- api-key:/g) || []).length;
    }
  } catch (err) {
    log.error('Failed to read cliproxy config for status', { err });
  }

  let dockerStatus = 'unknown';
  try {
    const { stdout } = await execAsync('docker inspect -f "{{.State.Status}}" cliproxyapi');
    dockerStatus = stdout.trim();
  } catch (err: unknown) {
    dockerStatus = 'stopped/error';
    log.warn('Failed to inspect docker cliproxyapi', { err });
  }

  let pingMs = -1;
  let httpOk = false;
  try {
    const t0 = Date.now();
    const res = await fetch(CLIPROXY_PING_URL, {
      headers: { Authorization: 'Bearer placeholder' },
      signal: AbortSignal.timeout(2000),
    });
    pingMs = Date.now() - t0;
    httpOk = res.ok;
  } catch {
    httpOk = false;
  }

  return {
    activeModel,
    keyCount,
    dockerStatus,
    httpOk,
    pingMs,
    lastActionMessage: actionMessage,
  };
}

export async function switchProxyModel(target: string): Promise<string> {
  let chosenModel = target;
  if (target === 'flash-lite') {
    chosenModel = 'gemini-3.5-flash-lite';
  } else if (target === 'flash') {
    chosenModel = 'gemini-3.5-flash';
  } else if (SUPPORTED_MODELS[target]) {
    chosenModel = SUPPORTED_MODELS[target].id;
  }

  let text = fs.readFileSync(CONFIG_PATH, 'utf8');

  for (const alias of SONNET_ALIASES) {
    const regex = new RegExp(`- name: "[^"]+"\\s*\\n\\s*alias: "${alias}"`, 'g');
    text = text.replace(regex, `- name: "${chosenModel}"\n        alias: "${alias}"`);
  }

  fs.writeFileSync(CONFIG_PATH, text, 'utf8');
  log.info('Updated cliproxy config.yaml model', { model: chosenModel });

  await execAsync('docker restart cliproxyapi');
  log.info('Restarted cliproxyapi docker container');

  // Wait briefly for HTTP readiness
  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch(CLIPROXY_PING_URL, {
        headers: { Authorization: 'Bearer placeholder' },
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  return chosenModel;
}

export async function restartProxyContainer(): Promise<void> {
  await execAsync('docker restart cliproxyapi');
  log.info('Manually restarted cliproxyapi container');

  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch(CLIPROXY_PING_URL, {
        headers: { Authorization: 'Bearer placeholder' },
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

export function buildModelConsolePayload(
  status: ModelStatus,
  requesterName?: string,
): {
  embeds: Array<Record<string, unknown>>;
  components: Array<Record<string, unknown>>;
} {
  const isLite = status.activeModel.includes('flash-lite');
  const isThinking = status.activeModel.includes('3.7') || status.activeModel.includes('3.8');
  const color = !status.httpOk ? 0xe74c3c : isLite ? 0x2ecc71 : isThinking ? 0x9b59b6 : 0xf39c12;

  const count = Math.max(1, status.keyCount || 1);
  const liteTotalStr = (500 * count).toLocaleString();
  const flashTotalStr = (20 * count).toLocaleString();

  let activeModelBadge = '알 수 없음';
  for (const model of Object.values(SUPPORTED_MODELS)) {
    if (status.activeModel === model.id) {
      activeModelBadge = `${model.badge} • ${formatModelQuota(model, count)}`;
      break;
    }
  }

  const fields: Array<Record<string, unknown>> = [
    {
      name: '📌 현재 활성 백엔드 모델',
      value: `**${status.activeModel}**\n${activeModelBadge}`,
      inline: true,
    },
    {
      name: '🔑 API Key 풀',
      value: `${status.keyCount}개 키 가동 (Round-Robin)`,
      inline: true,
    },
    {
      name: '⚙️ 프록시 상태 (CLI Proxy API)',
      value: `${status.httpOk ? '🟢 정상 가동 중' : '🔴 응답 없음'} (Docker: \`${status.dockerStatus}\`, 레이턴시: \`${status.pingMs >= 0 ? status.pingMs + 'ms' : 'N/A'}\`)`,
      inline: false,
    },
    {
      name: `📋 선택 가능한 6개 모델 안내 (${count}개 키 풀 기준)`,
      value:
        `• \`gemini-3.1-flash-lite\`: ⚡ 초경량 / 초고속 • **일 ~${liteTotalStr}회** (500회/키, 15 RPM)\n` +
        `• \`gemini-3.5-flash-lite\`: 🛡️ 1M 컨텍스트 / 비전 • **일상 추천 (일 ~${liteTotalStr}회)** ⭐\n` +
        `• \`gemini-3.5-flash\`: 🚀 표준 고성능 플래시 • 일 ${flashTotalStr}회 (20회/키, 5 RPM)\n` +
        `• \`gemini-3.6-flash\`: 🚀 차세대 고성능 플래시 • 일 ${flashTotalStr}회 (20회/키, 5 RPM)\n` +
        `• \`gemini-3.7-flash\`: 🧠 심층 추론(Thinking) • 일 ${flashTotalStr}회 (코딩·논리 특화)\n` +
        `• \`gemini-3.8-flash\`: ⚡ 초고속 심층 코딩/Agentic • 일 ${flashTotalStr}회 (최신 자율 에이전트)`,
      inline: false,
    },
  ];

  if (status.lastActionMessage) {
    fields.push({
      name: '🔔 작업 결과',
      value: status.lastActionMessage,
      inline: false,
    });
  }

  const embed = {
    title: '🎮 AI 모델 제어 콘솔 (OpenClaw Mode)',
    description: '원클릭으로 유이의 백엔드 AI 모델을 전환하고 프록시를 제어합니다.',
    color,
    fields,
    footer: {
      text: `NanoClaw Console • ⏰ 한도 초기화: 매일 16:00 KST (PST 00:00)${requesterName ? ` • 실행자: ${requesterName}` : ''}`,
    },
    timestamp: new Date().toISOString(),
  };

  // Row 1: Flash-Lite models (7,000 requests/day pool)
  const is31Lite = status.activeModel === 'gemini-3.1-flash-lite';
  const is35Lite = status.activeModel === 'gemini-3.5-flash-lite';
  const row1 = {
    type: 1, // ActionRow
    components: [
      {
        type: 2, // Button
        style: is31Lite ? 3 : 2, // Success(Green) if active
        label: is31Lite ? '⚡ 3.1 Flash-Lite [활성]' : '⚡ 3.1 Flash-Lite (초고속)',
        custom_id: 'model:3.1-flash-lite',
      },
      {
        type: 2, // Button
        style: is35Lite ? 3 : 2,
        label: is35Lite ? '🛡️ 3.5 Flash-Lite [활성]' : '🛡️ 3.5 Flash-Lite (추천⭐)',
        custom_id: 'model:3.5-flash-lite',
      },
    ],
  };

  // Row 2: Flash models (Performance & Reasoning)
  const is35Flash = status.activeModel === 'gemini-3.5-flash';
  const is36Flash = status.activeModel === 'gemini-3.6-flash';
  const is37Flash = status.activeModel === 'gemini-3.7-flash';
  const is38Flash = status.activeModel === 'gemini-3.8-flash';
  const row2 = {
    type: 1, // ActionRow
    components: [
      {
        type: 2,
        style: is35Flash ? 3 : 2,
        label: is35Flash ? '🚀 3.5 Flash [활성]' : '🚀 3.5 Flash',
        custom_id: 'model:3.5-flash',
      },
      {
        type: 2,
        style: is36Flash ? 3 : 2,
        label: is36Flash ? '🚀 3.6 Flash [활성]' : '🚀 3.6 Flash',
        custom_id: 'model:3.6-flash',
      },
      {
        type: 2,
        style: is37Flash ? 3 : 2,
        label: is37Flash ? '🧠 3.7 Flash [활성]' : '🧠 3.7 Flash',
        custom_id: 'model:3.7-flash',
      },
      {
        type: 2,
        style: is38Flash ? 3 : 2,
        label: is38Flash ? '⚡ 3.8 Flash [활성]' : '⚡ 3.8 Flash (최신🚀)',
        custom_id: 'model:3.8-flash',
      },
    ],
  };

  // Row 3: Utility buttons
  const row3 = {
    type: 1, // ActionRow
    components: [
      {
        type: 2,
        style: 1, // Primary (Blurple)
        label: '📊 상태 점검',
        custom_id: 'model:status',
      },
      {
        type: 2,
        style: 4, // Danger (Red)
        label: '🔄 프록시 재시작',
        custom_id: 'model:restart',
      },
      {
        type: 2,
        style: 2, // Secondary (Grey)
        label: '🗑️ 닫기',
        custom_id: 'model:close',
      },
    ],
  };

  return { embeds: [embed], components: [row1, row2, row3] };
}

/**
 * Handle slash command `/model` (interaction type 2)
 */
export async function handleModelSlashCommand(
  interaction: Record<string, unknown>,
  requesterName?: string,
): Promise<void> {
  const interactionId = interaction.id as string;
  const interactionToken = interaction.token as string;
  const status = await getModelStatus();
  const payload = buildModelConsolePayload(status, requesterName);

  await fetch(`https://discord.com/api/v10/interactions/${interactionId}/${interactionToken}/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 4, // CHANNEL_MESSAGE_WITH_SOURCE
      data: payload,
    }),
  });
}

/**
 * Handle button clicks `model:*` (interaction type 3)
 */
export async function handleModelButtonInteraction(
  interaction: Record<string, unknown>,
  applicationId: string,
): Promise<void> {
  const interactionId = interaction.id as string;
  const interactionToken = interaction.token as string;
  const customId = (interaction.data as Record<string, unknown>)?.custom_id as string;

  const user =
    ((interaction.member as Record<string, unknown>)?.user as Record<string, string> | undefined) ??
    (interaction.user as Record<string, string> | undefined);
  const userId = user?.id;
  const userName = user?.global_name || user?.username || '알 수 없음';

  if (!isAuthorizedUser(userId)) {
    // Ephemeral warning for unauthorized users
    await fetch(`https://discord.com/api/v10/interactions/${interactionId}/${interactionToken}/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 4,
        data: {
          content: '⚠️ 파파(관리자)만 모델을 변경하거나 프록시를 제어할 수 있습니다.',
          flags: 64, // EPHEMERAL
        },
      }),
    });
    return;
  }

  // Handle Close Button
  if (customId === 'model:close') {
    await fetch(`https://discord.com/api/v10/interactions/${interactionId}/${interactionToken}/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 6 }),
    });
    await fetch(`https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}/messages/@original`, {
      method: 'DELETE',
    });
    return;
  }

  // Prevent concurrent button spamming
  if (isActionInProgress) {
    await fetch(`https://discord.com/api/v10/interactions/${interactionId}/${interactionToken}/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 4,
        data: {
          content: '⏳ 이전 작업이 아직 처리 중입니다. 잠시 후 다시 눌러주세요.',
          flags: 64, // EPHEMERAL
        },
      }),
    });
    return;
  }

  isActionInProgress = true;

  try {
    // 1. Immediately acknowledge with deferred update (prevents 3s timeout)
    await fetch(`https://discord.com/api/v10/interactions/${interactionId}/${interactionToken}/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 6, // DEFERRED_UPDATE_MESSAGE
      }),
    });

    // 2. Perform requested action
    let actionMessage = '';
    try {
      clearExhaustedFlashModels();
      const currentStatus = await getModelStatus();
      const count = Math.max(1, currentStatus.keyCount || 1);
      const liteTotalStr = (500 * count).toLocaleString();
      const flashTotalStr = (20 * count).toLocaleString();

      if (customId === 'model:3.1-flash-lite') {
        const model = await switchProxyModel('3.1-flash-lite');
        actionMessage = `⚡ **${model}**(초경량/초고속 모드)로 전환되었습니다!\n(일 ~${liteTotalStr}회 풀, 15 RPM)`;
      } else if (customId === 'model:flash-lite' || customId === 'model:3.5-flash-lite') {
        const model = await switchProxyModel('3.5-flash-lite');
        actionMessage = `🛡️ **${model}**(일상 추천/안전 모드)로 전환되었습니다!\n(일 ~${liteTotalStr}회 풀, 15 RPM)`;
      } else if (customId === 'model:flash' || customId === 'model:3.5-flash') {
        const model = await switchProxyModel('3.5-flash');
        actionMessage = `🚀 **${model}**(표준 고성능 모드)로 전환되었습니다!\n(주의: 일 ${flashTotalStr}회 초과 시 429 가능, 5 RPM)`;
      } else if (customId === 'model:3.6-flash') {
        const model = await switchProxyModel('3.6-flash');
        actionMessage = `🚀 **${model}**(차세대 고성능 모드)로 전환되었습니다!\n(주의: 일 ${flashTotalStr}회 초과 시 429 가능, 5 RPM)`;
      } else if (customId === 'model:3.7-flash') {
        const model = await switchProxyModel('3.7-flash');
        actionMessage = `🧠 **${model}**(심층 추론·Thinking 모드)로 전환되었습니다!\n(일 ${flashTotalStr}회 풀, 코딩·논리 특화, 5 RPM)`;
      } else if (customId === 'model:3.8-flash') {
        const model = await switchProxyModel('3.8-flash');
        actionMessage = `⚡ **${model}**(초고속 심층 코딩/Agentic 모드)로 전환되었습니다!\n(일 ${flashTotalStr}회 풀, 최신 자율 에이전트, 5 RPM)`;
      } else if (customId === 'model:restart') {
        await restartProxyContainer();
        actionMessage = '🔄 Cliproxy API 컨테이너를 성공적으로 재시작했습니다.';
      } else if (customId === 'model:status') {
        const probe = await probeAllKeys();
        actionMessage = `📊 실시간 키 진단: **${probe.healthy}/${probe.total}개 키 정상 가동** (프로브 속도: ${probe.latencyMs}ms)`;
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      actionMessage = `❌ 작업 실패: ${errorMsg}`;
      log.error('Model console action failed', { customId, err });
    }

    // 3. Update the original message with new status
    const updatedStatus = await getModelStatus(actionMessage);
    const payload = buildModelConsolePayload(updatedStatus, userName);

    await fetch(`https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}/messages/@original`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } finally {
    isActionInProgress = false;
  }
}

/**
 * Handle plain text command `!model` or `!모델`
 */
export async function handleModelTextMessage(
  channelId: string,
  botToken: string,
  requesterName?: string,
): Promise<void> {
  const status = await getModelStatus();
  const payload = buildModelConsolePayload(status, requesterName);

  await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

/**
 * Smart 429 Failover & Watchdog (Zero-Degradation / No-Lite Policy)
 *
 * Behavior:
 * - Flash-Lite (3.1 Lite, 3.5 Lite): NO failover action. Claude Code handles 429 natively.
 * - Flash models (3.5, 3.6, 3.7, 3.8): When ANY flash model hits 429, rotates to another
 *   available Flash model in the pool to continue work.
 * - When all 4 Flash models are exhausted: STOP without switching to Lite,
 *   leaving Claude Code to handle natively.
 */
export const FLASH_PERFORMANCE_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
];

export const FLASH_FAILOVER_TARGETS: Record<string, string[]> = {
  'gemini-3.8-flash': ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash'],
  'gemini-3.7-flash': ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash'],
  'gemini-3.6-flash': ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash'],
  'gemini-3.5-flash': ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash'],
};

export const FLASH_FAILOVER_CHAIN: Record<string, string | null> = {
  'gemini-3.8-flash': 'gemini-3.7-flash',
  'gemini-3.7-flash': 'gemini-3.8-flash',
  'gemini-3.6-flash': 'gemini-3.8-flash',
  'gemini-3.5-flash': 'gemini-3.8-flash',
};

const exhaustedFlashModels = new Set<string>();

export function getExhaustedFlashModels(): Set<string> {
  return exhaustedFlashModels;
}

export function clearExhaustedFlashModels(): void {
  exhaustedFlashModels.clear();
}

export function getNextFlashModel(currentModel: string): string | null {
  if (!FLASH_PERFORMANCE_MODELS.includes(currentModel)) {
    return null; // Not a Flash performance model (e.g. Flash-Lite); no failover
  }

  exhaustedFlashModels.add(currentModel);

  const targets = FLASH_FAILOVER_TARGETS[currentModel] || [];
  for (const target of targets) {
    if (!exhaustedFlashModels.has(target)) {
      return target;
    }
  }

  return null; // All 3 Flash models exhausted! Strictly no Lite.
}

export const GIN_429_REGEX = /429\s*\|.*POST\s+"\/v1\/messages/;

let activeDiscordChannelId = process.env.DISCORD_ACTIVE_CHANNEL_ID || '';
let storedDiscordBotToken: string | null = null;
let isFailoverInProgress = false;
let lastFailoverAt = 0;
const FAILOVER_COOLDOWN_MS = 15000; // 15 seconds cooldown

export function recordActiveDiscordChannel(channelId?: string): void {
  if (channelId && channelId.length > 5) {
    activeDiscordChannelId = channelId;
  }
}

export function getActiveDiscordChannel(): string {
  return activeDiscordChannelId || process.env.DISCORD_ACTIVE_CHANNEL_ID || '';
}

export function setDiscordBotToken(token?: string): void {
  if (token) {
    storedDiscordBotToken = token;
  }
}

export function getDiscordBotToken(): string | null {
  return storedDiscordBotToken || process.env.DISCORD_BOT_TOKEN || null;
}

export async function sendDiscordNotification(embed: Record<string, unknown>): Promise<boolean> {
  const token = getDiscordBotToken();
  if (!token || !activeDiscordChannelId) {
    log.warn('Cannot send failover alert: Discord bot token or channel ID missing', {
      hasToken: Boolean(token),
      channelId: activeDiscordChannelId,
    });
    return false;
  }

  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${activeDiscordChannelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if (!res.ok) {
      const errText = await res.text();
      log.warn('Failed to send Discord alert', { status: res.status, body: errText });
      return false;
    }
    return true;
  } catch (err) {
    log.error('Error sending Discord alert', { err });
    return false;
  }
}

export async function handleRateLimitDetected(
  overrideCurrentModel?: string,
  skipCooldown = false,
): Promise<{ action: 'switch' | 'stop' | 'ignored'; from?: string; to?: string | null }> {
  const now = Date.now();
  if (!skipCooldown && (isFailoverInProgress || now - lastFailoverAt < FAILOVER_COOLDOWN_MS)) {
    log.info('429 watchdog: Skip failover, cooldown active or action in progress');
    return { action: 'ignored' };
  }

  isFailoverInProgress = true;
  lastFailoverAt = now;

  try {
    let currentModel = overrideCurrentModel;
    if (!currentModel) {
      const status = await getModelStatus();
      currentModel = status.activeModel;
    }

    // 1. If current model is not a Flash model (e.g. Flash-Lite):
    // DO NOTHING. Claude Code handles 429 natively.
    if (!FLASH_PERFORMANCE_MODELS.includes(currentModel)) {
      log.info(
        '429 watchdog: Active model is not a Flash performance model (e.g. Lite); leaving Claude Code to handle natively',
        {
          currentModel,
        },
      );
      return { action: 'ignored', from: currentModel };
    }

    // 2. Find next available Flash model among {3.7, 3.6, 3.5}
    const nextModel = getNextFlashModel(currentModel);

    if (nextModel) {
      log.info('429 watchdog: Auto-switching flash model', { from: currentModel, to: nextModel });
      await switchProxyModel(nextModel);

      await sendDiscordNotification({
        title: '⚡ [스마트 페일오버] Flash 모델 자동 전환 완료',
        description:
          `기존 활성 모델(**${currentModel}**)의 쿼터 소진(429)이 감지되었습니다.\n\n` +
          `🚀 작업 유지를 위해 다른 고성능 Flash 모델인 **${nextModel}**(으)로 즉시 자동 전환되었습니다.\n` +
          `Claude Code가 내부 재시도 중이므로 작업이 끊김 없이 자동 복구되어 이어집니다.`,
        color: 0x3498db, // Blue
        fields: [
          { name: '이전 모델', value: `\`${currentModel}\``, inline: true },
          { name: '전환 모델', value: `\`${nextModel}\``, inline: true },
          { name: '안내', value: 'Claude Code 세션이 자동 재시도에 성공하면 작업이 계속 진행됩니다.', inline: false },
        ],
        footer: { text: 'NanoClaw Watchdog • 고성능 Flash 풀 순환 가동 중' },
        timestamp: new Date().toISOString(),
      });

      return { action: 'switch', from: currentModel, to: nextModel };
    } else {
      // All 4 Flash models (3.8, 3.7, 3.6, 3.5) exhausted!
      // Do NOT switch to Lite. Do NOT send task stop alerts.
      // Leave Claude Code 100% alone to follow its native retry and exit behavior.
      log.info(
        '429 watchdog: All 4 Flash performance models (3.5, 3.6, 3.7, 3.8) exhausted. Leaving Claude Code to handle retries/errors natively without interference.',
        { currentModel },
      );

      return { action: 'stop', from: currentModel, to: null };
    }
  } catch (err) {
    log.error('429 watchdog failover failed', { err });
    return { action: 'ignored' };
  } finally {
    isFailoverInProgress = false;
  }
}

let watchdogProcess: ChildProcess | null = null;
let watchdogRestartTimer: NodeJS.Timeout | null = null;
let isWatchdogStopping = false;

export function startModelFailoverWatchdog(botToken?: string): void {
  if (botToken) {
    setDiscordBotToken(botToken);
  }

  if (watchdogProcess) {
    log.info('429 watchdog already running');
    return;
  }

  isWatchdogStopping = false;

  const runStream = () => {
    if (isWatchdogStopping) return;

    try {
      log.info('Starting cliproxyapi docker log watchdog stream...');
      const child = spawn('docker', ['logs', '-f', '-n', '0', 'cliproxyapi'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      watchdogProcess = child;

      let lineBuffer = '';

      const processData = (chunk: Buffer) => {
        lineBuffer += chunk.toString('utf8');
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? '';

        for (const line of lines) {
          if (GIN_429_REGEX.test(line)) {
            log.warn('429 watchdog detected 429 on /v1/messages in cliproxy log', { line: line.trim() });
            void handleRateLimitDetected();
            break;
          }
        }
      };

      child.stdout?.on('data', processData);
      child.stderr?.on('data', processData);

      child.on('error', (err) => {
        log.warn('429 watchdog process error', { err });
      });

      child.on('exit', (code, signal) => {
        watchdogProcess = null;
        log.info('429 watchdog process exited', { code, signal });
        if (!isWatchdogStopping) {
          if (watchdogRestartTimer) clearTimeout(watchdogRestartTimer);
          watchdogRestartTimer = setTimeout(() => {
            runStream();
          }, 3000);
        }
      });
    } catch (err) {
      log.error('Failed to spawn 429 watchdog process', { err });
      if (!isWatchdogStopping) {
        if (watchdogRestartTimer) clearTimeout(watchdogRestartTimer);
        watchdogRestartTimer = setTimeout(() => {
          runStream();
        }, 5000);
      }
    }
  };

  runStream();
}

export function stopModelFailoverWatchdog(): void {
  isWatchdogStopping = true;
  if (watchdogRestartTimer) {
    clearTimeout(watchdogRestartTimer);
    watchdogRestartTimer = null;
  }
  if (watchdogProcess) {
    watchdogProcess.kill('SIGTERM');
    watchdogProcess = null;
  }
}
