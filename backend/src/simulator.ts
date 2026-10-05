import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface GenerationOptions {
  endpoint: string;
  modelId: string;
  inputTokens: number;
  maxOutputTokens?: number;
  requestHash: string;
  userInput?: string;
}
export interface GenerationReceipt {
  requestId: string;
  createdAt: number;
  modelId: string;
  replyText: string;
  replyId?: string | null;
  replyIndex?: number;
  replyTotal?: number;
  ruleId?: string;
  streamChunkChars: number;
  streamDelayMs: number;
  inputTokens: number;
}
export interface SimulatorServices {
  models(request: FastifyRequest): Promise<Array<{ id: string; displayName?: string; coinsPerCall?: number }>>;
  authenticate(request: FastifyRequest): Promise<unknown>;
  accept(request: FastifyRequest, options: GenerationOptions): Promise<GenerationReceipt>;
  health?(): Promise<unknown>;
  onEnd?(requestId: string, status: 'completed' | 'disconnected'): Promise<unknown>;
}
type Body = Record<string, any>;
type Wire = 'chat' | 'completion' | 'responses' | 'anthropic';

// Match only user-authored text. Image, tool and system content never becomes a rule input.
function lastUserText(body: Body, wire: Wire): string | undefined {
  const textContent = (value: unknown, blockType: string): string | undefined => {
    if (typeof value === 'string') return value.trim();
    if (!Array.isArray(value)) return undefined;
    const texts = value.filter(part => part && part.type === blockType && typeof part.text === 'string').map(part => part.text);
    return texts.length ? texts.join('').trim() : undefined;
  };
  if (wire === 'completion') {
    return typeof body.prompt === 'string' ? body.prompt.trim()
      : Array.isArray(body.prompt) && typeof body.prompt[0] === 'string' ? body.prompt[0].trim() : undefined;
  }
  if (wire === 'responses') {
    if (typeof body.input === 'string') return body.input.trim();
    const item = [...body.input].reverse().find(item => item.role === 'user');
    return item ? textContent(item.content, 'input_text') : undefined;
  }
  const message = [...body.messages].reverse().find(item => item.role === 'user');
  return message ? textContent(message.content, 'text') : undefined;
}

// This is deliberately an estimate. The service bills by request, never by token.
export function estimateTokens(value: unknown): number {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const chinese = text.match(/[\u3400-\u9fff]/gu)?.length ?? 0;
  return Math.max(0, chinese + Math.ceil((Array.from(text).length - chinese) / 4));
}
export function limitText(text: string, limit?: number): string {
  if (limit === undefined || estimateTokens(text) <= limit) return text;
  const points = Array.from(text);
  let low = 0;
  let high = points.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(points.slice(0, mid).join('')) <= limit) low = mid;
    else high = mid - 1;
  }
  return points.slice(0, low).join('');
}
export function hashPayload(value: unknown): string {
  function stable(input: any): any {
    if (Array.isArray(input)) return input.map(stable);
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.keys(input).sort().map(key => [key, stable(input[key])]));
    }
    return input;
  }
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}
function invalid(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 400, code: 'invalid_request_error' });
}
function validate(request: FastifyRequest, wire: Wire): { body: Body; max?: number } {
  const body = request.body as Body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('A JSON object is required.');
  if (typeof body.model !== 'string' || !body.model.trim()) invalid('model is required.');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') invalid('stream must be a boolean.');
  if (body.n !== undefined && body.n !== 1) invalid('Only n=1 is supported by this simulator.');
  if (body.background === true) invalid('Background generation is not supported.');
  if (wire === 'chat' || wire === 'anthropic') {
    if (!Array.isArray(body.messages) || body.messages.length === 0) invalid('messages must be a nonempty array.');
    for (const message of body.messages) {
      if (!message || typeof message !== 'object' || typeof message.role !== 'string') invalid('Invalid message.');
      const roles = wire === 'anthropic' ? ['user', 'assistant'] : ['system', 'developer', 'user', 'assistant', 'tool', 'function'];
      if (!roles.includes(message.role)) invalid('Unsupported message role.');
      const content = message.content;
      const hasToolCalls = wire === 'chat' && message.role === 'assistant' && (Array.isArray(message.tool_calls) || message.function_call);
      if (typeof content !== 'string' && !Array.isArray(content) && !hasToolCalls) invalid('Message content must be text or an array.');
      if (Array.isArray(content) && content.some(part => !part || typeof part !== 'object' || typeof part.type !== 'string')) invalid('Invalid message content block.');
    }
  }
  if (wire === 'completion') {
    const prompt = body.prompt;
    const validPrompt = typeof prompt === 'string' || (Array.isArray(prompt) && prompt.length > 0 && (
      prompt.every(item => typeof item === 'string') || prompt.every(item => Number.isSafeInteger(item) && item >= 0)
      || prompt.every(item => Array.isArray(item) && item.every(token => Number.isSafeInteger(token) && token >= 0))
    ));
    if (!validPrompt) invalid('prompt must be text or a valid token array.');
  }
  if (wire === 'responses' && body.input === undefined) invalid('input is required.');
  if (wire === 'responses' && typeof body.input !== 'string' && !Array.isArray(body.input)) invalid('input must be text or an array.');
  if (wire === 'responses' && Array.isArray(body.input) && (!body.input.length || body.input.some((item: any) => !item || typeof item !== 'object'))) invalid('input must contain valid input items.');
  const format = body.response_format?.type ?? body.text?.format?.type;
  if (format && format !== 'text') invalid('Only fixed plain-text responses are supported.');
  const max = body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens;
  if (max !== undefined && (!Number.isSafeInteger(max) || max < 1 || max > 1_000_000)) invalid('max_tokens must be a positive integer no greater than 1000000.');
  if (wire === 'anthropic' && max === undefined) invalid('max_tokens is required.');
  return { body, max };
}
function errorReply(reply: FastifyReply, error: any, wire: Wire) {
  const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  const message = status >= 500 ? 'The simulator could not accept this request.' : error.message;
  const code = status === 401 ? 'authentication_error' : status === 403 ? 'permission_error'
    : status === 404 ? 'not_found_error' : status === 429 ? 'rate_limit_error'
    : status >= 500 ? 'api_error' : (error.code ?? 'invalid_request_error');
  if (wire === 'anthropic') return reply.code(status).send({ type: 'error', error: { type: code, message } });
  return reply.code(status).send({ error: { message, type: code, param: null, code: error.code ?? code } });
}
function openaiUsage(input: number, text: string) {
  const output = estimateTokens(text);
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}
function responseObject(r: GenerationReceipt, text: string, truncated: boolean) {
  const output = estimateTokens(text);
  return {
    id: 'resp_' + r.requestId, object: 'response', created_at: r.createdAt,
    status: truncated ? 'incomplete' : 'completed', error: null,
    incomplete_details: truncated ? { reason: 'max_output_tokens' } : null,
    instructions: null, max_output_tokens: null, model: r.modelId,
    output: [{
      id: 'msg_' + r.requestId, type: 'message', status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
    }],
    parallel_tool_calls: false, previous_response_id: null, reasoning: { effort: null, summary: null },
    store: false, temperature: 1, text: { format: { type: 'text' } }, tool_choice: 'none', tools: [],
    top_p: 1, truncation: 'disabled', usage: {
      input_tokens: r.inputTokens, input_tokens_details: { cached_tokens: 0 },
      output_tokens: output, output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: r.inputTokens + output,
    }, metadata: {},
  };
}
function chunks(text: string, size: number): string[] {
  const points = Array.from(text);
  const length = Math.max(1, Math.min(1024, size || 8));
  const result: string[] = [];
  for (let i = 0; i < points.length; i += length) result.push(points.slice(i, i + length).join(''));
  return result;
}
function data(value: unknown): string { return 'data: ' + JSON.stringify(value) + '\n\n'; }
function event(name: string, value: unknown): string {
  return 'event: ' + name + '\ndata: ' + JSON.stringify(value) + '\n\n';
}
async function sendStream(
  reply: FastifyReply, receipt: GenerationReceipt, frames: Array<{ text: string; delay?: boolean }>,
  services: SimulatorServices,
) {
  const controller = new AbortController();
  let completed = false;
  const onClose = () => controller.abort();
  reply.header('content-type', 'text/event-stream; charset=utf-8');
  reply.header('cache-control', 'no-cache, no-transform');
  reply.header('x-accel-buffering', 'no');
  reply.header('x-request-id', receipt.requestId);
  reply.hijack();
  reply.raw.on('close', onClose);
  try {
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) reply.raw.setHeader(name, value);
    }
    reply.raw.writeHead(200);
    for (const frame of frames) {
      if (controller.signal.aborted || reply.raw.destroyed) break;
      if (frame.delay && receipt.streamDelayMs > 0) {
        await sleep(Math.min(receipt.streamDelayMs, 5000), undefined, { signal: controller.signal });
      }
      if (!reply.raw.write(frame.text)) await once(reply.raw, 'drain', { signal: controller.signal });
    }
    if (!controller.signal.aborted && !reply.raw.destroyed) {
      completed = true;
      reply.raw.end();
    }
  } catch (error: any) {
    if (error?.name !== 'AbortError' && !reply.raw.destroyed) reply.raw.destroy(error);
  } finally {
    reply.raw.removeListener('close', onClose);
    await services.onEnd?.(receipt.requestId, completed ? 'completed' : 'disconnected').catch(() => undefined);
  }
}

export function registerSimulator(app: FastifyInstance, services: SimulatorServices) {
  app.get('/health', async (_request, reply) => {
    try { return { status: 'ok', service: 'wisdom-tree', ...(await services.health?.() as object ?? {}) }; }
    catch { return reply.code(503).send({ status: 'unavailable' }); }
  });
  app.get('/v1/models', async (request, reply) => {
    try {
      const models = await services.models(request);
      return { object: 'list', data: models.map(model => ({
        id: model.id, object: 'model', created: 0, owned_by: 'wisdom-tree-simulator',
      })) };
    } catch (error) { return errorReply(reply, error, 'chat'); }
  });
  app.post('/v1/messages/count_tokens', async (request, reply) => {
    try {
      await services.authenticate(request);
      const body = request.body as Body;
      if (!body || typeof body.model !== 'string' || !body.model.trim() || !Array.isArray(body.messages) || !body.messages.length) invalid('model and a nonempty messages array are required.');
      return { input_tokens: estimateTokens({ messages: body.messages, system: body.system, tools: body.tools }) };
    } catch (error) { return errorReply(reply, error, 'anthropic'); }
  });
  const route = (url: string, wire: Wire, canonical = url) => {
    app.post(url, async (request, reply) => {
      try {
        const { body, max } = validate(request, wire);
        const input = wire === 'completion' ? body.prompt : wire === 'responses'
          ? { input: body.input, instructions: body.instructions, tools: body.tools }
          : { messages: body.messages, system: body.system, tools: body.tools };
        const receipt = await services.accept(request, {
          endpoint: canonical, modelId: body.model, inputTokens: estimateTokens(input),
          maxOutputTokens: max, requestHash: hashPayload(body),
          userInput: lastUserText(body, wire),
        });
        const text = limitText(receipt.replyText, max);
        const truncated = text !== receipt.replyText;
        reply.header('x-request-id', receipt.requestId);
        if (!body.stream) {
          let result: unknown;
          if (wire === 'responses') result = responseObject(receipt, text, truncated);
          else if (wire === 'anthropic') result = {
            id: 'msg_' + receipt.requestId, type: 'message', role: 'assistant', model: receipt.modelId,
            content: [{ type: 'text', text }], stop_reason: truncated ? 'max_tokens' : 'end_turn',
            stop_sequence: null, usage: { input_tokens: receipt.inputTokens, output_tokens: estimateTokens(text) },
          };
          else result = {
            id: (wire === 'chat' ? 'chatcmpl_' : 'cmpl_') + receipt.requestId,
            object: wire === 'chat' ? 'chat.completion' : 'text_completion',
            created: receipt.createdAt, model: receipt.modelId,
            choices: [wire === 'chat'
              ? { index: 0, message: { role: 'assistant', content: text, refusal: null }, logprobs: null, finish_reason: truncated ? 'length' : 'stop' }
              : { index: 0, text, logprobs: null, finish_reason: truncated ? 'length' : 'stop' }],
            usage: openaiUsage(receipt.inputTokens, text),
          };
          let finished = false;
          reply.raw.once('finish', () => {
            finished = true;
            void services.onEnd?.(receipt.requestId, 'completed').catch(() => undefined);
          });
          reply.raw.once('close', () => {
            if (!finished) void services.onEnd?.(receipt.requestId, 'disconnected').catch(() => undefined);
          });
          return reply.send(result);
        }
        const frames: Array<{ text: string; delay?: boolean }> = [];
        const pieces = chunks(text, receipt.streamChunkChars);
        if (wire === 'chat' || wire === 'completion') {
          const base = {
            id: (wire === 'chat' ? 'chatcmpl_' : 'cmpl_') + receipt.requestId,
            object: wire === 'chat' ? 'chat.completion.chunk' : 'text_completion',
            created: receipt.createdAt, model: receipt.modelId,
          };
          if (wire === 'chat') frames.push({ text: data({
            ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
          }) });
          for (const delta of pieces) frames.push({ delay: true, text: data({
            ...base, choices: [wire === 'chat'
              ? { index: 0, delta: { content: delta }, finish_reason: null }
              : { index: 0, text: delta, logprobs: null, finish_reason: null }],
          }) });
          frames.push({ text: data({ ...base, choices: [wire === 'chat'
            ? { index: 0, delta: {}, finish_reason: truncated ? 'length' : 'stop' }
            : { index: 0, text: '', logprobs: null, finish_reason: truncated ? 'length' : 'stop' }],
          }) });
          if (body.stream_options?.include_usage) frames.push({ text: data({
            ...base, choices: [], usage: openaiUsage(receipt.inputTokens, text),
          }) });
          frames.push({ text: 'data: [DONE]\n\n' });
        } else if (wire === 'responses') {
          let sequence = 0;
          const push = (type: string, payload: object, delay = false) =>
            frames.push({ delay, text: event(type, { type, ...payload, sequence_number: sequence++ }) });
          const full = responseObject(receipt, text, truncated);
          const message = full.output[0];
          push('response.created', { response: { ...full, status: 'in_progress', output: [], usage: null, incomplete_details: null } });
          push('response.in_progress', { response: { ...full, status: 'in_progress', output: [], usage: null, incomplete_details: null } });
          push('response.output_item.added', { output_index: 0, item: { ...message, status: 'in_progress', content: [] } });
          push('response.content_part.added', { item_id: message.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [], logprobs: [] } });
          for (const delta of pieces) push('response.output_text.delta', { item_id: message.id, output_index: 0, content_index: 0, delta, logprobs: [] }, true);
          push('response.output_text.done', { item_id: message.id, output_index: 0, content_index: 0, text, logprobs: [] });
          push('response.content_part.done', { item_id: message.id, output_index: 0, content_index: 0, part: message.content[0] });
          push('response.output_item.done', { output_index: 0, item: message });
          push(truncated ? 'response.incomplete' : 'response.completed', { response: full });
        } else {
          const message = {
            id: 'msg_' + receipt.requestId, type: 'message', role: 'assistant', model: receipt.modelId,
            content: [], stop_reason: null, stop_sequence: null,
            usage: { input_tokens: receipt.inputTokens, output_tokens: 0 },
          };
          frames.push({ text: event('message_start', { type: 'message_start', message }) });
          frames.push({ text: event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) });
          for (const delta of pieces) frames.push({ delay: true, text: event('content_block_delta', {
            type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta },
          }) });
          frames.push({ text: event('content_block_stop', { type: 'content_block_stop', index: 0 }) });
          frames.push({ text: event('message_delta', { type: 'message_delta',
            delta: { stop_reason: truncated ? 'max_tokens' : 'end_turn', stop_sequence: null },
            usage: { output_tokens: estimateTokens(text) },
          }) });
          frames.push({ text: event('message_stop', { type: 'message_stop' }) });
        }
        await sendStream(reply, receipt, frames, services);
        return reply;
      } catch (error) { return errorReply(reply, error, wire); }
    });
  };
  route('/v1/chat/completions', 'chat');
  route('/v1/completions', 'completion');
  route('/v1/responses', 'responses');
  route('/responses', 'responses', '/v1/responses');
  route('/v1/messages', 'anthropic');
}
