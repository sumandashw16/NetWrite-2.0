import { useMemo } from 'react';
import { Check, X, Pencil, Eye, ShieldPlus, ShieldMinus, UserX } from 'lucide-react';
import AnimatedList from '../reactbits/AnimatedList';
import StarBorder from '../reactbits/StarBorder';
import CountUp from '../reactbits/CountUp';
import './PeoplePanel.css';

const ROLE_RANK = { host: 0, cohost: 1, joiner: 2 };
const ROLE_LABEL = { host: 'Host', cohost: 'Co-host', joiner: 'Joiner' };
const AVATAR_COLORS = ['#f87171', '#fb923c', '#fbbf24', '#a3e635', '#34d399', '#22d3ee', '#60a5fa', '#a78bfa', '#f472b6'];

export const colorFor = (name = '') => {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
};

export function Avatar({ name, online, size = 32 }) {
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, fontSize: size * 0.42, '--avatar': colorFor(name) }}
      title={name}
    >
      {(name || '?').slice(0, 1).toUpperCase()}
      {online !== undefined && <i className={`avatar__dot${online ? ' is-on' : ''}`} />}
    </span>
  );
}

export function RoleBadge({ role }) {
  if (role === 'host') {
    return (
      <StarBorder
        as="span"
        className="role role--host"
        color="#fbbf24"
        trailColor="#fbbf24"
        radius={999}
        duration={6}
        glow={0.5}
        hover="none"
        clickPulse={false}
      >
        {ROLE_LABEL.host}
      </StarBorder>
    );
  }
  return <span className={`role role--${role}`}>{ROLE_LABEL[role] ?? role}</span>;
}

// Overlapping avatars of whoever is online, used as the button that opens the panel
export function AvatarStack({ members, max = 4, waiting = 0, onClick }) {
  const online = members.filter((m) => m.online);
  const shown = online.slice(0, max);
  const extra = online.length - shown.length;
  return (
    <button type="button" className="stack" onClick={onClick} title="People">
      <span className="stack__avatars">
        {shown.map((m) => <Avatar key={m.id} name={m.username} size={28} />)}
        {extra > 0 && <span className="stack__more">+{extra}</span>}
      </span>
      <span className="stack__count">
        <CountUp to={online.length} duration={0.6} trigger="load" /> online
      </span>
      {waiting > 0 && <span className="stack__waiting" title="Join requests">{waiting}</span>}
    </button>
  );
}


function IconBtn({ title, onClick, tone, active, children }) {
  return (
    <button
      type="button"
      className={`icon-btn${tone ? ` icon-btn--${tone}` : ''}${active ? ' is-active' : ''}`}
      title={title}
      aria-label={title}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
    >
      {children}
    </button>
  );
}

export default function PeoplePanel({ roster, youId, role, isManager, lobby, act, onClose }) {
  const members = useMemo(
    () => [...roster.members].sort(
      (a, b) =>
        (ROLE_RANK[a.role] ?? 3) - (ROLE_RANK[b.role] ?? 3) ||
        Number(b.online) - Number(a.online) ||
        a.username.localeCompare(b.username)
    ),
    [roster]
  );
  const requests = useMemo(() => lobby.map((p) => ({ ...p })), [lobby]);
  const online = roster.members.filter((m) => m.online).length;

  const renderMember = (m) => {
    const mine = m.id === youId;
    const canKick = !mine && (role === 'host' || (role === 'cohost' && m.role === 'joiner'));
    const canToggle = isManager && m.role === 'joiner';
    return (
      <div className="person">
        <Avatar name={m.username} online={m.online} size={36} />
        <div className="person__text">
          <span className="person__name">
            {m.username}{mine && <em> (you)</em>}
          </span>
          <RoleBadge role={m.role} />
        </div>
        <div className="person__actions">
          {canToggle ? (
            <IconBtn
              title={m.canWrite ? 'Can draw (click to make view-only)' : 'View only (click to allow drawing)'}
              active={m.canWrite}
              onClick={() => act('member:setWrite', { targetId: m.id, value: !m.canWrite })}
            >
              {m.canWrite ? <Pencil size={15} /> : <Eye size={15} />}
            </IconBtn>
          ) : (
            <span className="perm" title={m.canWrite ? 'Can draw' : 'View only'}>
              {m.canWrite ? <Pencil size={14} /> : <Eye size={14} />}
            </span>
          )}
          {role === 'host' && m.role === 'joiner' && (
            <IconBtn title="Make co-host" onClick={() => act('member:promote', { targetId: m.id })}>
              <ShieldPlus size={15} />
            </IconBtn>
          )}
          {role === 'host' && m.role === 'cohost' && (
            <IconBtn title="Demote to joiner" onClick={() => act('member:demote', { targetId: m.id })}>
              <ShieldMinus size={15} />
            </IconBtn>
          )}
          {canKick && (
            <IconBtn
              title="Remove from board"
              tone="danger"
              onClick={() => window.confirm(`Remove ${m.username}?`) && act('member:kick', { targetId: m.id })}
            >
              <UserX size={15} />
            </IconBtn>
          )}
        </div>
      </div>
    );
  };

  const renderRequest = (p) => (
    <div className="person">
      <Avatar name={p.username} size={36} />
      <div className="person__text">
        <span className="person__name">{p.username}</span>
        <span className="person__hint">wants to join</span>
      </div>
      <div className="person__actions">
        <IconBtn title="Allow" tone="ok" onClick={() => act('join:resolve', { targetId: p.id, allow: true })}>
          <Check size={16} />
        </IconBtn>
        <IconBtn title="Deny" tone="danger" onClick={() => act('join:resolve', { targetId: p.id, allow: false })}>
          <X size={16} />
        </IconBtn>
      </div>
    </div>
  );

  return (
    <aside className="people" aria-label="People">
      <header className="people__head">
        <div>
          <h3>People</h3>
          <p><CountUp to={online} duration={0.6} trigger="load" /> online · {roster.members.length} total</p>
        </div>
        <button type="button" className="people__close" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
      </header>

      {isManager && requests.length > 0 && (
        <section className="people__section">
          <h4>Join requests <span className="people__badge">{requests.length}</span></h4>
          <AnimatedList
            items={requests}
            renderItem={renderRequest}
            frame={false}
            width="100%"
            maxHeight={200}
            gap={6}
            radius={12}
            animation="slide"
            selectOnHover={false}
            enableArrowNavigation={false}
            showGradients={false}
          />
        </section>
      )}

      <section className="people__section">
        <h4>Members</h4>
        <AnimatedList
          items={members}
          renderItem={renderMember}
          frame={false}
          width="100%"
          maxHeight={340}
          gap={6}
          radius={12}
          animation="slide"
          animateOnce
          enableArrowNavigation={false}
        />
      </section>
    </aside>
  );
}
