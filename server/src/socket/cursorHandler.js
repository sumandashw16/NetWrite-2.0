export default function registerCursorHandlers(io, socket) {
  socket.on('cursor-move', (cursorData) => {
    // Broadcast coordinates to everyone else in the room
    socket.to(cursorData.roomId).emit('receive-cursor', {
      socketId: socket.id,
      x: cursorData.x,
      y: cursorData.y
    });
  });
}