import { answerOpenCalls, prepareHistory } from './history';
import type { AiMessage, ContentBlock, StoredMessage } from './types';

let id = 0;
function stored(role: 'user' | 'assistant', content: ContentBlock[]): StoredMessage {
  id += 1;
  return { id: String(id), conversationId: 'c', role, content, profileId: null, model: null, inputTokens: null, outputTokens: null, createdAt: '' };
}

const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const thinking: ContentBlock = { type: 'thinking', text: 't', provider: 'anthropic', raw: { type: 'thinking', thinking: 't', signature: 'S' } };

describe('prepareHistory', () => {
  it('leaves history exactly as stored when it fits', () => {
    const list = [
      stored('user', [text('one')]),
      stored('assistant', [thinking, text('two')]),
      stored('user', [text('three')]),
    ];
    const { messages, trimmed } = prepareHistory(list, 10_000);
    expect(trimmed).toBe(false);
    expect(messages.map((m) => m.content)).toEqual(list.map((m) => m.content));
    // The very same objects, so nothing can have drifted.
    expect(messages[1].content).toBe(list[1].content);
  });

  it('drops a refused response, and any turn with no output', () => {
    const { messages } = prepareHistory(
      [
        stored('user', [text('one')]),
        stored('assistant', [{ type: 'status', stopReason: 'refusal', discarded: 'half an answer' }]),
        stored('user', [text('two')]),
        stored('assistant', [thinking, { type: 'status', stopReason: 'max_tokens' }]),
        stored('user', [text('three')]),
      ],
      10_000,
    );
    expect(messages.map((m) => m.role)).toEqual(['user', 'user', 'user']);
  });

  it('keeps a cancelled response\'s text', () => {
    const { messages } = prepareHistory(
      [stored('user', [text('one')]), stored('assistant', [text('half a'), { type: 'status', stopReason: 'cancelled' }]), stored('user', [text('go on')])],
      10_000,
    );
    expect(messages).toHaveLength(3);
  });

  it('removes the oldest whole turns to fit, and all thinking with them', () => {
    const big = 'word '.repeat(2000);
    const list = [
      stored('user', [text(big)]),
      stored('assistant', [thinking, { type: 'toolCall', id: 'a', name: 'get_page', input: {} }]),
      stored('user', [{ type: 'toolResult', toolCallId: 'a', content: 'result' }]),
      stored('assistant', [text('first answer')]),
      stored('user', [text('second question')]),
      stored('assistant', [thinking, text('second answer')]),
      stored('user', [text('third question')]),
    ];
    const { messages, trimmed, tokens } = prepareHistory(list, 200);
    expect(trimmed).toBe(true);
    expect(tokens).toBeLessThanOrEqual(200);
    // It starts at a real question, so no tool result is left without its call.
    expect(messages[0].content[0]).toEqual(text('second question'));
    expect(messages.flatMap((m) => m.content).some((b) => b.type === 'thinking')).toBe(false);
    expect(messages[messages.length - 1].content[0]).toEqual(text('third question'));
  });

  it('never removes the newest turn, even if it is too long alone', () => {
    const { messages } = prepareHistory([stored('user', [text('word '.repeat(5000))])], 10);
    expect(messages).toHaveLength(1);
  });
});

describe('answerOpenCalls', () => {
  const call = (callId: string): ContentBlock => ({ type: 'toolCall', id: callId, name: 'get_page', input: {} });

  it('answers a call left open, so the next request is valid', () => {
    const list: AiMessage[] = [
      { role: 'user', content: [text('q')] },
      { role: 'assistant', content: [call('a')] },
      { role: 'user', content: [text('never mind')] },
    ];
    const out = answerOpenCalls(list);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'user']);
    expect(out[2].content[0]).toMatchObject({ type: 'toolResult', toolCallId: 'a', isError: true });
    expect(out[3].content[0]).toEqual(text('never mind'));
  });

  it('answers only the calls that have no result', () => {
    const list: AiMessage[] = [
      { role: 'assistant', content: [call('a'), call('b')] },
      { role: 'user', content: [{ type: 'toolResult', toolCallId: 'b', content: 'ok' }] },
    ];
    const out = answerOpenCalls(list);
    expect(out).toHaveLength(2);
    expect(out[1].content.map((b) => (b as { toolCallId: string }).toolCallId)).toEqual(['a', 'b']);
  });

  it('answers a call at the very end', () => {
    const out = answerOpenCalls([{ role: 'assistant', content: [call('a')] }]);
    expect(out).toHaveLength(2);
  });

  it('changes nothing when every call has its result', () => {
    const list: AiMessage[] = [
      { role: 'assistant', content: [call('a')] },
      { role: 'user', content: [{ type: 'toolResult', toolCallId: 'a', content: 'ok' }] },
    ];
    expect(answerOpenCalls(list)).toEqual(list);
  });
});
