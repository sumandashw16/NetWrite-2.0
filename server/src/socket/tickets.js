import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const TTL_S = 60;
const spent = new Map(); // jti -> expiry (ms)

const secret = () => {
  if (!process.env.TICKET_SECRET) throw new Error('TICKET_SECRET is not set');
  return process.env.TICKET_SECRET;
};

export function issueTicket(roomId, identityId) {
  return jwt.sign({ rid: roomId }, secret(), {
    algorithm: 'HS256', audience: 'yjs', subject: identityId,
    jwtid: crypto.randomUUID(), expiresIn: TTL_S,
  });
}

// Synchronous (the upgrade handler must be). Call it LAST in the upgrade checks,
// so a refusal for a full room doesn't burn the ticket.
// -> { identityId } or null
export function redeemTicket(ticket, roomId) {
  if (typeof ticket !== 'string' || ticket.length > 1024) return null;
  try {
    const p = jwt.verify(ticket, secret(), { algorithms: ['HS256'], audience: 'yjs' });
    if (p.rid !== roomId || spent.has(p.jti)) return null;
    spent.set(p.jti, p.exp * 1000);
    return { identityId: p.sub };
  } catch {
    return null;
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [jti, exp] of spent) if (exp < now) spent.delete(jti);
}, 30_000).unref();