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
  },
  { timestamps: true }
);

export default mongoose.model('Board', boardSchema);
