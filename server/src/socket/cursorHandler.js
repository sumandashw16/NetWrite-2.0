export default function registerCursorHandlers(io, socket) {
  socket.on('cursor-move', (d) => {
    const roomId = socket.data.roomId;   // set only after admission
    if (!roomId || !Number.isFinite(d?.x) || !Number.isFinite(d?.y)) return;
    socket.to(roomId).emit('receive-cursor', {
      socketId: socket.id, x: d.x, y: d.y,
      username: socket.data.identity.username,   // server-verified, not from the payload
    });
  });
}