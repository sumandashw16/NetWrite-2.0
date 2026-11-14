import Y from './yjsShared.js';
import { WebSocketServer } from 'ws';
import yUtils from 'y-websocket/bin/utils'; // CJS module: default import, then destructure
import Board from '../models/Board.js';

const { setupWSConnection, setPersistence, docs } = yUtils;
export { docs };

const AUTOSAVE_MS = 5000;
const loading = new Map(); // roomId -> Promise: has the stored state been applied yet?
const timers = new Map();  // roomId -> pending autosave timer

const persist = (roomId, doc) =>
  Board.findOneAndUpdate(
    { roomId },
    { $set: { ydocState: Buffer.from(Y.encodeStateAsUpdate(doc)) } },
    { upsert: true }
  );

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

  // Called when a room's doc is first created in RAM
  bindState: async (roomId, ydoc) => {
    const task = (async () => {
      const board = await Board.findOne({ roomId });
      if (board?.ydocState?.length) {
        Y.applyUpdate(ydoc, new Uint8Array(board.ydocState));
      } else if (board?.strokes?.length) {
        seedFromLegacy(ydoc, board.toObject().strokes);
      }
      ydoc.on('update', () => scheduleSave(roomId, ydoc)); // registered AFTER load, so loading never triggers a save
    })();
    loading.set(roomId, task);
    await task;
  },

  // Called when the last client leaves; y-websocket destroys the doc afterwards (RAM freed)
  writeState: async (roomId, doc) => {
    clearTimeout(timers.get(roomId));
    timers.delete(roomId);
    try {
      await loading.get(roomId); // never save before the stored state was applied
    } catch {
      return;                    // load failed: saving now would overwrite the board with an empty doc
    } finally {
      loading.delete(roomId);
    }
    await persist(roomId, doc);
    console.log(`[rooms] saved + evicted ${roomId}`);
  }
});

// "Save now" for the REST route
export async function saveRoom(roomId) {
  const doc = docs.get(roomId);
  if (doc) await persist(roomId, doc);
}

// Handles ws://host/yjs/<roomId> upgrades and leaves /socket.io/ to Socket.IO
export function attachYjs(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  wss.on('connection', (ws, req, roomId) => setupWSConnection(ws, req, { docName: roomId }));

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (!pathname.startsWith('/yjs/')) return;
    const roomId = decodeURIComponent(pathname.slice('/yjs/'.length));
    if (!roomId) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, roomId));
  });
}