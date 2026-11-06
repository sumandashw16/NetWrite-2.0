import express from 'express';
import Board from '../models/Board.js';

const router = express.Router();

// Get board data by Room ID
router.get('/:roomId', async (req, res) => {
  try {
    const board = await Board.findOne({ roomId: req.params.roomId });
    if (!board) {
      return res.status(404).json({ message: 'Board not found' });
    }
    res.json(board);
  } catch (error) {
    res.status(500).json({ error: 'Server error fetching board' });
  }
});

// Save or update board data
router.post('/:roomId', async (req, res) => {
  try {
    const { strokes } = req.body;
    
    // Find the board and update it, or create it if it doesn't exist (upsert)
    const board = await Board.findOneAndUpdate(
      { roomId: req.params.roomId },
      { strokes },
      { new: true, upsert: true }
    );
    
    res.json({ message: 'Board saved successfully', board });
  } catch (error) {
    res.status(500).json({ error: 'Server error saving board' });
  }
});

export default router;