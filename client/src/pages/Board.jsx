import { useState, useRef, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import {
  MousePointer2, Pencil, Eraser, Shapes as ShapesIcon, Undo2, Redo2,
  ZoomIn, ZoomOut, Maximize, Trash2, Download, Save, Copy, Circle, Type
} from 'lucide-react';
import Canvas from '../components/canvas/Canvas';
import LiveCursors from '../components/collaboration/LiveCursors';
import PropertiesPanel from '../components/canvas/PropertiesPanel';
import { ShapePicker, IconPicker } from '../components/canvas/ToolPickers';

const C = {
  appBg: '#F5F6F8', canvasBg: '#F8FAFC', surface: '#FFFFFF',
  primary: '#2563EB', primaryHover: '#1D4ED8',
  text: '#111827', textMuted: '#6B7280', border: '#E5E7EB'
};

const navBar = {
  position: 'absolute', top: 0, left: 0, right: 0, height: 56, zIndex: 20,
  background: C.surface, borderBottom: `1px solid ${C.border}`,
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '0 16px', fontFamily: 'Inter, system-ui, sans-serif'
};

const toolbarWrap = {
  position: 'absolute', bottom: 20, left: '50%', transform: 'translateX(-50%)', zIndex: 20,
  display: 'flex', alignItems: 'center', gap: 4,
  background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14,
  boxShadow: '0 8px 24px rgba(17,24,39,0.12)', padding: 6,
  fontFamily: 'Inter, system-ui, sans-serif'
};

const divider = { width: 1, alignSelf: 'stretch', background: C.border, margin: '4px 2px' };

function ToolButton({ active, onClick, title, children }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        width: 36, height: 36, display: 'grid', placeItems: 'center',
        borderRadius: 9, border: 'none', cursor: 'pointer',
        background: active ? '#EFF6FF' : 'transparent',
        color: active ? C.primary : C.text,
        transition: 'background 120ms ease, color 120ms ease'
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = '#F3F4F6'; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
    >
      {children}
    </button>
  );
}

export default function Board() {
  const { roomId } = useParams();
  const [color, setColor] = useState('#000000');
  const [brushSize, setBrushSize] = useState(5);
  const [camera, setCamera] = useState({ x: 0, y: 0, scale: 1 });
  const [activeTool, setActiveTool] = useState('select');
  const [selectedObjects, setSelectedObjects] = useState([]);
  const canvasRef = useRef();

  // Poll selected objects' live values (color/rotation change during drag) without
  // threading a full re-render loop through Canvas; cheap since selections are small.
  const refreshSelection = useCallback(() => {
    setSelectedObjects(canvasRef.current?.getSelectedObjects?.() ?? []);
  }, []);

  const handleSelectionChange = useCallback(() => {
    refreshSelection();
  }, [refreshSelection]);

  const handleClear = () => {
    if (window.confirm('Are you sure you want to clear the entire whiteboard for everyone?')) {
      canvasRef.current?.clearBoard();
    }
  };

  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = `
      html, body {
        margin: 0;
        height: 100%;
        overflow: hidden;
      }
    `;
    document.head.appendChild(style);
    return () => document.head.removeChild(style);
  }, []);

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden', background: C.appBg }}>
      {/* Top navigation */}
      <div style={navBar}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <span style={{ fontWeight: 700, fontSize: 15, color: C.text }}>NetWrite</span>
          <div style={{ width: 1, height: 20, background: C.border }} />
          <span style={{ fontSize: 13, color: C.text }}>Room {roomId}</span>
          <button
            onClick={() => navigator.clipboard.writeText(roomId)}
            title="Copy room ID"
            style={{
              width: 26, height: 26, display: 'grid', placeItems: 'center',
              borderRadius: 6, border: `1px solid ${C.border}`, background: C.surface,
              cursor: 'pointer', color: C.textMuted
            }}
          >
            <Copy size={13} />
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: C.textMuted }}>
            <Circle size={8} fill={C.primary} color={C.primary} />
            Live
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={() => canvasRef.current?.saveToDatabase()}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px',
              background: C.primary, color: '#fff', border: 'none', borderRadius: 8,
              cursor: 'pointer', fontSize: 13, fontWeight: 600
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = C.primaryHover)}
            onMouseLeave={(e) => (e.currentTarget.style.background = C.primary)}
          >
            <Save size={14} /> Save
          </button>
        </div>
      </div>

      {/* Canvas area with dot-grid backdrop */}
      <div
        style={{
          position: 'absolute', inset: 0, top: 56,
          background: `${C.canvasBg} radial-gradient(${C.border} 1px, transparent 1px)`,
          backgroundSize: '20px 20px'
        }}
      >
        <Canvas
          ref={canvasRef}
          color={color}
          brushSize={brushSize}
          roomId={roomId}
          onCameraChange={setCamera}
          onToolChange={setActiveTool}
          onSelectionChange={handleSelectionChange}
        />
        <LiveCursors camera={camera} />
      </div>

      {/* Properties panel */}
      <PropertiesPanel
        objects={selectedObjects}
        onStyleChange={(fields) => { canvasRef.current?.updateSelectedStyle(fields); refreshSelection(); }}
        onDuplicate={() => { canvasRef.current?.duplicateSelected(); refreshSelection(); }}
        onDelete={() => { canvasRef.current?.deleteSelected(); setSelectedObjects([]); }}
      />

      {/* Floating bottom toolbar */}
      <div style={toolbarWrap}>
        <ToolButton active={activeTool === 'select'} onClick={() => canvasRef.current?.setTool('select')} title="Select (V)">
          <MousePointer2 size={17} />
        </ToolButton>
        <ToolButton active={activeTool === 'pen'} onClick={() => canvasRef.current?.setTool('pen')} title="Pen (P)">
          <Pencil size={17} />
        </ToolButton>
        <ToolButton active={activeTool === 'eraser'} onClick={() => canvasRef.current?.setTool('eraser')} title="Eraser (E)">
          <Eraser size={17} />
        </ToolButton>

        <div style={divider} />

        <input
          type="color" value={color}
          onChange={(e) => {
            setColor(e.target.value);
            if (canvasRef.current?.getSelectedIds?.().length) {
              canvasRef.current.updateSelectedStyle({ color: e.target.value });
            }
          }}
          title="Stroke color"
          style={{ width: 30, height: 30, border: 'none', borderRadius: 8, cursor: 'pointer', background: 'none' }}
        />
        <input
          type="range" min="1" max="20" value={brushSize}
          onChange={(e) => setBrushSize(parseInt(e.target.value, 10))}
          title="Brush size" style={{ width: 70 }}
        />

        <div style={divider} />

        <ShapePicker onPick={(t) => canvasRef.current?.addShape(t)} />
        <IconPicker onPick={(n) => canvasRef.current?.addIcon(n)} />
        <ToolButton onClick={() => canvasRef.current?.addText()} title="Add text">
          <Type size={17} />
        </ToolButton>
        <div style={divider} />

        <ToolButton onClick={() => canvasRef.current?.undo()} title="Undo (Ctrl+Z)"><Undo2 size={17} /></ToolButton>
        <ToolButton onClick={() => canvasRef.current?.redo()} title="Redo (Ctrl+Shift+Z)"><Redo2 size={17} /></ToolButton>

        <div style={divider} />

        <ToolButton onClick={() => canvasRef.current?.resetView()} title="Fit to screen"><Maximize size={17} /></ToolButton>

        <div style={divider} />

        <ToolButton onClick={handleClear} title="Clear board"><Trash2 size={17} /></ToolButton>
        <ToolButton onClick={() => canvasRef.current?.exportPNG()} title="Export PNG"><Download size={17} /></ToolButton>
      </div>
    </div>
  );
}