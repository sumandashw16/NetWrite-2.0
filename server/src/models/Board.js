import mongoose from 'mongoose';
const strokeSchema = new mongoose.Schema(
  {
    id: {
      type: String,
      required: true // client-generated UUID
    },
    userId: String,
    color: String,
    width: Number,
    points: {
      type: [Number], // flat array: [x0, y0, x1, y1, ...]. Never mutated after stroke:end.
      default: []
    },

    // Non-destructive transform. Applied at render time around the center of the raw-points AABB.
    x: { type: Number, default: 0 },        // translation, world units
    y: { type: Number, default: 0 },
    scaleX: { type: Number, default: 1 },
    scaleY: { type: Number, default: 1 },
    rotation: { type: Number, default: 0 },  // radians
  },
  { _id: false }
);
const memberSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },   // raw user id, no "u:" prefix. Guests are never stored.
    username: String,
    role: { type: String, enum: ['cohost', 'joiner'], default: 'joiner' },
    canWrite: { type: Boolean, default: false },
    grantedAt: { type: Number, default: 0 },    // co-host order for failover
  },
  { _id: false }
);

const boardSchema = new mongoose.Schema(
  {
    roomId: {
      type: String,
      required: true,
      unique: true
    },
    strokes: {
      type: [strokeSchema],
      default: []
    },
    ydocState: { type: Buffer }, // Yjs binary state (source of truth now)
    owner: { type: String, index: true },       // raw user id. Persisted boards are always user-owned.
    ownerName: String,
    isPrivate: { type: Boolean, default: false },
    members: { type: [memberSchema], default: [] },
  },
  { timestamps: true }
);
boardSchema.index({ 'members.userId': 1 });
export default mongoose.model('Board', boardSchema);
