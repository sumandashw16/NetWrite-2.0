import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { signGuestToken } from '../middlewares/authMiddleware.js';
const router = express.Router();

// A JSON body can hold objects like { "$ne": "" }. Accept plain strings only.
const creds = (body) => {
  const { username, password } = body ?? {};
  if (typeof username !== 'string' || typeof password !== 'string') return null;
  const u = username.trim();
  if (u.length < 3 || u.length > 32 || password.length < 6 || password.length > 128) return null;
  return { username: u, password };
};

// Register a new user
router.post('/register', async (req, res) => {
  try {
    const c = creds(req.body);
    if (!c) return res.status(400).json({ message: 'Invalid username or password' });
    const { username, password } = c;

    // Check if user exists
    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(400).json({ message: 'Username already taken' });
    }

    // Hash the password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Save to database
    const newUser = new User({ username, password: hashedPassword });
    await newUser.save();

    res.status(201).json({ message: 'User registered successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Server error during registration' });
  }
});

// Login user
router.post('/login', async (req, res) => {
  try {
    const c = creds(req.body);
    if (!c) return res.status(400).json({ message: 'Invalid credentials' });
    const { username, password } = c;

    // Find user
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    // Check password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    // Generate JWT
    const token = jwt.sign(
      { userId: user._id, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({ token, username: user.username });
  } catch (error) {
    res.status(500).json({ error: 'Server error during login' });
  }
});
router.post('/guest', (req, res) => res.json(signGuestToken()));
export default router;