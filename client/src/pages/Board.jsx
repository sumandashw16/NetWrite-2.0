import { useState, useRef } from 'react';
import { useParams } from 'react-router-dom';
import Canvas from '../components/canvas/Canvas';
import LiveCursors from '../components/collaboration/LiveCursors';

export default function Board() {
  const { roomId } = useParams();
  const [color, setColor] = useState('#000000');
  const [brushSize, setBrushSize] = useState(5);
  
  // Create a ref to access functions inside the Canvas component
  const canvasRef = useRef(); 

  const handleSave = () => {
    if (canvasRef.current) {
      canvasRef.current.saveToDatabase();
    }
  };

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', top: '16px', left: '16px', zIndex: 10, background: 'white', padding: '16px', borderRadius: '8px', boxShadow: '0 4px 6px rgba(0,0,0,0.1)', display: 'flex', gap: '16px', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginRight: '10px' }}>
          <span style={{ fontFamily: 'sans-serif', fontWeight: 'bold' }}>Room: {roomId}</span>
          <button 
            onClick={() => navigator.clipboard.writeText(roomId)}
            style={{ padding: '2px 8px', fontSize: '12px', cursor: 'pointer', borderRadius: '4px', border: '1px solid #ccc', background: '#f5f5f5' }}
            title="Copy Room ID"
          >
            Copy
          </button>
        </div>
        
        <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        <input type="range" min="1" max="20" value={brushSize} onChange={(e) => setBrushSize(parseInt(e.target.value))} />
        
        <button onClick={() => setColor('#ffffff')} style={{ padding: '4px 8px', cursor: 'pointer' }}>
          Eraser
        </button>
        
        {/* New Save Button */}
        <button 
          onClick={handleSave} 
          style={{ padding: '4px 12px', background: '#3b82f6', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
        >
          Save Board
        </button>
      </div>

      {/* Pass the ref to the Canvas */}
      <Canvas ref={canvasRef} color={color} brushSize={brushSize} roomId={roomId} />
      <LiveCursors />
    </div>
  );
}