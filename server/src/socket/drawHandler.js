export default function registerDrawHandlers(io, socket) {
  socket.on('draw', (drawData) => {
    // drawData includes: roomId, x, y, color, size, isStartingPoint
    socket.to(drawData.roomId).emit('receive-draw', drawData);
  });
}