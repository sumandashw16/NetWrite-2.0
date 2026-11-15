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
  // don't create empty boards for random room ids
  if (doc.getMap('strokes').size === 0 && !(await Board.exists({ roomId }))) return;
  await Board.findOneAndUpdate(
    { roomId },
    { $set: { ydocState: Buffer.from(state) } },
    { upsert: true }
  );
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

setPersistence({
  provider: null,

  bindState: async (roomId, ydoc) => {
    installDocGuard(ydoc);
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
    catch (err) { console.error(`Failed to load ${roomId}:`, err); } // writeState sees the failure through `loading`
  },

  writeState: async (roomId, doc) => {
    clearTimeout(timers.get(roomId));
    timers.delete(roomId);
    try {
      await loading.get(roomId);       // never save before the stored state was applied
      await persist(roomId, doc);
      console.log(`[rooms] saved + evicted ${roomId}`);
    } catch (err) {
      console.error(`Save failed for ${roomId}:`, err); // y-websocket doesn't catch this; unhandled, it would crash Node
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

  wss.on('connection', (ws, req, roomId, ip) => {
    ws.ip = ip;
    setupWSConnection(ws, req, { docName: roomId });
    guardConnection(ws);

    bump(connsByIp, ip, 1);
    bump(connsByRoom, roomId, 1);
    ws.on('close', () => { bump(connsByIp, ip, -1); bump(connsByRoom, roomId, -1); });
  });

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {}); // ECONNRESET etc. on the raw socket must not crash the process

    let roomId;
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      if (!pathname.startsWith('/yjs/')) return;   // leave /socket.io/ to Socket.IO
      roomId = decodeURIComponent(pathname.slice('/yjs/'.length));
    } 
    catch { return refuse(socket, 400, 'Bad Request', 'unparseable url'); }

    const ip = req.socket.remoteAddress;
    if (!ROOM_ID.test(roomId)) return refuse(socket, 400, 'Bad Request', `bad room id "${roomId}"`);
    if (!ALLOWED_ORIGINS.includes(req.headers.origin)) return refuse(socket, 403, 'Forbidden', `origin ${req.headers.origin}`);
    if (isBanned(ip)) return refuse(socket, 429, 'Too Many Requests', `${ip} is banned`);
    if ((connsByIp.get(ip) ?? 0) >= MAX_CONNS_PER_IP) return refuse(socket, 429, 'Too Many Requests', `${ip} has too many connections`);
    if ((connsByRoom.get(roomId) ?? 0) >= MAX_CONNS_PER_ROOM) return refuse(socket, 429, 'Too Many Requests', `room ${roomId} is full`);
    if (!docs.has(roomId) && docs.size >= MAX_ROOMS) return refuse(socket, 503, 'Service Unavailable', 'too many rooms');

    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, roomId, ip));
  });
}