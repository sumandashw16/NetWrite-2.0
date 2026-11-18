import Y from './yjsShared.js';
import { WebSocketServer } from 'ws';
import yUtils from 'y-websocket/bin/utils'; // CJS module: default import, then destructure
import Board from '../models/Board.js';

const { setupWSConnection, setPersistence, docs } = yUtils;
export { docs };

const AUTOSAVE_MS = 5000;
const loading = new Map(); // roomId -> Promise: has the stored state been applied yet?
const timers = new Map();  // roomId -> pending autosave timer

import { guardConnection, installDocGuard, isBanned, MAX_MESSAGE_BYTES } from './yjsGuard.js';
import { redeemTicket } from './tickets.js';
import { getRoom, isAdmitted, addConn, removeConn, roomEvents } from '../rooms/roomState.js';
import { canWrite } from '../rooms/permissions.js';

const ROOM_ID = /^[A-Za-z0-9_-]{1,64}$/;   // widen this if your room names can contain spaces
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173').split(',');
const MAX_CONNS_PER_IP = 20;
const MAX_CONNS_PER_ROOM = 50;
const MAX_ROOMS = 500;
const MAX_STATE_BYTES = 12 * 1024 * 1024;  // Mongo's document limit is 16 MB
const connsByIp = new Map();
const connsByRoom = new Map();
const bump = (m, k, d) => { const n = (m.get(k) ?? 0) + d; n > 0 ? m.set(k, n) : m.delete(k); };

const persist = async (roomId, doc) => {
  const state = Y.encodeStateAsUpdate(doc);
  if (state.length > MAX_STATE_BYTES) throw new Error(`state too large (${state.length} bytes)`);
  await Board.updateOne({ roomId }, { $set: { ydocState: Buffer.from(state) } });
};

const scheduleSave = (roomId, doc) => {
  if (timers.has(roomId)) return;
  timers.set(roomId, setTimeout(() => {
    timers.delete(roomId);
    persist(roomId, doc).catch((e) => console.error(`Autosave failed for ${roomId}:`, e));
  }, AUTOSAVE_MS));
};

// One-time migration: old boards stored a plain strokes array
function seedFromLegacy(ydoc, legacy) {
  const yStrokes = ydoc.getMap('strokes');
  ydoc.transact(() => {
    legacy.forEach((s, i) => {
      if (!s?.id || !Array.isArray(s.points)) return;
      const m = new Y.Map();
      for (const k of ['id', 'userId', 'color', 'width', 'points', 'x', 'y', 'scaleX', 'scaleY', 'rotation']) {
        if (s[k] !== undefined && s[k] !== null) m.set(k, s[k]);
      }
      m.set('ts', i);
      yStrokes.set(s.id, m);
    });
  });
}
const stash = new Map();        // roomId -> Uint8Array, for non-persisted (guest) rooms only
const ephemeral = new Set();    // roomIds bound as non-persisted, so writeState can tell after the room is gone

roomEvents.on('end', (room) => stash.delete(room.roomId));

// Revoke => close with 4403 so the client discards its diverged doc and resyncs.
// Grant => no close needed: the guard looks permission up live on every message.
roomEvents.on('permission', (room, id) => {
  for (const [cid, c] of room.conns) {
    if (id && cid !== id) continue;
    const now = canWrite(room, cid);
    for (const ws of c.yjs) {
      if (ws.couldWrite && !now) ws.close(4403, 'write revoked');
      ws.couldWrite = now;
    }
  }
});
setPersistence({
  provider: null,

    bindState: async (roomId, ydoc) => {
    installDocGuard(ydoc);
    const room = getRoom(roomId);
    if (!room || !room.persisted) {                    // guest room: RAM only, never Mongo
      ephemeral.add(roomId);
      const saved = stash.get(roomId);
      if (saved) Y.applyUpdate(ydoc, saved);
      return;
    }
    const task = (async () => {
      const board = await Board.findOne({ roomId });
      if (board?.ydocState?.length) {
        Y.applyUpdate(ydoc, new Uint8Array(board.ydocState));
      } else if (board?.strokes?.length) {
        seedFromLegacy(ydoc, board.toObject().strokes);
      }
      ydoc.on('update', () => scheduleSave(roomId, ydoc));
    })();
    loading.set(roomId, task);
    try { await task; }
    catch (err) { console.error(`Failed to load ${roomId}:`, err); }
  },

  writeState: async (roomId, doc) => {
    if (ephemeral.delete(roomId)) {                    // guest room
      if (getRoom(roomId)) stash.set(roomId, Y.encodeStateAsUpdate(doc));  // room still alive: keep for rejoin
      return;                                          // room ended: drop everything
    }
    clearTimeout(timers.get(roomId));
    timers.delete(roomId);
    try {
      await loading.get(roomId);
      await persist(roomId, doc);
    } catch (err) {
      console.error(`Save failed for ${roomId}:`, err);
    } finally {
      loading.delete(roomId);
    }
  }
});

// "Save now" for the REST route
export async function saveRoom(roomId) {
  const doc = docs.get(roomId);
  if (doc) await persist(roomId, doc);
}

const refuse = (socket, code, text, why) => {
  console.warn(`[guard] refused upgrade (${code}): ${why}`);
  socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
};

export function attachYjs(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  wss.on('connection', (ws, req, roomId, ip, identityId) => {
    const room = getRoom(roomId);
    if (!room) return ws.close(4410);                  // room ended during the handshake
    ws.ip = ip;
    ws.identityId = identityId;                        // from the redeemed ticket, never from the client
    ws.roomId = roomId;
    ws.couldWrite = canWrite(room, identityId);
    setupWSConnection(ws, req, { docName: roomId });
    ws.ydoc = docs.get(roomId);
    guardConnection(ws);
    addConn(room, identityId, 'yjs', ws);              // so kick can find and close this socket

    bump(connsByIp, ip, 1);
    bump(connsByRoom, roomId, 1);
    ws.on('close', () => {
      bump(connsByIp, ip, -1); bump(connsByRoom, roomId, -1);
      removeConn(room, identityId, 'yjs', ws);
    });
  });

  server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => {}); // ECONNRESET etc. on the raw socket must not crash the process

    let roomId, ticket;
    try {
      const { pathname, searchParams } = new URL(req.url, 'http://localhost');
      if (!pathname.startsWith('/yjs/')) return;
      roomId = decodeURIComponent(pathname.slice('/yjs/'.length));
      ticket = searchParams.get('ticket');
    }
    catch { return refuse(socket, 400, 'Bad Request', 'unparseable url'); }

    const ip = req.socket.remoteAddress;
    const room = getRoom(roomId);
    if (!ROOM_ID.test(roomId)) return refuse(socket, 400, 'Bad Request', `bad room id "${roomId}"`);
    if (!ALLOWED_ORIGINS.includes(req.headers.origin)) return refuse(socket, 403, 'Forbidden', `origin ${req.headers.origin}`);
    if (isBanned(ip)) return refuse(socket, 429, 'Too Many Requests', `${ip} is banned`);
    if ((connsByIp.get(ip) ?? 0) >= MAX_CONNS_PER_IP) return refuse(socket, 429, 'Too Many Requests', `${ip} has too many connections`);
    if ((connsByRoom.get(roomId) ?? 0) >= MAX_CONNS_PER_ROOM) return refuse(socket, 429, 'Too Many Requests', `room ${roomId} is full`);
    if (!docs.has(roomId) && docs.size >= MAX_ROOMS) return refuse(socket, 503, 'Service Unavailable', 'too many rooms');
    if (!room) return refuse(socket, 404, 'Not Found', `no room ${roomId}`);
    const t = redeemTicket(ticket, roomId);
    if (!t) return refuse(socket, 401, 'Unauthorized', 'bad or missing ticket');
    if (!isAdmitted(room, t.identityId)) return refuse(socket, 403, 'Forbidden', 'not admitted');
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, roomId, ip, t.identityId));
  });
}