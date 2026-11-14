import express from 'express';
import Y from '../socket/yjsShared.js'; 
import Board from '../models/Board.js';
import { docs, saveRoom } from '../socket/yjsServer.js';

const router = express.Router();

// Y.Doc -> plain stroke array, in draw order
const strokesFromDoc = (ydoc) =>
  [...ydoc.getMap('strokes').values()]
    .map((m) => m.toJSON())
    .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

// Get board data by Room ID. Live in-memory state wins over the DB copy for active rooms.
router.get('/:roomId', async (req, res) => {
  try {
    const { roomId } = req.params;

    const live = docs.get(roomId);
    if (live) return res.json({ roomId, strokes: strokesFromDoc(live) });

    // No .lean() here: it can return the Buffer field as a BSON Binary, which Yjs can't decode
    const board = await Board.findOne({ roomId });
    if (!board) return res.status(404).json({ message: 'Board not found' });

    if (board.ydocState?.length) {
      const ydoc = new Y.Doc();
      Y.applyUpdate(ydoc, new Uint8Array(board.ydocState));
      const strokes = strokesFromDoc(ydoc);
      ydoc.destroy();
      return res.json({ roomId, strokes });
    }

    res.json(board); // legacy board that hasn't been opened since the migration
  } catch (error) {
    console.error('GET board failed:', error);
    res.status(500).json({ error: 'Server error fetching board' });
  }
});

// Save: persist the live room right now. The request body is ignored.
router.post('/:roomId', async (req, res) => {
  try {
    // No-op if the room isn't in memory (already saved when the last user left)
    await saveRoom(req.params.roomId);
    res.json({ message: 'Board saved successfully' });
  } catch (error) {
    console.error('POST board failed:', error);
    res.status(500).json({ error: 'Server error saving board' });
  }
});

export default router;