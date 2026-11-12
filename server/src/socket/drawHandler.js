import { activeRoomsData, loadRoom, flushRoom, markDirty } from './roomStore.js';

const MAX_POINTS = 50_000; // sanity cap on a single stroke

const isValidStroke = (s) =>
  s &&
  typeof s.id === 'string' &&
  Array.isArray(s.points) &&
  s.points.length % 2 === 0 &&
  s.points.length <= MAX_POINTS * 2 &&
  s.points.every(Number.isFinite);

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
      strokes.push(stroke);
      markDirty(roomId);
      socket.to(roomId).emit('stroke:end', stroke);
    } catch (err) {
      console.error(`stroke:end failed for room ${roomId}:`, err);
    }
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