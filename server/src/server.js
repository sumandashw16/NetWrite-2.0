import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import dns from 'dns';
import registerDrawHandlers from './socket/drawHandler.js';
import registerCursorHandlers from './socket/cursorHandler.js';
import boardRoutes from './routes/boardRoutes.js';
import authRoutes from './routes/authRoutes.js';

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

// Increase JSON limit because arrays of strokes can get quite large
app.use(cors());
app.use(express.json({ limit: '50mb' })); 

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
app.use('/api/boards', boardRoutes);
app.use('/api/auth', authRoutes);

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "http://localhost:5173", methods: ["GET", "POST"] }
});

io.on('connection', (socket) => {
  socket.on('join-room', (roomId) => {
    socket.join(roomId);
  });
  registerDrawHandlers(io, socket);
  registerCursorHandlers(io, socket);
  socket.on('disconnect', () => {
    socket.broadcast.emit('user-disconnected', socket.id);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));