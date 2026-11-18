import express from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import Y from '../socket/yjsShared.js';
import Board from '../models/Board.js';
import { docs, saveRoom } from '../socket/yjsServer.js';
import { requireAuth, requireUser } from '../middlewares/authMiddleware.js';
import { getRoom, isAdmitted, endRoom } from '../rooms/roomState.js';
import { can } from '../rooms/permissions.js';

const router = express.Router();
const uidOf = (identity) => identity.id.slice(2);   // strip "u:"

const strokesFromDoc = (ydoc) =>
  [...ydoc.getMap('strokes').values()]
    .map((m) => m.toJSON())
    .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

// Live room: must be admitted. Otherwise: logged-in owner or member in Mongo.
async function mayRead(identity, roomId) {
  const room = getRoom(roomId);
  if (room) return isAdmitted(room, identity.id);
  if (identity.isGuest) return false;
  const uid = uidOf(identity);
  return !!(await Board.exists({ roomId, $or: [{ owner: uid }, { 'members.userId': uid }] }));
}

// ---- dashboard (logged-in only; guests get 403). Declared before '/:roomId'. ----
const card = (b, role) => ({
  roomId: b.roomId, ownerName: b.ownerName, isPrivate: b.isPrivate, updatedAt: b.updatedAt, role,
});

router.get('/dashboard/managed', requireUser, async (req, res) => {
  const uid = uidOf(req.identity);
  const boards = await Board.find({
    $or: [{ owner: uid }, { members: { $elemMatch: { userId: uid, role: 'cohost' } } }],
  }).sort({ updatedAt: -1 }).limit(200).lean();
  res.json(boards.map((b) => card(b, b.owner === uid ? 'host' : 'cohost')));
});

router.get('/dashboard/shared', requireUser, async (req, res) => {
  const uid = uidOf(req.identity);
  const boards = await Board.find({
    owner: { $ne: uid },
    members: { $elemMatch: { userId: uid, role: 'joiner' } },
  }).sort({ updatedAt: -1 }).limit(200).lean();
  res.json(boards.map((b) => card(b, 'joiner')));
});

// ---- create (logged-in hosts only; guest rooms are created over the socket) ----
router.post('/', requireUser, async (req, res) => {
  const roomId = crypto.randomUUID();
  await Board.create({
    roomId, owner: uidOf(req.identity), ownerName: req.identity.username,
    isPrivate: req.body?.isPrivate === true,
  });
  res.status(201).json({ roomId });
});

// ---- read ----
router.get('/:roomId', requireAuth, async (req, res) => {
  try {
    const { roomId } = req.params;
    if (!(await mayRead(req.identity, roomId))) return res.status(403).json({ message: 'Forbidden' });

    const live = docs.get(roomId);
    if (live) return res.json({ roomId, strokes: strokesFromDoc(live) });

    const board = await Board.findOne({ roomId });   // no .lean(): Buffer must stay a Buffer
    if (!board) return res.status(404).json({ message: 'Board not found' });
    if (board.ydocState?.length) {
      const ydoc = new Y.Doc();
      Y.applyUpdate(ydoc, new Uint8Array(board.ydocState));
      const strokes = strokesFromDoc(ydoc);
      ydoc.destroy();
      return res.json({ roomId, strokes });
    }
    res.json({ roomId, strokes: board.strokes ?? [] });
  } catch (e) {
    console.error('GET board failed:', e);
    res.status(500).json({ error: 'Server error fetching board' });
  }
});

// ---- snapshot: any admitted member; body ignored; server serializes its own state ----
router.post('/:roomId', requireAuth, rateLimit({ windowMs: 60_000, limit: 10 }), async (req, res) => {
  try {
    const room = getRoom(req.params.roomId);
    if (!room || !isAdmitted(room, req.identity.id)) return res.status(403).json({ message: 'Forbidden' });
    if (!can(room, req.identity.id, 'snapshot')) return res.status(403).json({ message: 'This board is not persisted' });
    await saveRoom(room.roomId);
    res.json({ message: 'Board saved successfully' });
  } catch (e) {
    console.error('POST board failed:', e);
    res.status(500).json({ error: 'Server error saving board' });
  }
});

// ---- delete: owner only ----
router.delete('/:roomId', requireUser, async (req, res) => {
  const { roomId } = req.params;
  const room = getRoom(roomId);
  if (room) {
    if (!can(room, req.identity.id, 'delete')) return res.status(403).json({ message: 'Forbidden' });
    endRoom(room);   // closes every Socket.IO and Yjs connection
  }
  const r = await Board.deleteOne({ roomId, owner: uidOf(req.identity) });
  if (!r.deletedCount) return res.status(403).json({ message: 'Forbidden' });
  res.json({ message: 'Board deleted' });
});

export default router;