import { useState, useContext, useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Plus, Lock, Trash2, PenLine } from 'lucide-react';
import { AuthContext } from '../context/AuthContext';
import { apiFetch } from '../services/api';
import { emitAck } from '../services/socket';
import DotGrid from '../components/reactbits/DotGrid';
import SplitText from '../components/reactbits/SplitText';
import TiltedCard, { TiltedCardLayer } from '../components/reactbits/TiltedCard';
import StarBorder from '../components/reactbits/StarBorder';
import PillNav from '../components/reactbits/PillNav';
import CountUp from '../components/reactbits/CountUp';
import './Home.css';

// PillNav renders links through this, so navigation stays client-side
const RouterLink = ({ href, children, ...props }) => (
  <Link to={href} {...props}>{children}</Link>
);

const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const formatDate = (v) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? 'Unknown date' : dateFmt.format(d);
};

// Stable tint per board, so cards are told apart at a glance
const hueFor = (id = '') => {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
};

const CARD = {
  containerWidth: '100%',
  containerHeight: '196px',
  imageWidth: '100%',
  imageHeight: '100%',
  radius: 16,
  rotateAmplitude: 7,
  scaleOnHover: 1.03,
  glare: 0.22,
  shadow: 0.55,
  gyroscope: false
};

function NewBoardCard({ onCreate, busy, index = 0 }) {
  return (
    <TiltedCard
      {...CARD}
      captionText={busy ? 'Creating…' : 'Create a new board'}
      introDelay={index * 60}
      onClick={busy ? undefined : onCreate}
    >
      <div className="card-bg card-bg--new" />
      <TiltedCardLayer depth={16}>
        <div className="new-card">
          <span className="new-card__plus"><Plus size={30} strokeWidth={1.6} /></span>
          <span className="new-card__label">New board</span>
        </div>
      </TiltedCardLayer>
    </TiltedCard>
  );
}

function BoardCard({ board, index, onOpen, onDelete }) {
  return (
    <TiltedCard
      {...CARD}
      captionText="Open board"
      introDelay={index * 60}
      onClick={() => onOpen(board.roomId)}
    >
      <div className="card-bg" style={{ '--hue': hueFor(board.roomId) }} />
      <TiltedCardLayer depth={14}>
        <div className="board-card">
          <div className="board-card__top">
            <span className={`chip chip--${board.role}`}>{board.role}</span>
            {board.isPrivate && <Lock size={13} className="board-card__lock" aria-label="Private" />}
          </div>
          <div className="board-card__bottom">
            <div className="board-card__title">Board {board.roomId.slice(0, 8)}</div>
            <div className="board-card__date">Edited {formatDate(board.updatedAt)}</div>
            <div className="board-card__host">Host · {board.ownerName || 'Unknown'}</div>
          </div>
          {onDelete && board.role === 'host' && (
            <button
              type="button"
              className="card-del"
              title="Delete board"
              aria-label="Delete board"
              onClick={(e) => { e.stopPropagation(); onDelete(board.roomId); }}
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </TiltedCardLayer>
    </TiltedCard>
  );
}

function PrivateToggle({ checked, onChange }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch__track"><span className="switch__thumb" /></span>
      <span className="switch__label">Private room · approve joiners</span>
    </label>
  );
}

function Column({ title, subtitle, count, children }) {
  return (
    <section className="col">
      <header className="col__head">
        <h2>{title}</h2>
        <span className="col__count"><CountUp to={count} duration={0.8} trigger="load" /></span>
      </header>
      <p className="col__sub">{subtitle}</p>
      {children}
    </section>
  );
}

export default function Home() {
  const navigate = useNavigate();
  const { user, logout } = useContext(AuthContext);
  const [joinId, setJoinId] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [managed, setManaged] = useState([]);
  const [shared, setShared] = useState([]);
  const [loaded, setLoaded] = useState(!!user.isGuest);
  const [busy, setBusy] = useState(false);

  const loadDashboard = useCallback(async () => {
    if (user.isGuest) return;   // guests have no history
    try {
      const [m, s] = await Promise.all([
        apiFetch('/api/boards/dashboard/managed'),
        apiFetch('/api/boards/dashboard/shared'),
      ]);
      if (m.ok) setManaged(await m.json());
      if (s.ok) setShared(await s.json());
    } catch (e) { console.error(e); }
    finally { setLoaded(true); }
  }, [user]);

  useEffect(() => { loadDashboard(); }, [loadDashboard]);

  const createNewBoard = async () => {
    setBusy(true);
    try {
      let roomId;
      if (user.isGuest) {
        ({ roomId } = await emitAck('room:create-guest', { isPrivate }));   // in-memory room
      } else {
        const res = await apiFetch('/api/boards', { method: 'POST', body: JSON.stringify({ isPrivate }) });
        if (!res.ok) throw new Error(`status ${res.status}`);
        ({ roomId } = await res.json());
      }
      if (!roomId) throw new Error('no room id');
      navigate(`/board/${roomId}`);
    } catch (e) {
      console.error(e);
      alert('Could not create the board.');
    } finally { setBusy(false); }
  };

  const joinBoard = (e) => {
    e.preventDefault();
    if (joinId.trim()) navigate(`/board/${joinId.trim()}`);
  };

  const deleteBoard = async (roomId) => {
    if (!window.confirm('Delete this board for everyone?')) return;
    const res = await apiFetch(`/api/boards/${roomId}`, { method: 'DELETE' });
    if (res.ok) loadDashboard(); else alert('Delete failed.');
  };

  const open = (id) => navigate(`/board/${id}`);

  return (
    <div className="home">
      <div className="home__bg" aria-hidden="true">
        <DotGrid
          baseColor="#222632"
          activeColor="#9bd3a5"
          dotSize={4}
          gap={22}
          proximity={120}
          shockRadius={260}
          shockStrength={4}
          glow={0.4}
          fade={0.7}
        />
      </div>

      <div className="home__inner">
        <header className="home__header">
          <PillNav
            logo={<PenLine size={18} />}
            logoAlt="NetWrite"
            logoHref="/"
            linkComponent={RouterLink}
            items={[{ label: 'Boards', href: '/' }, { label: 'Log out' }]}
            activeHref="/"
            onItemClick={(item) => { if (item.label === 'Log out') logout(); }}
            itemStyle="pill"
            hoverEffect="fill"
            indicator="dot"
          />
          <div className="user-chip">
            <span className="user-chip__avatar">{(user.username || '?').slice(0, 1).toUpperCase()}</span>
            <span>{user.username}{user.isGuest ? ' (guest)' : ''}</span>
          </div>
        </header>

        <section className="hero">
          <SplitText
            tag="h1"
            text="Think together."
            className="hero__title"
            effect="blur"
            splitType="chars"
            delay={40}
            duration={1}
            trigger="load"
            textAlign="center"
          />
          <p className="hero__sub">A shared board for sketches, notes and ideas, live with your team.</p>

          <form onSubmit={joinBoard} className="join">
            <input
              className="field"
              type="text"
              placeholder="Paste a room ID to join…"
              value={joinId}
              onChange={(e) => setJoinId(e.target.value)}
            />
            <StarBorder
              type="submit"
              color="#9bd3a5"
              trailColor="#9bd3a5"
              radius={12}
              duration={5}
              glow={0.5}
              hover="lap"
            >
              Join board
            </StarBorder>
          </form>
        </section>

        {user.isGuest ? (
          <section className="guest">
            <PrivateToggle checked={isPrivate} onChange={setIsPrivate} />
            <div className="guest__card"><NewBoardCard onCreate={createNewBoard} busy={busy} /></div>
            <p className="guest__note">Guest boards aren't saved. Log out and sign in to keep a history of your boards.</p>
          </section>
        ) : (
          <div className="split">
            <Column title="Managed boards" subtitle="Boards you host or co-host" count={managed.length}>
              <div className="col__toggle-row">
                <PrivateToggle checked={isPrivate} onChange={setIsPrivate} />
              </div>
              <div className="grid">
                <NewBoardCard onCreate={createNewBoard} busy={busy} />
                {managed.map((b, i) => (
                  <BoardCard key={b.roomId} board={b} index={i + 1} onOpen={open} onDelete={deleteBoard} />
                ))}
              </div>
              {loaded && managed.length === 0 && <p className="empty">Boards you create will show up here.</p>}
            </Column>

            <div className="split__divider" aria-hidden="true" />

            <Column title="Shared with me" subtitle="Boards you were invited to" count={shared.length}>
              <div className="col__toggle-row" />
              <div className="grid">
                {shared.map((b, i) => (
                  <BoardCard key={b.roomId} board={b} index={i} onOpen={open} />
                ))}
              </div>
              {loaded && shared.length === 0 && <p className="empty">Nothing shared with you yet. Paste a room ID above to join one.</p>}
            </Column>
          </div>
        )}
      </div>
    </div>
  );
}
