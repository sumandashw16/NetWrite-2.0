import jwt from 'jsonwebtoken';
import crypto from 'crypto';

// Read lazily: dotenv runs after imports are evaluated in server.js
const secret = () => {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not set');
  return process.env.JWT_SECRET;
};

export function signGuestToken() {
  const guestId = crypto.randomUUID();
  const username = `Guest-${guestId.slice(0, 4)}`;
  const token = jwt.sign({ guestId, guest: true, username }, secret(), { expiresIn: '12h' });
  return { token, username };
}

// -> { id, isGuest, username } or null. Never throws.
export function verifyToken(token) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  try {
    const p = jwt.verify(token, secret(), { algorithms: ['HS256'] });
    const username = String(p.username ?? '').slice(0, 32);
    if (p.guest === true) {
      return typeof p.guestId === 'string' ? { id: `g:${p.guestId}`, isGuest: true, username } : null;
    }
    return typeof p.userId === 'string' ? { id: `u:${p.userId}`, isGuest: false, username } : null;
  } catch {
    return null;
  }
}

export const requireAuth = (req, res, next) => {
  const h = req.headers.authorization ?? '';
  const identity = h.startsWith('Bearer ') ? verifyToken(h.slice(7)) : null;
  if (!identity) return res.status(401).json({ message: 'Unauthorized' });
  req.identity = identity;
  next();
};

// Dashboard routes: guests have no history at all
export const requireUser = (req, res, next) =>
  requireAuth(req, res, () => (req.identity.isGuest ? res.status(403).json({ message: 'Login required' }) : next()));

// io.use(socketAuth): identity comes from the handshake, never from an event payload
export const socketAuth = (socket, next) => {
  const identity = verifyToken(socket.handshake.auth?.token);
  if (!identity) return next(new Error('unauthorized'));
  socket.data.identity = identity;
  next();
};