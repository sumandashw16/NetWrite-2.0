import { useRef, useState, useEffect } from 'react';
import { socket } from '../../services/socket';

export default function Canvas({ color = '#000000', brushSize = 5, roomId = 'test-room' }) {
  const canvasRef = useRef(null);
  const [isDrawing, setIsDrawing] = useState(false);

  useEffect(() => {
    // Join the room as soon as the canvas mounts
    socket.emit('join-room', roomId);
    
    const canvas = canvasRef.current;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    
    const ctx = canvas.getContext('2d');
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Listen for incoming drawing data from other users
    socket.on('receive-draw', (data) => {
      if (data.isStartingPoint) {
        ctx.beginPath();
        ctx.moveTo(data.x, data.y);
      } else {
        ctx.lineTo(data.x, data.y);
        ctx.strokeStyle = data.color;
        ctx.lineWidth = data.size;
        ctx.stroke();
      }
    });

    return () => {
      socket.off('receive-draw');
    };
  }, [roomId]);

  const emitDrawEvent = (x, y, isStartingPoint) => {
    socket.emit('draw', {
      roomId,
      x,
      y,
      color,
      size: brushSize,
      isStartingPoint
    });
  };

  const startDrawing = ({ nativeEvent }) => {
    const { offsetX, offsetY } = nativeEvent;
    const ctx = canvasRef.current.getContext('2d');
    
    ctx.beginPath();
    ctx.moveTo(offsetX, offsetY);
    ctx.strokeStyle = color;
    ctx.lineWidth = brushSize;
    
    setIsDrawing(true);
    emitDrawEvent(offsetX, offsetY, true);
  };

  const draw = ({ nativeEvent }) => {
    if (!isDrawing) return;
    const { offsetX, offsetY } = nativeEvent;
    const ctx = canvasRef.current.getContext('2d');
    
    ctx.lineTo(offsetX, offsetY);
    ctx.stroke();
    
    emitDrawEvent(offsetX, offsetY, false);
  };

  const stopDrawing = () => {
    const ctx = canvasRef.current.getContext('2d');
    ctx.closePath();
    setIsDrawing(false);
  };

  const handleMouseMove = ({ nativeEvent }) => {
    const { offsetX, offsetY } = nativeEvent;
    
    // Emit cursor position constantly
    socket.emit('cursor-move', { roomId, x: offsetX, y: offsetY });

    // Only draw if mouse is clicked
    if (!isDrawing) return;
    
    const ctx = canvasRef.current.getContext('2d');
    ctx.lineTo(offsetX, offsetY);
    ctx.stroke();
    
    emitDrawEvent(offsetX, offsetY, false);
  };

  // Update the return statement at the bottom
  return (
    <canvas
      ref={canvasRef}
      onMouseDown={startDrawing}
      onMouseMove={handleMouseMove} // Changed this line
      onMouseUp={stopDrawing}
      onMouseLeave={stopDrawing}
      className="bg-white cursor-crosshair touch-none"
    />
  );
}