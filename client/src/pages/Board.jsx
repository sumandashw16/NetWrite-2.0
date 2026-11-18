import { useState, useRef, useEffect, useCallback, useContext } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  MousePointer2, Pencil, Eraser, Undo2, Redo2, Maximize, Trash2, Download,
  Save, Copy, Circle, Type, Users, Eye, Lock
} from 'lucide-react';
import Canvas from '../components/canvas/Canvas';
import LiveCursors from '../components/collaboration/LiveCursors';
import PropertiesPanel from '../components/canvas/PropertiesPanel';
import { ShapePicker, IconPicker } from '../components/canvas/ToolPickers';
import { AuthContext } from '../context/AuthContext';
import { socket, emitAck } from '../services/socket';

const C = {
  appBg: '#F5F6F8', canvasBg: '#F8FAFC', surface: '#FFFFFF',
  primary: '#2563EB', primaryHover: '#1D4ED8',
  text: '#111827', textMuted: '#6B7280', border: '#E5E7EB'
};
const font = 'Inter, system-ui, sans-serif';
const navBar = {
  position: 'absolute', top: 0, left: 0, right: 0, height: 56, zIndex: 20,
  background: C.surface, borderBottom: `1px solid ${C.border}`,
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '0 16px', fontFamily: font
};
const toolbarWrap = {
  position: 'absolute', bottom: 20, left: '50%', transform: 'translateX(-50%)', zIndex: 20,
  display: 'flex', alignItems: 'center', gap: 4,
  background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14,
  boxShadow: '0 8px 24px rgba(17,24,39,0.12)', padding: 6, fontFamily: font
};
const divider = { width: 1, alignSelf: 'stretch', background: C.border, margin: '4px 2px' };
const badge = { fontSize: 11, padding: '2px 8px', borderRadius: 999, background: '#EFF6FF', color: C.primary, fontWeight: 600 };
const panel = {
  position: 'absolute', top: 64, right: 12, width: 300, maxHeight: '70vh', overflowY: 'auto', zIndex: 25,
  background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 12,
  boxShadow: '0 8px 24px rgba(17,24,39,0.12)', fontFamily: font, fontSize: 13
};
const row = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '6px 0' };
const smallBtn = { fontSize: 12, padding: '3px 8px', borderRadius: 6, border: `1px solid ${C.border}`, background: C.surface, cursor: 'pointer' };

const GATE = {
  joining: ['Joining…'],
  pending: ['Waiting for the host to let you in…'],
  denied: ['The host declined your request.', true],
  cooldown: ['You were removed recently. Wait a minute, then try again.', true],
  kicked: ['You were removed from this board.', true],
  ended: ['This board has ended.'],
  notfound: ['Board not found.'],
  error: ['Something went wrong.', true],
};

function ToolButton({ active, disabled, onClick, title, children }) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={disabled ? `${title} (view only)` : title}
      style={{
        width: 36, height: 36, display: 'grid', placeItems: 'center',
        borderRadius: 9, border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.35 : 1,
        background: active ? '#EFF6FF' : 'transparent',
        color: active ? C.primary : C.text,
        transition: 'background 120ms ease, color 120ms ease'
      }}
      onMouseEnter={(e) => { if (!active && !disabled) e.currentTarget.style.background = '#F3F4F6'; }}
      onMouseLeave={(e) => { if (!active && !disabled) e.currentTarget.style.background = 'transparent'; }}
    >
      {children}
    </button>
  );
}

export default function Board() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const { user } = useContext(AuthContext);
  const [color, setColor] = useState('#000000');
  const [brushSize, setBrushSize] = useState(5);
  const [camera, setCamera] = useState({ x: 0, y: 0, scale: 1 });
  const [activeTool, setActiveTool] = useState('select');
  const [selectedObjects, setSelectedObjects] = useState([]);
  const canvasRef = useRef();

  // ---- room membership state ----
  const [status, setStatus] = useState('joining');
  const [ticket, setTicket] = useState(null);
  const [youId, setYouId] = useState(null);
  const [roster, setRoster] = useState(null);
  const [lobby, setLobby] = useState([]);
  const [showPeople, setShowPeople] = useState(false);
  const retryRef = useRef(0);
  const retryTimer = useRef(null);

  const join = useCallback(() => {
    socket.emit('join-room', roomId, (res) => {
      const s = res?.status;            // 'admitted' arrives as the 'admitted' event instead
      if (s === 'pending') setStatus('pending');
      else if (s === 'cooldown' || s === 'error') setStatus(s);
      else if (s === 'not-found') setStatus('notfound');
    });
  }, [roomId]);

  useEffect(() => {
    setStatus('joining'); setTicket(null); setRoster(null); setLobby([]); retryRef.current = 0;

    const onAdmitted = ({ you, ticket, roster }) => { setYouId(you); setRoster(roster); setTicket(ticket); setStatus('active'); };
    const onDenied = () => setStatus('denied');
    const onClosed = (code) => setStatus(code === 4401 ? 'kicked' : 'ended');
    socket.on('admitted', onAdmitted);
    socket.on('roster', setRoster);
    socket.on('lobby:pending', setLobby);
    socket.on('join:denied', onDenied);
    socket.on('closed', onClosed);
    socket.on('connect', join);           // also re-joins after a network drop
    if (socket.connected) join();

    return () => {
      socket.off('admitted', onAdmitted);
      socket.off('roster', setRoster);
      socket.off('lobby:pending', setLobby);
      socket.off('join:denied', onDenied);
      socket.off('closed', onClosed);
      socket.off('connect', join);
      clearTimeout(retryTimer.current);
      if (socket.connected) socket.emit('leave-room');
    };
  }, [roomId, join]);

  // Yjs connection died (revoke = 4403, network, spent ticket): fetch a fresh ticket, Canvas rebuilds.
  const handleYjsClosed = useCallback((code) => {
    if (code === 4401 || code === 4410) return;   // the socket 'closed' event handles these
    const n = retryRef.current++;
    clearTimeout(retryTimer.current);
    retryTimer.current = setTimeout(async () => {
      try {
        const res = await emitAck('ticket:request', {});
        if (res?.ticket) setTicket(res.ticket);
        else join();                              // no longer admitted (e.g. server restarted)
      } catch { /* socket is down: its 'connect' handler re-joins and delivers a ticket */ }
    }, Math.min(300 * 2 ** n, 5000));
  }, [join]);

  const retry = () => {
    setStatus('joining');
    if (socket.connected) join(); else socket.connect();
  };

  // ---- derived permissions (UI only; the server enforces) ----
  const me = roster?.members.find((m) => m.id === youId);
  const role = me?.role;
  const isManager = role === 'host' || role === 'cohost';
  const canWrite = status === 'active' && !!me && !roster.locked && me.canWrite;

  useEffect(() => { if (isManager && lobby.length) setShowPeople(true); }, [isManager, lobby.length]);

  const act = (event, payload) => emitAck(event, payload).catch(() => false);

  // ---- selection / clear / style (unchanged) ----
  const refreshSelection = useCallback(() => {
    setSelectedObjects(canvasRef.current?.getSelectedObjects?.() ?? []);
  }, []);
  const handleSelectionChange = useCallback(() => { refreshSelection(); }, [refreshSelection]);
  const handleClear = () => {
    if (window.confirm('Clear the entire whiteboard for everyone?')) canvasRef.current?.clearBoard();
  };

  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = `html, body { margin: 0; height: 100%; overflow: hidden; }`;
    document.head.appendChild(style);
    return () => document.head.removeChild(style);
  }, []);

  // ---- not (yet) in the room ----
  if (status !== 'active') {
    const [msg, retryable] = GATE[status] ?? GATE.error;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginTop: '25vh', fontFamily: font, gap: 12 }}>
        <p style={{ fontSize: 18 }}>{msg}</p>
        {retryable && <button onClick={retry} style={{ padding: '8px 16px', cursor: 'pointer' }}>Request again</button>}
        <button onClick={() => navigate('/')} style={{ padding: '8px 16px', cursor: 'pointer' }}>Back to home</button>
      </div>
    );
  }

  const online = roster.members.filter((m) => m.online).length;

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden', background: C.appBg }}>
      <div style={navBar}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontWeight: 700, fontSize: 15, color: C.text }}>NetWrite</span>
          <div style={{ width: 1, height: 20, background: C.border }} />
          <span style={{ fontSize: 13, color: C.text }}>Room {roomId.slice(0, 8)}…</span>
          <button
            onClick={() => navigator.clipboard.writeText(roomId)} title="Copy room ID"
            style={{ width: 26, height: 26, display: 'grid', placeItems: 'center', borderRadius: 6, border: `1px solid ${C.border}`, background: C.surface, cursor: 'pointer', color: C.textMuted }}
          >
            <Copy size={13} />
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: C.textMuted }}>
            <Circle size={8} fill={C.primary} color={C.primary} /> Live
          </div>
          <span style={badge}>{role}</span>
          {!canWrite && <span style={{ ...badge, background: '#FEF3C7', color: '#92400E', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Eye size={12} /> View only</span>}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={() => setShowPeople((v) => !v)} style={{ ...smallBtn, display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px' }}>
            <Users size={14} /> {online}{isManager && lobby.length > 0 ? ` · ${lobby.length} waiting` : ''}
          </button>
          {roster.persisted && (
            <button
              onClick={() => canvasRef.current?.saveToDatabase()}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', background: C.primary, color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
            >
              <Save size={14} /> Save
            </button>
          )}
        </div>
      </div>

      {roster.locked && (
        <div style={{ position: 'absolute', top: 64, left: '50%', transform: 'translateX(-50%)', zIndex: 22, background: '#FEF3C7', color: '#92400E', padding: '6px 14px', borderRadius: 999, fontFamily: font, fontSize: 13, display: 'flex', gap: 6, alignItems: 'center' }}>
          <Lock size={13} /> Host is away. The board is read-only until a host returns.
        </div>
      )}

      {showPeople && (
        <div style={panel}>
          {isManager && lobby.length > 0 && (
            <>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Join requests</div>
              {lobby.map((p) => (
                <div key={p.id} style={row}>
                  <span>{p.username}</span>
                  <span style={{ display: 'flex', gap: 6 }}>
                    <button style={smallBtn} onClick={() => act('join:resolve', { targetId: p.id, allow: true })}>Allow</button>
                    <button style={smallBtn} onClick={() => act('join:resolve', { targetId: p.id, allow: false })}>Deny</button>
                  </span>
                </div>
              ))}
              <div style={{ height: 1, background: C.border, margin: '8px 0' }} />
            </>
          )}
          <div style={{ fontWeight: 600, marginBottom: 4 }}>People</div>
          {roster.members.map((m) => {
            const mine = m.id === youId;
            const canKick = !mine && (role === 'host' || (role === 'cohost' && m.role === 'joiner'));
            const canToggle = isManager && m.role === 'joiner';
            return (
              <div key={m.id} style={{ ...row, flexWrap: 'wrap' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Circle size={8} fill={m.online ? '#22C55E' : '#D1D5DB'} color="none" />
                  {m.username}{mine ? ' (you)' : ''} <span style={{ color: C.textMuted }}>· {m.role}</span>
                </span>
                <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {canToggle && (
                    <label style={{ fontSize: 12 }}>
                      <input type="checkbox" checked={m.canWrite} onChange={() => act('member:setWrite', { targetId: m.id, value: !m.canWrite })} /> draw
                    </label>
                  )}
                  {role === 'host' && m.role === 'joiner' && <button style={smallBtn} onClick={() => act('member:promote', { targetId: m.id })}>Make co-host</button>}
                  {role === 'host' && m.role === 'cohost' && <button style={smallBtn} onClick={() => act('member:demote', { targetId: m.id })}>Demote</button>}
                  {canKick && <button style={{ ...smallBtn, color: '#B91C1C' }} onClick={() => window.confirm(`Remove ${m.username}?`) && act('member:kick', { targetId: m.id })}>Kick</button>}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ position: 'absolute', inset: 0, top: 56, background: `${C.canvasBg} radial-gradient(${C.border} 1px, transparent 1px)`, backgroundSize: '20px 20px' }}>
        <Canvas
          ref={canvasRef}
          color={color}
          brushSize={brushSize}
          roomId={roomId}
          ticket={ticket}
          canWrite={canWrite}
          onYjsClosed={handleYjsClosed}
          onYjsConnected={() => { retryRef.current = 0; }}
          onCameraChange={setCamera}
          onToolChange={setActiveTool}
          onSelectionChange={handleSelectionChange}
        />
        <LiveCursors camera={camera} />
      </div>

      {canWrite && (
        <PropertiesPanel
          objects={selectedObjects}
          onStyleChange={(fields) => { canvasRef.current?.updateSelectedStyle(fields); refreshSelection(); }}
          onDuplicate={() => { canvasRef.current?.duplicateSelected(); refreshSelection(); }}
          onDelete={() => { canvasRef.current?.deleteSelected(); setSelectedObjects([]); }}
        />
      )}

      <div style={toolbarWrap}>
        <ToolButton active={activeTool === 'select'} onClick={() => canvasRef.current?.setTool('select')} title="Select (V)"><MousePointer2 size={17} /></ToolButton>
        <ToolButton active={activeTool === 'pen'} disabled={!canWrite} onClick={() => canvasRef.current?.setTool('pen')} title="Pen (P)"><Pencil size={17} /></ToolButton>
        <ToolButton active={activeTool === 'eraser'} disabled={!canWrite} onClick={() => canvasRef.current?.setTool('eraser')} title="Eraser (E)"><Eraser size={17} /></ToolButton>

        <div style={divider} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 4, opacity: canWrite ? 1 : 0.35, pointerEvents: canWrite ? 'auto' : 'none' }}>
          <input
            type="color" value={color}
            onChange={(e) => {
              setColor(e.target.value);
              if (canvasRef.current?.getSelectedIds?.().length) canvasRef.current.updateSelectedStyle({ color: e.target.value });
            }}
            title="Stroke color"
            style={{ width: 30, height: 30, border: 'none', borderRadius: 8, cursor: 'pointer', background: 'none' }}
          />
          <input type="range" min="1" max="20" value={brushSize} onChange={(e) => setBrushSize(parseInt(e.target.value, 10))} title="Brush size" style={{ width: 70 }} />
        </div>

        <div style={divider} />

        <div style={{ display: 'flex', opacity: canWrite ? 1 : 0.35, pointerEvents: canWrite ? 'auto' : 'none' }}>
          <ShapePicker onPick={(t) => canvasRef.current?.addShape(t)} />
          <IconPicker onPick={(n) => canvasRef.current?.addIcon(n)} />
        </div>
        <ToolButton disabled={!canWrite} onClick={() => canvasRef.current?.addText()} title="Add text"><Type size={17} /></ToolButton>

        <div style={divider} />

        <ToolButton disabled={!canWrite} onClick={() => canvasRef.current?.undo()} title="Undo (Ctrl+Z)"><Undo2 size={17} /></ToolButton>
        <ToolButton disabled={!canWrite} onClick={() => canvasRef.current?.redo()} title="Redo (Ctrl+Shift+Z)"><Redo2 size={17} /></ToolButton>

        <div style={divider} />

        <ToolButton onClick={() => canvasRef.current?.resetView()} title="Fit to screen"><Maximize size={17} /></ToolButton>

        <div style={divider} />

        {isManager && <ToolButton disabled={roster.locked} onClick={handleClear} title="Clear board"><Trash2 size={17} /></ToolButton>}
        <ToolButton onClick={() => canvasRef.current?.exportPNG()} title="Export PNG"><Download size={17} /></ToolButton>
      </div>
    </div>
  );
}