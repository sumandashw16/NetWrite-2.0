import Y from './yjsShared.js';
import { createRequire } from 'module';
import { getRoom } from '../rooms/roomState.js';
import { canWrite } from '../rooms/permissions.js';
const require = createRequire(import.meta.url);
const decoding = require('lib0/decoding'); // same CJS build family y-websocket uses
// ---- Layers 1 + 2 ----
export const MAX_MESSAGE_BYTES = 64 * 1024;      // awareness and other messages
export const MAX_SYNC_BYTES = 4 * 1024 * 1024;   // sync messages carry document state
const MSG_RATE = 200, MSG_BURST = 400;
const BYTE_RATE = 512 * 1024, BYTE_BURST = 4 * 1024 * 1024; // burst must fit one full sync

// ---- Layer 3 ----
const MAX_STROKES = 20_000;
const MAX_POINT_VALUES = 20_000;                  // flat array length = 10k points
const COORD_LIMIT = 1_000_000;
const ALLOWED_ROOT_TYPES = new Set(['strokes', 'meta']);
const ENFORCE_FRAME_CHECK = true;
const SHAPE_TYPES = new Set(['rect', 'rounded', 'circle', 'triangle', 'diamond', 'pentagon', 'hexagon', 'star', 'arrow']);
const FONT_FAMILY_KEYS = new Set(['sans', 'serif', 'mono', 'hand']);
const ICON_NAME = /^[a-z0-9-]{1,40}$/;
const MUTABLE_FIELDS = new Set(['x', 'y', 'scaleX', 'scaleY', 'rotation', 'color', 'width', 'text', 'fontSize','boxWidth', 'fontFamily', 'autoWidth']);  // color/width: recolor later
// Repeat offenders get refused for 10 minutes (y-websocket clients auto-reconnect, so a bare kick is pointless)
const strikes = new Map(); // ip -> { count, until, last }
const STRIKE_WINDOW_MS = 60 * 60_000; // strikes expire after an hour

const isLoopback = (ip) =>
  ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

export const isBanned = (ip) =>
  !process.env.GUARD_BAN_LOOPBACK && isLoopback(ip)
    ? false
    : (strikes.get(ip)?.until ?? 0) > Date.now();

function strike(ip) {
  if (!ip || (!process.env.GUARD_BAN_LOOPBACK && isLoopback(ip))) return;
  const now = Date.now();
  const s = strikes.get(ip) ?? { count: 0, until: 0, last: now };
  if (now - s.last > STRIKE_WINDOW_MS) s.count = 0;
  s.last = now;
  if (++s.count >= 3) { s.until = now + 10 * 60_000; s.count = 0; }
  strikes.set(ip, s);
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, s] of strikes) {
    if (s.until < now && now - s.last > STRIKE_WINDOW_MS) strikes.delete(ip);
  }
}, 60_000).unref();

// The connection whose message is being processed right now (Node is single-threaded, so this is safe)
let activeConn = null;

const kick = (conn, why) => {
  if (!conn || typeof conn.terminate !== 'function' || conn.kicked) return;
  conn.kicked = true; // one kick and one strike per connection
  console.warn(`[guard] disconnecting ${conn.ip ?? 'client'}: ${why}`);
  strike(conn.ip);
  conn.terminate();
};

const bucket = (rate, burst) => {
  let tokens = burst, last = Date.now();
  return (cost) => {
    const now = Date.now();
    tokens = Math.min(burst, tokens + ((now - last) / 1000) * rate);
    last = now;
    if (tokens < cost) return false;
    tokens -= cost;
    return true;
  };
};
// Envelope check only: message type, sync subtype and the length prefix.
// The Yjs update inside is NOT decoded here; y-protocols already drops bad ones, and installDocGuard checks what actually lands in the doc.
function frameError(data) {
  try {
    const d = decoding.createDecoder(data);
    const type = decoding.readVarUint(d);
    if (type === 0) {                                   // sync
      const sub = decoding.readVarUint(d);
      if (sub > 2) return `unknown sync type ${sub}`;
      decoding.readVarUint8Array(d);                    // overruns (and throws) on a truncated frame
    } else if (type === 1) {                            // awareness
      decoding.readVarUint8Array(d);
    } else if (type !== 3) {                            // 3 = query awareness
      return `unsupported message type ${type}`;
    }
    if (d.pos > data.length) return 'frame overruns its length prefix';
    return null;
  } catch (err) {
    return err.message;
  }
}
// Close for a permission reason: no strike, no ban. 4403 tells the client to resync.
const denyWrite = (ws) => {
  if (ws.kicked) return;
  ws.kicked = true;
  ws.close(4403, 'write not permitted');
};

// Sync frame = [0, subtype, varuint len, ...update]. An empty update is 00 00.
const isEmptySync = (b) => b.length === 5 && b[2] === 2 && b[3] === 0 && b[4] === 0;

// Looked up on EVERY message. Nothing about permissions is cached on ws.
const mayWrite = (ws) => {
  const room = getRoom(ws.roomId);
  return !!room && canWrite(room, ws.identityId);
};
// Call AFTER setupWSConnection: wraps its message listener so bad packets never reach it
export function guardConnection(ws) {
  // An unhandled 'error' event on a ws socket throws and takes the whole process down
  ws.on('error', (err) => console.warn('[guard] ws error:', err.message));

  const handlers = ws.listeners('message');
  ws.removeAllListeners('message');
  const okMsg = bucket(MSG_RATE, MSG_BURST);
  const okBytes = bucket(BYTE_RATE, BYTE_BURST);

  ws.on('message', (data, isBinary) => {
    if (ws.kicked) return;
    if (!isBinary) return kick(ws, 'text frame');

    const size = data.byteLength ?? data.length;
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    const limit = bytes[0] === 0 ? MAX_SYNC_BYTES : MAX_MESSAGE_BYTES; // byte 0 = message type; 0 = sync
    if (size > limit) return kick(ws, `message too large (${size} bytes)`);
    if (!okMsg(1)) return kick(ws, 'message rate limit');
    if (!okBytes(size)) return kick(ws, 'bandwidth limit');

    const bad = frameError(bytes);
    if (bad) {
      console.warn(`[guard] bad frame: ${bad} size=${size} head=${Buffer.from(bytes).subarray(0, 16).toString('hex')}`);
      if (ENFORCE_FRAME_CHECK) return kick(ws, `malformed frame: ${bad}`);
    }
    // PRE-MERGE write gate. Subtype 0 = sync step 1 (a read request) is always fine.
    // Subtypes 1 (step 2) and 2 (update) carry mutations.
    if (bytes[0] === 0 && bytes[1] !== 0 && !mayWrite(ws)) {
      if (isEmptySync(bytes)) return;   // a read-only client's normal "nothing to add" reply
      return denyWrite(ws);             // real mutation: nothing reaches the doc
    }

    activeConn = ws;
    try {
      for (const h of handlers) h.call(ws, data, isBinary);
    } catch (err) {
      kick(ws, `handler threw: ${err.message}`);
    } finally {
      activeConn = null;
    }
  });
}

// ---- Layer 3: structural + semantic validation of what the doc receives ----
const isNum = (v) => Number.isFinite(v) && Math.abs(v) <= COORD_LIMIT;
const scaleOk = (v) => Number.isFinite(v) && Math.abs(v) >= 0.01 && Math.abs(v) <= 100;

function validField(k, v) {
  switch (k) {
    case 'id': return typeof v === 'string' && v.length > 0 && v.length <= 64;
    case 'userId': return typeof v === 'string' && v.length <= 128;
    case 'color': return typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v);
    case 'width': return Number.isFinite(v) && v > 0 && v <= 200;
    case 'fontSize': return Number.isFinite(v) && v > 0 && v <= 500;
    case 'boxWidth': return Number.isFinite(v) && v > 0 && v <= 4000;
    case 'fontFamily': return typeof v === 'string' && FONT_FAMILY_KEYS.has(v);
    case 'ts': return Number.isFinite(v);
    case 'x': case 'y': return isNum(v);
    case 'scaleX': case 'scaleY': return scaleOk(v);
    case 'rotation': return Number.isFinite(v) && Math.abs(v) <= 1e4;
    case 'points': return Array.isArray(v) && v.length % 2 === 0 && v.length <= MAX_POINT_VALUES && v.every(isNum);
    case 'shapeType': return v === null || (typeof v === 'string' && SHAPE_TYPES.has(v));
    case 'iconName': return v === null || (typeof v === 'string' && ICON_NAME.test(v));
    case 'svgPath': return v === null || (typeof v === 'string' && v.length <= 50_000);
    case 'type': return typeof v === 'string' && (v === 'path' || v === 'shape' || v === 'icon' || v === 'text');
    case 'text': return typeof v === 'string' && v.length <= 10_000;
    case 'autoWidth': return typeof v === 'boolean';
    default: return false; // unknown fields are not allowed
  }
}

function validStroke(key, ys) {
  if (!(ys instanceof Y.Map)) return false;
  const obj = ys.toJSON();
  if (obj.id !== key) return false;
  if (!Object.entries(obj).every(([k, v]) => validField(k, v))) return false;

  const type = obj.type || 'path';
  if (type === 'path') {
    if (!Array.isArray(obj.points) || obj.points.length < 2) return false;
  } else if (type === 'shape') {
    if (!SHAPE_TYPES.has(obj.shapeType)) return false;
  } else if (type === 'icon') {
    if (typeof obj.iconName !== 'string' || !ICON_NAME.test(obj.iconName)) return false;
  } else if (type === 'text') {
  if (typeof obj.text !== 'string') return false;
  } else {
    return false;
  }
  return true;
}

// Must run synchronously when the doc is created, so no update can slip in before it
export function installDocGuard(ydoc) {
  const strokes = ydoc.getMap('strokes');

  // A malformed binary: y-websocket catches the decode error and emits it on the doc (verify with test 3 below)
  ydoc.on('error', (err) => kick(activeConn, `malformed update: ${err?.message}`));

  // Nobody may create extra root types (e.g. a giant map named "x")
  const seenRoots = new Set(ALLOWED_ROOT_TYPES);
  ydoc.on('afterTransaction', () => {
    for (const name of ydoc.share.keys()) {
      if (seenRoots.has(name)) continue;
      seenRoots.add(name); // kick for each stray root only once, so later users aren't punished for it
      kick(activeConn, `unexpected root type "${name}"`);
    }
  });

    strokes.observeDeep((events, tr) => {
    if (typeof tr.origin?.terminate !== 'function') return; // only police remote clients, not our own writes

    const bad = new Set();
    const added = new Set();
    for (const ev of events) {
      if (ev.target === strokes) {
        for (const k of ev.keysChanged) {
          const v = strokes.get(k);
          if (v === undefined) continue; // a delete is always allowed (the eraser uses it)
          added.add(k);
          if (!validStroke(k, v)) bad.add(k);
        }
      } else {
        // a field inside an existing stroke changed: only transform fields may change, and only to valid values
        const k = ev.path[0];
        const ys = strokes.get(k);
        if (!ys) continue;
        for (const f of ev.keysChanged) {
          if (!MUTABLE_FIELDS.has(f)) { bad.add(k); continue; }
          const v = ys.get(f);
          // undefined = the field was removed (an undo of the first-ever transform); clients fall back to the default
          if (v !== undefined && !validField(f, v)) bad.add(k);
        }
      }
    }

    if (strokes.size > MAX_STROKES) added.forEach((k) => bad.add(k));
    if (!bad.size) return;

    kick(tr.origin, `invalid stroke data (${[...bad].length} stroke(s))`);
    queueMicrotask(() => {
      try {
        ydoc.transact(() => bad.forEach((k) => strokes.delete(k)), 'guard');
      } catch (err) {
        console.error('[guard] cleanup failed:', err);
      }
    });
  });
}