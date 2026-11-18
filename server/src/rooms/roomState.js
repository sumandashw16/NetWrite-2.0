import { EventEmitter } from 'events';
import { can, roleOf } from './permissions.js';

// Events: 'permission'(room, id|null) 'roster'(room) 'pending'(room) 'membersDirty'(room) 'end'(room)
export const roomEvents = new EventEmitter();

const HOST_GRACE_MS = 15_000;
const EMPTY_MS = 10 * 60_000;
const rooms = new Map();
const KICK_COOLDOWN_MS = 60_000;
export const getRoom = (roomId) => rooms.get(roomId);

export function openRoom({ roomId, ownerId, ownerName = '', isPrivate, persisted, members = [] }) {
  let room = rooms.get(roomId);
  if (room) return room;
  room = {
    roomId, ownerId, ownerName, isPrivate, persisted,
    actingHostId: ownerId, hostless: false, locked: false,
    members: new Map(),   // id -> { role:'cohost'|'joiner', canWrite, grantedAt, isGuest, username }. This IS the admission list.
    pending: new Map(),   // id -> { socket, username, requestedAt }
    conns: new Map(),     // id -> { io:Set<socket>, yjs:Set<ws> }
    cooldown: new Map(),
    lastGrant: 0, hostTimer: null, emptyTimer: null,
  };
  for (const m of members) room.members.set(m.id, { canWrite: false, grantedAt: 0, isGuest: false, ...m });
  rooms.set(roomId, room);
  return room;
}

export function endRoom(room) {
  clearTimeout(room.hostTimer); clearTimeout(room.emptyTimer);
  for (const id of room.conns.keys()) closeAll(room, id, 4410);
  rooms.delete(room.roomId);
  roomEvents.emit('end', room);
}

// ---- presence: "online" means at least one Socket.IO connection ----
const online = (room, id) => (room.conns.get(id)?.io.size ?? 0) > 0;
const anyOnline = (room) => [...room.conns.keys()].some((id) => online(room, id));

export function addConn(room, id, kind, handle) {
  let c = room.conns.get(id);
  if (!c) room.conns.set(id, (c = { io: new Set(), yjs: new Set() }));
  c[kind].add(handle);
  clearTimeout(room.emptyTimer); room.emptyTimer = null;
  if (kind === 'io') { checkHost(room); roomEvents.emit('roster', room); }
}

export function removeConn(room, id, kind, handle) {
  const c = room.conns.get(id);
  if (!c) return;
  c[kind].delete(handle);
  if (!c.io.size && !c.yjs.size) room.conns.delete(id);
  if (kind !== 'io') return;
  if (!online(room, id)) room.pending.delete(id);
  checkHost(room);
  if (!anyOnline(room) && !room.emptyTimer) room.emptyTimer = setTimeout(() => endRoom(room), EMPTY_MS);
  roomEvents.emit('roster', room);
}

// code: 4401 kicked, 4403 permission change (client resyncs), 4410 room ended
export function closeAll(room, id, code, only) {
  const c = room.conns.get(id);
  if (!c) return;
  if (only !== 'yjs') for (const s of [...c.io]) { s.emit('closed', code); s.disconnect(true); }
  if (only !== 'io') for (const ws of [...c.yjs]) ws.close(code);
}

// ---- host failover ----
const nextGrant = (room) => (room.lastGrant = Math.max(Date.now(), room.lastGrant + 1));

function nextCohost(room) {
  return [...room.members]
    .filter(([id, m]) => m.role === 'cohost' && id !== room.actingHostId && online(room, id))
    .sort((a, b) => a[1].grantedAt - b[1].grantedAt)[0]?.[0] ?? null;
}

function setActing(room, id) {
  clearTimeout(room.hostTimer); room.hostTimer = null;
  room.actingHostId = id; room.hostless = false; room.locked = false;
  roomEvents.emit('permission', room, null);
  roomEvents.emit('roster', room);
}

function checkHost(room) {
  if (online(room, room.ownerId)) {                       // owner (back): reclaim
    if (room.actingHostId !== room.ownerId || room.locked) setActing(room, room.ownerId);
    else { clearTimeout(room.hostTimer); room.hostTimer = null; }
    return;
  }
  if (online(room, room.actingHostId)) { clearTimeout(room.hostTimer); room.hostTimer = null; return; }
  if (room.hostless) { const n = nextCohost(room); if (n) setActing(room, n); return; }
  if (!room.hostTimer) room.hostTimer = setTimeout(() => { room.hostTimer = null; failover(room); }, HOST_GRACE_MS);
}

function failover(room) {
  if (online(room, room.actingHostId) || !anyOnline(room)) return;
  const n = nextCohost(room);
  if (n) return setActing(room, n);
  room.hostless = true; room.locked = true;               // nobody to promote: everyone read-only, room stays open
  roomEvents.emit('permission', room, null);
  roomEvents.emit('roster', room);
}

// ---- admission ----
export const isAdmitted = (room, id) => id === room.ownerId || room.members.has(id);

function addMember(room, ident, role = 'joiner') {
  room.members.set(ident.id, { role, canWrite: false, grantedAt: role === 'cohost' ? nextGrant(room) : 0, isGuest: ident.isGuest, username: ident.username });
  roomEvents.emit('membersDirty', room);
}

// -> 'admitted' | 'pending'. Public rooms admit instantly.
export function requestJoin(room, ident, socket) {
  if (isAdmitted(room, ident.id)) return 'admitted';
  if ((room.cooldown.get(ident.id) ?? 0) > Date.now()) return 'cooldown';
  if (!room.isPrivate) { addMember(room, ident); return 'admitted'; }
  room.pending.set(ident.id, { socket, username: ident.username, requestedAt: Date.now() });
  roomEvents.emit('pending', room);
  return 'pending';
}

// -> the pending entry (caller moves its socket into the room and issues the ticket) or null
export function resolveJoin(room, actorId, targetId, allow) {
  if (!can(room, actorId, allow ? 'admit' : 'deny')) return null;
  const p = room.pending.get(targetId);
  if (!p) return null;
  room.pending.delete(targetId);
  if (allow) addMember(room, { id: targetId, isGuest: targetId.startsWith('g:'), username: p.username });
  roomEvents.emit('pending', room);
  roomEvents.emit('roster', room);
  return p;
}

// ---- management actions (all gated by can()) ----
function act(room, actorId, action, targetId, fn) {
  if (!can(room, actorId, action, targetId)) return false;
  fn();
  roomEvents.emit('membersDirty', room);
  roomEvents.emit('roster', room);
  return true;
}

export const setWrite = (room, actor, target, v) =>
  act(room, actor, 'setWrite', target, () => {
    room.members.get(target).canWrite = !!v;
    roomEvents.emit('permission', room, target);
  });

export const promote = (room, actor, target) =>
  act(room, actor, 'promote', target, () => {
    Object.assign(room.members.get(target), { role: 'cohost', canWrite: true, grantedAt: nextGrant(room) });
    roomEvents.emit('permission', room, target);
  });

export const demote = (room, actor, target) =>
  act(room, actor, 'demote', target, () => {
    Object.assign(room.members.get(target), { role: 'joiner', canWrite: false });
    roomEvents.emit('permission', room, target);
  });

export const kick = (room, actor, target) =>
  act(room, actor, 'kick', target, () => {
    room.cooldown.set(target, Date.now() + KICK_COOLDOWN_MS);
    room.members.delete(target);
    room.pending.delete(target);
    closeAll(room, target, 4401);   // BOTH Socket.IO and Yjs
  });

// ---- what clients may see ----
export function roster(room) {
  const list = [];
  const push = (id, username, role, canWrite) =>
    list.push({ id, username, role, canWrite, online: online(room, id) });
  if (!room.members.has(room.ownerId)) push(room.ownerId, room.ownerName, roleOf(room, room.ownerId) ?? 'host', true);
  for (const [id, m] of room.members) {
    const r = roleOf(room, id);
    push(id, m.username, r, r !== 'joiner' || m.canWrite);
  }
  return { roomId: room.roomId, locked: room.locked, persisted: room.persisted, isPrivate: room.isPrivate, actingHostId: room.actingHostId, members: list };
}