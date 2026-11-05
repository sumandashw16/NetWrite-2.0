import { useState } from 'react';
import Canvas from './components/canvas/Canvas';
import LiveCursors from './components/collaboration/LiveCursors';

function App() {
  const [color, setColor] = useState('#000000');
  const [brushSize, setBrushSize] = useState(5);

  return (
    <div className="relative w-screen h-screen overflow-hidden">
      {/* Temporary basic toolbar for testing */}
      <div className="absolute top-4 left-4 z-10 bg-white p-4 rounded shadow flex gap-4">
        <input 
          type="color" 
          value={color} 
          onChange={(e) => setColor(e.target.value)} 
        />
        <input 
          type="range" 
          min="1" 
          max="20" 
          value={brushSize} 
          onChange={(e) => setBrushSize(parseInt(e.target.value))} 
        />
        {/* Eraser is just drawing with white */}
        <button onClick={() => setColor('#ffffff')} className="border px-2 rounded">
          Eraser
        </button>
      </div>

      <Canvas color={color} brushSize={brushSize} />
      <LiveCursors />
    </div>
  );
}

export default App;