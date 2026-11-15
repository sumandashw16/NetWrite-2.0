import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import dns from 'dns';
import { attachYjs, docs } from './socket/yjsServer.js';
import registerCursorHandlers from './socket/cursorHandler.js';
import boardRoutes from './routes/boardRoutes.js';
import authRoutes from './routes/authRoutes.js';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

// Last-resort nets: log instead of dying. In production, also run under pm2/systemd so a bad state restarts.
process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));

// Resolve MongoDB Atlas SRV record lookup timeout on local/ISP DNS
dns.setServers(['8.8.8.8', '8.8.4.4']);

import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from server directory as well as current working directory
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

const app = express();

app.use(helmet());
app.use(cors({ origin: 'http://localhost:5173' }));   // was open to every origin
app.use(express.json({ limit: '100kb' }));            // was 50mb; POST /boards ignores the body now

// Connect to MongoDB
const mongoURI = process.env.MONGODB_URI || process.env.MONGO_URI;

if (!mongoURI) {
  console.error('MongoDB connection error: No MONGODB_URI or MONGO_URI set in .env file.');
} else {
  mongoose.connect(mongoURI)
    .then(() => console.log('Connected to MongoDB'))
    .catch((err) => console.error('MongoDB connection error:', err));
}

// API Routes
app.use('/api', rateLimit({ windowMs: 60_000, limit: 120 }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60_000, limit: 20 })); // brute-force protection for login
app.use('/api/boards', boardRoutes);
app.use('/api/auth', authRoutes);

if (process.env.NODE_ENV !== 'production') {
  app.get('/debug/rooms', (req, res) => {
    res.json({
      roomsInRam: [...docs].map(([roomId, doc]) => ({
        roomId,
        strokes: doc.getMap('strokes').size,
        connections: doc.conns.size
      }))
    });
  });
}

const server = http.createServer(app);
attachYjs(server);
const io = new Server(server, {
  maxHttpBufferSize: 10_000, // 10 KB: cursor events are tiny
  cors: { origin: "http://localhost:5173", methods: ["GET", "POST"] }
});

const ROOM_ID = /^[A-Za-z0-9_-]{1,64}$/;

io.on('connection', (socket) => {
  // per-socket limit across ALL events: 60/s sustained, 120 burst
  let tokens = 120, last = Date.now();
  socket.use((_packet, next) => {
    const now = Date.now();
    tokens = Math.min(120, tokens + ((now - last) / 1000) * 60);
    last = now;
    if (tokens < 1) return socket.disconnect(true);
    tokens -= 1;
    next();
  });

  socket.on('join-room', (roomId) => {
    if (typeof roomId !== 'string' || !ROOM_ID.test(roomId)) return;
    if (socket.data.roomId) socket.leave(socket.data.roomId);
    socket.data.roomId = roomId;
    socket.join(roomId);
  });

  registerCursorHandlers(io, socket);

  socket.on('disconnect', () => {
    socket.broadcast.emit('user-disconnected', socket.id);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));