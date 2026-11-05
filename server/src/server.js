import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import registerDrawHandlers from './socket/drawHandler.js';
import registerCursorHandlers from './socket/cursorHandler.js';

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "http://localhost:5173",
    methods: ["GET", "POST"]
  }
});

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('join-room', (roomId) => {
    socket.join(roomId);
  });

  registerDrawHandlers(io, socket);
  registerCursorHandlers(io, socket);

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    // Tell everyone to remove this user's cursor
    socket.broadcast.emit('user-disconnected', socket.id);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});