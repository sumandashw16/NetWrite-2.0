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
      type: [Number], // flat array: [x0, y0, x1, y1, ...]
      default: []
    }
  },
  { _id: false } // we already have our own id; skip Mongo's per-stroke ObjectId
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
    }
  },
  { timestamps: true }
);

export default mongoose.model('Board', boardSchema);