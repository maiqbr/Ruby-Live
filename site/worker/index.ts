import { DurableObject } from 'cloudflare:workers';

interface Env {
  ASSETS: Fetcher;
  VOICE_HUB: DurableObjectNamespace<VoiceHub>;
  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  LIVE_SYNC_SECRET: string;
  PUBLIC_ORIGIN: string;
  ALLOWED_GUILD_IDS: string;
  MAINTENANCE_MODE?: string;
}

type VoiceLocation = {
  guildId: string;
  channelId: string;
  channelName: string;
  roomKey: string;
  sessionId: string;
  joinedAt: number;
};

type SessionUser = { id: string; name: string; avatar: string | null; exp: number };
type SocketAttachment = SessionUser & { roomKey: string | null; sessionId: string | null; sharing: boolean; camera?: boolean; windowStartedAt: number; messageCount: number };
type ChannelState = { sessionId: string; roomKey: string; channelName: string; members: string[]; createdAt: number };

const encoder = new TextEncoder();
const MAX_INTERNAL_BODY = 256 * 1024;
const MAX_SOCKET_MESSAGE = 64 * 1024;
const SNOWFLAKE = /^\d{15,22}$/;
const SESSION_COOKIE = '__Host-ruby_live_session';
const OAUTH_STATE_COOKIE = '__Host-ruby_oauth_state';
const OAUTH_VERIFIER_COOKIE = '__Host-ruby_oauth_verifier';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;

function json(value: unknown, status = 200, headers: HeadersInit = {}) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('content-type', 'application/json; charset=utf-8');
  responseHeaders.set('cache-control', 'no-store');
  return new Response(JSON.stringify(value), {
    status,
    headers: responseHeaders,
  });
}

function syncFailure(error: unknown) {
  const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  const validationErrors = new Set(['invalid_guild', 'invalid_user', 'invalid_channel', 'invalid_snapshot', 'invalid_type']);
  if (validationErrors.has(message)) return json({ accepted: false, error: message }, 400);
  // Only identify a daily row quota when the platform error actually says so.
  const rowLimit = /rows?[\s_]+(?:written|read)|(?:read|writ)[a-z]*.*(?:daily|per day)|(?:daily|per day).*(?:read|writ)/i.test(message)
    && /exceed|quota|limit/i.test(message);
  if (rowLimit) {
    const now = new Date();
    const retryAt = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 5);
    const retryAfter = Math.max(1, Math.ceil((retryAt - now.getTime()) / 1000));
    return json({ accepted: false, error: 'storage_quota_exceeded', retryAt: new Date(retryAt).toISOString() }, 503, { 'retry-after': String(retryAfter) });
  }
  // Do not leak SQL details, payloads, or credentials through error messages.
  return json({ accepted: false, error: 'sync_unavailable' }, 503, { 'retry-after': '30' });
}

function base64url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64url(value: string) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function hmac(secret: string, value: string) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

async function verifyHmac(secret: string, value: string, signature: Uint8Array) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, new Uint8Array(signature).buffer, encoder.encode(value));
}

async function makeSession(user: Omit<SessionUser, 'exp'>, secret: string) {
  const payload = base64url(encoder.encode(JSON.stringify({ ...user, exp: Date.now() + SESSION_TTL_MS })));
  const signature = base64url(await hmac(secret, payload));
  return `${payload}.${signature}`;
}

async function readSession(request: Request, secret: string): Promise<SessionUser | null> {
  const token = readCookies(request)[SESSION_COOKIE];
  if (!token || secret.length < 32) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return null;
  try {
    if (!(await verifyHmac(secret, payload, fromBase64url(signature)))) return null;
    const session = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as SessionUser;
    if (!SNOWFLAKE.test(session.id) || typeof session.name !== 'string' || session.exp < Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

function readCookies(request: Request) {
  const result: Record<string, string> = {};
  for (const item of (request.headers.get('cookie') || '').split(';')) {
    const index = item.indexOf('=');
    if (index > 0) result[item.slice(0, index).trim()] = decodeURIComponent(item.slice(index + 1).trim());
  }
  return result;
}

function cookie(name: string, value: string, maxAge: number) {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function clearOauthCookies(headers = new Headers()) {
  headers.append('set-cookie', cookie(OAUTH_STATE_COOKIE, '', 0));
  headers.append('set-cookie', cookie(OAUTH_VERIFIER_COOKIE, '', 0));
  return headers;
}

function methodNotAllowed(allowed: string) {
  return json({ error: 'method_not_allowed' }, 405, { allow: allowed });
}

function publicOrigin(request: Request, env: Env) {
  if (env.PUBLIC_ORIGIN?.startsWith('https://')) return env.PUBLIC_ORIGIN.replace(/\/$/, '');
  return new URL(request.url).origin;
}

function isSameOriginRequest(request: Request, canonicalOrigin: string) {
  const suppliedOrigin = request.headers.get('origin');
  const requestOrigin = new URL(request.url).origin;
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite === 'cross-site') return false;
  if (suppliedOrigin && suppliedOrigin !== 'null') {
    return suppliedOrigin === canonicalOrigin || suppliedOrigin === requestOrigin || fetchSite === 'same-site';
  }
  return fetchSite === null || fetchSite === 'none' || fetchSite === 'same-origin' || fetchSite === 'same-site';
}

function securityHeaders(response: Response) {
  // A resposta 101 carrega internamente o WebSocket da Cloudflare. Reconstruí-la
  // como uma Response comum remove esse vínculo e encerra o upgrade na hora.
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  headers.set('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https://cdn.discordapp.com data:; connect-src 'self' wss:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://discord.com");
  headers.set('referrer-policy', 'no-referrer');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('x-frame-options', 'DENY');
  headers.set('permissions-policy', 'camera=(self), microphone=(), display-capture=(self), geolocation=()');
  headers.set('cross-origin-opener-policy', 'same-origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function hub(env: Env) {
  return env.VOICE_HUB.get(env.VOICE_HUB.idFromName('global'));
}

async function verifyBotRequest(request: Request, secret: string) {
  if (encoder.encode(secret).byteLength < 32) return null;
  const timestamp = request.headers.get('x-voice-timestamp');
  const eventId = request.headers.get('x-voice-event-id');
  const signature = request.headers.get('x-voice-signature');
  const length = Number(request.headers.get('content-length') || 0);
  if (!timestamp || !eventId || !signature?.startsWith('sha256=') || length > MAX_INTERNAL_BODY) return null;
  const time = Number(timestamp);
  if (!Number.isFinite(time) || Math.abs(Date.now() - time) > 30_000 || !/^[0-9a-f-]{16,64}$/i.test(eventId)) return null;
  const body = await request.text();
  if (encoder.encode(body).byteLength > MAX_INTERNAL_BODY) return null;
  const hex = signature.slice(7);
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  const bytes = Uint8Array.from(hex.match(/.{2}/g)!, pair => Number.parseInt(pair, 16));
  if (!(await verifyHmac(secret, `${timestamp}.${eventId}.${body}`, bytes))) return null;
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function randomToken(size = 32) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

export class VoiceHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  private channelKey(guildId: string, channelId: string) {
    return `channel:${guildId}:${channelId}`;
  }

  private async markHeartbeat() {
    const now = Date.now();
    const previous = (await this.ctx.storage.get<number>('heartbeat')) || 0;
    if (now - previous < 30_000) return;
    await this.ctx.storage.put('heartbeat', now);
    await this.ctx.storage.setAlarm(now + 95_000);
  }

  private activeUserIds() {
    return new Set(this.ctx.getWebSockets()
      .filter(socket => socket.readyState === 1)
      .map(socket => socket.deserializeAttachment() as SocketAttachment | null)
      .filter((item): item is SocketAttachment => Boolean(item && item.exp > Date.now()))
      .map(item => item.id));
  }

  private async getVoice(userId: string) {
    return (await this.ctx.storage.get<VoiceLocation>(`user:${userId}`)) || null;
  }

  private socketsInRoom(roomKey: string) {
    return this.ctx.getWebSockets().filter(socket => socket.readyState === 1 && (socket.deserializeAttachment() as SocketAttachment | null)?.roomKey === roomKey);
  }

  private peer(attachment: SocketAttachment) {
    return { id: attachment.id, name: attachment.name, avatar: attachment.avatar, sharing: attachment.sharing, camera: Boolean(attachment.camera) };
  }

  private send(socket: WebSocket, value: unknown) {
    try { socket.send(JSON.stringify(value)); } catch { /* connection already gone */ }
  }

  private broadcast(roomKey: string, value: unknown, exceptUserId?: string) {
    for (const socket of this.socketsInRoom(roomKey)) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (attachment?.id !== exceptUserId) this.send(socket, value);
    }
  }

  private syncRoomRoster(roomKey: string) {
    const sockets = this.socketsInRoom(roomKey);
    const attachments = sockets
      .map(socket => socket.deserializeAttachment() as SocketAttachment | null)
      .filter((item): item is SocketAttachment => Boolean(item));
    for (const socket of sockets) {
      const self = socket.deserializeAttachment() as SocketAttachment | null;
      if (!self) continue;
      this.send(socket, {
        type: 'peers',
        peers: attachments.filter(item => item.id !== self.id).map(item => this.peer(item)),
      });
    }
  }

  private async notifyUser(userId: string) {
    const voice = await this.getVoice(userId);
    const heartbeat = (await this.ctx.storage.get<number>('heartbeat')) || 0;
    const syncHealthy = Date.now() - heartbeat < 90_000;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (socket.readyState !== 1 || attachment?.id !== userId) continue;
      const previousRoom = attachment.roomKey;
      const previousSession = attachment.sessionId;
      const roomChanged = previousRoom !== (voice?.roomKey || null) || previousSession !== (voice?.sessionId || null);
      if (previousRoom && roomChanged) this.broadcast(previousRoom, { type: 'peer_left', userId }, userId);
      attachment.roomKey = voice?.roomKey || null;
      attachment.sessionId = voice?.sessionId || null;
      // A sincronização do bot é periódica. Preserve o estado da transmissão
      // enquanto o usuário continuar exatamente na mesma sessão de voz.
      if (roomChanged) { attachment.sharing = false; attachment.camera = false; }
      socket.serializeAttachment(attachment);
      this.send(socket, { type: 'voice_state', voice: voice ? { roomKey: voice.roomKey, sessionId: voice.sessionId, channelName: voice.channelName } : null, syncHealthy });
      if (voice) {
        const peers = this.socketsInRoom(voice.roomKey)
          .map(item => item.deserializeAttachment() as SocketAttachment | null)
          .filter((item): item is SocketAttachment => Boolean(item && item.id !== userId))
          .map(item => this.peer(item));
        this.send(socket, { type: 'session', selfId: userId, roomKey: voice.roomKey, sessionId: voice.sessionId, channelName: voice.channelName, peers });
        if (roomChanged) this.broadcast(voice.roomKey, { type: 'peer_joined', peer: this.peer(attachment) }, userId);
        this.syncRoomRoster(voice.roomKey);
      }
    }
  }

  private async removeUser(userId: string) {
    const current = await this.getVoice(userId);
    if (!current) return;
    const key = this.channelKey(current.guildId, current.channelId);
    const channel = await this.ctx.storage.get<ChannelState>(key);
    if (channel) {
      channel.members = channel.members.filter(id => id !== userId);
      if (channel.members.length) await this.ctx.storage.put(key, channel);
      else await this.ctx.storage.delete(key);
    }
    await this.ctx.storage.delete(`user:${userId}`);
    await this.notifyUser(userId);
  }

  private async placeUser(guildId: string, channelId: string, userId: string, channelName: string) {
    const current = await this.getVoice(userId);
    if (current?.guildId === guildId && current.channelId === channelId) {
      const key = this.channelKey(guildId, channelId);
      let channel = await this.ctx.storage.get<ChannelState>(key);
      if (channel && channel.channelName === channelName && channel.members.includes(userId)
        && current.channelName === channelName && current.roomKey === channel.roomKey && current.sessionId === channel.sessionId) {
        // A new browser socket may need a session, but unchanged state needs no writes.
        const needsSession = this.ctx.getWebSockets().some(socket => {
          const item = socket.deserializeAttachment() as SocketAttachment | null;
          return item?.id === userId && (item.roomKey !== current.roomKey || item.sessionId !== current.sessionId);
        });
        if (needsSession) await this.notifyUser(userId);
        return;
      }
      if (!channel) {
        channel = { sessionId: current.sessionId, roomKey: current.roomKey, channelName, members: [userId], createdAt: Date.now() };
      } else {
        channel.channelName = channelName;
        if (!channel.members.includes(userId)) channel.members.push(userId);
      }
      await this.ctx.storage.put(key, channel);
      current.channelName = channelName;
      current.roomKey = channel.roomKey;
      current.sessionId = channel.sessionId;
      await this.ctx.storage.put(`user:${userId}`, current);
      await this.notifyUser(userId);
      this.syncRoomRoster(channel.roomKey);
      return;
    }
    if (current) await this.removeUser(userId);
    const key = this.channelKey(guildId, channelId);
    let channel = await this.ctx.storage.get<ChannelState>(key);
    if (!channel) channel = { sessionId: crypto.randomUUID(), roomKey: await randomToken(18), channelName, members: [], createdAt: Date.now() };
    else channel.channelName = channelName;
    if (!channel.members.includes(userId)) channel.members.push(userId);
    await this.ctx.storage.put(key, channel);
    await this.ctx.storage.put(`user:${userId}`, { guildId, channelId, channelName, roomKey: channel.roomKey, sessionId: channel.sessionId, joinedAt: Date.now() } satisfies VoiceLocation);
    await this.notifyUser(userId);
  }

  private validSnowflake(value: unknown): value is string {
    return typeof value === 'string' && SNOWFLAKE.test(value);
  }

  private async applySync(payload: Record<string, unknown>, eventId: string) {
    // Heartbeats are idempotent; HMAC and timestamp checks still run at the edge.
    if (payload.type === 'heartbeat') {
      await this.markHeartbeat();
      return;
    }
    const recent = (await this.ctx.storage.get<string[]>('recentEvents')) || [];
    if (recent.includes(eventId)) return;
    recent.push(eventId);
    if (recent.length > 500) recent.splice(0, recent.length - 500);
    await this.ctx.storage.put('recentEvents', recent);
    const guildId = payload.guildId;
    if (!this.validSnowflake(guildId)) throw new Error('invalid_guild');
    await this.markHeartbeat();

    if (payload.type === 'voice_event') {
      if (!this.validSnowflake(payload.userId)) throw new Error('invalid_user');
      if (!this.activeUserIds().has(payload.userId)) {
        await this.removeUser(payload.userId);
        return;
      }
      if (payload.newChannelId === null) await this.removeUser(payload.userId);
      else if (this.validSnowflake(payload.newChannelId)) {
        const channelName = typeof payload.newChannelName === 'string' && payload.newChannelName.length > 0 && payload.newChannelName.length <= 100 ? payload.newChannelName : 'Call do Discord';
        await this.placeUser(guildId, payload.newChannelId, payload.userId, channelName);
      }
      else throw new Error('invalid_channel');
      return;
    }

    if (payload.type === 'snapshot') {
      if (!Array.isArray(payload.channels) || payload.channels.length > 500) throw new Error('invalid_snapshot');
      const desired = new Map<string, { channelId: string; channelName: string }>();
      const activeUsers = this.activeUserIds();
      for (const raw of payload.channels) {
        if (!raw || typeof raw !== 'object') throw new Error('invalid_snapshot');
        const channel = raw as { channelId?: unknown; channelName?: unknown; userIds?: unknown };
        if (!this.validSnowflake(channel.channelId) || (channel.channelName !== undefined && (typeof channel.channelName !== 'string' || channel.channelName.length < 1 || channel.channelName.length > 100)) || !Array.isArray(channel.userIds) || channel.userIds.length > 100) throw new Error('invalid_snapshot');
        const channelName = typeof channel.channelName === 'string' ? channel.channelName : 'Call do Discord';
        for (const userId of channel.userIds) {
          if (!this.validSnowflake(userId)) throw new Error('invalid_snapshot');
          if (activeUsers.has(userId)) desired.set(userId, { channelId: channel.channelId, channelName });
        }
      }
      const current = await this.ctx.storage.list<VoiceLocation>({ prefix: 'user:' });
      for (const [key, location] of current) {
        if (location.guildId !== guildId) continue;
        const userId = key.slice(5);
        if (!desired.has(userId)) await this.removeUser(userId);
      }
      for (const [userId, channel] of desired) await this.placeUser(guildId, channel.channelId, userId, channel.channelName);
      return;
    }
    throw new Error('invalid_type');
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === '/internal-sync' && request.method === 'POST') {
      const payload = await request.json<Record<string, unknown>>();
      const eventId = request.headers.get('x-event-id') || '';
      try {
        await this.applySync(payload, eventId);
        return json({ accepted: true, eventId, activeUserIds: [...this.activeUserIds()] });
      } catch (error) {
        return syncFailure(error);
      }
    }
    if (url.pathname === '/state') {
      const userId = request.headers.get('x-user-id') || '';
      const voice = await this.getVoice(userId);
      const heartbeat = (await this.ctx.storage.get<number>('heartbeat')) || 0;
      return json({ voice: voice ? { roomKey: voice.roomKey, sessionId: voice.sessionId, channelName: voice.channelName } : null, syncHealthy: Date.now() - heartbeat < 90_000 });
    }
    if (url.pathname === '/health') {
      const heartbeat = (await this.ctx.storage.get<number>('heartbeat')) || 0;
      return json({ operational: Date.now() - heartbeat < 90_000 });
    }
    if (url.pathname === '/ws' && request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const userId = request.headers.get('x-user-id') || '';
      const name = (request.headers.get('x-user-name') || 'Tripulante').slice(0, 80);
      const avatar = request.headers.get('x-user-avatar') || null;
      if (!SNOWFLAKE.test(userId)) return new Response('Unauthorized', { status: 401 });
      const voice = await this.getVoice(userId);
      const heartbeat = (await this.ctx.storage.get<number>('heartbeat')) || 0;
      const healthy = Date.now() - heartbeat < 90_000;
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      // Check after all awaits: admission and registration must not interleave.
      if (this.activeUserIds().has(userId)) {
        server.accept();
        server.close(4009, 'Já existe uma sessão ativa para esta conta');
        return new Response(null, { status: 101, webSocket: client });
      }
      const requestedExpiry = Number(request.headers.get('x-session-exp'));
      const exp = Number.isFinite(requestedExpiry) ? Math.min(requestedExpiry, Date.now() + SESSION_TTL_MS) : Date.now() + SESSION_TTL_MS;
      const attachment: SocketAttachment = { id: userId, name, avatar, exp, roomKey: healthy ? voice?.roomKey || null : null, sessionId: healthy ? voice?.sessionId || null : null, sharing: false, windowStartedAt: Date.now(), messageCount: 0 };
      server.serializeAttachment(attachment);
      this.ctx.acceptWebSocket(server);
      if (!voice || !healthy) this.send(server, { type: 'waiting', syncHealthy: healthy });
      else {
        const peers = this.socketsInRoom(voice.roomKey)
          .map(item => item.deserializeAttachment() as SocketAttachment | null)
          .filter((item): item is SocketAttachment => Boolean(item && item.id !== userId))
          .map(item => this.peer(item));
        this.send(server, { type: 'session', selfId: userId, roomKey: voice.roomKey, sessionId: voice.sessionId, channelName: voice.channelName, peers });
        this.broadcast(voice.roomKey, { type: 'peer_joined', peer: this.peer(attachment) }, userId);
        this.syncRoomRoster(voice.roomKey);
      }
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response('Not found', { status: 404 });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string' || encoder.encode(message).byteLength > MAX_SOCKET_MESSAGE) {
      socket.close(1009, 'Mensagem muito grande');
      return;
    }
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (!attachment || attachment.exp < Date.now()) {
      socket.close(4003, 'Sessão expirada');
      return;
    }
    const now = Date.now();
    if (now - attachment.windowStartedAt > 10_000) {
      attachment.windowStartedAt = now;
      attachment.messageCount = 0;
    }
    attachment.messageCount += 1;
    if (attachment.messageCount > 120) {
      socket.close(4008, 'Limite de mensagens excedido');
      return;
    }
    socket.serializeAttachment(attachment);

    let value: Record<string, unknown>;
    try { value = JSON.parse(message) as Record<string, unknown>; } catch { return; }
    if (value.type === 'session_keepalive') {
      attachment.exp = Date.now() + SESSION_TTL_MS;
      socket.serializeAttachment(attachment);
      return;
    }
    const voice = await this.getVoice(attachment.id);
    const heartbeat = (await this.ctx.storage.get<number>('heartbeat')) || 0;
    if (Date.now() - heartbeat >= 90_000) {
      socket.close(4002, 'Sincronização com o Discord indisponível');
      return;
    }
    if (!voice || voice.roomKey !== attachment.roomKey || voice.sessionId !== attachment.sessionId) {
      this.send(socket, { type: 'error', code: 'not_in_voice', message: 'Você não está mais nesta call.' });
      return;
    }

    if (value.type === 'camera_state' && typeof value.camera === 'boolean') {
      attachment.camera = value.camera;
      socket.serializeAttachment(attachment);
      this.broadcast(voice.roomKey, { type: 'camera_state', userId: attachment.id, camera: value.camera }, attachment.id);
      return;
    }
    if (value.media !== undefined && value.media !== 'screen' && value.media !== 'camera') return;
    const media = value.media === 'camera' ? 'camera' : 'screen';
    if (value.type === 'share_state' && typeof value.sharing === 'boolean') {
      attachment.sharing = value.sharing;
      socket.serializeAttachment(attachment);
      this.broadcast(voice.roomKey, { type: 'share_state', userId: attachment.id, sharing: value.sharing }, attachment.id);
      return;
    }
    if (value.type === 'watch_state' && typeof value.to === 'string' && typeof value.watching === 'boolean') {
      const targetVoice = await this.getVoice(value.to);
      if (!targetVoice || targetVoice.roomKey !== voice.roomKey || targetVoice.sessionId !== voice.sessionId) return;
      const target = this.socketsInRoom(voice.roomKey).find(item => (item.deserializeAttachment() as SocketAttachment | null)?.id === value.to);
      if (target) this.send(target, { type: 'watch_state', from: attachment.id, watching: value.watching, media });
      return;
    }
    if (value.type !== 'signal' || typeof value.to !== 'string' || !value.data || typeof value.data !== 'object') return;
    const targetVoice = await this.getVoice(value.to);
    if (!targetVoice || targetVoice.roomKey !== voice.roomKey || targetVoice.sessionId !== voice.sessionId) return;
    const data = value.data as Record<string, unknown>;
    if (data.kind === 'description') {
      const description = data.description as { type?: unknown; sdp?: unknown } | undefined;
      if (!description || !['offer', 'answer'].includes(String(description.type)) || typeof description.sdp !== 'string' || description.sdp.length > 32_000) return;
    } else if (data.kind === 'candidate') {
      const candidate = data.candidate as { candidate?: unknown } | undefined;
      if (!candidate || typeof candidate.candidate !== 'string' || candidate.candidate.length > 2_000) return;
    } else return;
    const target = this.socketsInRoom(voice.roomKey).find(item => (item.deserializeAttachment() as SocketAttachment | null)?.id === value.to);
    if (target) this.send(target, { type: 'signal', from: attachment.id, data, media });
  }

  webSocketClose(socket: WebSocket) {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (attachment && this.ctx.getWebSockets().some(other => other !== socket && other.readyState === 1
      && (other.deserializeAttachment() as SocketAttachment | null)?.id === attachment.id)) return;
    if (attachment?.roomKey) this.broadcast(attachment.roomKey, { type: 'peer_left', userId: attachment.id }, attachment.id);
  }

  async alarm() {
    const heartbeat = (await this.ctx.storage.get<number>('heartbeat')) || 0;
    if (Date.now() - heartbeat < 90_000) {
      await this.ctx.storage.setAlarm(heartbeat + 95_000);
      return;
    }
    for (const socket of this.ctx.getWebSockets()) socket.close(4002, 'Sincronização com o Discord indisponível');
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = publicOrigin(request, env);
    let response: Response;

    if (url.pathname.startsWith('/api/')) {
      const secretReady = (value: string) => encoder.encode(value || '').byteLength >= 32 && !value.includes('INSIRA_');
      const guilds = (env.ALLOWED_GUILD_IDS || '').split(',').map(id => id.trim());
      if (!secretReady(env.LIVE_SYNC_SECRET) || !secretReady(env.SESSION_SECRET)
          || !/^\d{17,20}$/.test(env.DISCORD_CLIENT_ID || '')
          || !env.DISCORD_CLIENT_SECRET || env.DISCORD_CLIENT_SECRET.includes('INSIRA_')
          || !guilds.every(id => /^\d{17,20}$/.test(id))
          || !/^https:\/\/[^/]+\/?$/.test(env.PUBLIC_ORIGIN || '')
          || env.PUBLIC_ORIGIN.includes('example.com')) {
        return securityHeaders(json({ error: 'service_unavailable' }, 503));
      }
    }

    if (url.pathname === '/api/internal/voice-sync') {
      if (request.method !== 'POST') response = methodNotAllowed('POST');
      else if (encoder.encode(env.LIVE_SYNC_SECRET || '').byteLength < 32) response = json({ error: 'service_unavailable' }, 503);
      else {
        const payload = await verifyBotRequest(request, env.LIVE_SYNC_SECRET);
        if (!payload) response = json({ error: 'unauthorized' }, 401);
        else {
          const allowed = new Set((env.ALLOWED_GUILD_IDS || '').split(',').map(id => id.trim()).filter(Boolean));
          if (payload.type !== 'heartbeat' && (typeof payload.guildId !== 'string' || (allowed.size && !allowed.has(payload.guildId)))) response = json({ error: 'guild_not_allowed' }, 403);
          else {
            const eventId = typeof payload.eventId === 'string' ? payload.eventId : '';
            try {
              response = await hub(env).fetch(new Request('https://internal/internal-sync', { method: 'POST', headers: { 'content-type': 'application/json', 'x-event-id': eventId }, body: JSON.stringify(payload) }));
            } catch (error) {
              response = syncFailure(error);
            }
          }
        }
      }
    } else if (url.pathname === '/api/auth/discord' && request.method !== 'GET') {
      response = methodNotAllowed('GET');
    } else if (url.pathname === '/api/auth/discord') {
      const state = await randomToken();
      const verifier = await randomToken(48);
      const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))));
      const callback = `${origin}/api/auth/callback`;
      const authorize = new URL('https://discord.com/oauth2/authorize');
      authorize.search = new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, response_type: 'code', redirect_uri: callback, scope: 'identify', state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
      const headers = new Headers({ location: authorize.toString(), 'cache-control': 'no-store' });
      headers.append('set-cookie', cookie(OAUTH_STATE_COOKIE, state, 600));
      headers.append('set-cookie', cookie(OAUTH_VERIFIER_COOKIE, verifier, 600));
      response = new Response(null, { status: 302, headers });
    } else if (url.pathname === '/api/auth/callback' && request.method !== 'GET') {
      response = methodNotAllowed('GET');
    } else if (url.pathname === '/api/auth/callback') {
      const cookies = readCookies(request);
      const state = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      const clearedHeaders = clearOauthCookies();
      if (!state || !code || state !== cookies[OAUTH_STATE_COOKIE] || !cookies[OAUTH_VERIFIER_COOKIE]) response = json({ error: 'invalid_oauth_state' }, 400, clearedHeaders);
      else {
        const clientCredentials = btoa(`${env.DISCORD_CLIENT_ID}:${env.DISCORD_CLIENT_SECRET}`);
        const tokenResponse = await fetch('https://discord.com/api/v10/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${clientCredentials}` }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: `${origin}/api/auth/callback`, code_verifier: cookies[OAUTH_VERIFIER_COOKIE] }) });
        if (!tokenResponse.ok) {
          const discordError: { error?: unknown } = await tokenResponse.json<{ error?: unknown }>().catch(() => ({}));
          const discordCode = typeof discordError.error === 'string' && /^[a-z_]{3,40}$/.test(discordError.error) ? discordError.error : 'unknown';
          response = json({ error: 'discord_token_failed', discordCode }, 502, clearedHeaders);
        }
        else {
          const token = await tokenResponse.json<{ access_token: string }>();
          const userResponse = await fetch('https://discord.com/api/v10/users/@me', { headers: { authorization: `Bearer ${token.access_token}` } });
          if (!userResponse.ok) response = json({ error: 'discord_user_failed' }, 502, clearedHeaders);
          else {
            const user = await userResponse.json<{ id: string; username: string; global_name?: string | null; avatar?: string | null }>();
            const session = await makeSession({ id: user.id, name: (user.global_name || user.username).slice(0, 80), avatar: user.avatar || null }, env.SESSION_SECRET);
            const headers = new Headers({ location: '/', 'cache-control': 'no-store' });
            headers.append('set-cookie', cookie(SESSION_COOKIE, session, SESSION_TTL_SECONDS));
            clearOauthCookies(headers);
            response = new Response(null, { status: 302, headers });
          }
        }
      }
    } else if (url.pathname === '/api/session/refresh' && request.method !== 'POST') {
      response = methodNotAllowed('POST');
    } else if (url.pathname === '/api/session/refresh') {
      if (!isSameOriginRequest(request, origin)) response = json({ error: 'invalid_origin' }, 403);
      else {
        const current = await readSession(request, env.SESSION_SECRET || '');
        if (!current) response = json({ authenticated: false }, 401);
        else {
          const session = await makeSession({ id: current.id, name: current.name, avatar: current.avatar }, env.SESSION_SECRET);
          const headers = new Headers();
          headers.append('set-cookie', cookie(SESSION_COOKIE, session, SESSION_TTL_SECONDS));
          response = json({ authenticated: true }, 200, headers);
        }
      }
    } else if (url.pathname === '/api/logout' && request.method === 'POST') {
      if (!isSameOriginRequest(request, origin)) response = json({ error: 'invalid_origin' }, 403);
      else response = new Response(null, { status: 303, headers: { location: '/', 'set-cookie': cookie(SESSION_COOKIE, '', 0) } });
    } else if (url.pathname === '/api/me') {
      const session = await readSession(request, env.SESSION_SECRET || '');
      if (!session) response = json({ authenticated: false });
      else {
        const state = await hub(env).fetch(new Request('https://internal/state', { headers: { 'x-user-id': session.id } }));
        const voice = await state.json<{ voice: VoiceLocation | null; syncHealthy: boolean }>();
        response = json({ authenticated: true, user: { id: session.id, name: session.name, avatar: session.avatar }, voice: voice.voice, syncHealthy: voice.syncHealthy });
      }
    } else if (url.pathname === '/api/health' && request.method !== 'GET') {
      response = methodNotAllowed('GET');
    } else if (url.pathname === '/api/health') {
      const configured = env.MAINTENANCE_MODE !== 'true'
        && encoder.encode(env.LIVE_SYNC_SECRET || '').byteLength >= 32
        && encoder.encode(env.SESSION_SECRET || '').byteLength >= 32
        && Boolean(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET);
      if (!configured) response = json({ operational: false });
      else {
        try {
          const health = await hub(env).fetch(new Request('https://internal/health'));
          const status = await health.json<{ operational?: boolean }>();
          response = json({ operational: health.ok && status.operational === true });
        } catch {
          response = json({ operational: false });
        }
      }
    } else if (url.pathname === '/api/ws' && request.method !== 'GET') {
      response = methodNotAllowed('GET');
    } else if (url.pathname === '/api/ws') {
      const session = await readSession(request, env.SESSION_SECRET || '');
      if (!session) response = new Response('Unauthorized', { status: 401 });
      else if (request.headers.get('origin') !== origin) response = new Response('Forbidden', { status: 403 });
      else if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') response = new Response('Upgrade Required', { status: 426 });
      else {
        const headers = new Headers(request.headers);
        headers.set('x-user-id', session.id);
        headers.set('x-user-name', session.name);
        headers.set('x-session-exp', String(session.exp));
        if (session.avatar) headers.set('x-user-avatar', session.avatar);
        response = await hub(env).fetch(new Request('https://internal/ws', { headers }));
      }
    } else if (url.pathname.startsWith('/api/')) {
      response = json({ error: 'not_found' }, 404);
    } else {
      response = await env.ASSETS.fetch(request);
    }

    return securityHeaders(response);
  },
} satisfies ExportedHandler<Env>;
