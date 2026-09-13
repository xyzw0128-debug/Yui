import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isAuthorizedUser,
  buildModelConsolePayload,
  type ModelStatus,
  FLASH_FAILOVER_CHAIN,
  GIN_429_REGEX,
  SUPPORTED_MODELS,
  formatModelQuota,
  recordActiveDiscordChannel,
  getActiveDiscordChannel,
  handleRateLimitDetected,
} from './discord-model-console.js';

describe('discord-model-console', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('isAuthorizedUser', () => {
    it('authorizes the default owner ID (631432379889745930)', () => {
      expect(isAuthorizedUser('631432379889745930')).toBe(true);
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

  describe('buildModelConsolePayload', () => {
    it('builds a green payload when 3.5 flash-lite is active and healthy', () => {
      const status: ModelStatus = {
        activeModel: 'gemini-3.5-flash-lite',
        keyCount: 14,
        dockerStatus: 'running',
        httpOk: true,
        pingMs: 45,
      };

      const payload = buildModelConsolePayload(status, 'Lael');
      expect(payload.embeds).toHaveLength(1);
      const embed = payload.embeds[0];
      expect(embed.color).toBe(0x2ecc71); // Green
      expect(embed.title).toContain('AI 모델 제어 콘솔');

      expect(payload.components).toHaveLength(3); // 3 ActionRows

      // Row 1: 3.1 & 3.5 Flash-Lite
      const row1Buttons = (payload.components[0] as { components: Array<Record<string, unknown>> }).components;
      expect(row1Buttons).toHaveLength(2);
      expect(row1Buttons[0].custom_id).toBe('model:3.1-flash-lite');
      expect(row1Buttons[0].style).toBe(2);
      expect(row1Buttons[1].custom_id).toBe('model:3.5-flash-lite');
      expect(row1Buttons[1].style).toBe(3); // Active
      expect(row1Buttons[1].label).toContain('[활성]');

      // Row 2: 3.5, 3.6, 3.7 Flash
      const row2Buttons = (payload.components[1] as { components: Array<Record<string, unknown>> }).components;
      expect(row2Buttons).toHaveLength(3);
      expect(row2Buttons[0].custom_id).toBe('model:3.5-flash');
      expect(row2Buttons[1].custom_id).toBe('model:3.6-flash');
      expect(row2Buttons[2].custom_id).toBe('model:3.7-flash');

      // Row 3: Utility (status, restart, close)
      const row3Buttons = (payload.components[2] as { components: Array<Record<string, unknown>> }).components;
      expect(row3Buttons).toHaveLength(3);
      expect(row3Buttons[0].custom_id).toBe('model:status');
      expect(row3Buttons[1].custom_id).toBe('model:restart');
      expect(row3Buttons[1].style).toBe(4); // Danger
      expect(row3Buttons[2].custom_id).toBe('model:close');
    });

    it('builds a purple payload when 3.7 flash is active', () => {
      const status: ModelStatus = {
        activeModel: 'gemini-3.7-flash',
        keyCount: 14,
        dockerStatus: 'running',
        httpOk: true,
        pingMs: 50,
      };

      const payload = buildModelConsolePayload(status);
      expect(payload.embeds[0].color).toBe(0x9b59b6); // Purple for thinking

      const row2Buttons = (payload.components[1] as { components: Array<Record<string, unknown>> }).components;
      expect(row2Buttons[2].style).toBe(3); // Active
      expect(row2Buttons[2].label).toContain('[활성]');
    });

    it('builds a red payload when httpOk is false', () => {
      const status: ModelStatus = {
        activeModel: 'gemini-3.5-flash-lite',
        keyCount: 14,
        dockerStatus: 'stopped',
        httpOk: false,
        pingMs: -1,
      };

      const payload = buildModelConsolePayload(status);
      expect(payload.embeds[0].color).toBe(0xe74c3c); // Red
    });

    it('includes lastActionMessage if present', () => {
      const status: ModelStatus = {
        activeModel: 'gemini-3.5-flash-lite',
        keyCount: 14,
        dockerStatus: 'running',
        httpOk: true,
        pingMs: 42,
        lastActionMessage: '모델 전환 성공',
      };

      const payload = buildModelConsolePayload(status);
      const fields = payload.embeds[0].fields as Array<{ name: string; value: string }>;
      const actionField = fields.find((f) => f.name.includes('작업 결과'));
      expect(actionField).toBeDefined();
      expect(actionField?.value).toBe('모델 전환 성공');
    });
  });

  describe('FLASH_FAILOVER_CHAIN (Zero-Degradation Policy)', () => {
    it('cascades from 3.7-flash to 3.6-flash', () => {
      expect(FLASH_FAILOVER_CHAIN['gemini-3.7-flash']).toBe('gemini-3.6-flash');
    });

    it('cascades from 3.6-flash to 3.5-flash', () => {
      expect(FLASH_FAILOVER_CHAIN['gemini-3.6-flash']).toBe('gemini-3.5-flash');
    });

    it('STRICT: halts at 3.5-flash and NEVER cascades to Lite models', () => {
      expect(FLASH_FAILOVER_CHAIN['gemini-3.5-flash']).toBeNull();
    });

    it('does not include Lite models in failover chain to protect code integrity', () => {
      expect(FLASH_FAILOVER_CHAIN['gemini-3.5-flash-lite']).toBeUndefined();
      expect(FLASH_FAILOVER_CHAIN['gemini-3.1-flash-lite']).toBeUndefined();
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
    it('defaults to the configured default channel ID', () => {
      expect(getActiveDiscordChannel()).toBe('1547919112523747328');
    });

    it('updates active channel when a valid channel ID is passed', () => {
      recordActiveDiscordChannel('999888777666555444');
      expect(getActiveDiscordChannel()).toBe('999888777666555444');
      // Reset back to default for test isolation
      recordActiveDiscordChannel('1547919112523747328');
    });

    it('ignores empty or short invalid channel IDs', () => {
      recordActiveDiscordChannel('');
      expect(getActiveDiscordChannel()).toBe('1547919112523747328');
      recordActiveDiscordChannel('123');
      expect(getActiveDiscordChannel()).toBe('1547919112523747328');
    });
  });

  describe('handleRateLimitDetected (Safety Stop Behavior)', () => {
    it('strictly triggers STOP when 3.5-flash hits 429 without downgrading to Lite', async () => {
      const result = await handleRateLimitDetected('gemini-3.5-flash', true);
      expect(result.action).toBe('stop');
      expect(result.from).toBe('gemini-3.5-flash');
      expect(result.to).toBeNull();
    });

    it('ignores and does not switch if current model is already a Lite model', async () => {
      const result = await handleRateLimitDetected('gemini-3.5-flash-lite', true);
      expect(result.action).toBe('ignored');
      expect(result.from).toBe('gemini-3.5-flash-lite');
    });
  });

  describe('Dynamic Key & Quota Scaling (No Hardcoded 14 Keys)', () => {
    it('dynamically formats quota for any key count via formatModelQuota', () => {
      const liteModel = SUPPORTED_MODELS['3.5-flash-lite'];
      const flashModel = SUPPORTED_MODELS['3.7-flash'];

      // 10 keys: 5,000 lite, 200 flash
      expect(formatModelQuota(liteModel, 10)).toBe('일 ~5,000회 (500회/키, 15 RPM)');
      expect(formatModelQuota(flashModel, 10)).toBe('일 200회 (20회/키, 5 RPM)');

      // 20 keys: 10,000 lite, 400 flash
      expect(formatModelQuota(liteModel, 20)).toBe('일 ~10,000회 (500회/키, 15 RPM)');
      expect(formatModelQuota(flashModel, 20)).toBe('일 400회 (20회/키, 5 RPM)');

      // 1 key: 500 lite, 20 flash
      expect(formatModelQuota(liteModel, 1)).toBe('일 ~500회 (500회/키, 15 RPM)');
      expect(formatModelQuota(flashModel, 1)).toBe('일 20회 (20회/키, 5 RPM)');
    });

    it('dynamically renders embed header and values according to keyCount in status', () => {
      const status20: ModelStatus = {
        activeModel: 'gemini-3.7-flash',
        keyCount: 20,
        dockerStatus: 'running',
        httpOk: true,
        pingMs: 30,
      };

      const payload20 = buildModelConsolePayload(status20);
      const fields = payload20.embeds[0].fields as Array<{ name: string; value: string }>;

      const guideField = fields.find((f) => f.name.includes('선택 가능한 5개 모델 안내'));
      expect(guideField?.name).toContain('(20개 키 풀 기준)');
      expect(guideField?.value).toContain('일 ~10,000회'); // 20 * 500
      expect(guideField?.value).toContain('일 400회'); // 20 * 20

      const keyField = fields.find((f) => f.name.includes('API Key 풀'));
      expect(keyField?.value).toContain('20개 키 가동');

      const activeField = fields.find((f) => f.name.includes('현재 활성 백엔드 모델'));
      expect(activeField?.value).toContain('일 400회 (20회/키, 5 RPM)');
    });
  });
});
