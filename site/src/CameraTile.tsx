import { useEffect, useRef, useState } from 'react';
import { Maximize, Maximize2, Minimize2, Video } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { openMediaFullscreen } from './fullscreen';

type Props = {
  user: { id: string; name: string; avatar: string | null };
  stream?: MediaStream;
  stats?: { width?: number; height?: number; fps?: number; bitrate?: number; limited: boolean };
  actualLabel?: string;
  watching: boolean;
  local?: boolean;
  focused: boolean;
  onToggle: () => void;
  onFocus: () => void;
};

export function CameraTile({ user, stream, stats, actualLabel, watching, local, focused, onToggle, onFocus }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const tileRef = useRef<HTMLElement>(null);
  const [playBlocked, setPlayBlocked] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let active = true;
    video.srcObject = stream || null;
    setVideoReady(false);
    video.muted = true;
    setPlayBlocked(false);
    if (stream) void video.play().then(() => {
      if (active && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) setVideoReady(true);
    }).catch(() => { if (active) setPlayBlocked(true); });
    return () => { active = false; video.pause(); video.srcObject = null; };
  }, [stream]);
  const avatar = user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128` : null;
  const enterFullscreen = async () => {
    if (!await openMediaFullscreen(tileRef.current, videoRef.current) && !focused) onFocus();
  };
  return (
    <article ref={tileRef} className={`camera-tile${local ? ' camera-local' : ''}${focused ? ' camera-focused' : ''}`}>
      <button type="button" className="camera-picture" onClick={watching ? onFocus : onToggle} aria-label={`${watching ? 'Destacar' : 'Ver'} câmera de ${user.name}`}>
        {watching && stream ? <video ref={videoRef} muted autoPlay playsInline onLoadedMetadata={() => setVideoReady(true)} onLoadedData={() => setVideoReady(true)} onPlaying={() => setVideoReady(true)} onCanPlay={() => setVideoReady(true)} onTimeUpdate={() => setVideoReady(true)} onWaiting={() => setVideoReady(false)} onStalled={() => setVideoReady(false)} /> : <span className="camera-placeholder"><span className="avatar avatar-large">{avatar ? <img src={avatar} alt="" /> : user.name.slice(0, 1)}</span><span>{watching ? 'Conectando câmera…' : 'Clique para ver'}</span></span>}
        {watching && stream && !videoReady && <span className="media-loading camera-loading" role="status"><span className="loader" /><span>Carregando câmera…</span></span>}
        <span className="camera-kind"><Video size={12} />{local ? 'Prévia espelhada' : 'Webcam'}</span>
        {stats && <span className={stats.limited ? 'stream-stats camera-stats limited' : 'stream-stats camera-stats'}>{[stats.width && stats.height ? `${stats.width}×${stats.height}` : '', stats.fps ? `${Math.round(stats.fps)} FPS` : '', stats.bitrate ? `${stats.bitrate.toFixed(1)} Mbps` : ''].filter(Boolean).join(' · ') || 'Analisando…'}</span>}
      </button>
      {playBlocked && <Button size="sm" className="camera-play" onClick={() => void videoRef.current?.play().then(() => setPlayBlocked(false)).catch(() => undefined)}>Reproduzir câmera</Button>}
      <div className="camera-caption"><span className="camera-person"><strong>{local ? 'Você' : user.name}</strong><small>{local ? `${actualLabel || 'Verificando captura…'} · sem microfone` : watching ? 'Recebendo câmera' : 'Disponível · não recebendo'}</small></span>
        <Button size="xs" variant={watching ? 'secondary' : 'default'} onClick={onToggle}>{local ? 'Desligar' : watching ? 'Parar' : 'Ver'}</Button>
        {watching && <Button size="icon-xs" variant="ghost" onClick={onFocus} aria-label={focused ? 'Reduzir câmera' : 'Destacar câmera'} title={focused ? 'Reduzir câmera' : 'Destacar câmera'}>{focused ? <Minimize2 /> : <Maximize2 />}</Button>}
        {stream && watching && <Button size="icon-xs" variant="ghost" onClick={() => void enterFullscreen()} aria-label="Câmera em tela cheia" title="Tela cheia"><Maximize /></Button>}
      </div>
    </article>
  );
}
