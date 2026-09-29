import { Eye } from 'lucide-react';

type Viewer = { id: string; name: string; avatar: string | null };

function avatarUrl(viewer: Viewer) {
  return viewer.avatar ? `https://cdn.discordapp.com/avatars/${viewer.id}/${viewer.avatar}.png?size=64` : null;
}

export function ViewerSummary({ viewers, label }: { viewers: Viewer[]; label: string }) {
  return (
    <span className="viewer-summary" tabIndex={0} aria-label={`${viewers.length} ${viewers.length === 1 ? 'pessoa assistindo' : 'pessoas assistindo'}`}>
      <Eye size={14} /><b>{viewers.length}</b>
      <span className="viewer-popover" role="tooltip">
        <strong>{label}</strong>
        {viewers.length ? viewers.map(viewer => (
          <span className="viewer-person" key={viewer.id}>
            <span className="viewer-avatar">{avatarUrl(viewer) ? <img src={avatarUrl(viewer)!} alt="" /> : viewer.name.slice(0, 1).toUpperCase()}</span>
            <span>{viewer.name}</span>
          </span>
        )) : <small>Ninguém assistindo agora</small>}
      </span>
    </span>
  );
}
