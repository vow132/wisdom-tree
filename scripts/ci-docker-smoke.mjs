import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

// Run against a disposable CI stack behind Caddy, never a live server.
const origin = new URL(process.env.CI_SMOKE_ORIGIN || 'http://127.0.0.1');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname), 'CI smoke must target a loopback host.');
assert.equal(origin.protocol, 'http:', 'The disposable Caddy smoke stack uses HTTP.');
assert.ok(!origin.username && !origin.password && !origin.search && !origin.hash && origin.pathname === '/', 'Use an origin without credentials or a path.');
const base = origin.origin;
const deadline = AbortSignal.timeout(150_000);
const userJar = new Map();
const account = 'smoke_' + randomBytes(8).toString('hex');
const password = 'Disposable-' + randomBytes(18).toString('base64url') + '!';
const assetsManifest = '.local/docker-ci-assets.json';
let requests = 0;

async function request(path, { method = 'GET', body, jar, headers = {}, timeout = 10_000 } = {}) {
  assert.ok(++requests <= 80, 'CI smoke exceeded its fixed request budget.');
  const response = await fetch(base + path, {
    method,
    redirect: 'error',
    signal: AbortSignal.any([deadline, AbortSignal.timeout(timeout)]),
    headers: {
      ...headers,
      ...(!['GET', 'HEAD'].includes(method) ? { origin: base } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(jar ? { cookie: [...jar].map(([name, value]) => name + '=' + value).join('; ') } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (jar) {
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';', 1)[0];
      const equals = pair.indexOf('=');
      if (equals > 0) jar.set(pair.slice(0, equals), pair.slice(equals + 1));
    }
  }
  return response;
}

async function json(path, options = {}, expectedStatus = 200) {
  const response = await request(path, options);
  assert.equal(response.status, expectedStatus, `${options.method || 'GET'} ${path}: unexpected HTTP status`);
  assert.ok(response.headers.get('content-type')?.includes('application/json'), `${path}: expected JSON`);
  return response.json();
}

async function state() { return json('/api/me', { jar: userJar }); }
async function action(name, key = randomUUID()) {
  return json('/api/tree/' + name, { method: 'POST', body: {}, jar: userJar, headers: { 'Idempotency-Key': key } });
}

// Valid PNG fixtures use only Node's standard library. The API container must
// decode and re-encode them with its real sharp/libvips production dependency.
function pngFixture(width, height) {
  const crc32 = input => {
    let crc = 0xffffffff;
    for (const byte of input) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const name = Buffer.from(type);
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([length, name, data, checksum]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = y * (width * 4 + 1) + 1 + x * 4;
    rows[at] = 53; rows[at + 1] = 123; rows[at + 2] = 79; rows[at + 3] = 255;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

async function verifySiteAsset(asset) {
  assert.ok(/^\/api\/site-assets\/[a-f0-9]{32}\.(png|webp)$/.test(asset.url), 'Managed image URL must be a controlled same-origin asset.');
  const response = await request(asset.url);
  assert.equal(response.status, 200, 'Uploaded image is unavailable through Caddy.');
  assert.ok(response.headers.get('content-type')?.startsWith(asset.mimeType), 'Uploaded image MIME type is incorrect.');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(response.headers.get('cache-control')?.includes('immutable'), 'Versioned image cache policy is missing.');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.length > 12 && bytes.length <= 2 * 1024 * 1024, 'Uploaded image body is invalid.');
  if (asset.mimeType === 'image/png') {
    assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Favicon was not converted to PNG.');
    assert.equal(bytes.toString('ascii', 12, 16), 'IHDR');
    assert.equal(bytes.readUInt32BE(16), 256, 'Favicon width was not resized to its limit.');
    assert.equal(bytes.readUInt32BE(20), 256, 'Favicon height was not resized to its limit.');
  } else {
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
    assert.equal(bytes.toString('ascii', 8, 12), 'WEBP', 'Logo/background were not converted to WebP.');
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (asset.sha256) assert.equal(digest, asset.sha256, 'Uploaded image changed after an API recreation.');
  return { ...asset, sha256: digest };
}

async function siteSettingsSmoke(adminJar) {
  const original = await json('/api/admin/site-settings', { jar: adminJar });
  assert.equal(original.siteName, '智慧树', 'Fresh website settings did not use the defaults.');
  for (const field of ['logoUrl', 'faviconUrl', 'gardenBackgroundUrl']) assert.equal(original[field], null, 'Docker smoke expects a fresh disposable image configuration.');
  const texts = { siteName: 'CI 智慧树', browserTitle: 'CI 网站标题', gardenSubtitle: '', footerText: 'CI 页脚文案' };
  const savedAssets = [];
  try {
    const saved = await json('/api/admin/site-settings', { method: 'PATCH', body: texts, jar: adminJar });
    for (const [field, value] of Object.entries(texts)) assert.equal(saved[field], value, 'Website text did not persist.');
    const publicSettings = await request('/api/site-settings');
    assert.ok(publicSettings.headers.get('cache-control')?.includes('no-store'), 'Public configuration must not be served from a stale proxy cache.');
    assert.equal((await publicSettings.json()).siteName, texts.siteName);
    for (const [slot, field, width, height, mimeType] of [
      ['logo', 'logoUrl', 64, 24, 'image/webp'],
      ['favicon', 'faviconUrl', 320, 320, 'image/png'],
      ['garden-background', 'gardenBackgroundUrl', 800, 600, 'image/webp'],
    ]) {
      const result = await json('/api/admin/site-settings/assets/' + slot, { method: 'POST', body: { data: pngFixture(width, height).toString('base64'), mimeType: 'image/png' }, jar: adminJar });
      assert.equal(result.siteName, texts.siteName, 'Image upload overwrote the website text.');
      assert.ok(result[field]);
      savedAssets.push(await verifySiteAsset({ url: result[field], mimeType }));
    }
  } finally {
    const restored = await json('/api/admin/site-settings', { method: 'PATCH', body: {
      siteName: original.siteName, browserTitle: original.browserTitle, gardenSubtitle: original.gardenSubtitle, footerText: original.footerText,
      logoUrl: null, faviconUrl: null, gardenBackgroundUrl: null,
    }, jar: adminJar });
    for (const field of ['siteName', 'browserTitle', 'gardenSubtitle', 'footerText', 'logoUrl', 'faviconUrl', 'gardenBackgroundUrl']) assert.equal(restored[field], original[field], 'Disposable website settings were not restored.');
  }
  for (const asset of savedAssets) await verifySiteAsset(asset);
  await writeFile(assetsManifest, JSON.stringify(savedAssets) + '\n', { mode: 0o600 });
  console.log('PASS: website text, real sharp uploads, public images and default restoration through Caddy');
}

async function verifyPersistedSiteAssets() {
  const assets = JSON.parse(await readFile(assetsManifest, 'utf8'));
  assert.ok(Array.isArray(assets) && assets.length === 3, 'Managed CI image manifest is missing.');
  for (const asset of assets) {
    assert.ok(['image/png', 'image/webp'].includes(asset.mimeType) && /^[a-f0-9]{64}$/.test(asset.sha256), 'Managed CI image metadata is invalid.');
    await verifySiteAsset(asset);
  }
  console.log('PASS: uploaded images survived API container recreation');
}

// Consume the actual response body stream through Caddy. Bound size and frames;
// validate protocol terminal frames after reaching EOF, without logging contents.
async function sse(path, body, headers) {
  const response = await request(path, { method: 'POST', body: { ...body, stream: true }, headers, timeout: 20_000 });
  assert.equal(response.status, 200, `${path}: SSE request failed`);
  assert.ok(response.headers.get('content-type')?.includes('text/event-stream'), `${path}: expected event stream`);
  assert.ok(response.headers.get('cache-control')?.includes('no-transform'), `${path}: streaming cache policy missing`);
  assert.ok(response.body, `${path}: streaming body missing`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  let buffer = '';
  let bytes = 0;
  const parse = () => {
    buffer = buffer.replace(/\r\n/g, '\n');
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data) continue;
      const event = frame.split('\n').find(line => line.startsWith('event:'))?.slice(6).trim() || '';
      frames.push({ event, data: data === '[DONE]' ? data : JSON.parse(data) });
      assert.ok(frames.length <= 256, `${path}: SSE frame budget exceeded`);
    }
  };
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      assert.ok(bytes <= 131_072, `${path}: SSE size budget exceeded`);
      buffer += decoder.decode(chunk.value, { stream: true });
      parse();
    }
    buffer += decoder.decode();
    parse();
    assert.equal(buffer.trim(), '', `${path}: incomplete final SSE frame`);
    assert.ok(frames.length >= 3, `${path}: too few SSE frames`);
    return frames;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function chatText(value) {
  assert.equal(value.object, 'chat.completion');
  assert.equal(value.choices?.[0]?.finish_reason, 'stop');
  assert.ok(typeof value.choices[0].message.content === 'string' && value.choices[0].message.content.length > 0);
  return value.choices[0].message.content;
}
function responseText(value) {
  assert.equal(value.object, 'response');
  assert.equal(value.status, 'completed');
  const text = value.output?.[0]?.content?.[0]?.text;
  assert.ok(typeof text === 'string' && text.length > 0);
  return text;
}
function messageText(value) {
  assert.equal(value.type, 'message');
  assert.equal(value.stop_reason, 'end_turn');
  assert.equal(value.content?.[0]?.type, 'text');
  assert.ok(typeof value.content[0].text === 'string' && value.content[0].text.length > 0);
  return value.content[0].text;
}

async function main() {
  const page = await request('/');
  assert.equal(page.status, 200, 'Website index unavailable through Caddy.');
  assert.ok(page.headers.get('content-type')?.includes('text/html'));
  assert.ok(/id=["']root["']/.test(await page.text()), 'Production frontend root missing.');
  const health = await json('/health');
  assert.equal(health.status, 'ok');
  assert.equal(health.service, 'wisdom-tree');
  const publicModels = (await json('/api/models')).items;
  for (const [id, price] of [['gpt-5.6-luna', 1], ['gpt-5.6-sol', 2], ['claude-fable-5.1', 5]]) {
    assert.ok(publicModels.some(model => model.id === id && model.coinsPerCall === price), 'Fresh model defaults are incorrect.');
  }
  assert.equal((await json('/api/me')).user, null);
  await json('/v1/models', {}, 401);
  console.log('PASS: production frontend, health and public routes through Caddy');

  const registered = await json('/api/auth/register', { method: 'POST', body: { username: account, password, displayName: 'Docker smoke' }, jar: userJar });
  assert.equal(registered.user.role, 'user');
  assert.equal(registered.user.coins, 0);
  assert.ok(userJar.has('wisdom_session'), 'Registration did not establish a session.');
  const seedKey = randomUUID();
  const seed = await action('seed', seedKey);
  assert.deepEqual(await action('seed', seedKey), seed);
  assert.equal(seed.tree.seedClaimed, true);
  await json('/api/tree/seed', { method: 'POST', body: {}, jar: userJar, headers: { 'Idempotency-Key': randomUUID() } }, 409);
  assert.equal((await action('plant')).tree.height, 1);
  const claim = await action('claim-fertilizer');
  assert.equal(claim.user.fertilizer, 5);
  assert.equal(claim.daily.remaining, 0);
  const feedKey = randomUUID();
  const firstFeed = await action('feed', feedKey);
  assert.deepEqual(await action('feed', feedKey), firstFeed);
  assert.equal(firstFeed.tree.height, 2);
  assert.equal(firstFeed.user.coins, 10);
  const secondFeed = await action('feed');
  assert.equal(secondFeed.tree.height, 3);
  assert.equal(secondFeed.user.coins, 20);
  assert.equal(secondFeed.user.fertilizer, 3);
  await json('/api/admin/users', { jar: userJar }, 403);
  console.log('PASS: registration, one seed, daily fertilizer and immediate growth with replay protection');

  const created = await json('/api/keys', { method: 'POST', body: { name: 'Disposable Docker CI' }, jar: userJar });
  const apiKey = created.key;
  assert.ok(typeof apiKey === 'string' && apiKey.startsWith('sk_'), 'API key prefix is incorrect.');
  const listed = await json('/api/keys', { jar: userJar });
  assert.ok(listed.items.some(item => item.id === created.item.id && item.key === apiKey), 'Owner key recovery failed.');
  const bearer = { authorization: 'Bearer ' + apiKey };
  const anthropic = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  const models = await json('/v1/models', { headers: bearer });
  assert.equal(models.object, 'list');
  assert.ok(models.data.some(model => model.id === 'gpt-5.6-luna'));
  const count = await json('/v1/messages/count_tokens', { method: 'POST', body: { model: 'claude-fable-5.1', messages: [{ role: 'user', content: 'hello' }] }, headers: anthropic });
  assert.ok(count.input_tokens > 0);
  await json('/v1/models', { headers: { authorization: 'Bearer sk_invalid_disposable_' + randomUUID() } }, 401);
  assert.equal((await state()).user.coins, 20, 'Free endpoints or invalid credentials charged coins.');

  const chatBody = { model: 'gpt-5.6-luna', messages: [{ role: 'user', content: 'hello' }] };
  const responsesBody = { model: 'gpt-5.6-sol', input: 'hello' };
  const messagesBody = { model: 'claude-fable-5.1', max_tokens: 2048, messages: [{ role: 'user', content: 'hello' }] };
  const chat = chatText(await json('/v1/chat/completions', { method: 'POST', body: chatBody, headers: bearer }));
  const response = responseText(await json('/v1/responses', { method: 'POST', body: responsesBody, headers: bearer }));
  const message = messageText(await json('/v1/messages', { method: 'POST', body: messagesBody, headers: anthropic }));
  assert.equal((await state()).user.coins, 12);

  const chatFrames = await sse('/v1/chat/completions', { ...chatBody, stream_options: { include_usage: true } }, bearer);
  assert.equal(chatFrames.at(-1).data, '[DONE]', 'Chat stream missing its terminal frame.');
  const chatChunks = chatFrames.slice(0, -1).map(frame => frame.data);
  assert.ok(chatChunks.every(chunk => chunk.object === 'chat.completion.chunk'));
  assert.ok(chatChunks.some(chunk => chunk.choices?.[0]?.finish_reason === 'stop'));
  assert.ok(chatChunks.some(chunk => chunk.usage?.total_tokens > 0));
  assert.equal(chatChunks.map(chunk => chunk.choices?.[0]?.delta?.content || '').join(''), chat);

  const responseFrames = await sse('/v1/responses', responsesBody, bearer);
  assert.equal(responseFrames[0].event, 'response.created');
  assert.equal(responseFrames.at(-1).event, 'response.completed', 'Responses stream missing completion.');
  for (const [index, frame] of responseFrames.entries()) {
    assert.equal(frame.data.type, frame.event);
    assert.equal(frame.data.sequence_number, index);
  }
  assert.equal(responseFrames.filter(frame => frame.event === 'response.output_text.delta').map(frame => frame.data.delta).join(''), response);
  assert.equal(responseText(responseFrames.at(-1).data.response), response);

  const messageFrames = await sse('/v1/messages', messagesBody, anthropic);
  assert.equal(messageFrames[0].event, 'message_start');
  assert.equal(messageFrames.at(-1).event, 'message_stop', 'Anthropic stream missing its terminal frame.');
  assert.ok(messageFrames.every(frame => frame.data.type === frame.event));
  assert.ok(messageFrames.some(frame => frame.event === 'message_delta' && frame.data.delta.stop_reason === 'end_turn'));
  assert.equal(messageFrames.filter(frame => frame.event === 'content_block_delta').map(frame => frame.data.delta.text).join(''), message);
  assert.equal((await state()).user.coins, 4);

  const completionBody = { model: 'gpt-5.6-luna', prompt: 'hello' };
  const completion = await json('/v1/completions', { method: 'POST', body: completionBody, headers: bearer });
  assert.equal(completion.object, 'text_completion');
  assert.equal(completion.choices?.[0]?.finish_reason, 'stop');
  const completionFrames = await sse('/v1/completions', completionBody, bearer);
  assert.equal(completionFrames.at(-1).data, '[DONE]');
  assert.equal(completionFrames.slice(0, -1).map(frame => frame.data.choices?.[0]?.text || '').join(''), completion.choices[0].text);
  assert.equal((await state()).user.coins, 2);
  console.log('PASS: Chat, Responses, Anthropic and legacy completions JSON/SSE through Caddy');

  const replayKey = randomUUID();
  const replayOptions = { method: 'POST', body: chatBody, headers: { ...bearer, 'Idempotency-Key': replayKey } };
  const accepted = await json('/v1/chat/completions', replayOptions);
  assert.deepEqual(await json('/v1/chat/completions', replayOptions), accepted);
  assert.equal((await state()).user.coins, 1, 'API replay charged twice.');
  await json('/v1/chat/completions', { ...replayOptions, body: { ...chatBody, messages: [{ role: 'user', content: 'different' }] } }, 409);
  await json('/v1/messages', { method: 'POST', body: messagesBody, headers: anthropic }, 402);
  assert.equal((await state()).user.coins, 1, 'Rejected API requests changed the balance.');
  const usage = await json('/api/usage', { jar: userJar });
  assert.equal(usage.total, 9, 'Accepted API request count is incorrect.');
  assert.equal(usage.items.reduce((sum, item) => sum + item.coinsCharged, 0), 19);
  await json('/api/keys/' + created.item.id, { method: 'DELETE', jar: userJar });
  await json('/v1/models', { headers: bearer }, 401);
  console.log('PASS: idempotent billing, rejected requests, usage records and key revocation');

  if (process.env.CI_ADMIN_PASSWORD) {
    const adminJar = new Map();
    const admin = await json('/api/auth/login', { method: 'POST', body: { username: process.env.CI_ADMIN_USERNAME || 'ci_admin', password: process.env.CI_ADMIN_PASSWORD }, jar: adminJar });
    assert.equal(admin.user.role, 'admin', 'CLI-created administrator cannot log in.');
    assert.ok((await json('/api/admin/users', { jar: adminJar })).items.some(user => user.id === registered.user.id));
    assert.ok((await json('/api/admin/models', { jar: adminJar })).items.length >= 3);
    await json('/api/admin/site-settings', { jar: userJar }, 403);
    await siteSettingsSmoke(adminJar);
    console.log('PASS: CLI-created administrator login and management routes');
  }
  console.log(`Docker smoke passed (${requests} requests, disposable local stack).`);
}

await (process.argv.includes('--verify-assets-only') ? verifyPersistedSiteAssets() : main()).catch(error => {
  // Messages above never contain credentials, tokens, cookies or response bodies.
  console.error('Docker smoke failed: ' + (error instanceof Error ? error.message : 'unexpected check failure'));
  process.exitCode = 1;
});
