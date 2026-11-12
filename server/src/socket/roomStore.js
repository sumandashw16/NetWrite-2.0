import Board from '../models/Board.js';

// roomId -> Stroke[]  (authoritative while a room is active)
export const activeRoomsData = new Map();
const loadingRooms = new Map(); // roomId -> Promise, prevents double-loading on simultaneous joins
const dirtyRooms = new Set();   // rooms changed since last flush

export const markDirty = (roomId) => dirtyRooms.add(roomId);

// RAM first; on a miss, cold-start from MongoDB (or an empty board)
export function loadRoom(roomId) {
  if (activeRoomsData.has(roomId)) return Promise.resolve(activeRoomsData.get(roomId));

  if (!loadingRooms.has(roomId)) {
    const promise = Board.findOne({ roomId })
      .lean()
      .then((board) => {
        // Skip any legacy-format strokes (old x/y/isStartingPoint docs)
        const strokes = (board?.strokes ?? []).filter(
          (s) => s && typeof s.id === 'string' && Array.isArray(s.points)
        );
        activeRoomsData.set(roomId, strokes);
        console.log(`[rooms] loaded ${roomId} (${strokes.length} strokes). In RAM: ${activeRoomsData.size}`);
        return strokes;
      })
      .finally(() => loadingRooms.delete(roomId));
    loadingRooms.set(roomId, promise);
  }
  return loadingRooms.get(roomId);
}

// Write a room's strokes to MongoDB
export async function flushRoom(roomId) {
  const strokes = activeRoomsData.get(roomId);
  if (!strokes || !dirtyRooms.has(roomId)) return;

  dirtyRooms.delete(roomId); // anything changed during the await re-marks it
  try {
    await Board.findOneAndUpdate({ roomId }, { $set: { strokes } }, { upsert: true });
  } catch (err) {
    dirtyRooms.add(roomId); // keep it dirty so the next flush retries
    throw err;
  }
}

// Safety net so a server crash doesn't lose everything since the room opened
setInterval(() => {
  for (const roomId of dirtyRooms) {
    flushRoom(roomId).catch((err) => console.error(`Autosave failed for ${roomId}:`, err));
  }
}, 30_000).unref();