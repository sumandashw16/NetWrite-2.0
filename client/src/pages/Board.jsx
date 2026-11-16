import { useState, useRef } from 'react';
import { useParams } from 'react-router-dom';
import Canvas from '../components/canvas/Canvas';
import LiveCursors from '../components/collaboration/LiveCursors';
import { ShapePicker, IconPicker } from '../components/canvas/ToolPickers';

const btn = { padding: '4px 8px', cursor: 'pointer' };
const group = { display: 'flex', gap: 8, alignItems: 'center', borderLeft: '2px solid #e5e7eb', paddingLeft: 12 };

export default function Board() {
  const { roomId } = useParams();
  const [color, setColor] = useState('#000000');
  const [brushSize, setBrushSize] = useState(5);
  const [camera, setCamera] = useState({ x: 0, y: 0, scale: 1 });
  const [activeTool, setActiveTool] = useState('select');
  const canvasRef = useRef();

  const handleClear = () => {
    if (window.confirm('Are you sure you want to clear the entire whiteboard for everyone?')) canvasRef.current?.clearBoard();
  };

  const toolBtn = (tool) => ({
    onClick: () => canvasRef.current?.setTool(tool),
    style: {
      ...btn, borderRadius: 4,
      border: activeTool === tool ? '2px solid #3b82f6' : '1px solid #ccc',
      background: activeTool === tool ? '#eff6ff' : 'white',
      fontWeight: activeTool === tool ? 'bold' : 'normal'
    }
  });

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', top: 16, left: 16, zIndex: 10, background: 'white', padding: '6px 10px', borderRadius: 8, boxShadow: '0 2px 6px rgba(0,0,0,0.12)', display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'sans-serif' }}>
        <b>Room: {roomId}</b>
        <button onClick={() => navigator.clipboard.writeText(roomId)} style={{ padding: '2px 8px', fontSize: 12, cursor: 'pointer', borderRadius: 4, border: '1px solid #ccc', background: '#f5f5f5' }} title="Copy Room ID">Copy</button>
      </div>

      <div style={{ position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 10, maxWidth: '96vw', background: 'white', padding: '10px 14px', borderRadius: 10, boxShadow: '0 4px 12px rgba(0,0,0,0.18)', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center' }}>
        <button {...toolBtn('select')} title="Select (V)">🖱 Select</button>
        <button {...toolBtn('pen')} title="Pen (P)">✏️ Pen</button>
        <button {...toolBtn('eraser')} title="Eraser (E)">🧽 Eraser</button>
        <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        <input type="range" min="1" max="20" value={brushSize} onChange={(e) => setBrushSize(parseInt(e.target.value))} />

        <div style={group}>
          <ShapePicker onPick={(t) => canvasRef.current?.addShape(t)} />
          <IconPicker onPick={(n) => canvasRef.current?.addIcon(n)} />
        </div>

        <div style={group}>
          <button onClick={() => canvasRef.current?.undo()} style={btn}>Undo</button>
          <button onClick={() => canvasRef.current?.redo()} style={btn}>Redo</button>
          <button onClick={() => canvasRef.current?.resetView()} style={btn}>Reset view</button>
        </div>

        <div style={group}>
          <button onClick={handleClear} style={{ ...btn, borderRadius: 4, border: '1px solid #fca5a5', background: '#fff1f2', color: '#dc2626' }} title="Clear entire whiteboard">Clear</button>
          <button onClick={() => canvasRef.current?.saveToDatabase()} style={{ padding: '4px 12px', background: '#3b82f6', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 'bold' }}>Save</button>
          <button onClick={() => canvasRef.current?.exportPNG()} style={{ padding: '4px 12px', background: '#10b981', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 'bold' }}>Export PNG</button>
        </div>
      </div>

      <Canvas ref={canvasRef} color={color} brushSize={brushSize} roomId={roomId} onCameraChange={setCamera} onToolChange={setActiveTool} />
      <LiveCursors camera={camera} />
    </div>
  );
}