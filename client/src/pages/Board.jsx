import { useState, useRef, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  MousePointer2, Pencil, Eraser, Undo2, Redo2, Maximize, Trash2, Download,
  Save, Copy, Check, Type, Eye, Lock, ArrowLeft
} from 'lucide-react';
import Canvas from '../components/canvas/Canvas';
import LiveCursors from '../components/collaboration/LiveCursors';
import PropertiesPanel from '../components/canvas/PropertiesPanel';
import { ShapePicker, IconPicker } from '../components/canvas/ToolPickers';
import PeoplePanel, { AvatarStack, RoleBadge } from '../components/collaboration/PeoplePanel';
import { BOARD_THEMES, DEFAULT_THEME, isDefaultPen } from '../components/canvas/boardThemes';
import { socket, emitAck } from '../services/socket';
import './Board.css';

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
      type="button"
      className={`tool${active ? ' is-active' : ''}`}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={disabled ? `${title} (view only)` : title}
      aria-label={title}
    >
      {children}
    </button>
  );
}

export default function Board() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const [themeKey, setThemeKey] = useState(DEFAULT_THEME);
  const [color, setColor] = useState(BOARD_THEMES[DEFAULT_THEME].pen);
  const [brushSize, setBrushSize] = useState(5);
  const [camera, setCamera] = useState({ x: 0, y: 0, scale: 1 });
  const [activeTool, setActiveTool] = useState('select');
  const [selectedObjects, setSelectedObjects] = useState([]);
  const [copied, setCopied] = useState(false);
  const canvasRef = useRef();

  const theme = BOARD_THEMES[themeKey] ?? BOARD_THEMES[DEFAULT_THEME];

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

  // When the board theme changes, swap the pen to the new theme's default,
  // but only if the user is still on a default pen (never override a custom colour).
  useEffect(() => {
    setColor((c) => (isDefaultPen(c) ? theme.pen : c));
  }, [themeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = (event, payload) => emitAck(event, payload).catch(() => false);

  // ---- selection / clear / style ----
  const refreshSelection = useCallback(() => {
    setSelectedObjects(canvasRef.current?.getSelectedObjects?.() ?? []);
  }, []);
  const handleSelectionChange = useCallback(() => { refreshSelection(); }, [refreshSelection]);
  const handleClear = () => {
    if (window.confirm('Clear the entire whiteboard for everyone?')) canvasRef.current?.clearBoard();
  };

  const applyColor = (c) => {
    setColor(c);
    if (canvasRef.current?.getSelectedIds?.().length) canvasRef.current.updateSelectedStyle({ color: c });
  };

  const copyRoomId = async () => {
    try {
      await navigator.clipboard.writeText(roomId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked */ }
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
      <div className="gate">
        <div className="gate__card">
          <p className="gate__msg">{msg}</p>
          <div className="gate__actions">
            {retryable && <button type="button" className="ghost-btn" onClick={retry}>Request again</button>}
            <button type="button" className="ghost-btn" onClick={() => navigate('/')}>Back to home</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="board">
      <div className="bar">
        <div className="bar__left">
          <button type="button" className="bar-btn" onClick={() => navigate('/')} title="Back to boards" aria-label="Back to boards">
            <ArrowLeft size={16} />
          </button>
          <span className="brand">NetWrite</span>
          <span className="sep" />
          <span className="room">Room {roomId.slice(0, 8)}…</span>
          <button type="button" className="bar-btn" onClick={copyRoomId} title="Copy room ID" aria-label="Copy room ID">
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
          <span className="live"><i /> Live</span>
          <RoleBadge role={role} />
          {!canWrite && <span className="viewonly"><Eye size={12} /> View only</span>}
        </div>

        <div className="bar__right">
          {isManager && (
            <div className="themes" role="radiogroup" aria-label="Board theme">
              {Object.entries(BOARD_THEMES).map(([key, t]) => (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={key === themeKey}
                  disabled={!canWrite}
                  title={t.label}
                  className={`theme-dot${key === themeKey ? ' is-active' : ''}`}
                  style={{ background: t.board }}
                  onClick={() => canvasRef.current?.setBoardTheme(key)}
                />
              ))}
            </div>
          )}
          <AvatarStack
            members={roster.members}
            waiting={isManager ? lobby.length : 0}
            onClick={() => setShowPeople((v) => !v)}
          />
          {roster.persisted && (
            <button type="button" className="save-btn" onClick={() => canvasRef.current?.saveToDatabase()}>
              <Save size={14} /> Save
            </button>
          )}
        </div>
      </div>

      {roster.locked && (
        <div className="banner">
          <Lock size={13} /> Host is away. The board is read-only until a host returns.
        </div>
      )}

      {showPeople && (
        <PeoplePanel
          roster={roster}
          youId={youId}
          role={role}
          isManager={isManager}
          lobby={lobby}
          act={act}
          onClose={() => setShowPeople(false)}
        />
      )}

      <div
        className="stage"
        style={{ '--board': theme.board, '--dot': theme.dot, '--vignette': theme.vignette }}
      >
        <Canvas
          ref={canvasRef}
          color={color}
          brushSize={brushSize}
          roomId={roomId}
          ticket={ticket}
          canWrite={canWrite}
          boardTheme={themeKey}
          onThemeChange={setThemeKey}
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

      <div className="toolbar">
        <ToolButton active={activeTool === 'select'} onClick={() => canvasRef.current?.setTool('select')} title="Select (V)"><MousePointer2 size={17} /></ToolButton>
        <ToolButton active={activeTool === 'pen'} disabled={!canWrite} onClick={() => canvasRef.current?.setTool('pen')} title="Pen (P)"><Pencil size={17} /></ToolButton>
        <ToolButton active={activeTool === 'eraser'} disabled={!canWrite} onClick={() => canvasRef.current?.setTool('eraser')} title="Eraser (E)"><Eraser size={17} /></ToolButton>

        <span className="tb-div" />

        <div className={`tb-group${canWrite ? '' : ' is-disabled'}`}>
          <input
            type="color"
            className="color-input"
            value={color}
            onChange={(e) => applyColor(e.target.value)}
            title="Stroke color"
          />
          <div className="swatches">
            {theme.palette.map((c) => (
              <button
                key={c}
                type="button"
                className={`swatch${c === color.toLowerCase() ? ' is-active' : ''}`}
                style={{ background: c }}
                onClick={() => applyColor(c)}
                aria-label={`Color ${c}`}
              />
            ))}
          </div>
          <input
            type="range"
            className="brush"
            min="1"
            max="20"
            value={brushSize}
            onChange={(e) => setBrushSize(parseInt(e.target.value, 10))}
            title="Brush size"
          />
        </div>

        <span className="tb-div" />

        <div className={`tb-group${canWrite ? '' : ' is-disabled'}`}>
          <ShapePicker onPick={(t) => canvasRef.current?.addShape(t)} />
          <IconPicker onPick={(n) => canvasRef.current?.addIcon(n)} />
        </div>
        <ToolButton disabled={!canWrite} onClick={() => canvasRef.current?.addText()} title="Add text"><Type size={17} /></ToolButton>

        <span className="tb-div" />

        <ToolButton disabled={!canWrite} onClick={() => canvasRef.current?.undo()} title="Undo (Ctrl+Z)"><Undo2 size={17} /></ToolButton>
        <ToolButton disabled={!canWrite} onClick={() => canvasRef.current?.redo()} title="Redo (Ctrl+Shift+Z)"><Redo2 size={17} /></ToolButton>

        <span className="tb-div" />

        <ToolButton onClick={() => canvasRef.current?.resetView()} title="Fit to screen"><Maximize size={17} /></ToolButton>

        <span className="tb-div" />

        {isManager && <ToolButton disabled={roster.locked} onClick={handleClear} title="Clear board"><Trash2 size={17} /></ToolButton>}
        <ToolButton onClick={() => canvasRef.current?.exportPNG()} title="Export PNG"><Download size={17} /></ToolButton>
      </div>
    </div>
  );
}
