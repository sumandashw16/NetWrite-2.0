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
// imports
import { socketAuth } from './middlewares/authMiddleware.js';
import { registerRoomHandlers, initRoomBroadcasts } from './socket/roomHandler.js';
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
app.use('/api/auth/guest', rateLimit({ windowMs: 15 * 60_000, limit: 200 }));
app.use('/api/auth', rateLimit({
  windowMs: 15 * 60_000, limit: 20,
  skip: (req) => req.path === '/guest',
}));
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
io.use(socketAuth);
initRoomBroadcasts(io);


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

  registerRoomHandlers(io, socket);
  registerCursorHandlers(io, socket);  
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));