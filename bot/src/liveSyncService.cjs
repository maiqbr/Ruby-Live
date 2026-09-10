const crypto = require('node:crypto');

const endpoint = process.env.LIVE_SYNC_URL || '';
const secret = process.env.LIVE_SYNC_SECRET || '';
const instanceId = process.env.LIVE_SYNC_INSTANCE_ID || `ruby-${crypto.randomUUID()}`;
const allowedGuildIds = new Set(
  (process.env.LIVE_SYNC_GUILD_IDS || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean),
);
function idSet(name) {
  return new Set((process.env[name] || '').split(',').map(id => id.trim()).filter(id => /^\d{15,22}$/.test(id)));
}
const blockedChannelIds = idSet('LIVE_SYNC_BLOCKED_CHANNEL_IDS');
const blockedCategoryIds = idSet('LIVE_SYNC_BLOCKED_CATEGORY_IDS');
const unrestrictedChannelIds = idSet('LIVE_SYNC_UNRESTRICTED_CHANNEL_IDS');
const unrestrictedCategoryIds = idSet('LIVE_SYNC_UNRESTRICTED_CATEGORY_IDS');
const broadcastRoleIds = idSet('LIVE_SYNC_BROADCAST_ROLE_IDS');
const SNAPSHOT_INTERVAL_MS = 60_000;
const configuredPollInterval = Number(process.env.LIVE_SYNC_POLL_INTERVAL_MS);
const POLL_INTERVAL_MS = Number.isFinite(configuredPollInterval) && configuredPollInterval > 0
  ? Math.min(15_000, Math.max(2_000, configuredPollInterval))
  : 5_000;
const MAX_COOLDOWN_MS = 86_405_000;
const REQUEST_TIMEOUT_MS = 10_000;
const TRANSIENT_FAILURE_THRESHOLD = 3;

let clientRef = null;
let snapshotTimer = null;
let activeUserIds = new Set();
let polling = false;
let syncPausedUntil = 0;
let failureStreak = 0;
let recoveryPending = false;
const lastSnapshots = new Map();
const ERROR_LABELS = {
  storage_quota_exceeded: 'cota diária de armazenamento da Cloudflare esgotada',
  sync_unavailable: 'serviço de sincronização temporariamente indisponível',
  service_unavailable: 'configuração do serviço indisponível; confira LIVE_SYNC_SECRET no Worker',
  unauthorized: 'assinatura recusada; confira o segredo de sincronização e o relógio do host',
  guild_not_allowed: 'servidor Discord não autorizado na configuração da live',
  invalid_guild: 'identificador de servidor inválido',
  invalid_user: 'identificador de usuário inválido',
  invalid_channel: 'identificador de call inválido',
  invalid_snapshot: 'formato da sincronização de calls inválido',
  invalid_type: 'tipo de evento inválido',
  rate_limited: 'limite temporário de requisições',
  network_error: 'falha de rede ou tempo de resposta excedido',
  unknown_response: 'resposta não reconhecida do serviço',
};

function enabled() {
  return Boolean(secret && endpoint);
}

function guildAllowed(guildId) {
  return allowedGuildIds.size === 0 || allowedGuildIds.has(guildId);
}

function voicePolicy(state) {
  const channelId = state.channelId;
  const categoryId = state.channel?.parentId || null;
  const blocked = Boolean(channelId && blockedChannelIds.has(channelId)) || Boolean(categoryId && blockedCategoryIds.has(categoryId));
  const unrestricted = Boolean(channelId && unrestrictedChannelIds.has(channelId)) || Boolean(categoryId && unrestrictedCategoryIds.has(categoryId));
  const hasBroadcastRole = broadcastRoleIds.size > 0 && Boolean(state.member?.roles?.cache?.some(role => broadcastRoleIds.has(role.id)));
  return { blocked, unrestricted, hasBroadcastRole, canBroadcast: broadcastRoleIds.size === 0 || unrestricted || hasBroadcastRole };
}

function pauseSync(code, status, retryAfter) {
  if (Date.now() < syncPausedUntil) return;
  failureStreak += 1;
  const transient = code === 'network_error' || code === 'sync_unavailable';
  lastSnapshots.clear();
  if (transient && failureStreak < TRANSIENT_FAILURE_THRESHOLD) return;
  recoveryPending = true;
  const backoffStreak = transient ? failureStreak - TRANSIENT_FAILURE_THRESHOLD + 1 : failureStreak;
  let delay = Math.min(300_000, 30_000 * 2 ** Math.min(backoffStreak - 1, 4));
  if (status >= 400 && status < 500 && status !== 429) delay = 300_000;
  if (code === 'storage_quota_exceeded') {
    const now = new Date();
    delay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 5) - now.getTime();
  }
  if (retryAfter) {
    const value = /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(value) && value > 0) delay = Math.max(delay, Math.min(value, MAX_COOLDOWN_MS));
  }
  syncPausedUntil = Date.now() + Math.min(delay, MAX_COOLDOWN_MS);
  // Reconcile current Discord state on recovery, never replay old voice events.
  const resume = new Date(syncPausedUntil).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour12: false });
  console.error(`[live-sync] ${code}${status ? ` (HTTP ${status})` : ''}: ${ERROR_LABELS[code]}. Tentativas pausadas até ${resume} (Brasília).`);
}

async function postSigned(payload) {
  if (!enabled() || Date.now() < syncPausedUntil) return false;

  const body = JSON.stringify(payload);
  const timestamp = Date.now().toString();
  const eventId = payload.eventId || crypto.randomUUID();
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${eventId}.${body}`)
    .digest('hex');

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-voice-timestamp': timestamp,
        'x-voice-event-id': eventId,
        'x-voice-key-id': 'primary',
        'x-voice-signature': `sha256=${signature}`,
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const data = await response.json().catch(() => null);
    if (response.ok && data && typeof data === 'object' && data.accepted !== false) {
      if (Array.isArray(data.activeUserIds) && data.activeUserIds.every(id => typeof id === 'string' && /^\d{17,20}$/.test(id))) {
        activeUserIds = new Set(data.activeUserIds);
      }
      return true;
    }
    const code = typeof data?.error === 'string' && Object.hasOwn(ERROR_LABELS, data.error)
      ? data.error : response.status === 429 ? 'rate_limited' : response.status >= 500 ? 'sync_unavailable' : 'unknown_response';
    pauseSync(code, response.status, response.headers?.get('retry-after'));
  } catch {
    pauseSync('network_error', 0, null);
  }

  return false;
}

function voiceMembersForGuild(guild) {
  const channels = new Map();
  for (const userId of activeUserIds) {
    const state = guild.voiceStates.cache.get(userId);
    if (!state?.channelId || state.member?.user?.bot) continue;
    const policy = voicePolicy(state);
    const entry = channels.get(state.channelId) || {
      channelName: state.channel?.name || 'Call do Discord',
      userIds: [],
      broadcasterUserIds: [],
      blocked: policy.blocked,
      unrestricted: policy.unrestricted,
      restricted: broadcastRoleIds.size > 0,
    };
    entry.userIds.push(state.id);
    if (policy.hasBroadcastRole) entry.broadcasterUserIds.push(state.id);
    channels.set(state.channelId, entry);
  }

  return [...channels.entries()].map(([channelId, entry]) => ({
    channelId,
    channelName: entry.channelName,
    userIds: [...new Set(entry.userIds)].sort(),
    broadcasterUserIds: [...new Set(entry.broadcasterUserIds)].sort(),
    blocked: entry.blocked,
    unrestricted: entry.unrestricted,
    restricted: entry.restricted,
  }));
}

async function sendGuildSnapshot(guild, force) {
  const channels = voiceMembersForGuild(guild);
  const serialized = JSON.stringify(channels);
  const previous = lastSnapshots.get(guild.id);
  if (!force && previous?.serialized === serialized && Date.now() - previous.at < SNAPSHOT_INTERVAL_MS) return true;
  const accepted = await postSigned({
    version: 1,
    type: 'snapshot',
    eventId: crypto.randomUUID(),
    instanceId,
    guildId: guild.id,
    channels,
    occurredAt: Date.now(),
  });
  if (accepted) lastSnapshots.set(guild.id, { serialized, at: Date.now() });
  return accepted;
}

async function sendFullSnapshot(force = true) {
  if (!enabled() || !clientRef?.isReady() || polling || Date.now() < syncPausedUntil) return false;
  polling = true;
  try {
    const healthy = await postSigned({
      version: 1,
      type: 'heartbeat',
      eventId: crypto.randomUUID(),
      instanceId,
      discordConnected: true,
      guildCount: [...clientRef.guilds.cache.keys()].filter(guildAllowed).length,
      occurredAt: Date.now(),
    });
    if (!healthy) return false;
    for (const guild of clientRef.guilds.cache.values()) {
      if (!guildAllowed(guild.id)) continue;
      if (!(await sendGuildSnapshot(guild, force))) return false;
    }
    failureStreak = 0;
    if (recoveryPending) console.log('[live-sync] sincronização restabelecida; estado atual das calls reconciliado.');
    recoveryPending = false;
    return true;
  } finally {
    polling = false;
  }
}

async function handleVoiceStateUpdate(oldState, newState) {
  if (!enabled() || oldState.channelId === newState.channelId) return;
  if (newState.member?.user?.bot || oldState.member?.user?.bot) return;
  if (!guildAllowed(newState.guild.id)) return;
  if (!activeUserIds.has(newState.id)) return;

  const policy = voicePolicy(newState);
  await postSigned({
    version: 1,
    type: 'voice_event',
    eventId: crypto.randomUUID(),
    instanceId,
    guildId: newState.guild.id,
    userId: newState.id,
    oldChannelId: oldState.channelId,
    newChannelId: newState.channelId,
    newChannelName: newState.channel?.name || null,
    blocked: policy.blocked,
    unrestricted: policy.unrestricted,
    hasBroadcastRole: policy.hasBroadcastRole,
    canBroadcast: policy.canBroadcast,
    occurredAt: Date.now(),
  });
}

async function start(client) {
  clientRef = client;
  if (!enabled()) {
    console.warn('[live-sync] desativado: configure LIVE_SYNC_SECRET e LIVE_SYNC_URL.');
    return;
  }

  const synchronized = await sendFullSnapshot();
  if (snapshotTimer) clearInterval(snapshotTimer);
  snapshotTimer = setInterval(() => {
    sendFullSnapshot(false).catch(() => pauseSync('sync_unavailable', 0, null));
  }, POLL_INTERVAL_MS);
  snapshotTimer.unref?.();
  if (synchronized) console.log('[live-sync] sincronização ativa com o site da live.');
}

module.exports = {
  enabled,
  handleVoiceStateUpdate,
  sendFullSnapshot,
  start,
};
