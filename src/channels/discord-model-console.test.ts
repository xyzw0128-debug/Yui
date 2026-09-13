import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isAuthorizedUser, buildModelConsolePayload, type ModelStatus } from './discord-model-console.js';

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
});
