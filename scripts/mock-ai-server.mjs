#!/usr/bin/env node
/**
 * Imitates the Anthropic and OpenAI APIs for tests, since real keys are not available in
 * CI. It follows the current docs closely, including SSE event order, and it is strict in
 * the same places they are, so a request the real service would refuse fails here too:
 *
 *   Anthropic  POST /v1/messages, GET /v1/models
 *   OpenAI     POST /v1/responses, POST /v1/chat/completions, GET /v1/models
 *   Control    GET /__mock/requests, POST /__mock/reset
 *
 * It is a stand-in for the wire formats. Passing against it does not show that the real
 * services behave this way.
 *
 * What a response does is set by a marker in the last user message, such as
 * `[mock:tool]`. See the `scenario` calls below. Run alone with `--port 8787`, or import
 * `startMockServer` from a test.
 */

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export const ANTHROPIC_KEY = 'sk-ant-mock-key';
export const OPENAI_KEY = 'sk-openai-mock-key';

const ANTHROPIC_VERSION = '2026-10-21';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const ANTHROPIC_MODELS = [
  { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', max_input_tokens: 1000000, max_tokens: 128000 },
  { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', max_input_tokens: 1000000, max_tokens: 128000 },
  { id: 'claude-opus-5', display_name: 'Claude Opus 5', max_input_tokens: 1000000, max_tokens: 128000 },
  { id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', max_input_tokens: 1000000, max_tokens: 128000 },
];
const OPENAI_MODELS = ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-5.6-terra', 'text-embedding-3-small', 'whisper-1'];

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function json(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Writes events, in pieces small enough that a client sees real chunk boundaries. */
class Sse {
  constructor(res, gapMs = 1) {
    this.res = res;
    this.gapMs = gapMs;
    this.closed = false;
    res.on('close', () => {
      this.closed = true;
    });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  }

  async write(text) {
    if (this.closed) return;
    // Split inside the text on purpose, including inside characters that take several bytes.
    const bytes = Buffer.from(text, 'utf8');
    const middle = Math.floor(bytes.length / 2);
    this.res.write(bytes.subarray(0, middle));
    await sleep(this.gapMs);
    if (this.closed) return;
    this.res.write(bytes.subarray(middle));
    await sleep(this.gapMs);
  }

  async event(name, data) {
    await this.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  async data(value) {
    await this.write(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`);
  }

  end() {
    if (!this.closed) this.res.end();
  }
}

/** The text pieces a stream sends, broken up the way real deltas are. */
function pieces(text, size = 7) {
  const chars = Array.from(text);
  const out = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''));
  return out;
}

function tokens(text) {
  return Math.ceil(text.length / 4);
}

function hash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 24);
}

/**
 * The first marker in some text: `[mock:name]`, `[mock:name=value]`, or for a value that
 * holds brackets, `[mock:name=value[/mock]`.
 */
function scenario(text) {
  const long = /\[mock:([a-z0-9-]+)=([\s\S]*?)\[\/mock\]/.exec(text);
  const match = long ?? /\[mock:([a-z0-9-]+)(?:=([^\]]*))?\]/.exec(text);
  return match ? { name: match[1], value: match[2] ?? '' } : { name: '', value: '' };
}

const LONG_TEXT = 'The rain came down over the Silver Vale all through that night, and the watchers on the wall said nothing to each other. '.repeat(40);

/** What a model "says", given what it was asked. Deterministic, so tests can check it. */
function answerFor(text) {
  const { name, value } = scenario(text);
  if (name === 'say' || name === 'wait') return value;
  if (name === 'slow') return LONG_TEXT;
  // A different answer for each version asked for, so they can be told apart.
  if (name === 'version') return `${value} Take ${/version (\d+) of \d+/i.exec(text)?.[1] ?? '?'}.`;
  const selection = /<selection[^>]*>\n?([\s\S]*?)\n?<\/selection>/.exec(text);
  const rewrite = /\[rewrite:([^\]|]*)\|([^\]]*)\]/.exec(text);
  if (selection && rewrite) return selection[1].split(rewrite[1]).join(rewrite[2]);
  const question = text.split('\n').pop() ?? '';
  return `This is a mock answer to: ${question.slice(0, 80)}`;
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

function anthropicError(res, status, type, message, headers) {
  json(res, status, { type: 'error', error: { type, message }, request_id: 'req_mock' }, headers);
}

function userText(message) {
  if (typeof message.content === 'string') return message.content;
  return (message.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') {
      const text = userText(messages[i]);
      if (text) return text;
    }
  }
  return '';
}

/**
 * A thinking block's signature records everything before it, so editing history breaks
 * it, as with the real API. `system` and `tools` are part of what is bound. A cache marker
 * is not, since moving one is allowed.
 */
function prefixSignature(body, messages, blocksBefore) {
  const withoutCache = (value) =>
    JSON.parse(JSON.stringify(value ?? null, (key, v) => (key === 'cache_control' ? undefined : v)));
  const tools = [...(body.tools ?? [])].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const prefix = JSON.stringify([withoutCache(body.system), withoutCache(tools), withoutCache(messages), withoutCache(blocksBefore)]);
  return `sig_${hash(prefix)}`;
}

function validateAnthropic(req, body) {
  const fail = (status, type, message) => ({ status, type, message });
  if (req.headers['anthropic-version'] !== ANTHROPIC_VERSION) {
    return fail(400, 'invalid_request_error', `anthropic-version: expected ${ANTHROPIC_VERSION}`);
  }
  for (const banned of ['temperature', 'top_p', 'top_k']) {
    if (body[banned] !== undefined) return fail(400, 'invalid_request_error', `${banned}: Extra inputs are not permitted`);
  }
  if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1) return fail(400, 'invalid_request_error', 'max_tokens: Field required');
  if (!Array.isArray(body.messages) || body.messages.length === 0) return fail(400, 'invalid_request_error', 'messages: at least one message is required');
  if (body.messages[0].role !== 'user') return fail(400, 'invalid_request_error', 'messages: first message must use the "user" role');

  const thinking = body.thinking;
  if (thinking?.type === 'disabled' || thinking?.type === 'enabled') {
    return fail(400, 'invalid_request_error', `"thinking.type.${thinking.type}" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.`);
  }
  if (thinking && thinking.type !== 'adaptive') return fail(400, 'invalid_request_error', 'thinking.type: unknown');
  if (thinking?.block_binding && !String(req.headers['anthropic-beta'] ?? '').includes('thinking-binding-controls')) {
    return fail(400, 'invalid_request_error', 'block_binding: Extra inputs are not permitted');
  }

  const choice = body.tool_choice?.type;
  if (choice === 'any' || choice === 'tool') {
    return fail(400, 'invalid_request_error', 'tool_choice: type "tool" and "any" are not supported for this model.');
  }
  for (const tool of body.tools ?? []) {
    if (!tool.name || !tool.input_schema) return fail(400, 'invalid_request_error', 'tools: name and input_schema are required');
  }

  if (body.fallbacks !== undefined) {
    const betas = String(req.headers['anthropic-beta'] ?? '');
    if (body.fallbacks === 'default' && !betas.includes(FALLBACK_BETA)) {
      return fail(400, 'invalid_request_error', `fallbacks: requires the ${FALLBACK_BETA} value in the anthropic-beta header`);
    }
    if (!['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-1'].includes(body.model)) {
      return fail(400, 'invalid_request_error', `fallbacks: not available for ${body.model}`);
    }
  }

  const format = body.output_config?.format;
  if (format) {
    if (format.type !== 'json_schema' || typeof format.schema !== 'object') {
      return fail(400, 'invalid_request_error', 'output_config.format: expected {type: "json_schema", schema}');
    }
    if (format.schema.type === 'object' && format.schema.additionalProperties !== false) {
      return fail(400, 'invalid_request_error', 'output_config.format.schema: additionalProperties must be false');
    }
  }
  const effort = body.output_config?.effort;
  if (effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
    return fail(400, 'invalid_request_error', 'output_config.effort: invalid value');
  }

  let markers = body.cache_control ? 1 : 0;
  JSON.stringify([body.system, body.tools, body.messages], (key, v) => {
    if (key === 'cache_control') markers += 1;
    return v;
  });
  if (markers > 4) return fail(400, 'invalid_request_error', 'A maximum of 4 blocks with cache_control may be provided.');

  // The conversation must be valid: no prefill, tools answered, text not empty.
  const messages = body.messages;
  const last = messages[messages.length - 1];
  const endsInServerTool = last.role === 'assistant' && (last.content ?? []).some((b) => b.type === 'server_tool_use');
  if (last.role === 'assistant' && !endsInServerTool) {
    return fail(400, 'invalid_request_error', 'This model does not support assistant message prefill. The conversation must end with a user message.');
  }
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type === 'text' && block.text === '') return fail(400, 'invalid_request_error', `messages.${i}: text content blocks must be non-empty`);
      if (block.type === 'image') {
        if (block.source?.type !== 'base64' || !block.source.media_type || !block.source.data) {
          return fail(400, 'invalid_request_error', `messages.${i}: image source must be base64 with a media_type`);
        }
      }
    }
    const uses = (Array.isArray(message.content) ? message.content : []).filter((b) => b.type === 'tool_use');
    if (uses.length > 0) {
      const next = messages[i + 1];
      const results = next?.role === 'user' && Array.isArray(next.content) ? next.content.filter((b) => b.type === 'tool_result') : [];
      for (const use of uses) {
        if (typeof use.input !== 'object' || use.input === null) return fail(400, 'invalid_request_error', `messages.${i}: tool_use.input must be an object`);
        if (!results.some((r) => r.tool_use_id === use.id)) {
          return fail(400, 'invalid_request_error', `messages.${i}: tool_use ids were found without tool_result blocks immediately after: ${use.id}`);
        }
      }
    }
  }

  // Preserved thinking: replayed blocks must match the conversation that made them.
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i].role !== 'assistant' || !Array.isArray(messages[i].content)) continue;
    for (let b = 0; b < messages[i].content.length; b += 1) {
      const block = messages[i].content[b];
      if (block.type !== 'thinking') continue;
      if (!String(block.signature ?? '').startsWith('sig_')) {
        return fail(400, 'invalid_request_error', `messages.${i}.content.${b}: Invalid \`signature\` in \`thinking\` block.`);
      }
      const expected = prefixSignature(body, messages.slice(0, i), messages[i].content.slice(0, b));
      if (block.signature !== expected) {
        return fail(400, 'invalid_request_error', `messages.${i}.content.${b}: Invalid \`signature\` in \`thinking\` block. The block is bound to a different conversation.`);
      }
    }
  }
  return null;
}

/** Streams one Anthropic response, block by block, in the documented order. */
async function streamAnthropicMessage(sse, body, plan, options = {}) {
  const usage = {
    input_tokens: options.inputTokens ?? 100,
    cache_creation_input_tokens: options.cacheWrite ?? 0,
    cache_read_input_tokens: options.cacheRead ?? 0,
    output_tokens: 1,
  };
  await sse.event('message_start', {
    type: 'message_start',
    message: {
      id: `msg_${hash(String(Math.random()))}`, type: 'message', role: 'assistant', content: [],
      model: options.model ?? body.model, stop_reason: null, stop_sequence: null, usage,
    },
  });
  await sse.event('ping', { type: 'ping' });

  const sent = [];
  let output = 0;
  let index = 0;
  for (const block of plan.blocks) {
    if (block.type === 'thinking') {
      await sse.event('content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      for (const piece of pieces(block.text)) {
        await sse.event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: piece } });
      }
      const signature = prefixSignature(body, body.messages, sent);
      await sse.event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature } });
      sent.push({ type: 'thinking', thinking: block.text, signature });
    } else if (block.type === 'text') {
      await sse.event('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      for (const piece of pieces(block.text, block.chunk ?? 7)) {
        if (sse.closed) return;
        await sse.event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } });
        if (block.pauseMs) await sleep(block.pauseMs);
      }
      sent.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool_use') {
      await sse.event('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
      const raw = block.rawInput ?? JSON.stringify(block.input);
      for (const piece of pieces(raw, 9)) {
        await sse.event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: piece } });
      }
      sent.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input ?? {} });
    } else {
      await sse.event('content_block_start', { type: 'content_block_start', index, content_block: block });
      sent.push(block);
    }
    await sse.event('content_block_stop', { type: 'content_block_stop', index });
    output += tokens(block.text ?? block.rawInput ?? 'block');
    index += 1;
  }
  await sse.event('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: plan.stopReason, stop_sequence: null, stop_details: plan.stopDetails ?? null },
    usage: { output_tokens: output, ...(plan.usageExtra ?? {}) },
  });
  await sse.event('message_stop', { type: 'message_stop' });
}

function planAnthropic(body, state) {
  const text = lastUserText(body.messages);
  const first = scenario(userText(body.messages[0]));
  // A repair prompt has no marker of its own, and belongs to the request that came first.
  const { name, value } = first.name === 'json' ? first : scenario(text);
  const thinking = { type: 'thinking', text: 'Considering what the author asked, and what the lore says.' };
  const hasResult = body.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));
  const toolAvailable = (tool) => (body.tools ?? []).some((t) => t.name === tool);

  switch (name) {
    case 'tool': {
      // A tool round: call search_lore, then answer using what came back.
      if (!hasResult && toolAvailable('search_lore')) {
        return {
          stopReason: 'tool_use',
          blocks: [
            thinking,
            { type: 'text', text: 'Let me check the lore.' },
            // Keys on purpose not in sorted order, to show if a client reorders them.
            { type: 'tool_use', id: 'toolu_mock1', name: 'search_lore', input: { query: value || 'Aria', limit: 5 } },
          ],
        };
      }
      const results = body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_result');
      const last = results[results.length - 1];
      const shown = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
      return {
        stopReason: 'end_turn',
        blocks: [thinking, { type: 'text', text: `The lore search said: ${shown.slice(0, 200)}` }],
      };
    }
    case 'invalid-json': {
      if (!hasResult) {
        return {
          stopReason: 'tool_use',
          blocks: [{ type: 'tool_use', id: 'toolu_bad', name: 'get_page', rawInput: '{"title":"Aria' }],
        };
      }
      const result = body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((b) => b.type === 'tool_result');
      const invalid = result?.is_error && String(result.content).includes('INVALID_JSON');
      return { stopReason: 'end_turn', blocks: [{ type: 'text', text: invalid ? 'I sent bad input and was told so.' : 'The bad input was not reported.' }] };
    }
    case 'refusal':
      return {
        stopReason: 'refusal',
        stopDetails: { type: 'refusal', category: 'cyber', explanation: 'This request falls under a restricted category.' },
        blocks: [],
      };
    case 'refusal-mid':
      return {
        stopReason: 'refusal',
        stopDetails: { type: 'refusal', category: null, explanation: null },
        blocks: [thinking, { type: 'text', text: 'I started writing this and then' }],
      };
    case 'fallback':
      return {
        stopReason: 'end_turn',
        model: 'claude-opus-5',
        usageExtra: {
          iterations: [
            { type: 'message', input_tokens: 100, output_tokens: 5 },
            { type: 'fallback_message', input_tokens: 100, output_tokens: 20 },
          ],
        },
        blocks: [
          thinking,
          { type: 'text', text: 'The first model wrote this, ' },
          { type: 'fallback', from: { model: body.model }, to: { model: 'claude-opus-5' } },
          { type: 'text', text: 'and the fallback model finished it.' },
        ],
      };
    case 'max-tokens':
      return { stopReason: 'max_tokens', blocks: [thinking, { type: 'text', text: value || 'This answer was cut' }] };
    case 'max-tokens-empty':
      return { stopReason: 'max_tokens', blocks: [thinking] };
    case 'max-tokens-tool':
      return {
        stopReason: 'max_tokens',
        blocks: [{ type: 'tool_use', id: 'toolu_cut', name: 'get_page', rawInput: '{"title":"Ar' }],
      };
    case 'pause': {
      // A paused turn ends in a server tool call and resumes from being sent back.
      const last = body.messages[body.messages.length - 1];
      if (last.role === 'assistant') return { stopReason: 'end_turn', blocks: [{ type: 'text', text: 'Resumed after the pause.' }] };
      return {
        stopReason: 'pause_turn',
        blocks: [{ type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'x' } }],
      };
    }
    case 'slow':
      return { stopReason: 'end_turn', blocks: [{ type: 'text', text: LONG_TEXT, chunk: 5, pauseMs: 12 }] };
    case 'json': {
      const attempt = (state.jsonAttempts = (state.jsonAttempts ?? 0) + 1);
      if (value === 'bad-first' && attempt === 1) return { stopReason: 'end_turn', blocks: [{ type: 'text', text: '{"answer": 1,}' }] };
      return { stopReason: 'end_turn', blocks: [{ type: 'text', text: JSON.stringify({ fields: [{ label: 'Home', value: 'The Silver Vale', kind: 'text' }] }) }] };
    }
    default:
      return { stopReason: 'end_turn', blocks: [thinking, { type: 'text', text: answerFor(text) }] };
  }
}

async function handleAnthropic(req, res, body, state) {
  const key = req.headers['x-api-key'];
  if (!key) return anthropicError(res, 401, 'authentication_error', 'x-api-key header is required');
  if (key !== ANTHROPIC_KEY) {
    // A hostile echo, to prove the app does not repeat a key it is sent back.
    return anthropicError(res, 401, 'authentication_error', `invalid x-api-key ${key}`);
  }
  if (!ANTHROPIC_MODELS.some((m) => m.id === body.model)) {
    return anthropicError(res, 404, 'not_found_error', `model: ${body.model}`);
  }
  const problem = validateAnthropic(req, body);
  if (problem) return anthropicError(res, problem.status, problem.type, problem.message);

  const text = lastUserText(body.messages);
  const { name } = scenario(text);
  // Failures that happen before any output. Each one happens once per test.
  if (name === 'overloaded-once' && !state.failedOnce) {
    state.failedOnce = true;
    return anthropicError(res, 529, 'overloaded_error', 'Overloaded', { 'retry-after': '0' });
  }
  if (name === 'rate-limit-once' && !state.failedOnce) {
    state.failedOnce = true;
    return anthropicError(res, 429, 'rate_limit_error', 'Too many requests', { 'retry-after': '1' });
  }
  if (name === 'too-long') return anthropicError(res, 400, 'invalid_request_error', 'prompt is too long: 1000001 tokens > 1000000 maximum');

  const sse = new Sse(res);
  if (name === 'sse-overloaded-once' && !state.failedOnce) {
    state.failedOnce = true;
    await sse.event('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
    sse.end();
    return undefined;
  }
  const plan = planAnthropic(body, state);
  // Caching, in outline: a marked prefix is written once and read after that.
  const marked = JSON.stringify(body).includes('cache_control');
  const prefixKey = hash(JSON.stringify(body.system ?? '') + JSON.stringify(body.tools ?? ''));
  const seen = state.cachePrefixes.has(prefixKey);
  if (marked) state.cachePrefixes.add(prefixKey);
  await streamAnthropicMessage(sse, body, plan, {
    model: plan.model,
    cacheWrite: marked && !seen ? 900 : 0,
    cacheRead: marked && seen ? 900 : 0,
  });
  sse.end();
  return undefined;
}

// ---------------------------------------------------------------------------
// OpenAI Responses
// ---------------------------------------------------------------------------

function openAiError(res, status, message, extra = {}, headers = {}) {
  json(res, status, { error: { message, type: 'invalid_request_error', param: null, code: null, ...extra } }, headers);
}

function inputText(item) {
  if (typeof item.content === 'string') return item.content;
  return (item.content ?? []).filter((p) => p.type === 'input_text' || p.type === 'text').map((p) => p.text).join('\n');
}

function validateResponses(body) {
  const known = new Set([
    'model', 'stream', 'store', 'instructions', 'input', 'max_output_tokens', 'reasoning', 'include', 'tools',
    'tool_choice', 'text', 'prompt_cache_key', 'parallel_tool_calls',
  ]);
  for (const key of Object.keys(body)) {
    if (!known.has(key)) return { message: `Unknown parameter: '${key}'.`, param: key, code: 'unknown_parameter' };
  }
  if (!Array.isArray(body.input)) return { message: "Invalid type for 'input'.", param: 'input' };
  if (body.reasoning?.effort && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(body.reasoning.effort)) {
    return { message: "Invalid value for 'reasoning.effort'.", param: 'reasoning.effort' };
  }

  const calls = new Set();
  for (let i = 0; i < body.input.length; i += 1) {
    const item = body.input[i];
    if (item.type === 'reasoning') {
      // Stateless requests need the encrypted form, and a reasoning item needs what followed it.
      if (body.store === false && !item.encrypted_content) {
        return { message: `Item '${item.id}' of type 'reasoning' was not found. Items are not persisted when \`store\` is set to false.`, param: `input[${i}]` };
      }
      const next = body.input[i + 1];
      if (!next || next.type === 'reasoning' || next.role === 'user') {
        return { message: `Item '${item.id}' of type 'reasoning' was provided without its required following item.`, param: `input[${i}]` };
      }
    }
    if (item.type === 'function_call') {
      if (typeof item.arguments !== 'string') return { message: 'function_call arguments must be a string.', param: `input[${i}].arguments` };
      calls.add(item.call_id);
    }
    if (item.type === 'function_call_output' && !calls.has(item.call_id)) {
      return { message: `No tool call found for function call output with call_id ${item.call_id}.`, param: `input[${i}]` };
    }
    if (item.role === 'user' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part.type === 'input_image' && !/^data:image\/[\w.+-]+;base64,/.test(part.image_url ?? '')) {
          return { message: 'input_image must have a data URL.', param: `input[${i}]` };
        }
      }
    }
  }
  for (const call of calls) {
    if (!body.input.some((item) => item.type === 'function_call_output' && item.call_id === call)) {
      return { message: `No tool output found for function call ${call}.`, param: 'input' };
    }
  }
  const format = body.text?.format;
  if (format && (format.type !== 'json_schema' || !format.name || !format.schema)) {
    return { message: "Missing required parameter: 'text.format.name'.", param: 'text.format' };
  }
  return null;
}

async function handleResponses(req, res, body, state) {
  const auth = req.headers.authorization ?? '';
  if (auth !== `Bearer ${OPENAI_KEY}`) {
    return openAiError(res, 401, `Incorrect API key provided: ${auth.replace('Bearer ', '')}.`, { type: 'invalid_request_error', code: 'invalid_api_key' });
  }
  if (!OPENAI_MODELS.includes(body.model)) {
    return openAiError(res, 404, `The model \`${body.model}\` does not exist or you do not have access to it.`, { code: 'model_not_found' });
  }
  const problem = validateResponses(body);
  if (problem) return openAiError(res, 400, problem.message, problem);

  const lastUser = [...body.input].reverse().find((item) => item.role === 'user');
  const text = lastUser ? inputText(lastUser) : '';
  const { name, value } = scenario(text);

  if (name === 'summary-unverified' && body.reasoning?.summary) {
    return openAiError(res, 400, 'Your organization must be verified to generate reasoning summaries.', { param: 'reasoning.summary', code: 'unsupported_value' });
  }
  if (name === 'rate-limit-once' && !state.failedOnce) {
    state.failedOnce = true;
    return openAiError(res, 429, 'Rate limit reached.', { code: 'rate_limit_exceeded', type: 'requests' }, { 'retry-after': '1' });
  }
  if (name === 'quota') return openAiError(res, 429, 'You exceeded your current quota.', { code: 'insufficient_quota', type: 'insufficient_quota' });
  if (name === 'too-long') return openAiError(res, 400, 'Your input exceeds the context window of this model.', { code: 'context_length_exceeded' });

  const sse = new Sse(res);
  let sequence = 0;
  const send = (type, data) => sse.event(type, { type, sequence_number: (sequence += 1), ...data });
  const id = `resp_${hash(String(Math.random()))}`;
  const shell = { id, object: 'response', model: body.model, status: 'in_progress', output: [], usage: null };
  await send('response.created', { response: shell });
  await send('response.in_progress', { response: shell });

  const output = [];
  let index = 0;

  const emitReasoning = async () => {
    if (!body.reasoning) return;
    const itemId = `rs_${hash(String(Math.random()))}`;
    const summaryText = 'Considering what the author asked.';
    await send('response.output_item.added', { output_index: index, item: { id: itemId, type: 'reasoning', summary: [] } });
    if (body.reasoning.summary) {
      await send('response.reasoning_summary_part.added', { item_id: itemId, output_index: index, summary_index: 0, part: { type: 'summary_text', text: '' } });
      for (const piece of pieces(summaryText)) {
        await send('response.reasoning_summary_text.delta', { item_id: itemId, output_index: index, summary_index: 0, delta: piece });
      }
      await send('response.reasoning_summary_text.done', { item_id: itemId, output_index: index, summary_index: 0, text: summaryText });
      await send('response.reasoning_summary_part.done', { item_id: itemId, output_index: index, summary_index: 0, part: { type: 'summary_text', text: summaryText } });
    }
    const item = {
      id: itemId, type: 'reasoning', status: 'completed',
      summary: body.reasoning.summary ? [{ type: 'summary_text', text: summaryText }] : [],
      encrypted_content: `enc_${hash(itemId)}`,
    };
    await send('response.output_item.done', { output_index: index, item });
    output.push(item);
    index += 1;
  };

  const emitMessage = async (words, phase, pauseMs = 0, chunk = 7) => {
    const itemId = `msg_${hash(String(Math.random()))}`;
    await send('response.output_item.added', { output_index: index, item: { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', phase, content: [] } });
    await send('response.content_part.added', { item_id: itemId, output_index: index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    for (const piece of pieces(words, chunk)) {
      if (sse.closed) return;
      await send('response.output_text.delta', { item_id: itemId, output_index: index, content_index: 0, delta: piece });
      if (pauseMs) await sleep(pauseMs);
    }
    await send('response.output_text.done', { item_id: itemId, output_index: index, content_index: 0, text: words });
    await send('response.content_part.done', { item_id: itemId, output_index: index, content_index: 0, part: { type: 'output_text', text: words, annotations: [] } });
    const item = { id: itemId, type: 'message', role: 'assistant', status: 'completed', phase, content: [{ type: 'output_text', text: words, annotations: [] }] };
    await send('response.output_item.done', { output_index: index, item });
    output.push(item);
    index += 1;
  };

  const emitCall = async (name_, argumentsText) => {
    const itemId = `fc_${hash(String(Math.random()))}`;
    const callId = `call_${hash(String(Math.random()))}`;
    await send('response.output_item.added', { output_index: index, item: { id: itemId, type: 'function_call', call_id: callId, name: name_, arguments: '', status: 'in_progress' } });
    for (const piece of pieces(argumentsText, 9)) {
      await send('response.function_call_arguments.delta', { item_id: itemId, output_index: index, delta: piece });
    }
    await send('response.function_call_arguments.done', { item_id: itemId, output_index: index, arguments: argumentsText, name: name_ });
    const item = { id: itemId, type: 'function_call', call_id: callId, name: name_, arguments: argumentsText, status: 'completed' };
    await send('response.output_item.done', { output_index: index, item });
    output.push(item);
    index += 1;
  };

  const usage = {
    input_tokens: 120, input_tokens_details: { cached_tokens: state.cacheSeen ? 80 : 0, cache_write_tokens: 0 },
    output_tokens: 40, output_tokens_details: { reasoning_tokens: 12 }, total_tokens: 160,
  };
  state.cacheSeen = true;
  const complete = async () => {
    await send('response.completed', { response: { ...shell, status: 'completed', output, usage } });
    sse.end();
  };

  const hasResult = body.input.some((item) => item.type === 'function_call_output');
  switch (name) {
    case 'tool':
      if (!hasResult && (body.tools ?? []).some((t) => t.name === 'search_lore')) {
        await emitReasoning();
        await emitMessage('Let me check the lore.', 'commentary');
        await emitCall('search_lore', JSON.stringify({ query: value || 'Aria', limit: 5 }));
      } else {
        const result = body.input.filter((item) => item.type === 'function_call_output').pop();
        await emitReasoning();
        await emitMessage(`The lore search said: ${String(result?.output ?? '').slice(0, 200)}`, 'final_answer');
      }
      return complete();
    case 'refusal': {
      const itemId = 'msg_refused';
      await send('response.output_item.added', { output_index: 0, item: { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] } });
      for (const piece of pieces('I cannot help with that request.')) {
        await send('response.refusal.delta', { item_id: itemId, output_index: 0, content_index: 0, delta: piece });
      }
      await send('response.refusal.done', { item_id: itemId, output_index: 0, content_index: 0, refusal: 'I cannot help with that request.' });
      output.push({ id: itemId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'I cannot help with that request.' }] });
      return complete();
    }
    case 'max-tokens':
      await emitReasoning();
      await emitMessage(value || 'This answer was cut', 'final_answer');
      await send('response.incomplete', { response: { ...shell, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output, usage } });
      sse.end();
      return undefined;
    case 'failed':
      await send('response.failed', { response: { ...shell, status: 'failed', error: { code: 'server_error', message: 'The server had an error.' }, output: [] } });
      sse.end();
      return undefined;
    case 'slow':
      await emitMessage(LONG_TEXT, 'final_answer', 12, 5);
      return complete();
    default:
      await emitReasoning();
      await emitMessage(answerFor(text), 'final_answer');
      return complete();
  }
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions, for OpenAI-compatible profiles
// ---------------------------------------------------------------------------

async function handleChat(req, res, body) {
  const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user');
  const text = typeof lastUser?.content === 'string'
    ? lastUser.content
    : (lastUser?.content ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  const { name, value } = scenario(text);
  if (body.max_completion_tokens && body.max_tokens) return openAiError(res, 400, 'Setting both is not allowed.');
  if (body.response_format && name === 'no-format') {
    return openAiError(res, 400, 'this response_format requires constrained output', { code: 'response_format_not_supported', param: 'response_format' });
  }
  const sse = new Sse(res);
  // Time for something else to happen while the model is thinking.
  if (name === 'wait') await sleep(1500);
  // A model that never answers, until the app gives up on it.
  if (name === 'hang') return new Promise((resolve) => { res.on('close', () => resolve(undefined)); });
  const chunk = (delta, finish = null) => ({
    id: 'chatcmpl-mock', object: 'chat.completion.chunk', model: body.model, created: 1,
    choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }], usage: null,
  });
  await sse.data(chunk({ role: 'assistant', content: '' }));
  for (const piece of pieces('Thinking it through.')) await sse.data(chunk({ reasoning_content: piece }));
  const hasResult = (body.messages ?? []).some((m) => m.role === 'tool');
  if (name === 'tool' && !hasResult && (body.tools ?? []).length > 0) {
    await sse.data(chunk({ tool_calls: [{ index: 0, id: 'call_mock', type: 'function', function: { name: 'search_lore', arguments: '' } }] }));
    for (const piece of pieces(JSON.stringify({ query: value || 'Aria' }), 5)) {
      await sse.data(chunk({ tool_calls: [{ index: 0, function: { arguments: piece } }] }));
    }
    await sse.data(chunk({}, 'tool_calls'));
  } else {
    const result = (body.messages ?? []).filter((m) => m.role === 'tool').pop();
    const words = name === 'tool' ? `The lore search said: ${String(result?.content ?? '').slice(0, 200)}` : answerFor(text);
    for (const piece of pieces(words)) await sse.data(chunk({ content: piece }));
    await sse.data(chunk({}, 'stop'));
  }
  await sse.data({ id: 'chatcmpl-mock', choices: [], usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70, completion_tokens_details: { reasoning_tokens: 5 } } });
  await sse.data('[DONE]');
  sse.end();
  return undefined;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function freshState() {
  return { failedOnce: false, cachePrefixes: new Set(), jsonAttempts: 0, cacheSeen: false };
}

/** Starts a server. Returns its address, what it has received, and how to stop it. */
export function startMockServer({ port = 0, host = '127.0.0.1' } = {}) {
  const requests = [];
  let state = freshState();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    const path = url.pathname;
    const text = req.method === 'POST' ? await readBody(req) : '';
    if (path === '/__mock/requests') return json(res, 200, requests);
    if (path === '/__mock/reset') {
      requests.length = 0;
      state = freshState();
      return json(res, 200, { ok: true });
    }
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        return json(res, 400, { error: { message: 'Invalid JSON.' } });
      }
    }
    requests.push({ method: req.method, path, query: url.search, headers: req.headers, body });
    try {
      if (req.method === 'GET' && path === '/v1/models') {
        if (req.headers['anthropic-version'] !== undefined) {
          if (req.headers['x-api-key'] !== ANTHROPIC_KEY) return anthropicError(res, 401, 'authentication_error', 'invalid x-api-key');
          const limit = Number(url.searchParams.get('limit') ?? 20);
          const after = url.searchParams.get('after_id');
          const start = after ? ANTHROPIC_MODELS.findIndex((m) => m.id === after) + 1 : 0;
          const page = ANTHROPIC_MODELS.slice(start, start + Math.min(limit, 2));
          return json(res, 200, {
            data: page.map((m) => ({ type: 'model', created_at: '2026-01-01T00:00:00Z', capabilities: {}, ...m })),
            has_more: start + page.length < ANTHROPIC_MODELS.length,
            first_id: page[0]?.id ?? null,
            last_id: page[page.length - 1]?.id ?? null,
          });
        }
        if (req.headers.authorization && req.headers.authorization !== `Bearer ${OPENAI_KEY}`) {
          return openAiError(res, 401, 'Incorrect API key provided.', { code: 'invalid_api_key' });
        }
        return json(res, 200, { object: 'list', data: OPENAI_MODELS.map((id) => ({ id, object: 'model', created: 1, owned_by: 'mock' })) });
      }
      if (req.method === 'POST' && path === '/v1/messages') return await handleAnthropic(req, res, body, state);
      if (req.method === 'POST' && path === '/v1/responses') return await handleResponses(req, res, body, state);
      if (req.method === 'POST' && path === '/v1/chat/completions') return await handleChat(req, res, body);
    } catch (e) {
      if (!res.headersSent) return json(res, 500, { error: { message: String(e) } });
      res.end();
      return undefined;
    }
    return json(res, 404, { error: { message: `No route for ${req.method} ${path}` } });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve({
        url: `http://${host}:${address.port}`,
        port: address.port,
        requests,
        close: () => new Promise((done) => {
          server.closeAllConnections?.();
          server.close(() => done());
        }),
      });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const at = process.argv.indexOf('--port');
  const port = at >= 0 ? Number(process.argv[at + 1]) : 8787;
  const started = await startMockServer({ port });
  console.log(`Mock AI server on ${started.url}`);
}
