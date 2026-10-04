import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isAuthorizedUser,
  buildModelConsolePayload,
  type ModelStatus,
  ANTIGRAVITY_MODELS,
  FLASH_PERFORMANCE_MODELS,
  getNextFlashModel,
  clearExhaustedFlashModels,
  GIN_429_REGEX,
  SUPPORTED_MODELS,
  formatModelQuota,
  recordActiveDiscordChannel,
  getActiveDiscordChannel,
  handleRateLimitDetected,
  handleModelSlashCommand,
  UNAUTHORIZED_MODEL_MESSAGE,
} from './discord-model-console.js';

describe('discord-model-console (Antigravity Edition)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('isAuthorizedUser', () => {
    it('authorizes the owner ID configured via DISCORD_OWNER_ID', () => {
      process.env.DISCORD_OWNER_ID = '999888777666555444';
      expect(isAuthorizedUser('999888777666555444')).toBe(true);
    });

    it('rejects undefined or empty userId', () => {
      expect(isAuthorizedUser(undefined)).toBe(false);
      expect(isAuthorizedUser('')).toBe(false);
    });

    it('rejects unknown users when no admin env is set', () => {
      expect(isAuthorizedUser('123456789012345678')).toBe(false);
    });

    it('authorizes users listed in MODEL_CONSOLE_ADMINS', () => {
      process.env.MODEL_CONSOLE_ADMINS = '111,222, 333 ';
      expect(isAuthorizedUser('111')).toBe(true);
      expect(isAuthorizedUser('222')).toBe(true);
      expect(isAuthorizedUser('333')).toBe(true);
      expect(isAuthorizedUser('444')).toBe(false);
    });
  });

  describe('handleModelSlashCommand authorization', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('refuses a mode switch from a non-admin with an ephemeral notice', async () => {
      process.env.DISCORD_OWNER_ID = '999888777666555444';
      const fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
      vi.stubGlobal('fetch', fetchMock);

      await handleModelSlashCommand({
        id: 'i1',
        token: 't1',
        member: { user: { id: '123456789012345678' } },
        data: { name: 'model', options: [{ name: 'mode', value: 'flash' }] },
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://discord.com/api/v10/interactions/i1/t1/callback');
      expect(JSON.parse(init.body)).toEqual({ type: 4, data: { content: UNAUTHORIZED_MODEL_MESSAGE, flags: 64 } });
    });
  });

  describe('buildModelConsolePayload (Antigravity Models)', () => {
    it('builds a purple payload when gemini-pro-agent (Boost) is active and healthy', () => {
      const status: ModelStatus = {
        activeModel: 'gemini-pro-agent',
        oauthAccount: 'xyzw0128@gmail.com',
        keyCount: 1,
        dockerStatus: 'running',
        httpOk: true,
        pingMs: 45,
      };

      const payload = buildModelConsolePayload(status, 'Lael');
      expect(payload.embeds).toHaveLength(1);
      const embed = payload.embeds[0];
      expect(embed.color).toBe(0x9b59b6); // Purple for Pro/Boost
      expect(embed.title).toContain('AI 모델 제어 콘솔 (Antigravity Mode)');

      expect(payload.components).toHaveLength(2); // 2 ActionRows

      // Row 1: Antigravity Models (Pro Agent & Flash)
      const row1Buttons = (payload.components[0] as { components: Array<Record<string, unknown>> }).components;
      expect(row1Buttons).toHaveLength(2);
      expect(row1Buttons[0].custom_id).toBe('model:gemini-pro-agent');
      expect(row1Buttons[0].style).toBe(3); // Active (Success Green)
      expect(row1Buttons[0].label).toContain('[활성]');

      expect(row1Buttons[1].custom_id).toBe('model:gemini-3-flash');
      expect(row1Buttons[1].style).toBe(2); // Inactive (Secondary Grey)

      // Row 2: Utility (status, restart, close)
      const row2Buttons = (payload.components[1] as { components: Array<Record<string, unknown>> }).components;
      expect(row2Buttons).toHaveLength(3);
      expect(row2Buttons[0].custom_id).toBe('model:status');
      expect(row2Buttons[1].custom_id).toBe('model:restart');
      expect(row2Buttons[1].style).toBe(4); // Danger
      expect(row2Buttons[2].custom_id).toBe('model:close');
    });

    it('builds a blue payload when gemini-3-flash is active', () => {
      const status: ModelStatus = {
        activeModel: 'gemini-3-flash',
        oauthAccount: 'xyzw0128@gmail.com',
        keyCount: 1,
        dockerStatus: 'running',
        httpOk: true,
        pingMs: 30,
      };

      const payload = buildModelConsolePayload(status);
      expect(payload.embeds[0].color).toBe(0x3498db); // Blue for Flash

      const row1Buttons = (payload.components[0] as { components: Array<Record<string, unknown>> }).components;
      expect(row1Buttons[1].style).toBe(3); // Active
      expect(row1Buttons[1].label).toContain('[활성]');
      expect(row1Buttons[0].style).toBe(1); // Primary (Blurple)
    });

    it('builds a red payload when httpOk is false', () => {
      const status: ModelStatus = {
        activeModel: 'gemini-pro-agent',
        oauthAccount: 'xyzw0128@gmail.com',
        keyCount: 1,
        dockerStatus: 'stopped',
        httpOk: false,
        pingMs: -1,
      };

      const payload = buildModelConsolePayload(status);
      expect(payload.embeds[0].color).toBe(0xe74c3c); // Red
    });

    it('omits redundant fields (guide, action message, duplicate oauth)', () => {
      const status: ModelStatus = {
        activeModel: 'gemini-pro-agent',
        oauthAccount: 'xyzw0128@gmail.com',
        keyCount: 1,
        dockerStatus: 'running',
        httpOk: true,
        pingMs: 42,
        lastActionMessage: '모델 전환 성공',
      };

      const payload = buildModelConsolePayload(status);
      const fields = payload.embeds[0].fields as Array<{ name: string; value: string }>;
      expect(fields.find((f) => f.name.includes('작업 결과'))).toBeUndefined();
      expect(fields.find((f) => f.name.includes('모델 가이드'))).toBeUndefined();
      expect(fields.find((f) => f.name.includes('Antigravity 연동 계정'))).toBeUndefined();
      expect(fields.find((f) => f.name.includes('활성 백엔드 모델'))).toBeDefined();
      expect(fields.find((f) => f.name.includes('프록시 상태'))).toBeDefined();
    });
  });

  describe('ANTIGRAVITY_MODELS & getNextFlashModel (Antigravity Failover)', () => {
    beforeEach(() => {
      clearExhaustedFlashModels();
    });

    it('contains gemini-pro-agent and gemini-3-flash', () => {
      expect(ANTIGRAVITY_MODELS).toEqual(['gemini-pro-agent', 'gemini-3-flash']);
      expect(FLASH_PERFORMANCE_MODELS).toEqual(ANTIGRAVITY_MODELS);
    });

    it('cascades from gemini-pro-agent to gemini-3-flash then stops', () => {
      expect(getNextFlashModel('gemini-pro-agent')).toBe('gemini-3-flash');
      expect(getNextFlashModel('gemini-3-flash')).toBeNull();
    });

    it('cascades from gemini-3-flash to gemini-pro-agent then stops', () => {
      expect(getNextFlashModel('gemini-3-flash')).toBe('gemini-pro-agent');
      expect(getNextFlashModel('gemini-pro-agent')).toBeNull();
    });

    it('maps aliases like pro and boost to gemini-pro-agent for failover', () => {
      expect(getNextFlashModel('boost')).toBe('gemini-3-flash');
    });

    it('ignores unknown models', () => {
      expect(getNextFlashModel('unknown-model-xyz')).toBeNull();
    });
  });

  describe('GIN_429_REGEX', () => {
    it('matches Gin logger 429 error on /v1/messages', () => {
      const sample =
        '[2026-09-13 07:23:37] [c5866540] [warn ] [gin_logger.go:101] 429 | 5.384s | 172.18.0.1 | POST "/v1/messages?beta=true"';
      expect(GIN_429_REGEX.test(sample)).toBe(true);
    });

    it('matches Gin logger 429 on /v1/messages without query params', () => {
      const sample =
        '[2026-09-13 07:23:37] [c5866540] [warn ] [gin_logger.go:101] 429 | 150ms | 172.18.0.1 | POST "/v1/messages"';
      expect(GIN_429_REGEX.test(sample)).toBe(true);
    });

    it('does not match 200 OK responses on /v1/messages', () => {
      const sample =
        '[2026-09-13 07:23:37] [c5866540] [info ] [gin_logger.go:103] 200 | 2.181s | 172.18.0.1 | POST "/v1/messages?beta=true"';
      expect(GIN_429_REGEX.test(sample)).toBe(false);
    });

    it('does not match 404 or other paths', () => {
      const sample =
        '[2026-09-13 07:26:41] [--------] [warn ] [gin_logger.go:101] 404 | 0s | 172.18.0.1 | GET "/metrics"';
      expect(GIN_429_REGEX.test(sample)).toBe(false);
    });

    it('does not match 429 on /v1/models', () => {
      const sample =
        '[2026-09-13 07:32:06] [e7c0123d] [warn ] [gin_logger.go:101] 429 | 0s | 172.18.0.1 | GET "/v1/models"';
      expect(GIN_429_REGEX.test(sample)).toBe(false);
    });
  });

  describe('recordActiveDiscordChannel', () => {
    it('returns empty or environment default channel ID when set', () => {
      process.env.DISCORD_ACTIVE_CHANNEL_ID = '111222333444555666';
      expect(getActiveDiscordChannel()).toBe('111222333444555666');
    });

    it('updates active channel when a valid channel ID is passed', () => {
      recordActiveDiscordChannel('999888777666555444');
      expect(getActiveDiscordChannel()).toBe('999888777666555444');
      // Reset back for test isolation
      recordActiveDiscordChannel('111222333444555666');
    });

    it('ignores empty or short invalid channel IDs', () => {
      recordActiveDiscordChannel('111222333444555666');
      recordActiveDiscordChannel('');
      expect(getActiveDiscordChannel()).toBe('111222333444555666');
      recordActiveDiscordChannel('123');
      expect(getActiveDiscordChannel()).toBe('111222333444555666');
    });
  });

  describe('handleRateLimitDetected (Antigravity Failover)', () => {
    beforeEach(() => {
      clearExhaustedFlashModels();
    });

    it('rotates from gemini-pro-agent to gemini-3-flash and stops when exhausted', async () => {
      const res1 = await handleRateLimitDetected('gemini-pro-agent', true);
      expect(res1.action).toBe('switch');
      expect(res1.to).toBe('gemini-3-flash');

      const res2 = await handleRateLimitDetected('gemini-3-flash', true);
      expect(res2.action).toBe('stop');
      expect(res2.to).toBeNull();
    });

    it('rotates from gemini-3-flash to gemini-pro-agent and stops when exhausted', async () => {
      const res1 = await handleRateLimitDetected('gemini-3-flash', true);
      expect(res1.action).toBe('switch');
      expect(res1.to).toBe('gemini-pro-agent');

      const res2 = await handleRateLimitDetected('gemini-pro-agent', true);
      expect(res2.action).toBe('stop');
      expect(res2.to).toBeNull();
    });
  });

  describe('Antigravity OAuth Model Quota', () => {
    it('formats quota for Antigravity models with 1M context', () => {
      const proModel = SUPPORTED_MODELS['gemini-pro-agent'];
      const flashModel = SUPPORTED_MODELS['gemini-3-flash'];

      expect(formatModelQuota(proModel)).toBe('Antigravity OAuth 연동 (1M Tokens)');
      expect(formatModelQuota(flashModel)).toBe('Antigravity OAuth 연동 (1M Tokens)');
    });
  });

  describe('Antigravity Quota Formatting & Console Display', () => {
    it('formats quota progress bar correctly', async () => {
      const { formatQuotaBar } = await import('./discord-model-console.js');
      expect(formatQuotaBar(undefined)).toBe('`정보 대기 중`');
      expect(formatQuotaBar(1.0)).toBe('🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩 **100%**');
      expect(formatQuotaBar(0.623)).toBe('🟩🟩🟩🟩🟩🟩⬜⬜⬜⬜ **62%**');
      expect(formatQuotaBar(0.35)).toBe('🟨🟨🟨🟨⬜⬜⬜⬜⬜⬜ **35%**');
      expect(formatQuotaBar(0.1)).toBe('🟥⬜⬜⬜⬜⬜⬜⬜⬜⬜ **10%**');
    });

    it('formats reset countdown string', async () => {
      const { formatResetCountdown } = await import('./discord-model-console.js');
      expect(formatResetCountdown(undefined)).toBe('실시간 자동 갱신');

      // Future date (1 hour from now)
      const future = new Date(Date.now() + 3600000 + 120000).toISOString();
      const res = formatResetCountdown(future);
      expect(res).toContain('약 1시간 2분 후');
      expect(res).toContain('KST');

      // Past date
      const past = new Date(Date.now() - 5000).toISOString();
      const resPast = formatResetCountdown(past);
      expect(resPast).toContain('초기화 완료 / 갱신 중');
    });

    it('renders Antigravity quota field in buildModelConsolePayload when present', () => {
      const status: ModelStatus = {
        activeModel: 'gemini-3-flash',
        oauthAccount: 'xyzw0128@gmail.com',
        keyCount: 1,
        dockerStatus: 'running',
        httpOk: true,
        pingMs: 30,
        quotaInfo: {
          userName: '장성원',
          userEmail: 'xyzw0128@gmail.com',
          planName: 'Pro',
          proRemainingFraction: 0.62,
          proResetTime: new Date(Date.now() + 7200000).toISOString(),
          flashRemainingFraction: 0.62,
          flashResetTime: new Date(Date.now() + 7200000).toISOString(),
          fetchedAt: Date.now(),
        },
      };

      const payload = buildModelConsolePayload(status);
      const fields = payload.embeds[0].fields as Array<{ name: string; value: string }>;
      const quotaField = fields.find((f) => f.name.includes('토큰 & 쿼터 현황'));
      expect(quotaField).toBeDefined();
      expect(quotaField?.value).toContain('장성원');
      expect(quotaField?.value).toContain('Pro 플랜');
      expect(quotaField?.value).toContain('Gemini 잔여 쿼터 (Pro / Flash 공용)');
      expect(quotaField?.value).toContain('62%');
      expect(quotaField?.value).toContain('쿼터 리셋 예정');
    });
  });
});
