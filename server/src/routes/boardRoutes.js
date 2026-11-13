import express from 'express';
import Board from '../models/Board.js';
import { activeRoomsData, flushRoom } from '../socket/roomStore.js';

const router = express.Router();

// Get board data by Room ID. Live RAM state wins over the DB copy for active rooms.
router.get('/:roomId', async (req, res) => {
  try {
    const { roomId } = req.params;

    const live = activeRoomsData.get(roomId);
    if (live) return res.json({ roomId, strokes: live });

    const board = await Board.findOne({ roomId }).lean();
    if (!board) return res.status(404).json({ message: 'Board not found' });
    res.json(board);
  } catch (error) {
    console.error('GET board failed:', error);
    res.status(500).json({ error: 'Server error fetching board' });
  }
});

// Save: persist the server's authoritative in-memory state. The request body is ignored.
router.post('/:roomId', async (req, res) => {
  try {
    // No-op if the room isn't in RAM (already saved) or hasn't changed since the last flush
    await flushRoom(req.params.roomId);
    res.json({ message: 'Board saved successfully' });
  } catch (error) {
    console.error('POST board failed:', error);
    res.status(500).json({ error: 'Server error saving board' });
  }
});

export default router;