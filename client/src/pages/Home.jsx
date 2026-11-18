import { useState, useContext, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { AuthContext } from '../context/AuthContext';
import { apiFetch } from '../services/api';
import { emitAck } from '../services/socket';

function BoardList({ title, boards, onOpen, onDelete }) {
  return (
    <div style={{ width: 420, marginTop: 24 }}>
      <h3>{title}</h3>
      {boards.length === 0 && <p style={{ color: '#6B7280' }}>Nothing here yet.</p>}
      {boards.map((b) => (
        <div key={b.roomId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #E5E7EB' }}>
          <div>
            <div style={{ fontSize: 14 }}>{b.roomId.slice(0, 8)}… {b.isPrivate ? '🔒' : ''}</div>
            <div style={{ fontSize: 12, color: '#6B7280' }}>
              {b.role} · host {b.ownerName || '?'} · {new Date(b.updatedAt).toLocaleString()}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => onOpen(b.roomId)}>Open</button>
            {b.role === 'host' && onDelete && <button onClick={() => onDelete(b.roomId)}>Delete</button>}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function Home() {
  const navigate = useNavigate();
  const { user, logout } = useContext(AuthContext);
  const [joinId, setJoinId] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [managed, setManaged] = useState([]);
  const [shared, setShared] = useState([]);
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginTop: '10vh', fontFamily: 'sans-serif' }}>
      <div style={{ position: 'absolute', top: 16, right: 16, fontSize: 14 }}>
        {user.username}{user.isGuest ? ' (guest)' : ''} <button onClick={logout}>Log out</button>
      </div>

      <h1>NetWrite Collaborative Whiteboard</h1>

      <label style={{ marginBottom: 10 }}>
        <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} /> Private room (approve joiners)
      </label>
      <button
        onClick={createNewBoard} disabled={busy}
        style={{ padding: '10px 20px', fontSize: 16, cursor: 'pointer', marginBottom: 30 }}
      >
        Create New Board
      </button>

      <form onSubmit={joinBoard} style={{ display: 'flex', gap: 10 }}>
        <input
          type="text" placeholder="Paste Room ID here..." value={joinId}
          onChange={(e) => setJoinId(e.target.value)}
          style={{ padding: 10, fontSize: 16, width: 250 }}
        />
        <button type="submit" style={{ padding: '10px 20px', fontSize: 16, cursor: 'pointer' }}>Join Board</button>
      </form>

      {!user.isGuest && (
        <>
          <BoardList title="Managed Boards" boards={managed} onOpen={(id) => navigate(`/board/${id}`)} onDelete={deleteBoard} />
          <BoardList title="Shared with me" boards={shared} onOpen={(id) => navigate(`/board/${id}`)} />
        </>
      )}
    </div>
  );
}