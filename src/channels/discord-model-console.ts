import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { log } from '../log.js';

const execAsync = promisify(exec);

const CONFIG_PATH = '/home/lael/cliproxyapi/config.yaml';
const CLIPROXY_PING_URL = 'http://172.17.0.1:8317/v1/models';
const OWNER_DISCORD_ID = '631432379889745930';

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
  quota: string;
}

export const SUPPORTED_MODELS: Record<string, ModelOption> = {
  '3.1-flash-lite': {
    key: '3.1-flash-lite',
    id: 'gemini-3.1-flash-lite',
    name: '3.1 Flash-Lite',
    badge: '⚡ 초경량/초고속',
    quota: '일 ~21,000회 (안전)',
  },
  '3.5-flash-lite': {
    key: '3.5-flash-lite',
    id: 'gemini-3.5-flash-lite',
    name: '3.5 Flash-Lite',
    badge: '🛡️ 일상 추천/안전',
    quota: '일 ~21,000회 (안전)',
  },
  '3.5-flash': {
    key: '3.5-flash',
    id: 'gemini-3.5-flash',
    name: '3.5 Flash',
    badge: '🚀 표준 고성능',
    quota: '일 280회 (20회/키)',
  },
  '3.6-flash': {
    key: '3.6-flash',
    id: 'gemini-3.6-flash',
    name: '3.6 Flash',
    badge: '🚀 최신 고성능',
    quota: '일 280회 (20회/키)',
  },
  '3.7-flash': {
    key: '3.7-flash',
    id: 'gemini-3.7-flash',
    name: '3.7 Flash',
    badge: '🧠 심층 추론(Thinking)',
    quota: '일 280회 (코딩/추론 특화)',
  },
};

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
  const isThinking = status.activeModel.includes('3.7');
  const color = !status.httpOk ? 0xe74c3c : isLite ? 0x2ecc71 : isThinking ? 0x9b59b6 : 0xf39c12;

  let activeModelBadge = '알 수 없음';
  for (const model of Object.values(SUPPORTED_MODELS)) {
    if (status.activeModel === model.id) {
      activeModelBadge = `${model.badge} • ${model.quota}`;
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
      name: '📋 선택 가능한 5개 모델 안내',
      value:
        '• `gemini-3.1-flash-lite`: ⚡ 초경량 / 초고속 / 일 ~21,000회\n' +
        '• `gemini-3.5-flash-lite`: 🛡️ 1M 컨텍스트 / 시각 / **일상 추천 (일 ~21,000회)** ⭐\n' +
        '• `gemini-3.5-flash`: 🚀 표준 고성능 플래시 (일 280회)\n' +
        '• `gemini-3.6-flash`: 🚀 차세대 고성능 플래시 (일 280회)\n' +
        '• `gemini-3.7-flash`: 🧠 심층 추론(Thinking) / **코딩·논리 특화**',
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
      text: `NanoClaw Model Console • ${requesterName ? `실행자: ${requesterName}` : 'OpenClaw Engine'}`,
    },
    timestamp: new Date().toISOString(),
  };

  // Row 1: Flash-Lite models (21,000 requests/day pool)
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
        label: is37Flash ? '🧠 3.7 Flash [활성]' : '🧠 3.7 Flash (추론형)',
        custom_id: 'model:3.7-flash',
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
    if (customId === 'model:3.1-flash-lite') {
      const model = await switchProxyModel('3.1-flash-lite');
      actionMessage = `⚡ **${model}**(초경량/초고속 모드)로 전환되었습니다!`;
    } else if (customId === 'model:flash-lite' || customId === 'model:3.5-flash-lite') {
      const model = await switchProxyModel('3.5-flash-lite');
      actionMessage = `🛡️ **${model}**(일상 추천/안전 모드)로 전환되었습니다! (일 21,000회 풀)`;
    } else if (customId === 'model:flash' || customId === 'model:3.5-flash') {
      const model = await switchProxyModel('3.5-flash');
      actionMessage = `🚀 **${model}**(표준 고성능 모드)로 전환되었습니다!\n(주의: 일 20회 초과 시 429 가능)`;
    } else if (customId === 'model:3.6-flash') {
      const model = await switchProxyModel('3.6-flash');
      actionMessage = `🚀 **${model}**(차세대 고성능 모드)로 전환되었습니다!\n(주의: 일 20회 초과 시 429 가능)`;
    } else if (customId === 'model:3.7-flash') {
      const model = await switchProxyModel('3.7-flash');
      actionMessage = `🧠 **${model}**(심층 추론·Thinking 모드)로 전환되었습니다!\n(복잡한 코딩 및 아키텍처 추론 특화)`;
    } else if (customId === 'model:restart') {
      await restartProxyContainer();
      actionMessage = '🔄 Cliproxy API 컨테이너를 성공적으로 재시작했습니다.';
    } else if (customId === 'model:status') {
      actionMessage = '📊 최신 프록시 상태와 지연시간을 갱신했습니다.';
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
