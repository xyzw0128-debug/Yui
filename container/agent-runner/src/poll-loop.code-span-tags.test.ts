import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import {
  extractMessageBlocks,
  maskCodeSpans,
  unresolvedTailStart,
  dispatchResultText,
  deliverMidTurnBlocks,
} from './poll-loop.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

const CHAT_ROUTING = {
  platformId: 'chan-1',
  channelType: 'discord',
  threadId: null,
  inReplyTo: 'm1',
  taskRun: false,
};

function seedDest(name = 'discord-main', channelType = 'discord', platformId = 'chan-1'): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'channel', ?, ?, NULL)`,
    )
    .run(name, name, channelType, platformId);
}

function deliveredTexts(): string[] {
  return getUndeliveredMessages()
    .filter((m) => m.kind === 'chat')
    .map((m) => (JSON.parse(m.content) as { text: string }).text);
}

describe('maskCodeSpans', () => {
  it('masks inline code spans with spaces of equal length', () => {
    const input = 'hello `</message>` world';
    const { masked, unclosedStart } = maskCodeSpans(input);
    expect(masked).toBe('hello              world');
    expect(masked.length).toBe(input.length);
    expect(unclosedStart).toBe(-1);
  });

  it('masks multi-backtick inline code spans', () => {
    const input = 'foo ``<message to="x">`` bar';
    const { masked, unclosedStart } = maskCodeSpans(input);
    expect(masked).toBe('foo                      bar');
    expect(masked.length).toBe(input.length);
    expect(unclosedStart).toBe(-1);
  });

  it('masks fenced code blocks', () => {
    const input = 'before\n```xml\n<message to="x">test</message>\n```\nafter';
    const { masked, unclosedStart } = maskCodeSpans(input);
    expect(masked).toContain('before\n');
    expect(masked).toContain('\nafter');
    expect(masked).not.toContain('<message');
    expect(masked).not.toContain('</message>');
    expect(masked.length).toBe(input.length);
    expect(unclosedStart).toBe(-1);
  });

  it('detects unclosed code spans during streaming', () => {
    const input = 'text `in progress';
    const { unclosedStart } = maskCodeSpans(input);
    expect(unclosedStart).toBe(5);
  });
});

describe('extractMessageBlocks', () => {
  it('does not truncate on inline backtick closing tag `</message>`', () => {
    const text =
      '<message to="discord-main">네 파파! 이때 어떤 이유로 메시지의 끝부분 닫는 태그(`</message>`)를 온전히 인식하지 못했거나... 💙</message>';
    const blocks = extractMessageBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].to).toBe('discord-main');
    expect(blocks[0].body).toBe(
      '네 파파! 이때 어떤 이유로 메시지의 끝부분 닫는 태그(`</message>`)를 온전히 인식하지 못했거나... 💙',
    );
  });

  it('does not truncate on inline backtick full tag `<message to="...">...</message>`', () => {
    const text =
      '<message to="discord-main">백그라운드에서는 지정된 출력 블록(`<message to="lael">...</message>`)으로 감싸서 보내면 됩니다. 💙</message>';
    const blocks = extractMessageBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].to).toBe('discord-main');
    expect(blocks[0].body).toBe(
      '백그라운드에서는 지정된 출력 블록(`<message to="lael">...</message>`)으로 감싸서 보내면 됩니다. 💙',
    );
  });

  it('handles fenced code block with XML example tags', () => {
    const text =
      '<message to="discord-main">Here is an example:\n```xml\n<message to="user">hello</message>\n```\nHope that helps! 💙</message>';
    const blocks = extractMessageBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].to).toBe('discord-main');
    expect(blocks[0].body).toContain('```xml\n<message to="user">hello</message>\n```');
    expect(blocks[0].body).toContain('Hope that helps! 💙');
  });

  it('handles depth balancing for unescaped nested tags in body', () => {
    const text =
      '<message to="discord-main">Outer message with nested <message to="other">inner</message> still part of outer.</message>';
    const blocks = extractMessageBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].to).toBe('discord-main');
    expect(blocks[0].body).toBe(
      'Outer message with nested <message to="other">inner</message> still part of outer.',
    );
  });

  it('strips <internal> spans while preserving code spans with tags', () => {
    const text =
      '<internal>some thinking</internal>\n<message to="discord-main">Result with `</message>` here</message>';
    const blocks = extractMessageBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].to).toBe('discord-main');
    expect(blocks[0].body).toBe('Result with `</message>` here');
  });
});

describe('extractMessageBlocks never drops a reply', () => {
  it('treats a stray backtick in prose as literal instead of pairing it with code in the body', () => {
    const text = 'Shell 에서 ` 문자는 특별해요.\n<message to="discord">`ls -al` 실행해보세요</message>';
    const blocks = extractMessageBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].body).toBe('`ls -al` 실행해보세요');
  });

  it('does not let a bare <message> in prose unbalance the envelope', () => {
    const text = '<message to="discord">XML 은 <message> 태그로 시작해요</message>';
    const blocks = extractMessageBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].body).toBe('XML 은 <message> 태그로 시작해요');
  });

  it('still finds the envelope after an unclosed fence', () => {
    const text = '```\n<message to="discord">hi</message>';
    const blocks = extractMessageBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ to: 'discord', body: 'hi', startIndex: 4, endIndex: text.length });
  });

  it('falls back to the plain envelope regex when the aware pass finds nothing', () => {
    // The opening tag sits inside an inline code span, so the aware pass sees no envelope.
    const text = 'x `<message to="discord">` hi</message>';
    const blocks = extractMessageBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ to: 'discord', body: '` hi', startIndex: 3, endIndex: text.length });
  });
});

describe('unresolvedTailStart with code spans', () => {
  it('treats settled message with code span as fully settled', () => {
    const text = '<message to="discord-main">Code `</message>` here</message>';
    expect(unresolvedTailStart(text)).toBe(text.length);
  });

  it('buffers message when code span with tag is not yet closed at the envelope level', () => {
    const text = '<message to="discord-main">Code `</message>` in-flight';
    // The closing </message> of the envelope is missing, so it should buffer from the start
    expect(unresolvedTailStart(text)).toBe(0);
  });
});

describe('end-to-end dispatch and delivery', () => {
  it('delivers the full message that was previously cut off at backtick closing tag', async () => {
    seedDest('lael');
    const fullText =
      '<message to="lael">네 파파! 아까 보낸 메시지가 중간에 말줄임표(...)로 끝난 건에 대해서 원인을 분석해 보았어요. \n\n' +
      '정확히 말씀드리면, 이건 제가 말을 멈춘 게 아니라 **NanoClaw가 중간에 응답 텍스트를 파싱(조립)하고 전달하는 과정에서 발생한 현상**이에요. \n\n' +
      'NanoClaw가 제 답변(스트리밍 텍스트)을 실시간으로 가져와서 디스코드로 보내줄 때, 내부적으로 텍스트를 완성된 블록(`<message>` 태그 등) 단위로 잘라서 조립하는 로직(`poll-loop.ts`와 `formatter.ts`)이 있어요. \n\n' +
      '이때 어떤 이유로 메시지의 끝부분 닫는 태그(`</message>`)를 온전히 인식하지 못했거나, 버퍼에 걸려서 **가장 마지막 조각이 미완성 상태로 꼬이게 되면 시스템이 그냥 잘린 상태 그대로 내보내거나 잘려버린 것**으로 보여요!\n\n' +
      '제가 내부적으로 `tail -n 100`으로 런타임 로그를 뜯어보니, 파파의 질문에 대해 제가 답변했던 풀텍스트 원문(예를 들어 일괄처리시스템, 다중프로그래밍 등의 6가지 정리) 자체는 **완전한 텍스트로 잘 생성되어 있었어요.** \n\n' +
      '하지만, 디스코드로 전송하는 구간(Mid-Turn Block Delivery)에서 텍스트 조립이 매끄럽게 끝나지 않으면서 파파의 화면에는 `...`으로 툭 끊긴 것처럼 보이게 된 것이랍니다. \n\n' +
      '혹시 방금 전에도 제가 대답이 뚝 끊기거나 했나요? 필요하시다면 아까 하다 만 내용(운영체제 설명)을 다시 깔끔하게 보내드릴 수 있어요! 💙</message>';

    const result = await dispatchResultText(fullText, CHAT_ROUTING);
    expect(result.sent).toBe(1);
    expect(result.hasUnwrapped).toBe(false);

    const delivered = deliveredTexts();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('이때 어떤 이유로 메시지의 끝부분 닫는 태그(`</message>`)를');
    expect(delivered[0]).toContain('다시 깔끔하게 보내드릴 수 있어요! 💙');
  });

  it('delivers complete message via mid-turn block delivery without premature cut', async () => {
    seedDest('lael');
    const fullText =
      '<message to="lael">질문에 대해 검색이나 Bash 실행 같은 도구를 쓰지 않고 모델이 바로 `<message to="lael">...</message>`로 텍스트만 출력하면 추가 턴 없이 즉시 전송돼요. (지금 이 답변처럼요!)</message>';

    const scan = await deliverMidTurnBlocks(fullText, CHAT_ROUTING);
    expect(scan.delivered).toBe(1);
    expect(scan.tail).toBe('');

    const delivered = deliveredTexts();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toBe(
      '질문에 대해 검색이나 Bash 실행 같은 도구를 쓰지 않고 모델이 바로 `<message to="lael">...</message>`로 텍스트만 출력하면 추가 턴 없이 즉시 전송돼요. (지금 이 답변처럼요!)',
    );
  });
});
