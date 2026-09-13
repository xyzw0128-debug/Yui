/**
 * Approval-card terminal rendering in the Chat SDK bridge.
 *
 * Drives the bridge's real onAction handler through the real Chat SDK
 * dispatch (`chat.processAction`): `bridge.setup()` registers the handler on
 * a real Chat instance, which the test captures from the webhook-server
 * registration (mocked so no HTTP server binds a port). After a button click,
 * the bridge must retain the approval body, remove the actions, and add a
 * muted resolution that identifies the actor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter, AdapterPostableMessage, Chat } from 'chat';

const captured = vi.hoisted(() => ({ chat: null as unknown }));

vi.mock('../webhook-server.js', () => ({
  registerWebhookAdapter: vi.fn((chat: unknown) => {
    captured.chat = chat;
  }),
}));

import { closeDb, initTestDb, runMigrations } from '../db/index.js';
import { createPendingApproval } from '../db/sessions.js';
import type { ChannelSetup } from './adapter.js';
import { createChatSdkBridge, handleForwardedEvent } from './chat-sdk-bridge.js';
import { registerQuestionRenderResolver } from './question-render-registry.js';

interface CapturedEdit {
  threadId: string;
  messageId: string;
  message: AdapterPostableMessage;
}

function makeAdapter(edits: CapturedEdit[]): Adapter {
  return {
    name: 'stub',
    initialize: async () => {},
    channelIdFromThreadId: (threadId: string) => `stub:${threadId}`,
    editMessage: async (threadId: string, messageId: string, message: AdapterPostableMessage) => {
      edits.push({ threadId, messageId, message });
    },
  } as unknown as Adapter;
}

function terminalText(edit: CapturedEdit): Array<{ type: string; content?: string; style?: string }> {
  const message = edit.message as {
    card: { children: Array<{ type: string; content?: string; style?: string }> };
  };
  return message.card.children;
}

async function fireAction(
  user: Record<string, unknown>,
  selectedOption = 'approve',
  actionId = `ncq:q-1:${selectedOption}`,
): Promise<{ edits: CapturedEdit[]; actions: string[] }> {
  const edits: CapturedEdit[] = [];
  const actions: string[] = [];
  const adapter = makeAdapter(edits);
  const bridge = createChatSdkBridge({ adapter, supportsThreads: false });

  await bridge.setup({
    onInbound: async () => {},
    onInboundEvent: async () => {},
    onMetadata: () => {},
    onAction: (questionId: string, selectedOption: string, userId: string) => {
      actions.push(`${questionId}:${selectedOption}:${userId}`);
    },
  } as ChannelSetup);

  const chat = captured.chat as Chat;
  expect(chat).toBeTruthy();
  await chat.processAction(
    {
      actionId,
      adapter,
      messageId: 'msg-1',
      raw: {},
      threadId: 'T-1',
      user: user as never,
      value: selectedOption,
    },
    undefined,
  );
  return { edits, actions };
}

beforeEach(async () => {
  captured.chat = null;
  const db = await initTestDb();
  await runMigrations(db);
  await createPendingApproval({
    approval_id: 'q-1',
    session_id: null,
    request_id: 'q-1',
    action: 'test_action',
    payload: '{}',
    created_at: new Date().toISOString(),
    title: 'Approval needed',
    question: 'Keep these full request details.',
    options_json: JSON.stringify([
      { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve', style: 'primary' },
      { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject', style: 'danger' },
    ]),
  });
});

afterEach(async () => {
  await closeDb();
});

describe('chat-sdk-bridge approval-card terminal state', () => {
  it('retains the body, removes actions, and shows the acting user', async () => {
    const { edits, actions } = await fireAction({ userId: 'U1', userName: 'alex', fullName: 'Alex C' });

    expect(edits).toHaveLength(1);
    expect(edits[0].threadId).toBe('T-1');
    expect(edits[0].messageId).toBe('msg-1');
    expect(terminalText(edits[0])).toEqual([
      { type: 'text', content: 'Keep these full request details.' },
      { type: 'text', content: '✅ Approved by alex', style: 'muted' },
    ]);
    expect(terminalText(edits[0]).some((child) => child.type === 'actions')).toBe(false);
    expect(actions).toEqual(['q-1:approve:U1']);
  });

  it('falls back to fullName when userName is missing', async () => {
    const { edits } = await fireAction({ userId: 'U2', fullName: 'Alex C' });

    expect(edits).toHaveLength(1);
    expect(terminalText(edits[0]).at(-1)?.content).toBe('✅ Approved by Alex C');
  });

  it('renders a rejected decision with the actor and original body', async () => {
    const { edits, actions } = await fireAction({ userId: 'U4', userName: 'reviewer' }, 'reject');

    expect(terminalText(edits[0])).toEqual([
      { type: 'text', content: 'Keep these full request details.' },
      { type: 'text', content: '❌ Rejected by reviewer', style: 'muted' },
    ]);
    expect(actions).toEqual(['q-1:reject:U4']);
  });

  it('omits the byline when the actor has no name', async () => {
    const { edits } = await fireAction({ userId: 'U3' });

    expect(edits).toHaveLength(1);
    expect(terminalText(edits[0]).at(-1)).toEqual({
      type: 'text',
      content: '✅ Approved',
      style: 'muted',
    });
  });

  it('resolves compact option indexes through a module resolver', async () => {
    registerQuestionRenderResolver((questionId) => {
      if (questionId !== 'module-compact-question') return undefined;
      return {
        title: 'Custom approval',
        options: [{ label: 'Approve', selectedLabel: 'Approved safely', value: 'approve-real-value' }],
      };
    });

    const { edits, actions } = await fireAction(
      { userId: 'U4', userName: 'reviewer' },
      '0',
      'ncq:module-compact-question:0',
    );

    const message = edits[0].message as { markdown: string };
    expect(message.markdown).toContain('Custom approval');
    expect(message.markdown).toContain('Approved safely by reviewer');
    expect(actions).toEqual(['module-compact-question:approve-real-value:U4']);
  });

  it('strips newline delimiter from actionId and value in chat.onAction', async () => {
    registerQuestionRenderResolver((questionId) => {
      if (questionId !== 'discord-newline-question') return undefined;
      return {
        title: 'Restart approval',
        options: [{ label: 'Approve', selectedLabel: 'Approved', value: 'approve' }],
      };
    });

    const { edits, actions } = await fireAction(
      { userId: 'U5', userName: 'admin' },
      '0\n0',
      'ncq:discord-newline-question:0\n0',
    );

    const message = edits[0].message as { markdown: string };
    expect(message.markdown).toContain('Restart approval');
    expect(message.markdown).toContain('Approved by admin');
    expect(actions).toEqual(['discord-newline-question:approve:U5']);
  });

  it('correctly resolves Discord gateway button interaction with newline delimiter in custom_id', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const dispatchedActions: string[] = [];

    const setupConfig: ChannelSetup = {
      onInbound: async () => {},
      onInboundEvent: async () => {},
      onMetadata: () => {},
      onAction: (questionId: string, selectedOption: string, userId: string) => {
        dispatchedActions.push(`${questionId}:${selectedOption}:${userId}`);
      },
    } as unknown as ChannelSetup;

    const gatewayPayload = JSON.stringify({
      type: 'GATEWAY_INTERACTION_CREATE',
      data: {
        type: 3,
        id: 'interaction-123',
        token: 'token-456',
        data: {
          custom_id: 'ncq:q-1:0\n0',
        },
        user: {
          id: 'user-lael',
          username: 'lael',
        },
        message: {
          embeds: [{ title: 'Approval needed', description: 'Keep these full request details.' }],
        },
      },
    });

    await handleForwardedEvent(gatewayPayload, {} as never, setupConfig);

    expect(dispatchedActions).toEqual(['q-1:approve:user-lael']);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://discord.com/api/v10/interactions/interaction-123/token-456/callback',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('✅ Approved by lael'),
      }),
    );
    fetchSpy.mockRestore();
  });
});
