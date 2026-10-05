import fs from 'fs';
import path from 'path';
import https from 'https';
import { exec, spawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import { envValue } from '../env.js';
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
  'claude-3-7-sonnet-20250219',
  'claude-3-5-sonnet-20241022',
  'claude-opus-4-6-thinking',
  'claude-opus-5',
];

export interface ModelOption {
  key: string;
  id: string;
  name: string;
  badge: string;
  description: string;
  contextWindow?: string;
  quotaPerKey?: number;
  rpmPerKey?: number;
}

export const SUPPORTED_MODELS: Record<string, ModelOption> = {
  'gemini-pro-agent': {
    key: 'gemini-pro-agent',
    id: 'gemini-pro-agent',
    name: 'Gemini 3.1 Pro',
    badge: '🚀 최고 성능 / 심층 추론 및 코딩 (Boost)',
    description: 'Antigravity 플래그십 모델 • 최고 성능, 심층 추론 및 고난도 자율 에이전트 코딩',
    contextWindow: '1M Tokens',
    quotaPerKey: 500,
    rpmPerKey: 15,
  },
  'gemini-3-flash': {
    key: 'gemini-3-flash',
    id: 'gemini-3-flash',
    name: 'Gemini 3.8 Flash',
    badge: '⚡ 초고속 표준 / 일상 대화 및 Q&A (Flash)',
    description: 'Antigravity 고속 표준 모델 • 실시간 빠른 응답, 일상 대화 및 Q&A 최적화',
    contextWindow: '1M Tokens',
    quotaPerKey: 1000,
    rpmPerKey: 30,
  },
  // Backwards compatibility for legacy model keys
  '3.7-flash': {
    key: '3.7-flash',
    id: 'gemini-pro-agent',
    name: '3.7 Flash (Legacy)',
    badge: '🧠 심층 추론',
    description: '레거시 키 풀 모델 (gemini-pro-agent로 연결됨)',
    quotaPerKey: 20,
    rpmPerKey: 5,
  },
  '3.8-flash': {
    key: '3.8-flash',
    id: 'gemini-3-flash',
    name: '3.8 Flash (Legacy)',
    badge: '⚡ 초고속 표준',
    description: '레거시 키 풀 모델 (gemini-3-flash로 연결됨)',
    quotaPerKey: 1000,
    rpmPerKey: 30,
  },
  '3.5-flash-lite': {
    key: '3.5-flash-lite',
    id: 'gemini-3-flash',
    name: '3.5 Flash-Lite (Legacy)',
    badge: '⚡ 초고속',
    description: '레거시 키 풀 모델 (gemini-3-flash로 연결됨)',
    quotaPerKey: 1000,
    rpmPerKey: 30,
  },
};

export const MODEL_ALIASES: Record<string, string> = {
  // Pro tier (Gemini 3.1 Pro)
  'gemini-pro-agent': 'gemini-pro-agent',
  'pro-agent': 'gemini-pro-agent',
  pro: 'gemini-pro-agent',
  boost: 'gemini-pro-agent',
  agent: 'gemini-pro-agent',
  'gemini-3.1-pro': 'gemini-pro-agent',
  '3.1-pro': 'gemini-pro-agent',

  // Flash tier (Gemini 3.8 Flash)
  'gemini-3-flash': 'gemini-3-flash',
  '3-flash': 'gemini-3-flash',
  flash: 'gemini-3-flash',
  'gemini-3.8-flash': 'gemini-3-flash',
  '3.8-flash': 'gemini-3-flash',

  // Fallback to Flash for any lite alias
  'gemini-3.5-flash-lite': 'gemini-3-flash',
  '3.5-flash-lite': 'gemini-3-flash',
  'flash-lite': 'gemini-3-flash',
  lite: 'gemini-3-flash',
  '3.1-flash-lite': 'gemini-3-flash',
  'gemini-3.1-flash-lite': 'gemini-3-flash',

  // Legacy mappings
  '3.5-flash': 'gemini-3-flash',
  '3.6-flash': 'gemini-3-flash',
  '3.7-flash': 'gemini-pro-agent',
};

export function formatModelQuota(model: ModelOption, keyCount?: number): string {
  if (model.id === 'gemini-pro-agent' || model.id === 'gemini-3-flash') {
    return `Antigravity OAuth 연동 (${model.contextWindow || '1M 컨텍스트'})`;
  }
  const count = Math.max(1, keyCount || 1);
  const totalRpd = ((model.quotaPerKey || 100) * count).toLocaleString();
  const prefix = (model.quotaPerKey || 0) >= 500 ? '~' : '';
  return `일 ${prefix}${totalRpd}회 (${model.quotaPerKey}회/키, ${model.rpmPerKey} RPM)`;
}

export interface AntigravityQuotaInfo {
  userName?: string;
  userEmail?: string;
  planName?: string;
  proRemainingFraction?: number;
  proResetTime?: string;
  flashRemainingFraction?: number;
  flashResetTime?: string;
  fetchedAt: number;
}

let cachedQuota: AntigravityQuotaInfo | null = null;
const QUOTA_CACHE_TTL_MS = 10000; // 10 seconds cache

export function formatQuotaBar(fraction?: number, length = 10): string {
  if (fraction === undefined || fraction === null || isNaN(fraction)) {
    return '`정보 대기 중`';
  }
  const pct = Math.round(fraction * 100);
  const filled = Math.max(0, Math.min(length, Math.round(fraction * length)));
  const empty = length - filled;
  const icon = pct >= 50 ? '🟩' : pct >= 20 ? '🟨' : '🟥';
  return `${icon.repeat(filled)}${'⬜'.repeat(empty)} **${pct}%**`;
}

export function formatResetCountdown(isoTime?: string): string {
  if (!isoTime) return '실시간 자동 갱신';
  try {
    const target = new Date(isoTime);
    const diffMs = target.getTime() - Date.now();
    const kstStr = target.toLocaleTimeString('ko-KR', {
      timeZone: 'Asia/Seoul',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    if (diffMs <= 0) {
      return `초기화 완료 / 갱신 중 (${kstStr} KST)`;
    }
    const hours = Math.floor(diffMs / 3600000);
    const mins = Math.floor((diffMs % 3600000) / 60000);
    const timeParts = [];
    if (hours > 0) timeParts.push(`${hours}시간`);
    timeParts.push(`${mins}분`);
    return `약 ${timeParts.join(' ')} 후 (${kstStr} KST)`;
  } catch {
    return isoTime;
  }
}

export async function fetchAntigravityQuota(forceRefresh = false): Promise<AntigravityQuotaInfo | null> {
  const now = Date.now();
  if (!forceRefresh && cachedQuota && now - cachedQuota.fetchedAt < QUOTA_CACHE_TTL_MS) {
    return cachedQuota;
  }

  if (process.env.VITEST || process.env.NODE_ENV === 'test') {
    return cachedQuota;
  }

  try {
    const { stdout: pgrepOut } = await execAsync('pgrep -f language_server || true');
    const pids = pgrepOut.trim().split(/\s+/).filter(Boolean);
    if (pids.length === 0) return cachedQuota;

    let csrfToken: string | null = null;
    let targetPid: string | null = null;

    for (const pid of pids) {
      try {
        const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        const m = cmdline.match(/--csrf_token[\x00=]([^\x00\s]+)/);
        if (m) {
          csrfToken = m[1];
          targetPid = pid;
          break;
        }
      } catch {
        // ignore
      }
    }

    if (!csrfToken || !targetPid) return cachedQuota;

    const { stdout: ssOut } = await execAsync('ss -tulpn || true');
    const ports: number[] = [];
    for (const line of ssOut.split('\n')) {
      if (line.includes(`pid=${targetPid},`)) {
        const m = line.match(/127\.0\.0\.1:(\d+)/);
        if (m) ports.push(parseInt(m[1], 10));
      }
    }

    if (ports.length === 0) return cachedQuota;

    for (const port of ports) {
      try {
        const data = await new Promise<any>((resolve, reject) => {
          const req = https.request(
            `https://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/GetUserStatus`,
            {
              method: 'POST',
              rejectUnauthorized: false,
              timeout: 2500,
              headers: {
                'Content-Type': 'application/json',
                'x-codeium-csrf-token': csrfToken!,
              },
            },
            (res) => {
              let body = '';
              res.on('data', (c) => (body += c));
              res.on('end', () => {
                if (res.statusCode === 200) {
                  try {
                    resolve(JSON.parse(body));
                  } catch (e) {
                    reject(e);
                  }
                } else {
                  reject(new Error(`Status ${res.statusCode}`));
                }
              });
            },
          );
          req.on('error', reject);
          req.on('timeout', () => {
            req.destroy();
            reject(new Error('Timeout'));
          });
          req.write('{}');
          req.end();
        });

        const userStatus = data?.userStatus;
        if (!userStatus) continue;

        const userName = userStatus.name || undefined;
        const userEmail = userStatus.email || undefined;
        const planName = userStatus.planStatus?.planInfo?.planName || undefined;

        let proRemainingFraction: number | undefined;
        let proResetTime: string | undefined;
        let flashRemainingFraction: number | undefined;
        let flashResetTime: string | undefined;

        const configs = userStatus.cascadeModelConfigData?.clientModelConfigs || [];
        for (const c of configs) {
          const label = c.label || '';
          const quota = c.quotaInfo;
          if (label.includes('3.1 Pro')) {
            if (quota?.remainingFraction !== undefined && proRemainingFraction === undefined) {
              proRemainingFraction = quota.remainingFraction;
              proResetTime = quota.resetTime;
            }
          } else if (label.includes('3.8 Flash')) {
            if (quota?.remainingFraction !== undefined && flashRemainingFraction === undefined) {
              flashRemainingFraction = quota.remainingFraction;
              flashResetTime = quota.resetTime;
            }
          }
        }

        cachedQuota = {
          userName,
          userEmail,
          planName,
          proRemainingFraction,
          proResetTime,
          flashRemainingFraction,
          flashResetTime,
          fetchedAt: now,
        };
        return cachedQuota;
      } catch {
        // try next port
      }
    }
  } catch (err) {
    log.warn('Failed to fetch Antigravity quota from language_server', { err });
  }

  return cachedQuota;
}

export interface ModelStatus {
  activeModel: string;
  oauthAccount?: string;
  keyCount: number;
  dockerStatus: string;
  httpOk: boolean;
  pingMs: number;
  lastActionMessage?: string;
  quotaInfo?: AntigravityQuotaInfo | null;
}

export function isAuthorizedUser(userId?: string): boolean {
  if (!userId) return false;
  const ownerId = process.env.DISCORD_OWNER_ID || OWNER_DISCORD_ID || envValue('DISCORD_OWNER_ID') || '';
  if (ownerId && userId === ownerId) return true;
  const adminRaw = process.env.MODEL_CONSOLE_ADMINS || envValue('MODEL_CONSOLE_ADMINS') || '';
  const adminList = adminRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return adminList.includes(userId);
}

export const UNAUTHORIZED_MODEL_MESSAGE = '⚠️ 관리자(파파)만 모델을 변경하거나 프록시를 제어할 수 있습니다.';

/** Discord user id behind an interaction (guild: member.user, DM: user). */
export function interactionUserId(interaction: Record<string, unknown>): string | undefined {
  const user =
    ((interaction.member as Record<string, unknown>)?.user as Record<string, string> | undefined) ??
    (interaction.user as Record<string, string> | undefined);
  return user?.id;
}

/** Answer an interaction with an ephemeral notice only the invoker sees. */
export async function replyEphemeral(interaction: Record<string, unknown>, content: string): Promise<void> {
  await fetch(
    `https://discord.com/api/v10/interactions/${interaction.id as string}/${interaction.token as string}/callback`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 4, data: { content, flags: 64 } }),
    },
  );
}

export async function probeAntigravity(): Promise<{ healthy: boolean; latencyMs: number; account: string }> {
  const t0 = Date.now();
  let account = 'unknown';
  try {
    const authDir = path.resolve(path.dirname(CONFIG_PATH), 'auth');
    if (fs.existsSync(authDir)) {
      const authFiles = fs.readdirSync(authDir).filter((f) => f.startsWith('antigravity-') && f.endsWith('.json'));
      if (authFiles.length > 0) {
        const emailMatch = authFiles[0].match(/antigravity-(.+)\.json/);
        if (emailMatch) {
          account = emailMatch[1];
        }
      }
    }
  } catch {
    // ignore
  }

  try {
    const res = await fetch(CLIPROXY_PING_URL, {
      headers: { Authorization: 'Bearer placeholder' },
      signal: AbortSignal.timeout(3000),
    });
    return { healthy: res.ok, latencyMs: Date.now() - t0, account };
  } catch {
    return { healthy: false, latencyMs: -1, account };
  }
}

export async function probeAllKeys(): Promise<{ healthy: number; total: number; latencyMs: number }> {
  const probe = await probeAntigravity();
  return {
    healthy: probe.healthy ? 1 : 0,
    total: 1,
    latencyMs: probe.latencyMs,
  };
}

export async function getModelStatus(actionMessage?: string, forceRefresh = false): Promise<ModelStatus> {
  let activeModel = 'unknown';
  let keyCount = 0;
  let oauthAccount = 'unknown';

  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const config = fs.readFileSync(CONFIG_PATH, 'utf8');
      const match = config.match(/- name:\s*"?([^"\r\n]+)"?\s*\n\s*alias:\s*"?claude-3-7-sonnet-20250219"?/);
      if (match) {
        activeModel = match[1].trim();
      }
      keyCount = (config.match(/- api-key:/g) || []).length;
    }

    const authDir = path.resolve(path.dirname(CONFIG_PATH), 'auth');
    if (fs.existsSync(authDir)) {
      const authFiles = fs.readdirSync(authDir).filter((f) => f.startsWith('antigravity-') && f.endsWith('.json'));
      if (authFiles.length > 0) {
        const emailMatch = authFiles[0].match(/antigravity-(.+)\.json/);
        if (emailMatch) {
          oauthAccount = emailMatch[1];
        }
      }
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

  let quotaInfo: AntigravityQuotaInfo | null = null;
  try {
    quotaInfo = await fetchAntigravityQuota(forceRefresh);
  } catch (err) {
    log.warn('Failed to resolve Antigravity quota in getModelStatus', { err });
  }

  return {
    activeModel,
    oauthAccount,
    keyCount,
    dockerStatus,
    httpOk,
    pingMs,
    lastActionMessage: actionMessage,
    quotaInfo,
  };
}

export async function switchProxyModel(target: string): Promise<string> {
  const chosenModel =
    MODEL_ALIASES[target] || (SUPPORTED_MODELS[target] ? SUPPORTED_MODELS[target].id : target) || 'gemini-pro-agent';

  // In test environment or if config file does not exist, do not attempt real filesystem writes or docker restart
  if (process.env.VITEST || process.env.NODE_ENV === 'test' || !fs.existsSync(CONFIG_PATH)) {
    log.info('Mocking switchProxyModel in test/missing-config environment', { model: chosenModel });
    return chosenModel;
  }

  let text = fs.readFileSync(CONFIG_PATH, 'utf8');

  let matchCount = 0;
  for (const alias of SONNET_ALIASES) {
    const regex = new RegExp(`(- name:\\s*)"?[^"\\r\\n]+"?(\\s*\\n\\s*alias:\\s*"?${alias}"?)`, 'g');
    if (regex.test(text)) {
      matchCount++;
      text = text.replace(regex, `$1"${chosenModel}"$2`);
    }
  }
  if (matchCount === 0) {
    log.warn('switchProxyModel: YAML regex matched no aliases — config format may have changed', {
      model: chosenModel,
      configPath: CONFIG_PATH,
      aliases: SONNET_ALIASES,
    });
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
  /** Include the OAuth account name/email. Only for owner/admin viewers — the embed is posted publicly. */
  showAccount = false,
): {
  embeds: Array<Record<string, unknown>>;
  components: Array<Record<string, unknown>>;
} {
  const isPro = status.activeModel === 'gemini-pro-agent';
  const isFlash = status.activeModel === 'gemini-3-flash';

  const color = !status.httpOk ? 0xe74c3c : isPro ? 0x9b59b6 : isFlash ? 0x3498db : 0x2ecc71;

  let activeModelBadge = 'Antigravity OAuth 연동 모델';
  if (isPro) {
    activeModelBadge = '🚀 Pro Agent (최고 성능 / 심층 추론·코딩)';
  } else if (isFlash) {
    activeModelBadge = '⚡ Gemini 3 Flash (초고속 / 일상 대화·고효율)';
  } else {
    activeModelBadge = `✨ ${status.activeModel} (Antigravity 연동)`;
  }

  const fields: Array<Record<string, unknown>> = [
    {
      name: '📌 현재 활성 백엔드 모델',
      value: `**${status.activeModel}**\n${activeModelBadge}`,
      inline: true,
    },
    {
      name: '⚙️ 프록시 상태 (CLI Proxy API)',
      value: `${status.httpOk ? '🟢 정상 가동 중' : '🔴 응답 없음'}\n(Docker: \`${status.dockerStatus}\`, 지연: \`${status.pingMs >= 0 ? status.pingMs + 'ms' : 'N/A'}\`)`,
      inline: true,
    },
  ];

  if (status.quotaInfo) {
    const q = status.quotaInfo;
    const quotaFraction = q.proRemainingFraction !== undefined ? q.proRemainingFraction : q.flashRemainingFraction;
    const quotaBar = formatQuotaBar(quotaFraction);
    const resetCountdown = formatResetCountdown(q.proResetTime || q.flashResetTime);
    const planText = q.planName ? ` • **${q.planName} 플랜**` : '';
    const account = q.userEmail || status.oauthAccount || 'unknown';
    const userText = !showAccount
      ? planText.replace(/^ • /, '')
      : q.userName
        ? `👤 **${q.userName}** (\`${account}\`)${planText}`
        : `👤 \`${account}\`${planText}`;

    fields.push({
      name: '📊 Antigravity Gemini 토큰 & 쿼터 현황',
      value:
        (userText ? `${userText}\n` : '') +
        `• 🔋 **Gemini 잔여 쿼터 (Pro / Flash 공용)**: ${quotaBar} 잔여\n` +
        `• ⏳ **쿼터 리셋 예정**: ${resetCountdown}`,
      inline: false,
    });
  }

  const embed = {
    title: '🎮 AI 모델 제어 콘솔 (Antigravity Mode)',
    description: '원클릭으로 유이의 백엔드 AI 모델을 전환하고 프록시 상태를 제어합니다.',
    color,
    fields,
    footer: {
      text: `NanoClaw Console • Google Antigravity OAuth 연동${requesterName ? ` • 실행자: ${requesterName}` : ''}`,
    },
    timestamp: new Date().toISOString(),
  };

  // Row 1: Model Buttons (Pro Agent vs Flash)
  const row1 = {
    type: 1, // ActionRow
    components: [
      {
        type: 2, // Button
        style: isPro ? 3 : 1, // Success(Green) if active, else Primary(Blurple)
        label: isPro ? '🚀 Pro Agent [활성]' : '🚀 Pro Agent (고성능)',
        custom_id: 'model:gemini-pro-agent',
      },
      {
        type: 2, // Button
        style: isFlash ? 3 : 2, // Success(Green) if active, else Secondary(Grey)
        label: isFlash ? '⚡ Gemini 3 Flash [활성]' : '⚡ Gemini 3 Flash (고속)',
        custom_id: 'model:gemini-3-flash',
      },
    ],
  };

  // Row 2: Utility buttons
  const row2 = {
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

  return { embeds: [embed], components: [row1, row2] };
}

/**
 * Handle slash command `/model` or `/boost` (interaction type 2)
 */
export async function handleModelSlashCommand(
  interaction: Record<string, unknown>,
  requesterName?: string,
): Promise<void> {
  const interactionId = interaction.id as string;
  const interactionToken = interaction.token as string;
  const data = interaction.data as Record<string, unknown> | undefined;

  let actionMessage: string | undefined;
  const options = (data?.options as Array<Record<string, unknown>>) || [];
  const modeOpt = options.find((o) => o.name === 'mode');
  if (modeOpt?.value) {
    // Viewing the console is open; switching models rewrites config.yaml and
    // restarts the proxy, so it is owner/admin-only (same as the buttons).
    if (!isAuthorizedUser(interactionUserId(interaction))) {
      await replyEphemeral(interaction, UNAUTHORIZED_MODEL_MESSAGE);
      return;
    }
    const target = String(modeOpt.value);
    try {
      const switched = await switchProxyModel(target);
      actionMessage = `✅ **${switched}** 모델로 성공적으로 전환되었습니다!`;
    } catch (err) {
      actionMessage = `❌ 모델 전환 실패: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const status = await getModelStatus(actionMessage);
  const payload = buildModelConsolePayload(status, requesterName, isAuthorizedUser(interactionUserId(interaction)));

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
    await replyEphemeral(interaction, UNAUTHORIZED_MODEL_MESSAGE);
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

      if (customId === 'model:gemini-pro-agent' || customId === 'model:pro' || customId === 'model:boost') {
        const model = await switchProxyModel('gemini-pro-agent');
        actionMessage = `🚀 **${model}**(Pro Agent / Boost 모드)로 전환되었습니다!\n(심층 추론 및 고난도 코딩 작업에 최적화, 1M 컨텍스트)`;
      } else if (
        customId === 'model:gemini-3-flash' ||
        customId === 'model:flash' ||
        customId === 'model:3-flash' ||
        customId === 'model:flash-lite' ||
        customId === 'model:3.5-flash-lite' ||
        customId === 'model:3.1-flash-lite' ||
        customId === 'model:3.5-flash' ||
        customId === 'model:3.6-flash'
      ) {
        const model = await switchProxyModel('gemini-3-flash');
        actionMessage = `⚡ **${model}**(초고속 Flash 모드)로 전환되었습니다!\n(빠른 응답 속도 및 일상 작업에 최적화, 1M 컨텍스트)`;
      } else if (customId === 'model:3.7-flash' || customId === 'model:3.8-flash') {
        const model = await switchProxyModel('gemini-pro-agent');
        actionMessage = `🚀 **${model}**(Pro Agent / Boost 모드)로 전환되었습니다!\n(심층 추론 및 고난도 코딩 작업에 최적화, 1M 컨텍스트)`;
      } else if (customId === 'model:restart') {
        await restartProxyContainer();
        actionMessage = '🔄 CLI Proxy API 컨테이너를 성공적으로 재시작했습니다.';
      } else if (customId === 'model:status') {
        const probe = await probeAntigravity();
        actionMessage = probe.healthy
          ? `📊 실시간 Antigravity 상태: **정상 가동 중** (계정: \`${probe.account}\`, 응답 속도: ${probe.latencyMs}ms)`
          : `⚠️ 프록시 응답 지연 또는 오류 상태`;
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      actionMessage = `❌ 작업 실패: ${errorMsg}`;
      log.error('Model console action failed', { customId, err });
    }

    // 3. Update the original message with new status (force refresh quota on status check)
    const isStatusCheck = customId === 'model:status';
    const updatedStatus = await getModelStatus(actionMessage, isStatusCheck);
    const payload = buildModelConsolePayload(updatedStatus, userName, true);

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
 * Handle plain text command `!model`, `!boost`, `!모델`, `!부스트`
 */
export async function handleModelTextMessage(
  channelId: string,
  botToken: string,
  requesterName?: string,
  actionMessage?: string,
  showAccount = false,
): Promise<void> {
  const status = await getModelStatus(actionMessage);
  const payload = buildModelConsolePayload(status, requesterName, showAccount);

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
 * Smart 429 Failover & Watchdog for Antigravity
 *
 * Behavior:
 * - Antigravity Models: 'gemini-pro-agent' and 'gemini-3-flash'.
 * - When 'gemini-pro-agent' hits 429, rotates to 'gemini-3-flash' to continue work.
 * - When 'gemini-3-flash' hits 429, rotates to 'gemini-pro-agent' to continue work.
 * - When all models in the pool are exhausted: STOP without infinite cycling,
 *   leaving Claude Code to handle retry natively.
 */
export const ANTIGRAVITY_MODELS = ['gemini-pro-agent', 'gemini-3-flash'];

export const FLASH_PERFORMANCE_MODELS = ['gemini-pro-agent', 'gemini-3-flash'];

export const FLASH_FAILOVER_TARGETS: Record<string, string[]> = {
  'gemini-pro-agent': ['gemini-3-flash'],
  'gemini-3-flash': ['gemini-pro-agent'],
};

export const FLASH_FAILOVER_CHAIN: Record<string, string | null> = {
  'gemini-pro-agent': 'gemini-3-flash',
  'gemini-3-flash': null,
};

const exhaustedFlashModels = new Set<string>();

export function getExhaustedFlashModels(): Set<string> {
  return exhaustedFlashModels;
}

export function clearExhaustedFlashModels(): void {
  exhaustedFlashModels.clear();
}

export function getNextFlashModel(currentModel: string): string | null {
  const resolved = MODEL_ALIASES[currentModel] || currentModel;
  if (!ANTIGRAVITY_MODELS.includes(resolved)) {
    return null;
  }

  exhaustedFlashModels.add(resolved);

  const targets = FLASH_FAILOVER_TARGETS[resolved] || [];
  for (const target of targets) {
    if (!exhaustedFlashModels.has(target)) {
      return target;
    }
  }

  return null;
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
  // .env is not loaded into process.env (see src/env.ts), so read it directly;
  // otherwise failover alerts after a restart have no channel until someone
  // sends a message.
  return activeDiscordChannelId || process.env.DISCORD_ACTIVE_CHANNEL_ID || envValue('DISCORD_ACTIVE_CHANNEL_ID') || '';
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
  const channelId = getActiveDiscordChannel();
  if (!token || !channelId) {
    log.warn('Cannot send failover alert: Discord bot token or channel ID missing', {
      hasToken: Boolean(token),
      channelId,
    });
    return false;
  }

  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
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

    const resolvedCurrent = MODEL_ALIASES[currentModel] || currentModel;

    if (!ANTIGRAVITY_MODELS.includes(resolvedCurrent)) {
      log.info(
        '429 watchdog: Active model is not an Antigravity failover model; leaving Claude Code to handle natively',
        {
          currentModel,
        },
      );
      return { action: 'ignored', from: currentModel };
    }

    const nextModel = getNextFlashModel(resolvedCurrent);

    if (nextModel) {
      log.info('429 watchdog: Auto-switching Antigravity model', { from: resolvedCurrent, to: nextModel });
      await switchProxyModel(nextModel);

      await sendDiscordNotification({
        title: '⚡ [스마트 페일오버] Antigravity 모델 자동 전환 완료',
        description:
          `기존 활성 모델(**${resolvedCurrent}**)의 쿼터 소진(429)이 감지되었습니다.\n\n` +
          `🚀 작업 유지를 위해 대체 Antigravity 모델인 **${nextModel}**(으)로 즉시 자동 전환되었습니다.\n` +
          `Claude Code가 내부 재시도 중이므로 작업이 끊김 없이 자동 복구되어 이어집니다.`,
        color: 0x3498db, // Blue
        fields: [
          { name: '이전 모델', value: `\`${resolvedCurrent}\``, inline: true },
          { name: '전환 모델', value: `\`${nextModel}\``, inline: true },
          { name: '안내', value: 'Claude Code 세션이 자동 재시도에 성공하면 작업이 계속 진행됩니다.', inline: false },
        ],
        footer: { text: 'NanoClaw Watchdog • Google Antigravity OAuth 보호 중' },
        timestamp: new Date().toISOString(),
      });

      return { action: 'switch', from: resolvedCurrent, to: nextModel };
    } else {
      log.info(
        '429 watchdog: All Antigravity failover models exhausted. Leaving Claude Code to handle retries/errors natively without interference.',
        { currentModel },
      );

      return { action: 'stop', from: resolvedCurrent, to: null };
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

      const processLines = (buf: string): string => {
        const lines = buf.split('\n');
        const remainder = lines.pop() ?? '';
        for (const line of lines) {
          if (GIN_429_REGEX.test(line)) {
            log.warn('429 watchdog detected 429 on /v1/messages in cliproxy log', { line: line.trim() });
            void handleRateLimitDetected();
            break;
          }
        }
        return remainder;
      };

      let stdoutBuffer = '';
      let stderrBuffer = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuffer = processLines(stdoutBuffer + chunk.toString('utf8'));
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBuffer = processLines(stderrBuffer + chunk.toString('utf8'));
      });

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
