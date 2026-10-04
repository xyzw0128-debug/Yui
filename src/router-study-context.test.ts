/**
 * Study RAG gating at the router: course material is only attached for
 * owners/admins (user_roles). Exercised through the REAL routeInbound path
 * with the permissions module loaded so sender ids resolve as in production.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from './db/index.js';
import { initChannelAdapters, registerChannelAdapter, teardownChannelAdapters } from './channels/channel-registry.js';
import { routeInbound } from './router.js';
import { grantRole } from './modules/permissions/db/user-roles.js';
import { upsertUser } from './modules/permissions/db/users.js';
import './modules/permissions/index.js';
import type { ChannelAdapter, ChannelDefaults } from './channels/adapter.js';
import type { MessagingGroupAgent } from './types.js';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-study-context' };
});

const attachStudyContext = vi.fn(async (_id: string, content: string) => content);
vi.mock('./modules/study-rag/index.js', () => ({
  attachStudyContext: (id: string, content: string) => attachStudyContext(id, content),
  isStudyRagActive: () => true,
  isStudyRagEnabled: () => true,
}));

const TEST_DIR = '/tmp/nanoclaw-test-study-context';

function now(): string {
  return new Date().toISOString();
}

const channelDefaults: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'public' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

function makeAdapter(): ChannelAdapter {
  return {
    name: 'testchat',
    channelType: 'testchat',
    supportsThreads: true,
    defaults: channelDefaults,
    setup: async () => {},
    teardown: async () => {},
    isConnected: () => true,
    deliver: async () => undefined,
  };
}

async function activate(): Promise<void> {
  registerChannelAdapter('testchat', { factory: () => makeAdapter(), defaults: channelDefaults });
  await initChannelAdapters(() => ({
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
}

async function seedWiring(options: {
  isGroup?: 0 | 1;
  engageMode?: MessagingGroupAgent['engage_mode'];
  engagePattern?: string | null;
  sessionMode?: 'shared' | 'per-thread';
  ignoredMessagePolicy?: 'drop' | 'accumulate';
}): Promise<void> {
  await createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'testchat',
    platform_id: 'testchat:C1',
    instance: 'testchat',
    name: 'Test Chat',
    is_group: options.isGroup ?? 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await createMessagingGroupAgent({
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: options.engageMode ?? 'pattern',
    engage_pattern: options.engagePattern === undefined ? '.' : options.engagePattern,
    sender_scope: 'all',
    ignored_message_policy: options.ignoredMessagePolicy ?? 'drop',
    session_mode: options.sessionMode ?? 'per-thread',
    priority: 0,
    threads: 1,
    created_at: now(),
  });
}

async function inbound(id: string, senderId: string, text: string): Promise<void> {
  await routeInbound({
    channelType: 'testchat',
    platformId: 'testchat:C1',
    threadId: null,
    message: {
      id,
      kind: 'chat-sdk',
      content: JSON.stringify({ sender: 'Alex', senderId, text }),
      timestamp: now(),
      isMention: true,
      isGroup: false,
    },
  });
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  attachStudyContext.mockClear();
});

afterEach(async () => {
  await teardownChannelAdapters();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('study context gating', () => {
  it('attaches study context for an owner but not for other senders', async () => {
    await activate();
    await seedWiring({ sessionMode: 'shared' });
    await upsertUser({ id: 'testchat:OWNER', kind: 'testchat', display_name: 'Owner', created_at: now() });
    await grantRole({
      user_id: 'testchat:OWNER',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });

    await inbound('m1', 'STRANGER', 'B+ 트리 분할이 뭐야?');
    expect(attachStudyContext).not.toHaveBeenCalled();

    await inbound('m2', 'OWNER', 'B+ 트리 분할이 뭐야?');
    expect(attachStudyContext).toHaveBeenCalledTimes(1);
    expect(attachStudyContext.mock.calls[0][0]).toBe('m2');
  });
});
