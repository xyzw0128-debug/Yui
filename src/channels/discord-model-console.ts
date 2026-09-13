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
  if (userId === OWNER_DISCORD_ID) return true;
  const adminList = process.env.MODEL_CONSOLE_ADMINS?.split(',').map((s) => s.trim()) || [];
  return adminList.includes(userId);
}

export async function getModelStatus(actionMessage?: string): Promise<ModelStatus> {
  let activeModel = 'unknown';
  let keyCount = 0;

  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const config = fs.readFileSync(CONFIG_PATH, 'utf8');
      const match =
        config.match(/alias:\s*"claude-3-7-sonnet-20250219"[\s\S]*?name:\s*"([^"]+)"/) ||
        config.match(/name:\s*"([^"]+)"[\s\S]*?alias:\s*"claude-3-7-sonnet-20250219"/);
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

export async function switchProxyModel(target: 'flash-lite' | 'flash'): Promise<string> {
  const chosenModel = target === 'flash' ? 'gemini-3.5-flash' : 'gemini-3.5-flash-lite';
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
  const isFlash = !isLite && status.activeModel.includes('flash');

  const color = !status.httpOk ? 0xe74c3c : isLite ? 0x2ecc71 : 0xf39c12;

  const quotaInfo = isLite
    ? '총 ~21,000 req/day (1,500회 × 14키)\n💡 429 Rate Limit 걱정 없음 🛡️'
    : '총 280 req/day (20회 × 14키)\n⚠️ 프로젝트당 일 20회 제한으로 429 발생 주의!';

  const modelBadge = isLite ? `**${status.activeModel}** (안전 모드 🛡️)` : `**${status.activeModel}** (고성능 모드 ⚡)`;

  const fields: Array<Record<string, unknown>> = [
    {
      name: '📌 현재 활성 모델',
      value: modelBadge,
      inline: true,
    },
    {
      name: '🔑 API Key 풀',
      value: `${status.keyCount}개 정상 가동 (Round-Robin)`,
      inline: true,
    },
    {
      name: '📊 일일 가용 할당량',
      value: quotaInfo,
      inline: false,
    },
    {
      name: '⚙️ 프록시 상태 (CLI Proxy API)',
      value: `${status.httpOk ? '🟢 정상 가동 중' : '🔴 응답 없음'} (Docker: \`${status.dockerStatus}\`, 레이턴시: \`${status.pingMs >= 0 ? status.pingMs + 'ms' : 'N/A'}\`)`,
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

  const components = [
    {
      type: 1, // ActionRow
      components: [
        {
          type: 2, // Button
          style: isLite ? 3 : 2, // Success(Green) if active, else Secondary(Grey)
          label: isLite ? '⚡ Flash-Lite [활성]' : '⚡ Flash-Lite (일 2만회)',
          custom_id: 'model:flash-lite',
        },
        {
          type: 2, // Button
          style: isFlash ? 3 : 2, // Success(Green) if active, else Secondary(Grey)
          label: isFlash ? '🚀 Flash [활성]' : '🚀 Flash (고성능형)',
          custom_id: 'model:flash',
        },
        {
          type: 2, // Button
          style: 1, // Primary (Blurple)
          label: '📊 상태 점검',
          custom_id: 'model:status',
        },
        {
          type: 2, // Button
          style: 4, // Danger (Red)
          label: '🔄 프록시 재시작',
          custom_id: 'model:restart',
        },
      ],
    },
  ];

  return { embeds: [embed], components };
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
    if (customId === 'model:flash-lite') {
      const model = await switchProxyModel('flash-lite');
      actionMessage = `✅ **${model}**(안전 모드)로 성공적으로 전환되었습니다!`;
    } else if (customId === 'model:flash') {
      const model = await switchProxyModel('flash');
      actionMessage = `⚡ **${model}**(고성능 모드)로 성공적으로 전환되었습니다!\n(주의: 일 20회 초과 시 429가 발생할 수 있습니다)`;
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
