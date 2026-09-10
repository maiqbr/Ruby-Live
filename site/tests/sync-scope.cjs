const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { webcrypto } = require('node:crypto');

async function main() {
  const source = fs.readFileSync(path.join(__dirname, '../worker/index.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exported = {};
  const pairs = [];
  class FakeSocket {
    readyState = 1;
    accept() {}
    close(code) { this.closeCode = code; this.readyState = 3; }
    serializeAttachment(data) { this.data = structuredClone(data); }
    deserializeAttachment() { return structuredClone(this.data); }
    send() {}
  }
  class FakePair {
    constructor() { this[0] = new FakeSocket(); this[1] = new FakeSocket(); pairs.push(this); }
  }
  class WorkerResponse {
    constructor(body, init) { if (init?.status === 101) Object.assign(this, init); else return new Response(body, init); }
  }
  vm.runInNewContext(code, { exports: exported, require: () => ({ DurableObject: class { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } }), TextEncoder, TextDecoder, crypto: webcrypto, btoa, atob, Response: WorkerResponse, Request, URL, Headers, WebSocketPair: FakePair, WebSocketRequestResponsePair: class {} });
  const ids = Array.from({ length: 100 }, (_, i) => String(100000000000000000n + BigInt(i)));
  let sockets = ids.slice(0, 2).map(id => ({ readyState: 1, data: { id, name: 'Test', exp: Date.now() + 60000, roomKey: null, sessionId: null, sharing: false }, deserializeAttachment() { return structuredClone(this.data); }, serializeAttachment(data) { this.data = structuredClone(data); }, send() {} }));
  const db = new Map();
  let writes = 0;
  const ctx = { getWebSockets: () => sockets, setWebSocketAutoResponse() {}, storage: {
    async get(key) { return structuredClone(db.get(key)); },
    async put(key, value) { writes++; db.set(key, structuredClone(value)); },
    async delete(key) { writes++; db.delete(key); },
    async setAlarm() { writes++; },
    async list({ prefix }) { return new Map([...db].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value)])); },
  } };
  const hub = new exported.VoiceHub(ctx, {});
  const snapshot = { type: 'snapshot', guildId: '200000000000000001', channels: [{ channelId: '300000000000000001', channelName: 'Test', userIds: ids }] };
  await hub.applySync(snapshot, 'event-1');
  assert.equal([...db.keys()].filter(key => key.startsWith('user:')).length, 2);
  assert.equal(db.get(`user:${ids[0]}`).roomKey, db.get(`user:${ids[1]}`).roomKey);
  const messages = [];
  sockets[1].send = value => messages.push(JSON.parse(value));
  writes = 0;
  await hub.webSocketMessage(sockets[0], JSON.stringify({ type: 'camera_state', camera: true }));
  assert.equal(hub.peer(sockets[0].data).camera, true);
  assert.equal(hub.peer(sockets[0].data).sharing, false, 'camera does not mark screen as shared');
  await hub.webSocketMessage(sockets[0], JSON.stringify({ type: 'watch_state', to: ids[1], watching: true, media: 'camera' }));
  assert.equal(messages.at(-1).media, 'camera');
  assert.equal(messages.at(-1).type, 'watch_state');
  await hub.webSocketMessage(sockets[0], JSON.stringify({ type: 'signal', to: ids[1], media: 'camera', data: { kind: 'description', description: { type: 'offer', sdp: 'test' } } }));
  assert.equal(messages.at(-1).media, 'camera');
  assert.equal(messages.at(-1).type, 'signal');
  const beforeInvalid = messages.length;
  await hub.webSocketMessage(sockets[0], JSON.stringify({ type: 'watch_state', to: ids[1], watching: true, media: 'microphone' }));
  assert.equal(messages.length, beforeInvalid, 'unknown media types rejected');
  const previousRoom = db.get(`user:${ids[1]}`).roomKey;
  db.get(`user:${ids[1]}`).roomKey = 'other-room';
  await hub.webSocketMessage(sockets[0], JSON.stringify({ type: 'watch_state', to: ids[1], watching: true, media: 'camera' }));
  assert.equal(messages.length, beforeInvalid, 'camera requests cannot cross rooms');
  db.get(`user:${ids[1]}`).roomKey = previousRoom;
  assert.equal(writes, 0, 'camera state/signaling adds no storage writes');
  writes = 0;
  await hub.applySync(snapshot, 'event-2');
  assert.equal(writes, 1, 'unchanged snapshot only writes its event id');
  writes = 0;
  for (let i = 0; i < 100; i++) await hub.applySync({ type: 'heartbeat' }, `hb-${i}`);
  assert.equal(writes, 0, 'heartbeats within 30 seconds do not write');
  sockets = [];
  await hub.applySync(snapshot, 'event-3');
  assert.equal([...db.keys()].filter(key => key.startsWith('user:')).length, 2, 'one missing-socket snapshot is tolerated');
  for (const userId of ids.slice(0, 2)) hub.inactiveSince.set(userId, Date.now() - 16000);
  await hub.applySync(snapshot, 'event-3b');
  assert.equal([...db.keys()].filter(key => key.startsWith('user:')).length, 0, 'continued absence is removed after the grace period');
  await hub.applySync({ type: 'voice_event', guildId: snapshot.guildId, userId: ids[80], newChannelId: snapshot.channels[0].channelId }, 'event-4');
  assert.equal(db.has(`user:${ids[80]}`), false);

  ctx.acceptWebSocket = socket => sockets.push(socket);
  const upgrade = () => new Request('https://internal/ws', { headers: { upgrade: 'websocket', 'x-user-id': ids[0] } });
  writes = 0;
  await Promise.all([hub.fetch(upgrade()), hub.fetch(upgrade())]);
  assert.equal(sockets.length, 1, 'simultaneous tabs admit exactly one session');
  assert.equal(pairs[1][1].closeCode, 4009, 'second tab receives terminal duplicate code');
  assert.equal(sockets[0].readyState, 1, 'original tab is not disconnected');
  assert.equal(writes, 0, 'duplicate protection consumes no database writes');
  const original = sockets[0];
  original.close(1000);
  await hub.fetch(upgrade());
  assert.equal(sockets.filter(socket => socket.readyState === 1).length, 1, 'retry succeeds after original closes');
  let departures = 0;
  hub.broadcast = () => { departures++; };
  original.data.roomKey = 'old-room';
  hub.webSocketClose(original);
  assert.equal(departures, 0, 'late close from old session cannot remove replacement');

  const sent = [];
  let connectedIds = ids.slice(0, 2);
  let pollInterval;
  const botModule = { exports: {} };
  const botRequire = specifier => specifier === './liveConfig.cjs'
    ? { getConfig: () => ({ blocked_channel_ids: [], blocked_category_ids: ['400000000000000001'], broadcast_role_ids: [], unrestricted_channel_ids: [], unrestricted_category_ids: ['400000000000000001'] }) }
    : require(specifier);
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../bot/src/liveSyncService.cjs'), 'utf8'), {
    module: botModule, require: botRequire, process: { env: { LIVE_SYNC_URL: 'https://live.example.com/api/internal/voice-sync', LIVE_SYNC_SECRET: 'x'.repeat(32) } }, console,
    AbortSignal, setTimeout, clearInterval() {}, setInterval(_callback, delay) { pollInterval = delay; return { unref() {} }; },
    fetch: async (_url, options) => { sent.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ activeUserIds: connectedIds }) }; },
  });
  const guild = { id: snapshot.guildId, voiceStates: { cache: new Map(ids.map(id => [id, { id, channelId: snapshot.channels[0].channelId, channel: { name: 'Test', parentId: '400000000000000001' } }])) } };
  await botModule.exports.start({ isReady: () => true, guilds: { cache: new Map([[guild.id, guild]]) } });
  assert.equal(pollInterval, 5_000, 'new browser sessions use the quota-conscious polling window');
  assert.equal(sent[0].type, 'heartbeat');
  assert.deepEqual(sent.find(p => p.type === 'snapshot').channels[0].userIds, ids.slice(0, 2));
  assert.equal(sent.find(p => p.type === 'snapshot').channels[0].blocked, true, 'blocked category applies to its voice channels');
  assert.equal(sent.find(p => p.type === 'snapshot').channels[0].unrestricted, true, 'unrestricted category applies to its voice channels');
  const before = sent.length;
  await botModule.exports.handleVoiceStateUpdate({ channelId: null }, { id: ids[50], channelId: '123', guild });
  assert.equal(sent.length, before, 'unrelated Discord members send no events');
  connectedIds = [];
  await botModule.exports.sendFullSnapshot();
  assert.equal(sent.at(-1).type, 'snapshot');
  assert.equal(sent.at(-1).channels.length, 0, 'empty site sends no Discord members or calls');
  const afterEmpty = sent.length;
  await botModule.exports.handleVoiceStateUpdate({ channelId: null }, { id: ids[0], channelId: '123', guild });
  assert.equal(sent.length, afterEmpty, 'departed site users stop producing voice events after reconciliation');
  const originalSync = hub.applySync;
  const syncRequest = () => new Request('https://internal/internal-sync', { method: 'POST', body: JSON.stringify({ type: 'heartbeat' }) });
  hub.applySync = async () => { throw new Error('Exceeded daily Durable Objects rows_written limit'); };
  const quota = await hub.fetch(syncRequest());
  assert.equal(quota.status, 503);
  assert.equal((await quota.json()).error, 'storage_quota_exceeded');
  assert.ok(Number(quota.headers.get('retry-after')) > 0);
  assert.ok(Number(quota.headers.get('retry-after')) <= 86405);
  hub.applySync = async () => { throw new Error('invalid_snapshot'); };
  const invalid = await hub.fetch(syncRequest());
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, 'invalid_snapshot');
  hub.applySync = async () => { throw new Error('SQLITE_FULL: storage size limit exceeded SECRET-must-not-leak'); };
  const unavailable = await hub.fetch(syncRequest());
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get('retry-after'), '30');
  const failureBody = await unavailable.text();
  assert.ok(!failureBody.includes('SECRET'));
  assert.equal(JSON.parse(failureBody).error, 'sync_unavailable', 'storage capacity is not assumed to reset daily');
  hub.applySync = originalSync;
  const health = await hub.fetch(new Request('https://internal/health'));
  assert.equal(health.status, 200);
  assert.equal(typeof (await health.json()).operational, 'boolean', 'health exposes bot heartbeat without counting users');
  const page = await exported.default.fetch(new Request('https://live.example.com/'), { PUBLIC_ORIGIN: 'https://live.example.com', ASSETS: { fetch: async () => new Response('test') } });
  const unconfigured = await exported.default.fetch(new Request('https://live.example.com/api/auth/discord'), {});
  assert.equal(unconfigured.status, 503, 'missing configuration must fail closed before OAuth or storage access');
  const placeholders = await exported.default.fetch(new Request('https://live.example.com/api/internal/voice-sync'), {
    PUBLIC_ORIGIN: 'https://live.example.com', ALLOWED_GUILD_IDS: 'INSIRA_O_ID_DO_SERVIDOR',
    SESSION_SECRET: 'INSIRA_UM_SEGREDO'.repeat(3), LIVE_SYNC_SECRET: 'INSIRA_OUTRO_SEGREDO'.repeat(3),
  });
  assert.equal(placeholders.status, 503, 'sample placeholders must not enable API access');
  assert.match(page.headers.get('permissions-policy'), /camera=\(self\)/);
  assert.match(page.headers.get('permissions-policy'), /microphone=\(\)/);
  console.log('PASS: scope, writes, duplicate tabs, camera signaling, media isolation, same-call checks, camera/microphone policy');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
