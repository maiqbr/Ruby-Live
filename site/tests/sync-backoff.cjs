const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../bot/src/liveSyncService.cjs'), 'utf8');

function harness() {
  let now = Date.parse('2026-08-30T15:00:00Z');
  class FakeDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const logs = [];
  const calls = [];
  let reply = () => ({ ok: true, status: 200, json: async () => ({ accepted: true, activeUserIds: [] }) });
  const bot = { exports: {} };
  const botRequire = specifier => specifier === './liveConfig.cjs'
    ? { getConfig: () => ({ blocked_channel_ids: [], blocked_category_ids: [], broadcast_role_ids: [], unrestricted_channel_ids: [], unrestricted_category_ids: [] }) }
    : require(specifier);
  vm.runInNewContext(source, { module: bot, require: botRequire, Date: FakeDate, process: { env: { LIVE_SYNC_URL: 'https://live.example.com/api/internal/voice-sync', LIVE_SYNC_SECRET: 'private-secret-do-not-log'.repeat(2) } },
    console: { log: (...args) => logs.push(args.join(' ')), error: (...args) => logs.push(args.join(' ')), warn: (...args) => logs.push(args.join(' ')) },
    AbortSignal, setInterval: () => ({ unref() {} }), clearInterval() {},
    fetch: async (_url, options) => { calls.push(JSON.parse(options.body)); return reply(); },
  });
  return { api: bot.exports, logs, calls, client: { isReady: () => true, guilds: { cache: new Map() } },
    advance(ms) { now += ms; }, setTime(value) { now = Date.parse(value); },
    respond(status, error, retryAfter) { reply = () => ({ ok: status === 200, status, json: async () => ({ error, activeUserIds: [] }), headers: { get: () => retryAfter || null } }); },
    networkFailure() { reply = () => { throw new Error('private-secret-do-not-log'); }; },
  };
}

async function main() {
  const quota = harness();
  quota.respond(503, 'storage_quota_exceeded', '32405');
  await quota.api.start(quota.client);
  for (let i = 0; i < 20; i++) { quota.advance(15000); await quota.api.sendFullSnapshot(); }
  assert.equal(quota.calls.length, 1, 'quota cooldown makes no repeated requests');
  assert.equal(quota.logs.length, 1, 'quota logs once and does not claim sync active');
  assert.match(quota.logs[0], /storage_quota_exceeded/);
  quota.setTime('2026-08-31T00:00:06Z');
  quota.respond(200);
  await quota.api.sendFullSnapshot();
  assert.equal(quota.calls.length, 2);
  assert.match(quota.logs.at(-1), /restabelecida/);

  const temporary = harness();
  temporary.respond(503, 'sync_unavailable', '30');
  await temporary.api.start(temporary.client);
  assert.equal(temporary.logs.length, 0, 'isolated transient failure stays silent');
  temporary.advance(5000); await temporary.api.sendFullSnapshot();
  assert.equal(temporary.calls.length, 2);
  temporary.advance(5000); await temporary.api.sendFullSnapshot();
  assert.equal(temporary.calls.length, 3);
  assert.match(temporary.logs[0], /sync_unavailable/, 'third consecutive failure starts cooldown');
  temporary.advance(29000); await temporary.api.sendFullSnapshot();
  assert.equal(temporary.calls.length, 3, 'transient cooldown starts only after three consecutive failures');

  const invalid = harness();
  invalid.respond(400, 'invalid_snapshot');
  await invalid.api.start(invalid.client);
  invalid.advance(299000); await invalid.api.sendFullSnapshot();
  assert.equal(invalid.calls.length, 1);
  assert.match(invalid.logs[0], /invalid_snapshot/);

  const unknown = harness();
  unknown.respond(400, 'private-secret-do-not-log\nFORGED LOG');
  await unknown.api.start(unknown.client);
  assert.match(unknown.logs[0], /unknown_response/);
  assert.ok(!unknown.logs.join('').includes('private-secret'));
  assert.ok(!unknown.logs.join('').includes('FORGED'));

  const network = harness(); network.networkFailure();
  await network.api.start(network.client);
  network.advance(5000); await network.api.sendFullSnapshot();
  assert.equal(network.logs.length, 0, 'one or two network failures do not create noisy alerts');
  network.advance(5000); await network.api.sendFullSnapshot();
  assert.match(network.logs[0], /network_error/);
  assert.ok(!network.logs[0].includes('private-secret'));
  assert.match(source, /AbortSignal\.timeout\(REQUEST_TIMEOUT_MS\)/);
  assert.match(source, /REQUEST_TIMEOUT_MS = 10_000/);

  const limited = harness(); limited.respond(429, undefined, '600');
  await limited.api.start(limited.client);
  limited.advance(599000); await limited.api.sendFullSnapshot();
  assert.equal(limited.calls.length, 1, 'Retry-After is respected');
  console.log('PASS: quota pause/resume, progressive backoff, 400 cooldown, Retry-After, no secret/raw-response logs');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
