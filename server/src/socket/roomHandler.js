import crypto from 'crypto';
import Y from './yjsShared.js';
import Board from '../models/Board.js';
import { docs } from './yjsServer.js';
import { issueTicket } from './tickets.js';
import { can } from '../rooms/permissions.js';
import {
  getRoom, openRoom, endRoom, isAdmitted, requestJoin, resolveJoin,
  addConn, removeConn, setWrite, promote, demote, kick, roster, roomEvents,
} from '../rooms/roomState.js';

const ROOM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ack = (cb, v) => typeof cb === 'function' && cb(v);
const current = (socket) => getRoom(socket.data.roomId);
const opening = new Map();

// Live room, or rebuilt from Mongo for persisted boards. Guest rooms exist only in memory.
async function ensureRoom(roomId, ident) {
  // ...unchanged until the lookup, then:
  const p = (async () => {
    let b = await Board.findOne({ roomId }).lean();
    if (b && !b.owner && ident && !ident.isGuest) {
      b = (await Board.findOneAndUpdate(
        { roomId, $or: [{ owner: { $exists: false } }, { owner: null }, { owner: '' }] },
        { $set: { owner: ident.id.slice(2), ownerName: ident.username } },
        { new: true }
      ).lean()) ?? await Board.findOne({ roomId }).lean();   // lost the race: use the winner
    }
    if (!b?.owner) return null;
    return getRoom(roomId) ?? openRoom({
      roomId, ownerId: `u:${b.owner}`, ownerName: b.ownerName ?? '',
      isPrivate: !!b.isPrivate, persisted: true,
      members: (b.members ?? []).map((m) => ({
        id: `u:${m.userId}`, username: m.username, role: m.role,
        canWrite: m.canWrite, grantedAt: m.grantedAt, isGuest: false,
      })),
    });
  })().finally(() => opening.delete(roomId));
  opening.set(roomId, p);
  return p;
}

function leave(socket) {
  const { roomId, pendingRoom, identity } = socket.data;
  socket.data.roomId = socket.data.pendingRoom = null;
  if (pendingRoom) {
    const r = getRoom(pendingRoom);
    if (r?.pending.get(identity.id)?.socket === socket) { r.pending.delete(identity.id); roomEvents.emit('pending', r); }
  }
  if (roomId) {
    socket.leave(roomId);
    const r = getRoom(roomId);
    if (r) removeConn(r, identity.id, 'io', socket);
  }
}

// Move into the real Socket.IO room AND issue the Yjs ticket
function admit(room, socket) {
  const id = socket.data.identity.id;
  const ticket = issueTicket(room.roomId, id);   // throws before any state changes
  socket.data.pendingRoom = null;
  socket.data.roomId = room.roomId;
  socket.join(room.roomId);
  addConn(room, id, 'io', socket);
  socket.emit('admitted', { you: id, ticket, roster: roster(room) });
}

// ---- once, from server.js ----
export function initRoomBroadcasts(io) {
  const pushPending = (room) => {
    const list = [...room.pending].map(([id, p]) => ({ id, username: p.username }));
    for (const [id, c] of room.conns) if (can(room, id, 'admit')) for (const s of c.io) s.emit('lobby:pending', list);
  };
  roomEvents.on('roster', (room) => { io.to(room.roomId).emit('roster', roster(room)); pushPending(room); });
  roomEvents.on('pending', pushPending);
  roomEvents.on('end', (room) => { for (const p of room.pending.values()) p.socket.emit('closed', 4410); });

  // Logged-in members persist (debounced). Guests never reach Mongo.
  roomEvents.on('membersDirty', (room) => {
    if (!room.persisted) return;
    clearTimeout(room.saveTimer);
    room.saveTimer = setTimeout(() => {
      const members = [...room.members].filter(([, m]) => !m.isGuest).map(([id, m]) => ({
        userId: id.slice(2), username: m.username, role: m.role, canWrite: m.canWrite, grantedAt: m.grantedAt,
      }));
      Board.updateOne({ roomId: room.roomId }, { $set: { members } }).catch((e) => console.error('members save failed', e));
    }, 500);
  });
}

// ---- per socket ----
export function registerRoomHandlers(io, socket) {
  const me = () => socket.data.identity;

  socket.on('room:create-guest', ({ isPrivate } = {}, cb) => {
    if (!me().isGuest) return ack(cb, { error: 'logged-in users create boards via REST' });
    const roomId = crypto.randomUUID();
    openRoom({ roomId, ownerId: me().id, ownerName: me().username, isPrivate: !!isPrivate, persisted: false });
    ack(cb, { roomId });
  });

  socket.on('join-room', async (roomId, cb) => {
    if (typeof roomId !== 'string' || !ROOM_ID.test(roomId)) return ack(cb, { status: 'error' });
    const seq = (socket.data.seq = (socket.data.seq ?? 0) + 1);
    leave(socket);
    const room = await ensureRoom(roomId, me()).catch(() => null);
    if (socket.disconnected || socket.data.seq !== seq) return;   // superseded by a newer join or a leave
    if (!room) return ack(cb, { status: 'not-found' });

    const r = requestJoin(room, me(), socket);
    if (r === 'cooldown') return ack(cb, { status: 'cooldown' });
    if (r === 'admitted') { admit(room, socket); return ack(cb, { status: 'admitted' }); }

    socket.data.pendingRoom = roomId;
    ack(cb, { status: 'pending' });
  });

  socket.on('leave-room', () => {
    socket.data.seq = (socket.data.seq ?? 0) + 1;
    const rid = socket.data.roomId;
    leave(socket);
    if (rid) io.to(rid).emit('user-disconnected', socket.id);
  });

  // Fresh single-use ticket for Yjs (first connect and every reconnect)
  socket.on('ticket:request', (_p, cb) => {
    const room = current(socket);
    ack(cb, room && isAdmitted(room, me().id) ? { ticket: issueTicket(room.roomId, me().id) } : null);
  });

  socket.on('join:resolve', ({ targetId, allow } = {}, cb) => {
    const room = current(socket);
    if (!room || typeof targetId !== 'string') return ack(cb, false);
    const p = resolveJoin(room, me().id, targetId, !!allow);   // can() checked inside
    if (!p) return ack(cb, false);
    if (allow) admit(room, p.socket);
    else { p.socket.data.pendingRoom = null; p.socket.emit('join:denied'); }
    ack(cb, true);
  });

  const manage = { 'member:setWrite': setWrite, 'member:promote': promote, 'member:demote': demote, 'member:kick': kick };
  for (const [event, fn] of Object.entries(manage)) {
    socket.on(event, (p, cb) => {
      const room = current(socket);
      ack(cb, !!room && typeof p?.targetId === 'string' && fn(room, me().id, p.targetId, p.value));
    });
  }

  // Clear is a server action; the Yjs gate will reject client-side bulk deletes
  socket.on('clear-board', (_p, cb) => {
    const room = current(socket);
    const doc = room && docs.get(room.roomId);
    if (!doc || !can(room, me().id, 'clear')) return ack(cb, false);
    const strokes = doc.getMap('strokes'), meta = doc.getMap('meta');
    doc.transact(() => {
      strokes.clear();
      meta.set('clearEpoch', (meta.get('clearEpoch') ?? 0) + 1);
    }, 'server');
    ack(cb, true);
  });

  // Guest-hosted rooms only; persisted boards are deleted via REST
  socket.on('room:end', (_p, cb) => {
    const room = current(socket);
    if (room && !room.persisted && can(room, me().id, 'delete')) { endRoom(room); return ack(cb, true); }
    ack(cb, false);
  });

  socket.on('disconnect', () => {
    const rid = socket.data.roomId;
    leave(socket);
    if (rid) io.to(rid).emit('user-disconnected', socket.id);   // this room only
  });
}