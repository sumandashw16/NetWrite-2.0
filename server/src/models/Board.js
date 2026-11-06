import mongoose from 'mongoose';

const boardSchema = new mongoose.Schema({
  roomId: { 
    type: String, 
    required: true, 
    unique: true 
  },
  strokes: { 
    type: Array, 
    default: [] 
  }
}, { timestamps: true });

export default mongoose.model('Board', boardSchema);