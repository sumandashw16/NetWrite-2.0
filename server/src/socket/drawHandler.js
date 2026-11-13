import { activeRoomsData, loadRoom, flushRoom, markDirty } from './roomStore.js';

const MAX_POINTS = 50_000;          // sanity cap on a single stroke
const MAX_UPDATES_PER_EVENT = 500;  // cap on objects moved in one stroke:update
const COORD_LIMIT = 1_000_000;      // sanity cap on x/y offsets
const MIN_ABS_SCALE = 0.01;
const MAX_ABS_SCALE = 100;

const isValidStroke = (s) =>
  s &&
  typeof s.id === 'string' &&
  Array.isArray(s.points) &&
  s.points.length % 2 === 0 &&
  s.points.length <= MAX_POINTS * 2 &&
  s.points.every(Number.isFinite);

const clampCoord = (v) => Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, v));
const validScale = (v) =>
  Number.isFinite(v) && Math.abs(v) >= MIN_ABS_SCALE && Math.abs(v) <= MAX_ABS_SCALE;

// For stroke:end (including redo of a moved stroke): keep valid transform fields, default the rest
function sanitizeTransform(s) {
  return {
    x: Number.isFinite(s.x) ? clampCoord(s.x) : 0,
    y: Number.isFinite(s.y) ? clampCoord(s.y) : 0,
    scaleX: validScale(s.scaleX) ? s.scaleX : 1,
    scaleY: validScale(s.scaleY) ? s.scaleY : 1,
    rotation: Number.isFinite(s.rotation) ? s.rotation : 0
  };
}

// For stroke:update: apply only the fields that are present AND valid.
// Returns the sanitized partial update, or null if nothing was applied.
function applyUpdate(target, u) {
  const out = { id: target.id };
  let changed = false;

  if (Number.isFinite(u.x)) { target.x = clampCoord(u.x); out.x = target.x; changed = true; }
  if (Number.isFinite(u.y)) { target.y = clampCoord(u.y); out.y = target.y; changed = true; }
  if (validScale(u.scaleX)) { target.scaleX = u.scaleX; out.scaleX = u.scaleX; changed = true; }
  if (validScale(u.scaleY)) { target.scaleY = u.scaleY; out.scaleY = u.scaleY; changed = true; }
  if (Number.isFinite(u.rotation)) { target.rotation = u.rotation; out.rotation = u.rotation; changed = true; }

  return changed ? out : null;
}

export default function registerDrawHandlers(io, socket) {
  // Live preview: pure relay. Never stored in RAM or the database.
  socket.on('stroke:preview', (data) => {
    const roomId = socket.data.roomId;
    if (!roomId || !data?.id) return;
    // socketId set server-side so a client can't spoof it
    socket.to(roomId).emit('stroke:preview', { ...data, socketId: socket.id });
  });

  // Finalized stroke: store it, then broadcast to everyone else
  socket.on('stroke:end', async (stroke) => {
    const roomId = socket.data.roomId;
    if (!roomId || !isValidStroke(stroke)) return;

    try {
      const strokes = activeRoomsData.get(roomId) ?? (await loadRoom(roomId));
      if (strokes.some((s) => s.id === stroke.id)) return; // ignore duplicates

      const clean = { ...stroke, ...sanitizeTransform(stroke) };
      strokes.push(clean);
      (socket.data.ownIds ??= new Set()).add(clean.id);    // remember who drew it
      markDirty(roomId);
      socket.to(roomId).emit('stroke:end', clean);
    } catch (err) {
      console.error(`stroke:end failed for room ${roomId}:`, err);
    }
  });

  // Move (and later scale/rotate) existing strokes.
  // payload: { updates: [{ id, x, y, scaleX?, scaleY?, rotation? }], final: boolean }
  // Absolute values, so last-write-wins and a dropped packet is harmless.
  socket.on('stroke:update', (payload) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const raw = payload?.updates;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_UPDATES_PER_EVENT) return;

    const strokes = activeRoomsData.get(roomId);
    if (!strokes) return;

    // id -> requested update (later duplicates win)
    const wanted = new Map();
    for (const u of raw) {
      if (u && typeof u.id === 'string') wanted.set(u.id, u);
    }
    if (wanted.size === 0) return;

    // One pass over the room instead of a findIndex per update
    const applied = [];
    for (const stroke of strokes) {
      const u = wanted.get(stroke.id);
      if (!u) continue;
      const out = applyUpdate(stroke, u);
      if (out) applied.push(out);
      if (applied.length === wanted.size) break;
    }
    if (applied.length === 0) return;

    const final = payload.final === true;
    markDirty(roomId); // only flag for persistence when the drag ends

    socket.to(roomId).emit('stroke:update', { updates: applied, final });
  });

  socket.on('stroke:remove', (payload) => {
    const roomId = socket.data.roomId;
    const id = payload?.id;
    if (!roomId || typeof id !== 'string' || !socket.data.ownIds?.has(id)) return;

    const strokes = activeRoomsData.get(roomId);
    const i = strokes ? strokes.findIndex((s) => s.id === id) : -1;
    if (i === -1) return;

    strokes.splice(i, 1);
    markDirty(roomId);
    socket.to(roomId).emit('stroke:remove', { id });
  });

  socket.on('clear-board', async () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    try {
      const strokes = activeRoomsData.get(roomId) ?? (await loadRoom(roomId));
      strokes.length = 0;
      markDirty(roomId);
      io.to(roomId).emit('clear-board'); // everyone, including the sender
    } catch (err) {
      console.error(`clear-board failed for room ${roomId}:`, err);
    }
  });

  // 'disconnecting' (not 'disconnect'): socket.rooms is still populated here
  socket.on('disconnecting', () => {
    for (const roomId of socket.rooms) {
      if (roomId === socket.id) continue;

      socket.to(roomId).emit('peer-left', socket.id); // removes their orphaned previews

      const size = io.sockets.adapter.rooms.get(roomId)?.size ?? 0;
      if (size <= 1) {
        // Last person out: save to MongoDB, then free the RAM
        flushRoom(roomId)
          .then(() => {
            // Don't evict if someone rejoined while we were saving
            if ((io.sockets.adapter.rooms.get(roomId)?.size ?? 0) === 0) {
              activeRoomsData.delete(roomId);
              console.log(`[rooms] evicted ${roomId}. In RAM: ${activeRoomsData.size}`);
            }
          })
          .catch((err) => console.error(`Flush failed for ${roomId}, keeping in RAM:`, err));
      }
    }
  });
}