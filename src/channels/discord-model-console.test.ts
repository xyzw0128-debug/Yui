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
    it('builds a green payload when flash-lite is active and healthy', () => {
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

      const buttons = (payload.components[0] as { components: Array<Record<string, unknown>> }).components;
      expect(buttons).toHaveLength(4);

      // Button 1 (flash-lite) should be marked active with style 3 (Success)
      expect(buttons[0].custom_id).toBe('model:flash-lite');
      expect(buttons[0].style).toBe(3);
      expect(buttons[0].label).toContain('[활성]');

      // Button 2 (flash) should be style 2 (Secondary)
      expect(buttons[1].custom_id).toBe('model:flash');
      expect(buttons[1].style).toBe(2);

      // Button 3 (status) and 4 (restart)
      expect(buttons[2].custom_id).toBe('model:status');
      expect(buttons[3].custom_id).toBe('model:restart');
      expect(buttons[3].style).toBe(4); // Danger
    });

    it('builds an orange payload when flash is active', () => {
      const status: ModelStatus = {
        activeModel: 'gemini-3.5-flash',
        keyCount: 14,
        dockerStatus: 'running',
        httpOk: true,
        pingMs: 50,
      };

      const payload = buildModelConsolePayload(status);
      expect(payload.embeds[0].color).toBe(0xf39c12); // Orange

      const buttons = (payload.components[0] as { components: Array<Record<string, unknown>> }).components;
      // Button 1 (flash-lite) should be style 2
      expect(buttons[0].style).toBe(2);
      // Button 2 (flash) should be style 3
      expect(buttons[1].style).toBe(3);
      expect(buttons[1].label).toContain('[활성]');
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
