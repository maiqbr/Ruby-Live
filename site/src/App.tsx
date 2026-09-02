import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BadgeCheck,
  CircleStop,
  LayoutGrid,
  LogOut,
  Maximize,
  Maximize2,
  Minimize2,
  MonitorUp,
  Radio,
  ShieldCheck,
  Volume2,
  VolumeX,
  WifiOff,
  Video,
  VideoOff,
  SlidersHorizontal,
  ChevronDown,
  ChevronUp,
  RefreshCw,
} from 'lucide-react';
import { cameraConstraints, exactCameraVideoConstraints, prepareScreenTrack, syncOutgoingTracks, type MediaKind, type CameraQuality, type CameraFps } from './media';
import { CameraTile } from './CameraTile';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverTrigger, PopoverContent, PopoverTitle, PopoverDescription } from '@/components/ui/popover';

type User = { id: string; name: string; avatar: string | null };
type VoiceRoom = { roomKey: string; sessionId: string; channelName?: string };
type Me = { authenticated: boolean; user?: User; voice?: VoiceRoom | null; syncHealthy?: boolean };
type Peer = User & { sharing?: boolean; camera?: boolean };
type SocketMessage =
  | { type: 'waiting'; syncHealthy: boolean }
  | { type: 'session'; selfId: string; roomKey: string; sessionId: string; channelName?: string; peers: Peer[] }
  | { type: 'voice_state'; voice: VoiceRoom | null; syncHealthy: boolean }
  | { type: 'peer_joined'; peer: Peer }
  | { type: 'peer_left'; userId: string }
  | { type: 'peers'; peers: Peer[] }
  | { type: 'share_state'; userId: string; sharing: boolean }
  | { type: 'camera_state'; userId: string; camera: boolean }
  | { type: 'watch_state'; from: string; watching: boolean; media?: MediaKind }
  | { type: 'signal'; from: string; data: SignalData; media?: MediaKind }
  | { type: 'error'; code: string; message: string };
type SignalData =
  | { kind: 'description'; description: RTCSessionDescriptionInit }
  | { kind: 'candidate'; candidate: RTCIceCandidateInit };

type PeerState = {
  pc: RTCPeerConnection;
  media: MediaKind;
  makingOffer: boolean;
  ignoreOffer: boolean;
  settingRemoteAnswer: boolean;
  pendingCandidates: RTCIceCandidateInit[];
  restartAttempts: number;
};

type StreamQuality = '480' | '720' | '1080';
type ScreenLayout = 'auto' | 'grid' | 'theater' | 'row' | 'list';
type PlaybackStats = { width?: number; height?: number; fps?: number; bitrate?: number; limited: boolean };
const QUALITY_PRESETS: Record<StreamQuality, { width: number; height: number; label: string }> = {
  '480': { width: 854, height: 480, label: '480p' },
  '720': { width: 1280, height: 720, label: '720p' },
  '1080': { width: 1920, height: 1080, label: '1080p' },
};

const ICE_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

function avatarUrl(user: User) {
  return user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
    : null;
}

function waitingAvatarUrl(user: User) {
  const defaultIndex = Number((BigInt(user.id) >> BigInt(22)) % BigInt(6));
  return avatarUrl(user) || `https://cdn.discordapp.com/embed/avatars/${defaultIndex}.png`;
}

function StatsBadge({ stats }: { stats?: PlaybackStats }) {
  if (!stats) return null;
  const parts = [stats.width && stats.height ? `${stats.width}×${stats.height}` : '', stats.fps ? `${Math.round(stats.fps)} FPS` : '', stats.bitrate ? `${stats.bitrate.toFixed(1)} Mbps` : ''].filter(Boolean);
  return <span className={stats.limited ? 'stream-stats limited' : 'stream-stats'} title={stats.limited ? 'A conexão ou o computador pode estar reduzindo a reprodução.' : 'Qualidade recebida neste navegador'}>{parts.join(' · ') || 'Analisando qualidade…'}</span>;
}

function VideoTile({ peer, stream, watching, focused, stats, onToggle, onFocus }: { peer: Peer; stream?: MediaStream; watching: boolean; focused: boolean; stats?: PlaybackStats; onToggle: () => void; onFocus: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const tileRef = useRef<HTMLElement>(null);
  const [muted, setMuted] = useState(true);
  const [videoReady, setVideoReady] = useState(false);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream || null;
    setVideoReady(false);
    video.muted = true;
    setMuted(true);
    if (stream) void video.play().then(() => { if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) setVideoReady(true); }).catch(() => undefined);
  }, [stream]);

  const toggleAudio = () => {
    const video = videoRef.current;
    if (!video) return;
    const nextMuted = !video.muted;
    video.muted = nextMuted;
    setMuted(nextMuted);
    void video.play().catch(() => {
      video.muted = true;
      setMuted(true);
    });
  };

  return (
    <article ref={tileRef} className={focused ? 'video-tile focused' : 'video-tile'}>
      {stream ? (
        <video ref={videoRef} autoPlay playsInline muted={muted} onLoadedMetadata={() => setVideoReady(true)} onLoadedData={() => setVideoReady(true)} onPlaying={() => setVideoReady(true)} onCanPlay={() => setVideoReady(true)} onTimeUpdate={() => setVideoReady(true)} onWaiting={() => setVideoReady(false)} onStalled={() => setVideoReady(false)} />
      ) : (
        <div className="video-empty">
          <span className="avatar avatar-large">
            {avatarUrl(peer) ? <img src={avatarUrl(peer)!} alt="" /> : peer.name.slice(0, 1).toUpperCase()}
          </span>
          <p>{watching ? 'Conectando à transmissão…' : 'Transmissão disponível'}</p>
        </div>
      )}
      {stream && !videoReady && <div className="media-loading" role="status"><span className="loader" /><span>Carregando transmissão…</span></div>}
      {stream && <StatsBadge stats={stats} />}
      <div className="tile-caption">
        <span className={peer.sharing ? 'live-dot active' : 'live-dot'} />
        <strong>{peer.name}</strong>
        {peer.sharing && <span>ao vivo</span>}
        <button className={watching ? 'watch-toggle active' : 'watch-toggle'} type="button" onClick={onToggle}>
          {watching ? 'Parar de assistir' : 'Assistir'}
        </button>
        {watching && <button className="view-toggle" type="button" onClick={onFocus} title={focused ? 'Voltar para a grade' : 'Destacar transmissão'}>{focused ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>}
        {stream && <button className="view-toggle" type="button" onClick={() => void tileRef.current?.requestFullscreen()} title="Tela cheia" aria-label="Tela cheia"><Maximize size={15} /></button>}
        {stream && (
          <button className="audio-toggle" type="button" onClick={toggleAudio} title={muted ? 'Ativar áudio' : 'Silenciar'}>
            {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
            <span>{muted ? 'Ativar áudio' : 'Áudio ligado'}</span>
          </button>
        )}
      </div>
    </article>
  );
}

function LocalVideoTile({ stream, focused, stats, onFocus, onStop }: { stream: MediaStream; focused: boolean; stats?: PlaybackStats; onFocus: () => void; onStop: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const tileRef = useRef<HTMLElement>(null);
  const [previewVisible, setPreviewVisible] = useState(true);
  const [videoReady, setVideoReady] = useState(false);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    setVideoReady(false);
    void video.play().then(() => { if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) setVideoReady(true); }).catch(() => undefined);
    // Detach only the preview; never stop the tracks being sent to viewers.
    return () => { video.pause(); video.srcObject = null; };
  }, [stream, previewVisible]);
  return (
    <article ref={tileRef} className={`video-tile local-tile${focused ? ' focused' : ''}`}>
      {previewVisible ? <video ref={videoRef} autoPlay playsInline muted onLoadedMetadata={() => setVideoReady(true)} onLoadedData={() => setVideoReady(true)} onPlaying={() => setVideoReady(true)} onCanPlay={() => setVideoReady(true)} onTimeUpdate={() => setVideoReady(true)} onWaiting={() => setVideoReady(false)} onStalled={() => setVideoReady(false)} /> : <div className="video-empty"><MonitorUp size={32} /><p>Prévia oculta · você continua transmitindo</p></div>}
      {previewVisible && !videoReady && <div className="media-loading" role="status"><span className="loader" /><span>Preparando prévia…</span></div>}
      {previewVisible && <StatsBadge stats={stats} />}
      <div className="tile-caption local-caption">
        <span className="live-dot active" /><strong>Sua transmissão</strong><span>ao vivo</span>
        <button className="watch-toggle" type="button" onClick={() => setPreviewVisible(current => !current)} title="Altera somente a sua prévia, sem interromper a transmissão">{previewVisible ? 'Ocultar prévia' : 'Mostrar prévia'}</button>
        <button className="view-toggle" type="button" onClick={onFocus} title={focused ? 'Voltar para a grade' : 'Destacar transmissão'} aria-label={focused ? 'Voltar para a grade' : 'Destacar sua transmissão'}>{focused ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
        {previewVisible && <button className="view-toggle" type="button" onClick={() => void tileRef.current?.requestFullscreen().catch(() => undefined)} title="Tela cheia" aria-label="Sua transmissão em tela cheia"><Maximize size={15} /></button>}
        <button className="watch-toggle stop-local-share" type="button" onClick={onStop} title="Encerrar a transmissão para todos"><CircleStop size={14} /> Parar transmissão</button>
      </div>
    </article>
  );
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [peers, setPeers] = useState<Record<string, Peer>>({});
  const [streams, setStreams] = useState<Record<string, MediaStream>>({});
  const [watching, setWatching] = useState<Record<string, boolean>>({});
  const [focusedPeerId, setFocusedPeerId] = useState<string | null>(null);
  const [screenLayout, setScreenLayout] = useState<ScreenLayout>('auto');
  const [screenStats, setScreenStats] = useState<Record<string, PlaybackStats>>({});
  const [sharing, setSharing] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [serviceOnline, setServiceOnline] = useState<boolean | null>(null);
  const [streamQuality, setStreamQuality] = useState<StreamQuality>('720');
  const [streamFps, setStreamFps] = useState<15 | 30 | 60>(30);
  const [notice, setNotice] = useState<string | null>(null);
  const [socketEpoch, setSocketEpoch] = useState(0);
  const [duplicateSession, setDuplicateSession] = useState(false);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [cameraStreams, setCameraStreams] = useState<Record<string, MediaStream>>({});
  const [watchingCameras, setWatchingCameras] = useState<Record<string, boolean>>({});
  const [cameraDevices, setCameraDevices] = useState<MediaDeviceInfo[]>([]);
  const [cameraDeviceId, setCameraDeviceId] = useState('');
  const [cameraQuality, setCameraQuality] = useState<CameraQuality>(360);
  const [cameraFps, setCameraFps] = useState<CameraFps>(15);
  const [cameraActual, setCameraActual] = useState('');
  const [cameraBusy, setCameraBusy] = useState(false);
  const [cameraLayout, setCameraLayout] = useState<'auto' | 'strip' | 'grid' | 'spotlight'>('auto');
  const [cameraStats, setCameraStats] = useState<Record<string, PlaybackStats>>({});
  const [camerasMinimized, setCamerasMinimized] = useState(false);
  const [screensMinimized, setScreensMinimized] = useState(false);
  const [focusedCameraId, setFocusedCameraId] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const selfIdRef = useRef<string | null>(null);
  const peerConnections = useRef(new Map<string, PeerState>());
  const localStreamRef = useRef<MediaStream | null>(null);
  const subscribersRef = useRef(new Set<string>());
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const cameraConnections = useRef(new Map<string, PeerState>());
  const cameraSubscribersRef = useRef(new Set<string>());
  const watchingRef = useRef<Record<string, boolean>>({});
  const watchingCamerasRef = useRef<Record<string, boolean>>({});
  const cameraRequestRef = useRef(0);
  const roomRef = useRef<string | null>(null);
  const statsHistoryRef = useRef(new Map<string, { bytes: number; packets: number; lost: number; at: number }>());
  const reconnectAttemptsRef = useRef(0);
  const lastSessionRefreshRef = useRef(Date.now());

  const send = useCallback((message: unknown) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }, []);

  const closePeer = useCallback((peerId: string) => {
    for (const connections of [peerConnections.current, cameraConnections.current]) {
      const pc = connections.get(peerId)?.pc;
      if (pc) { pc.onconnectionstatechange = null; pc.onnegotiationneeded = null; pc.close(); }
      connections.delete(peerId);
    }
    subscribersRef.current.delete(peerId);
    cameraSubscribersRef.current.delete(peerId);
    setWatchingCameras(current => ({ ...current, [peerId]: false }));
    setFocusedCameraId(current => current === peerId ? null : current);
    setCameraStreams(current => { const next = { ...current }; delete next[peerId]; return next; });
    setStreams(current => {
      if (!current[peerId]) return current;
      const next = { ...current };
      delete next[peerId];
      return next;
    });
  }, []);

  const negotiatePeer = useCallback(async (peerId: string, state: PeerState) => {
    const { pc } = state;
    if (state.makingOffer || pc.signalingState !== 'stable') return;
    try {
      state.makingOffer = true;
      await pc.setLocalDescription(await pc.createOffer());
      send({ type: 'signal', to: peerId, media: state.media, data: { kind: 'description', description: pc.localDescription } });
    } catch {
      setNotice('Não foi possível negociar uma conexão direta.');
    } finally {
      state.makingOffer = false;
    }
  }, [send]);

  const ensurePeer = useCallback((peerId: string, media: MediaKind = 'screen') => {
    const connections = media === 'camera' ? cameraConnections.current : peerConnections.current;
    const subscribers = media === 'camera' ? cameraSubscribersRef.current : subscribersRef.current;
    const local = media === 'camera' ? cameraStreamRef.current : localStreamRef.current;
    const existing = connections.get(peerId);
    if (existing) return existing;

    const pc = new RTCPeerConnection(ICE_CONFIG);
    const state: PeerState = { pc, media, makingOffer: false, ignoreOffer: false, settingRemoteAnswer: false, pendingCandidates: [], restartAttempts: 0 };
    connections.set(peerId, state);

    syncOutgoingTracks(pc, local, subscribers.has(peerId));

    pc.onicecandidate = event => {
      if (event.candidate) {
        send({ type: 'signal', to: peerId, media, data: { kind: 'candidate', candidate: event.candidate.toJSON() } });
      }
    };
    pc.ontrack = event => {
      const stream = event.streams[0] || new MediaStream([event.track]);
      const publish = media === 'camera' ? setCameraStreams : setStreams;
      publish(current => ({ ...current, [peerId]: stream }));
    };
    pc.onnegotiationneeded = () => { void negotiatePeer(peerId, state); };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') state.restartAttempts = 0;
      if (pc.connectionState === 'failed' && state.restartAttempts < 6) {
        state.restartAttempts += 1;
        window.setTimeout(() => {
          if (pc.connectionState !== 'failed' || pc.signalingState === 'closed') return;
          pc.restartIce();
          void negotiatePeer(peerId, state);
        }, Math.min(1_000 * state.restartAttempts, 5_000));
      } else if (pc.connectionState === 'closed') {
        closePeer(peerId);
      }
    };
    if (subscribers.has(peerId) && local?.getTracks().length) {
      queueMicrotask(() => void negotiatePeer(peerId, state));
    }
    return state;
  }, [closePeer, negotiatePeer, send]);

  const handleSignal = useCallback(async (from: string, data: SignalData, media: MediaKind = 'screen') => {
    const state = ensurePeer(from, media);
    const { pc } = state;
    try {
      if (data.kind === 'description') {
        const description = data.description;
        const readyForOffer = !state.makingOffer && (pc.signalingState === 'stable' || state.settingRemoteAnswer);
        const collision = description.type === 'offer' && !readyForOffer;
        const polite = (selfIdRef.current || '') > from;
        state.ignoreOffer = !polite && collision;
        if (state.ignoreOffer) return;

        state.settingRemoteAnswer = description.type === 'answer';
        if (collision) await pc.setLocalDescription({ type: 'rollback' });
        await pc.setRemoteDescription(description);
        state.settingRemoteAnswer = false;
        for (const candidate of state.pendingCandidates.splice(0)) {
          await pc.addIceCandidate(candidate);
        }
        if (description.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer());
          send({ type: 'signal', to: from, media, data: { kind: 'description', description: pc.localDescription } });
        }
      } else if (data.kind === 'candidate') {
        if (!pc.remoteDescription) {
          state.pendingCandidates.push(data.candidate);
          return;
        }
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (error) {
          if (!state.ignoreOffer) throw error;
        }
      }
    } catch {
      setNotice('Uma conexão P2P falhou. Em redes restritas isso pode acontecer.');
    }
  }, [ensurePeer, send]);

  const updateSubscriber = useCallback(async (peerId: string, shouldWatch: boolean, media: MediaKind = 'screen') => {
    const subscribers = media === 'camera' ? cameraSubscribersRef.current : subscribersRef.current;
    if (shouldWatch) subscribers.add(peerId);
    else subscribers.delete(peerId);
    const stream = media === 'camera' ? cameraStreamRef.current : localStreamRef.current;
    if (!stream) return;
    const state = ensurePeer(peerId, media);
    syncOutgoingTracks(state.pc, stream, shouldWatch);
    await negotiatePeer(peerId, state);
    if (shouldWatch) {
      window.setTimeout(() => {
        if (!subscribers.has(peerId) || !stream.getTracks().some(track => track.readyState === 'live')) return;
        syncOutgoingTracks(state.pc, stream, true);
        void negotiatePeer(peerId, state);
      }, 1_000);
    }
  }, [ensurePeer, negotiatePeer]);

  const stopCamera = useCallback(() => {
    cameraRequestRef.current += 1;
    const stream = cameraStreamRef.current;
    cameraStreamRef.current = null;
    for (const track of stream?.getTracks() || []) track.stop();
    for (const { pc } of cameraConnections.current.values()) syncOutgoingTracks(pc, null, false);
    cameraSubscribersRef.current.clear();
    setCameraStream(null);
    setCameraBusy(false);
    setFocusedCameraId(current => current === 'self' ? null : current);
    if (stream) send({ type: 'camera_state', camera: false });
  }, [send]);

  const stopRoomMedia = useCallback(() => {
    stopCamera();
    for (const id of new Set([...peerConnections.current.keys(), ...cameraConnections.current.keys()])) closePeer(id);
    for (const track of localStreamRef.current?.getTracks() || []) track.stop();
    localStreamRef.current = null;
    setLocalStream(null);
    setSharing(false);
    setWatching({});
    setWatchingCameras({});
    setFocusedPeerId(null);
    setFocusedCameraId(null);
    setStreams({});
    setCameraStreams({});
  }, [closePeer, stopCamera]);

  const resetPeerConnections = useCallback(() => {
    for (const connections of [peerConnections.current, cameraConnections.current]) {
      for (const { pc } of connections.values()) {
        pc.onconnectionstatechange = null;
        pc.onnegotiationneeded = null;
        pc.close();
      }
      connections.clear();
    }
    subscribersRef.current.clear();
    cameraSubscribersRef.current.clear();
    setStreams({});
    setCameraStreams({});
  }, []);

  useEffect(() => { watchingRef.current = watching; }, [watching]);
  useEffect(() => { watchingCamerasRef.current = watchingCameras; }, [watchingCameras]);

  const refreshCameraDevices = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setCameraDevices(devices.filter(device => device.kind === 'videoinput'));
    } catch { /* The capture prompt will explain permission/device errors. */ }
  }, []);

  useEffect(() => {
    if (!me?.authenticated || !navigator.mediaDevices) return;
    let active = true;
    void navigator.mediaDevices.enumerateDevices().then(devices => {
      if (active) setCameraDevices(devices.filter(device => device.kind === 'videoinput'));
    }).catch(() => undefined);
    navigator.mediaDevices.addEventListener('devicechange', refreshCameraDevices);
    return () => { active = false; navigator.mediaDevices.removeEventListener('devicechange', refreshCameraDevices); };
  }, [me?.authenticated, refreshCameraDevices]);

  useEffect(() => {
    fetch('/api/me', { credentials: 'include' })
      .then(response => response.json() as Promise<Me>)
      .then(setMe)
      .catch(() => setMe({ authenticated: false }));
  }, []);

  useEffect(() => {
    if (!me?.authenticated) return;
    let active = true;
    const refresh = async () => {
      if (Date.now() - lastSessionRefreshRef.current < 3 * 60 * 60 * 1000) return;
      try {
        const response = await fetch('/api/session/refresh', { method: 'POST', credentials: 'include' });
        if (!active) return;
        if (response.status === 401) {
          setMe({ authenticated: false });
          setNotice('Sua sessão expirou. Entre novamente com o Discord.');
          return;
        }
        if (response.ok) {
          lastSessionRefreshRef.current = Date.now();
          send({ type: 'session_keepalive' });
        }
      } catch { /* Uma queda temporária será tratada pelo WebSocket. */ }
    };
    const timer = window.setInterval(refresh, 4 * 60 * 60 * 1000);
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { active = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [me?.authenticated, send]);

  useEffect(() => {
    const track = localStreamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const preset = QUALITY_PRESETS[streamQuality];
    void track.applyConstraints({
      width: { ideal: preset.width },
      height: { ideal: preset.height },
      frameRate: { ideal: streamFps, max: streamFps },
    }).catch(() => setNotice('O navegador não conseguiu aplicar essa qualidade durante a transmissão.'));
  }, [streamQuality, streamFps]);

  useEffect(() => {
    let active = true;
    const collect = async (media: MediaKind, connections: Map<string, PeerState>, activeStreams: Record<string, MediaStream>) => {
      const result: Record<string, PlaybackStats> = {};
      await Promise.all(Object.keys(activeStreams).map(async peerId => {
        const pc = connections.get(peerId)?.pc;
        if (!pc) return;
        const report = await pc.getStats().catch(() => null);
        report?.forEach(raw => {
          const stat = raw as RTCInboundRtpStreamStats & { mediaType?: string; frameWidth?: number; frameHeight?: number; framesPerSecond?: number; bytesReceived?: number; packetsReceived?: number; packetsLost?: number };
          if (stat.type !== 'inbound-rtp' || (stat.kind || stat.mediaType) !== 'video') return;
          const key = `${media}:${peerId}`;
          const now = stat.timestamp || performance.now();
          const bytes = stat.bytesReceived || 0;
          const packets = stat.packetsReceived || 0;
          const lost = stat.packetsLost || 0;
          const previous = statsHistoryRef.current.get(key);
          const seconds = previous ? (now - previous.at) / 1000 : 0;
          const bitrate = previous && seconds > 0 ? Math.max(0, (bytes - previous.bytes) * 8 / seconds / 1_000_000) : undefined;
          const packetDelta = previous ? Math.max(0, packets - previous.packets) : 0;
          const lostDelta = previous ? Math.max(0, lost - previous.lost) : 0;
          const loss = packetDelta + lostDelta > 0 ? lostDelta / (packetDelta + lostDelta) : 0;
          statsHistoryRef.current.set(key, { bytes, packets, lost, at: now });
          result[peerId] = { width: stat.frameWidth, height: stat.frameHeight, fps: stat.framesPerSecond, bitrate, limited: loss > 0.05 || (typeof stat.framesPerSecond === 'number' && stat.framesPerSecond < 10) };
        });
      }));
      return result;
    };
    const update = async () => {
      const [screens, cameras] = await Promise.all([collect('screen', peerConnections.current, streams), collect('camera', cameraConnections.current, cameraStreams)]);
      if (active) { setScreenStats(screens); setCameraStats(cameras); }
    };
    void update();
    const timer = window.setInterval(update, 2_500);
    return () => { active = false; window.clearInterval(timer); };
  }, [streams, cameraStreams]);

  useEffect(() => {
    if (me?.authenticated !== false) return;
    let active = true;
    const update = () => fetch('/api/health', { cache: 'no-store' })
      .then(response => response.json() as Promise<{ operational?: boolean }>)
      .then(data => { if (active) setServiceOnline(data.operational === true); })
      .catch(() => { if (active) setServiceOnline(false); });
    void update();
    const timer = window.setInterval(update, 300_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [me?.authenticated]);

  useEffect(() => {
    if (!me?.authenticated) return;
    let cancelled = false;
    let reconnectTimer: number | undefined;
    let keepAliveTimer: number | undefined;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const storageKey = 'ruby_live_tab_id';
    let tabId = sessionStorage.getItem(storageKey);
    if (!tabId || !/^[0-9a-f-]{36}$/i.test(tabId)) {
      tabId = crypto.randomUUID();
      sessionStorage.setItem(storageKey, tabId);
    }
    const socket = new WebSocket(`${protocol}//${location.host}/api/ws?client=${encodeURIComponent(tabId)}`);
    socketRef.current = socket;
    socket.onopen = () => {
      reconnectAttemptsRef.current = 0;
      keepAliveTimer = window.setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send('ping');
      }, 25_000);
    };

    socket.onmessage = event => {
      if (cancelled || socketRef.current !== socket) return;
      if (event.data === 'pong') return;
      const message = JSON.parse(String(event.data)) as SocketMessage;
      if (message.type === 'waiting') {
        stopRoomMedia();
        roomRef.current = null;
        setMe(current => current ? { ...current, voice: null, syncHealthy: message.syncHealthy } : current);
      } else if (message.type === 'session') {
        const room = `${message.roomKey}:${message.sessionId}`;
        if (roomRef.current && roomRef.current !== room) stopRoomMedia();
        roomRef.current = room;
        selfIdRef.current = message.selfId;
        setMe(current => current ? { ...current, voice: { roomKey: message.roomKey, sessionId: message.sessionId, channelName: message.channelName } } : current);
        setPeers(Object.fromEntries(message.peers.map(peer => [peer.id, peer])));
        for (const peer of message.peers) {
          ensurePeer(peer.id);
          if (watchingRef.current[peer.id]) send({ type: 'watch_state', to: peer.id, watching: true, media: 'screen' });
          if (watchingCamerasRef.current[peer.id]) send({ type: 'watch_state', to: peer.id, watching: true, media: 'camera' });
        }
        if (localStreamRef.current) send({ type: 'share_state', sharing: true });
        if (cameraStreamRef.current) send({ type: 'camera_state', camera: true });
      } else if (message.type === 'voice_state') {
        setMe(current => current ? { ...current, voice: message.voice, syncHealthy: message.syncHealthy } : current);
        if (!message.voice || (roomRef.current && roomRef.current !== `${message.voice.roomKey}:${message.voice.sessionId}`)) {
          stopRoomMedia();
          roomRef.current = null;
          setPeers({});
        }
      } else if (message.type === 'peer_joined') {
        setPeers(current => ({ ...current, [message.peer.id]: message.peer }));
        ensurePeer(message.peer.id);
      } else if (message.type === 'peers') {
        const incomingIds = new Set(message.peers.map(peer => peer.id));
        for (const id of new Set([...peerConnections.current.keys(), ...cameraConnections.current.keys()])) {
          if (!incomingIds.has(id)) closePeer(id);
        }
        setPeers(Object.fromEntries(message.peers.map(peer => [peer.id, peer])));
        for (const peer of message.peers) ensurePeer(peer.id);
      } else if (message.type === 'peer_left') {
        closePeer(message.userId);
        setPeers(current => {
          const next = { ...current };
          delete next[message.userId];
          return next;
        });
      } else if (message.type === 'share_state') {
        setPeers(current => current[message.userId]
          ? { ...current, [message.userId]: { ...current[message.userId], sharing: message.sharing } }
          : current);
        if (!message.sharing) {
          setFocusedPeerId(current => current === message.userId ? null : current);
          setWatching(current => ({ ...current, [message.userId]: false }));
          setStreams(current => {
            if (!current[message.userId]) return current;
            const next = { ...current };
            delete next[message.userId];
            return next;
          });
        }
      } else if (message.type === 'camera_state') {
        setPeers(current => current[message.userId] ? { ...current, [message.userId]: { ...current[message.userId], camera: message.camera } } : current);
        if (!message.camera) {
          setWatchingCameras(current => ({ ...current, [message.userId]: false }));
          setFocusedCameraId(current => current === message.userId ? null : current);
          setCameraStreams(current => { const next = { ...current }; delete next[message.userId]; return next; });
        }
      } else if (message.type === 'watch_state') {
        void updateSubscriber(message.from, message.watching, message.media);
      } else if (message.type === 'signal') {
        void handleSignal(message.from, message.data, message.media);
      } else if (message.type === 'error') {
        setNotice(message.message);
      }
    };
    socket.onclose = event => {
      if (cancelled || socketRef.current !== socket) return;
      window.clearInterval(keepAliveTimer);
      socketRef.current = null;
      resetPeerConnections();
      setPeers({});
      if (event.code === 4009 || event.code === 4000) {
        stopRoomMedia();
        roomRef.current = null;
        setDuplicateSession(true);
        return;
      }
      if (event.code === 4003) {
        stopRoomMedia();
        roomRef.current = null;
        setMe({ authenticated: false });
        setNotice('Sua sessão expirou. Entre novamente com o Discord.');
        return;
      }
      if (event.code === 4002) setNotice('A sincronização com o Discord foi interrompida. Tentando reconectar…');
      const delay = Math.min(1_500 * 2 ** reconnectAttemptsRef.current, 30_000);
      reconnectAttemptsRef.current += 1;
      reconnectTimer = window.setTimeout(() => setSocketEpoch(value => value + 1), delay);
    };
    return () => {
      cancelled = true;
      window.clearTimeout(reconnectTimer);
      window.clearInterval(keepAliveTimer);
      if (socketRef.current === socket) { socketRef.current = null; resetPeerConnections(); }
      socket.close();
    };
  }, [me?.authenticated, socketEpoch, closePeer, ensurePeer, handleSignal, updateSubscriber, stopRoomMedia, resetPeerConnections, send]);

  const startCamera = async (deviceId = cameraDeviceId) => {
    const socket = socketRef.current;
    const room = roomRef.current;
    if (!room || socket?.readyState !== WebSocket.OPEN) { setNotice('Aguarde a conexão com a call antes de ligar a câmera.'); return; }
    const request = ++cameraRequestRef.current;
    setCameraBusy(true);
    try {
      for (const track of cameraStreamRef.current?.getTracks() || []) track.stop();
      const stream = await navigator.mediaDevices.getUserMedia(cameraConstraints(deviceId, cameraQuality, cameraFps));
      if (request !== cameraRequestRef.current || roomRef.current !== room || socketRef.current !== socket || socket.readyState !== WebSocket.OPEN) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      cameraStreamRef.current = stream;
      setCameraStream(stream);
      const track = stream.getVideoTracks()[0];
      const settings = track.getSettings();
      setCameraActual(`${settings.width || '?'} × ${settings.height || '?'} · ${settings.frameRate ? Math.round(settings.frameRate) : '?'} FPS`);
      track.addEventListener('ended', () => { if (cameraStreamRef.current === stream) stopCamera(); });
      setCameraDeviceId(track.getSettings().deviceId || deviceId);
      send({ type: 'camera_state', camera: true });
      for (const peerId of cameraSubscribersRef.current) void updateSubscriber(peerId, true, 'camera');
      void refreshCameraDevices();
      setNotice(null);
    } catch (error) {
      if (request !== cameraRequestRef.current) return;
      stopCamera();
      const name = (error as DOMException).name;
      setNotice(name === 'NotAllowedError' ? 'A câmera não foi autorizada. Permita o acesso nas configurações deste site.' : name === 'NotFoundError' ? 'Nenhuma câmera foi encontrada. Conecte uma webcam e tente novamente.' : 'Não foi possível abrir a câmera. Confira se outro aplicativo está usando o dispositivo.');
    } finally {
      if (request === cameraRequestRef.current) setCameraBusy(false);
    }
  };

  const changeCameraSettings = async (quality: CameraQuality, fps: CameraFps) => {
    if (cameraBusy) return;
    const stream = cameraStreamRef.current;
    const track = stream?.getVideoTracks()[0];
    if (!track) { setCameraQuality(quality); setCameraFps(fps); return; }
    const request = cameraRequestRef.current;
    setCameraBusy(true);
    try {
      await track.applyConstraints(exactCameraVideoConstraints(quality, fps));
      if (cameraStreamRef.current !== stream || cameraRequestRef.current !== request) return;
      setCameraQuality(quality);
      setCameraFps(fps);
      const settings = track.getSettings();
      setCameraActual(`${settings.width || '?'} × ${settings.height || '?'} · ${settings.frameRate ? Math.round(settings.frameRate) : '?'} FPS`);
      setNotice(null);
    } catch {
      if (cameraStreamRef.current === stream && cameraRequestRef.current === request) {
        setNotice('A webcam não aceitou esse ajuste. A configuração anterior foi mantida; tente uma qualidade ou FPS menor.');
      }
    } finally {
      if (cameraRequestRef.current === request) setCameraBusy(false);
    }
  };

  const toggleWatchingCamera = (peerId: string) => {
    const next = !watchingCameras[peerId];
    setWatchingCameras(current => ({ ...current, [peerId]: next }));
    if (!next) {
      setFocusedCameraId(current => current === peerId ? null : current);
      setCameraStreams(current => { const updated = { ...current }; delete updated[peerId]; return updated; });
    }
    send({ type: 'watch_state', to: peerId, watching: next, media: 'camera' });
    if (next) {
      window.setTimeout(() => {
        if (cameraStreams[peerId]) return;
        send({ type: 'watch_state', to: peerId, watching: true, media: 'camera' });
      }, 2_500);
    }
  };

  const toggleWatching = (peerId: string) => {
    const next = !watching[peerId];
    setWatching(current => ({ ...current, [peerId]: next }));
    if (!next) {
      setFocusedPeerId(current => current === peerId ? null : current);
      setStreams(current => {
        if (!current[peerId]) return current;
        const updated = { ...current };
        delete updated[peerId];
        return updated;
      });
    }
    send({ type: 'watch_state', to: peerId, watching: next });
  };

  const focusFromSidebar = (peerId: string) => {
    if (!watching[peerId]) {
      setWatching(current => ({ ...current, [peerId]: true }));
      send({ type: 'watch_state', to: peerId, watching: true });
    }
    setFocusedPeerId(peerId);
  };

  const startSharing = async () => {
    const room = roomRef.current;
    const socket = socketRef.current;
    if (!room || socket?.readyState !== WebSocket.OPEN || localStreamRef.current) return;
    try {
      const preset = QUALITY_PRESETS[streamQuality];
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: streamFps, max: streamFps }, width: { ideal: preset.width }, height: { ideal: preset.height } },
        audio: true,
        systemAudio: 'include',
      } as DisplayMediaStreamOptions);
      for (const track of stream.getVideoTracks()) prepareScreenTrack(track);
      if (roomRef.current !== room || socketRef.current !== socket || socket.readyState !== WebSocket.OPEN || localStreamRef.current) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      localStreamRef.current = stream;
      setLocalStream(stream);
      for (const peerId of subscribersRef.current) {
        const state = ensurePeer(peerId);
        syncOutgoingTracks(state.pc, stream, true);
        await negotiatePeer(peerId, state);
      }
      stream.getVideoTracks()[0]?.addEventListener('ended', () => stopSharing());
      setSharing(true);
      setNotice(null);
      send({ type: 'share_state', sharing: true });
    } catch (error) {
      if ((error as DOMException).name !== 'NotAllowedError') {
        setNotice('Seu navegador não conseguiu iniciar a captura de tela.');
      }
    }
  };

  const stopSharing = () => {
    const stream = localStreamRef.current;
    if (!stream) return;
    for (const track of stream.getTracks()) track.stop();
    for (const { pc } of peerConnections.current.values()) {
      for (const sender of pc.getSenders()) {
        if (sender.track && stream.getTracks().some(track => track.id === sender.track?.id)) pc.removeTrack(sender);
      }
    }
    localStreamRef.current = null;
    subscribersRef.current.clear();
    setLocalStream(null);
    setSharing(false);
    setFocusedPeerId(current => current === 'self' ? null : current);
    send({ type: 'share_state', sharing: false });
  };

  if (!me || (!me.authenticated && serviceOnline === null)) {
    return <main className="center-shell"><div className="loader" aria-label="Carregando" /></main>;
  }

  if (!me.authenticated) {
    return (
      <main className="landing-shell">
        <div className="stars" aria-hidden="true" />
        <nav className="topbar">
          <a className="brand" href="/" aria-label="Ruby Live">
            <span className="brand-mark"><img src="/brand-mark.svg" alt="" /></span>
            <span>Ruby <b>Live</b></span>
          </a>
          <div className="service-status"><span className={serviceOnline ? 'status-dot' : 'status-dot maintenance'} /><strong>{serviceOnline ? 'Online' : 'Manutenção'}</strong></div>
        </nav>
        <section className="hero">
          <div className="hero-copy">
            <Badge className="eyebrow"><Radio size={13} /> transmissão privada da sua call</Badge>
            <h1>Sua tela, só para quem está <span>na nave.</span></h1>
            <p>Entre com o Discord. A gente encontra sua call automaticamente e conecta sua transmissão direto aos tripulantes.</p>
            <a className="discord-button" href="/api/auth/discord"><span className="discord-glyph">Discord</span> Entrar e encontrar minha call</a>
            <div className="trust-row">
              <span><ShieldCheck size={17} /> Login oficial do Discord</span>
              <span><BadgeCheck size={17} /> Sem gravação</span>
              <span><WifiOff size={17} /> Mídia P2P criptografada</span>
            </div>
          </div>
          <div className="hero-art" aria-label="Ruby apresentando a transmissão privada">
            <img className="meteor-art" src="/comet.svg" alt="" />
            <div className="brand-halo" />
            <img className="ruby-art" src="/space-host.svg" alt="Apresentadora espacial genérica" />
            <div className="screen-card"><img src="/screen.svg" alt="" /><strong>Tela ao vivo</strong><small>conexão direta</small></div>
            <div className="feature-token token-shield"><img src="/shield.svg" alt="" /><span>Protegido</span></div>
            <div className="feature-token token-fast"><img src="/bolt.svg" alt="" /><span>P2P direto</span></div>
          </div>
        </section>
      </main>
    );
  }

  if (duplicateSession) {
    return (
      <main className="waiting-shell">
        <section className="waiting-card">
          <h1>Você já está conectado em outro lugar</h1>
          <p>Esta conta Discord já está usando a live em outra aba, navegador ou dispositivo. A sessão original continua funcionando normalmente.</p>
          <p>Para usar esta aba, feche a outra sessão e clique abaixo. Não tentaremos reconectar automaticamente.</p>
          <Button type="button" size="lg" className="duplicate-retry-button" onClick={() => { setDuplicateSession(false); setSocketEpoch(value => value + 1); }}><RefreshCw /> Já fechei a outra sessão — tentar novamente</Button>
        </section>
      </main>
    );
  }

  if (!me.voice) {
    return (
      <main className="waiting-shell">
        <nav className="topbar">
          <a className="brand" href="/"><span className="brand-mark"><img src="/brand-mark.svg" alt="" /></span><span>Ruby <b>Live</b></span></a>
          <form method="post" action="/api/logout"><Button type="submit" variant="ghost" size="sm"><LogOut /> Sair</Button></form>
        </nav>
        <section className="waiting-card">
          <div className="radar"><span /><img src="/rocket.svg" alt="" /></div>
          <Badge variant="outline" className="waiting-identity">{me.user && <img src={waitingAvatarUrl(me.user)} alt="" />} conectado como {me.user?.name}</Badge>
          <h1>Buscando sua call…</h1>
          <p>Já está em uma call? Aguarde alguns segundos enquanto identificamos sua sala.</p>
          <p>Se ainda não estiver, entre em uma call na comunidade <strong>{COMMUNITY_NAME}</strong> para transmitir sua tela ou câmera e assistir às transmissões das pessoas dessa call.</p>
          <div className="status-pill"><span className={me.syncHealthy === false ? 'status-dot warning' : 'status-dot'} /> {me.syncHealthy === false ? 'Bot temporariamente sem comunicação' : 'Procurando sua call…'}</div>
        </section>
      </main>
    );
  }

  const peerList = Object.values(peers);
  const broadcastingPeers = peerList.filter(peer => peer.sharing);
  const selectedBroadcasts = broadcastingPeers.filter(peer => watching[peer.id]);
  const hasBroadcast = sharing || broadcastingPeers.length > 0;
  const cameraPeers = peerList.filter(peer => peer.camera);
  const cameraCount = cameraPeers.length + (cameraStream ? 1 : 0);
  const activeCameraCount = cameraPeers.filter(peer => watchingCameras[peer.id]).length;
  const screensVisible = hasBroadcast && !screensMinimized;
  const effectiveCameraLayout = cameraLayout === 'auto' ? (screensVisible ? 'strip' : 'grid') : cameraLayout;
  const effectiveScreenLayout: Exclude<ScreenLayout, 'auto'> = screenLayout === 'auto' ? (selectedBroadcasts.length + (sharing ? 1 : 0) <= 1 ? 'list' : 'grid') : screenLayout;
  const localScreenSettings = localStream?.getVideoTracks()[0]?.getSettings();
  const localScreenStats: PlaybackStats | undefined = localScreenSettings ? { width: localScreenSettings.width, height: localScreenSettings.height, fps: localScreenSettings.frameRate, limited: false } : undefined;
  const cameraEntries = [
    ...(cameraStream && me.user ? [{ user: me.user, key: 'self', stream: cameraStream, watching: true, local: true }] : []),
    ...cameraPeers.map(peer => ({ user: peer, key: peer.id, stream: watchingCameras[peer.id] ? cameraStreams[peer.id] : undefined, watching: Boolean(watchingCameras[peer.id]), local: false })),
  ];
  const cameraTile = (entry: typeof cameraEntries[number]) => <CameraTile key={entry.key} user={entry.user} stream={entry.stream} stats={entry.local ? undefined : cameraStats[entry.key]} actualLabel={entry.local ? cameraActual : undefined} watching={entry.watching} local={entry.local} focused={focusedCameraId === entry.key} onToggle={entry.local ? stopCamera : () => toggleWatchingCamera(entry.key)} onFocus={() => setFocusedCameraId(current => current === entry.key ? null : entry.key)} />;
  const focusedCamera = cameraEntries.find(entry => entry.key === focusedCameraId && entry.watching);
  return (
    <main className="room-shell">
      <nav className="roombar">
        <div className="brand"><span className="brand-mark"><img src="/brand-mark.svg" alt="" /></span><span>Ruby <b>Live</b></span></div>
        <div className="room-status"><span className="status-dot" /> {me.voice.channelName || 'Call do Discord'}</div>
        <form method="post" action="/api/logout"><Button type="submit" variant="ghost" size="sm"><LogOut /> Sair</Button></form>
      </nav>

      <div className="room-content">
        <aside className="participants-panel" aria-label="Participantes conectados">
          <header><span><span className="status-dot" /> Conectados</span><Badge variant="outline">{peerList.length + 1}</Badge></header>
          <div className="participant-list">
            <div className="participant-row">
              <span className="avatar">{me.user && avatarUrl(me.user) ? <img src={avatarUrl(me.user)!} alt="" /> : me.user?.name.slice(0, 1)}</span>
              <span><strong>{me.user?.name}</strong><small>{[sharing && 'Tela ao vivo', cameraStream && 'Câmera ligada'].filter(Boolean).join(' + ') || 'Na sala'}</small></span>
              <span className={sharing || cameraStream ? 'participant-live active' : 'participant-live'} />
            </div>
            {peerList.map(peer => (
              <button type="button" className={`participant-row${peer.sharing || peer.camera ? ' clickable' : ''}${focusedPeerId === peer.id || focusedCameraId === peer.id ? ' selected' : ''}`} key={peer.id} disabled={!peer.sharing && !peer.camera} onClick={() => { if (peer.sharing) focusFromSidebar(peer.id); else { if (!watchingCameras[peer.id]) toggleWatchingCamera(peer.id); setFocusedCameraId(peer.id); } }} title={`Ver mídia de ${peer.name}`}>
                <span className="avatar">{avatarUrl(peer) ? <img src={avatarUrl(peer)!} alt="" /> : peer.name.slice(0, 1).toUpperCase()}</span>
                <span><strong>{peer.name}</strong><small>{[peer.sharing && 'Tela ao vivo', peer.camera && 'Webcam'].filter(Boolean).join(' + ') || 'Na sala'}</small></span>
                <span className={peer.sharing || peer.camera ? 'participant-live active' : 'participant-live'} />
              </button>
            ))}
          </div>
        </aside>

        <div className="room-stage">
          {(hasBroadcast || !cameraCount) && <div className="stream-toolbar"><span>Transmissões <b>{broadcastingPeers.length + (sharing ? 1 : 0)}</b></span><div className="stream-toolbar-actions">{!screensMinimized && <label className="layout-picker"><span>Layout</span><select value={screenLayout} onChange={event => { setScreenLayout(event.target.value as ScreenLayout); setFocusedPeerId(null); }}><option value="auto">Automático</option><option value="grid">Grade</option><option value="theater">Cinema</option><option value="row">Faixa horizontal</option><option value="list">Lista vertical</option></select></label>}{!screensMinimized && (selectedBroadcasts.length > 1 || focusedPeerId) && <button type="button" onClick={() => setFocusedPeerId(null)} disabled={!focusedPeerId}><LayoutGrid size={15} /> Mostrar todas</button>}<button type="button" aria-expanded={!screensMinimized} aria-controls="call-screens-content" title={screensMinimized ? 'Mostrar transmissões' : 'Minimizar área sem interromper as transmissões'} onClick={() => setScreensMinimized(current => !current)}>{screensMinimized ? <ChevronDown size={15} /> : <ChevronUp size={15} />}{screensMinimized ? 'Mostrar' : 'Minimizar'}</button></div></div>}
          {(hasBroadcast || !cameraCount) && <section id="call-screens-content" hidden={screensMinimized} className={`video-grid layout-${effectiveScreenLayout}${focusedPeerId ? ' focus-mode' : ''}`}>
            {sharing && localStream && <LocalVideoTile stream={localStream} stats={localScreenStats} focused={focusedPeerId === 'self'} onFocus={() => setFocusedPeerId(current => current === 'self' ? null : 'self')} onStop={stopSharing} />}
            {broadcastingPeers.map(peer => <VideoTile key={peer.id} peer={peer} stream={watching[peer.id] ? streams[peer.id] : undefined} watching={Boolean(watching[peer.id])} stats={screenStats[peer.id]} focused={focusedPeerId === peer.id} onFocus={() => setFocusedPeerId(current => current === peer.id ? null : peer.id)} onToggle={() => toggleWatching(peer.id)} />)}
            {!hasBroadcast && <div className="no-broadcast"><img src="/screen.svg" alt="" /><h2>Ninguém está transmitindo ainda</h2><p>Quando alguém compartilhar a tela, a transmissão aparecerá aqui automaticamente.</p></div>}
          </section>}
          <section className={`camera-panel${!screensVisible ? ' cameras-primary' : ''}${camerasMinimized ? ' cameras-minimized' : ''}`} aria-label="Câmeras da call">
            <header className="camera-panel-header">
              <div><h2><Video size={18} /> Câmeras <span>{cameraCount}</span></h2><p>{activeCameraCount ? `${activeCameraCount} recebida${activeCameraCount > 1 ? 's' : ''} · áudio continua no Discord` : 'Escolha quais câmeras receber. Nenhuma abre automaticamente.'}</p></div>
              <div className="camera-layout-controls">{!camerasMinimized && <label className="layout-picker"><span>Layout</span><select value={cameraLayout} onChange={event => { setCameraLayout(event.target.value as typeof cameraLayout); setFocusedCameraId(null); }}><option value="auto">Automático</option><option value="strip">Faixa</option><option value="grid">Grade</option><option value="spotlight">Destaque</option></select></label>}<Button size="sm" variant="ghost" aria-expanded={!camerasMinimized} aria-controls="call-cameras-content" onClick={() => setCamerasMinimized(current => !current)} title={camerasMinimized ? 'Mostrar câmeras' : 'Minimizar área sem desligar as câmeras'}>{camerasMinimized ? <ChevronDown /> : <ChevronUp />}{camerasMinimized ? 'Mostrar' : 'Minimizar'}</Button></div>
            </header>
            <div id="call-cameras-content" hidden={camerasMinimized}>
            {focusedCamera && <div className="camera-featured">{cameraTile(focusedCamera)}</div>}
            {cameraCount ? <div className={`camera-collection camera-${focusedCamera ? 'strip' : effectiveCameraLayout}`}>{cameraEntries.filter(entry => entry !== focusedCamera).map(cameraTile)}</div> : <div className="camera-empty"><VideoOff size={22} /><span>Nenhuma câmera ligada. Você pode ligar a sua no painel abaixo.</span></div>}
            {activeCameraCount > 4 && <p className="camera-load-hint">Muitas câmeras podem pesar no computador. Use “Parar” nas que não precisa ver.</p>}
            </div>
          </section>
        </div>
      </div>

      {notice && <output className="notice">{notice}<button onClick={() => setNotice(null)} aria-label="Fechar aviso">×</button></output>}

      <footer className="media-dock" aria-label="Controles de câmera e tela">
        <div className="identity">
          <span className="avatar">{me.user && avatarUrl(me.user) ? <img src={avatarUrl(me.user)!} alt="" /> : me.user?.name.slice(0, 1)}</span>
          <span><strong>{me.user?.name}</strong></span>
        </div>
        <div className="media-dock-actions">
          <Button variant={cameraStream || cameraBusy ? 'secondary' : 'outline'} className={cameraStream ? 'camera-on' : ''} aria-label={cameraBusy ? 'Cancelar câmera' : cameraStream ? 'Desligar câmera' : 'Ligar câmera'} aria-pressed={Boolean(cameraStream)} onClick={() => cameraStream || cameraBusy ? stopCamera() : void startCamera()}>{cameraStream ? <VideoOff /> : <Video />}{cameraBusy ? 'Cancelar' : cameraStream ? 'Desligar' : 'Câmera'}</Button>
          {sharing ? (
            <Button variant="destructive" onClick={stopSharing} aria-label="Parar transmissão de tela"><CircleStop /> Parar tela</Button>
          ) : (
            <Button className="share-button" onClick={startSharing} aria-label="Compartilhar tela e áudio"><MonitorUp /> Transmitir</Button>
          )}
          <Popover>
            <PopoverTrigger render={<Button variant="ghost" className="media-settings-trigger" aria-label="Ajustar qualidade, FPS e webcam" title="Qualidade, FPS e webcam" />}><SlidersHorizontal /><span>Ajustes</span></PopoverTrigger>
            <PopoverContent side="top" align="end" sideOffset={12} className="media-settings-popover">
              <PopoverTitle>Qualidade da transmissão</PopoverTitle>
              <PopoverDescription>Configure a tela e a câmera separadamente.</PopoverDescription>
              <section className="media-settings-section" aria-label="Configurações da tela">
                <h3><MonitorUp size={15} /> Tela e áudio</h3>
                <div className="media-settings-grid">
          <label><span>Qualidade</span><select value={streamQuality} onChange={event => setStreamQuality(event.target.value as StreamQuality)}>{Object.entries(QUALITY_PRESETS).map(([value, preset]) => <option value={value} key={value}>{preset.label}</option>)}</select></label>
          <label><span>FPS</span><select value={streamFps} onChange={event => setStreamFps(Number(event.target.value) as 15 | 30 | 60)}><option value={15}>15</option><option value={30}>30</option><option value={60}>60</option></select></label>
                </div>
              </section>
              <section className="media-settings-section" aria-label="Configurações da webcam">
                <h3><Video size={15} /> Câmera</h3>
          <label><span>Câmera · sem microfone</span><select aria-label="Selecionar webcam" value={cameraDeviceId} disabled={cameraBusy} onChange={event => { const id = event.target.value; setCameraDeviceId(id); if (cameraStreamRef.current) void startCamera(id); }}><option value="">Câmera padrão</option>{cameraDevices.filter(device => device.deviceId).map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Câmera ${index + 1}`}</option>)}</select></label>
          <div className="media-settings-grid">
            <label><span>Qualidade da câmera</span><select aria-label="Qualidade da webcam" value={cameraQuality} disabled={cameraBusy} onChange={event => void changeCameraSettings(Number(event.target.value) as CameraQuality, cameraFps)}><option value={360}>360p · leve</option><option value={480}>480p</option><option value={720}>720p · HD</option><option value={1080}>1080p · Full HD</option></select></label>
            <label><span>FPS</span><select aria-label="FPS da webcam" value={cameraFps} disabled={cameraBusy} onChange={event => void changeCameraSettings(cameraQuality, Number(event.target.value) as CameraFps)}><option value={15}>15</option><option value={30}>30</option><option value={60}>60</option></select></label>
          </div>
          <small className="camera-settings-hint" aria-live="polite">{cameraStream ? `Captura: ${cameraActual}` : '360p / 15 FPS usa menos recursos.'} Qualidade e FPS dependem da webcam; valores altos pesam mais.</small>
              </section>
            </PopoverContent>
          </Popover>
        </div>
      </footer>
    </main>
  );
}
import { COMMUNITY_NAME } from './config';
