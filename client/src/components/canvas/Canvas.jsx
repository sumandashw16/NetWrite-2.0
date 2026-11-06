import { useRef, useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import { socket } from '../../services/socket';

const Canvas = forwardRef(({ color = '#000000', brushSize = 5, roomId }, ref) => {
  const canvasRef = useRef(null);
  const [isDrawing, setIsDrawing] = useState(false);
  
  // Track all strokes in memory without causing React to re-render
  const strokeHistory = useRef([]);

  // Expose the save function to the parent Board component
  useImperativeHandle(ref, () => ({
    saveToDatabase: async () => {
      try {
        await fetch(`http://localhost:5000/api/boards/${roomId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ strokes: strokeHistory.current })
        });
        alert('Board saved successfully!');
      } catch (error) {
        console.error('Error saving board:', error);
        alert('Failed to save board.');
      }
    }
  }));

  // Function to draw a single stroke data object to the canvas
  const drawStrokeOnCanvas = (data, ctx) => {
    if (data.isStartingPoint) {
      ctx.beginPath();
      ctx.moveTo(data.x, data.y);
    } else {
      ctx.lineTo(data.x, data.y);
      ctx.strokeStyle = data.color;
      ctx.lineWidth = data.size;
      ctx.stroke();
    }
  };

  useEffect(() => {
    socket.emit('join-room', roomId);
    
    const canvas = canvasRef.current;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const ctx = canvas.getContext('2d');
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // 1. Fetch existing board data from MongoDB on load
    fetch(`http://localhost:5000/api/boards/${roomId}`)
      .then(res => res.json())
      .then(data => {
        if (data.strokes && data.strokes.length > 0) {
          strokeHistory.current = data.strokes;
          data.strokes.forEach(stroke => drawStrokeOnCanvas(stroke, ctx));
        }
      })
      .catch(err => console.log('No existing board found or error fetching.'));

    // 2. Listen for real-time strokes from others
    socket.on('receive-draw', (data) => {
      strokeHistory.current.push(data); // Save to history
      drawStrokeOnCanvas(data, ctx);    // Draw to screen
    });

    return () => {
      socket.off('receive-draw');
    };
  }, [roomId]);

  const emitAndTrackDraw = (x, y, isStartingPoint) => {
    const drawData = { roomId, x, y, color, size: brushSize, isStartingPoint };
    
    strokeHistory.current.push(drawData); // Track locally
    socket.emit('draw', drawData);        // Send to others
  };

  const startDrawing = ({ nativeEvent }) => {
    const { offsetX, offsetY } = nativeEvent;
    const ctx = canvasRef.current.getContext('2d');
    
    ctx.beginPath();
    ctx.moveTo(offsetX, offsetY);
    ctx.strokeStyle = color;
    ctx.lineWidth = brushSize;
    
    setIsDrawing(true);
    emitAndTrackDraw(offsetX, offsetY, true);
  };

  const handleMouseMove = ({ nativeEvent }) => {
    const { offsetX, offsetY } = nativeEvent;
    socket.emit('cursor-move', { roomId, x: offsetX, y: offsetY });

    if (!isDrawing) return;
    
    const ctx = canvasRef.current.getContext('2d');
    ctx.lineTo(offsetX, offsetY);
    ctx.stroke();
    
    emitAndTrackDraw(offsetX, offsetY, false);
  };

  const stopDrawing = () => {
    if (isDrawing) {
      const ctx = canvasRef.current.getContext('2d');
      ctx.closePath();
      setIsDrawing(false);
    }
  };

  return (
    <canvas
      ref={canvasRef}
      onMouseDown={startDrawing}
      onMouseMove={handleMouseMove}
      onMouseUp={stopDrawing}
      onMouseLeave={stopDrawing}
      className="bg-white cursor-crosshair touch-none"
    />
  );
});

export default Canvas;