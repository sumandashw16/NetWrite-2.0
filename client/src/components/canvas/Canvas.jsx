import { useRef, useEffect, forwardRef, useImperativeHandle, useContext } from 'react';
import { socket } from '../../services/socket';
import { AuthContext } from '../../context/AuthContext';

const MIN_POINT_DISTANCE = 1;     // 1px radial prefilter
const PREVIEW_INTERVAL_MS = 40;   // throttle for stroke:preview
const SIMPLIFY_EPSILON = 1.0;     // Douglas-Peucker tolerance (px)

const round1 = (n) => Math.round(n * 10) / 10;

// Squared distance from point P to segment AB
function sqSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = 0;
  if (lenSq !== 0) {
    t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
  }
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return (px - cx) ** 2 + (py - cy) ** 2;
}

// Iterative Douglas-Peucker on a flat [x0, y0, x1, y1, ...] array
function simplify(points, epsilon) {
  const n = points.length / 2;
  if (n < 3) return points.slice();

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const epsSq = epsilon * epsilon;
  const stack = [[0, n - 1]];

  while (stack.length) {
    const [first, last] = stack.pop();
    const ax = points[first * 2], ay = points[first * 2 + 1];
    const bx = points[last * 2], by = points[last * 2 + 1];
    let maxDistSq = 0;
    let index = -1;

    for (let i = first + 1; i < last; i++) {
      const d = sqSegDist(points[i * 2], points[i * 2 + 1], ax, ay, bx, by);
      if (d > maxDistSq) {
        maxDistSq = d;
        index = i;
      }
    }

    if (index !== -1 && maxDistSq > epsSq) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  const out = [];
  for (let i = 0; i < n; i++) {
    if (keep[i]) out.push(points[i * 2], points[i * 2 + 1]);
  }
  return out;
}

// Draw one stroke object, smoothed with quadratic curves through midpoints
function drawStroke(ctx, stroke) {
  const { points, color, width } = stroke;
  const n = points.length / 2;
  if (n === 0) return;

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Single click: draw a dot
  if (n === 1) {
    ctx.beginPath();
    ctx.arc(points[0], points[1], width / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  ctx.beginPath();
  ctx.moveTo(points[0], points[1]);

  if (n === 2) {
    ctx.lineTo(points[2], points[3]);
  } else {
    for (let i = 1; i < n - 1; i++) {
      const cx = points[i * 2];
      const cy = points[i * 2 + 1];
      const mx = (cx + points[(i + 1) * 2]) / 2;
      const my = (cy + points[(i + 1) * 2 + 1]) / 2;
      ctx.quadraticCurveTo(cx, cy, mx, my);
    }
    ctx.lineTo(points[(n - 1) * 2], points[(n - 1) * 2 + 1]);
  }
  ctx.stroke();
}

const Canvas = forwardRef(({ color = '#000000', brushSize = 5, roomId }, ref) => {
  const canvasRef = useRef(null);
  const { user } = useContext(AuthContext);

  // Refs, not state: drawing is imperative, and we don't want a React re-render per point.
  const strokesRef = useRef(new Map());        // finalized strokes: id -> stroke
  const currentStrokeRef = useRef(null);       // my in-progress stroke
  const peerPreviewsRef = useRef(new Map());   // others' in-progress strokes: id -> preview
  const lastPreviewEmitRef = useRef(0);
  const rafRef = useRef(null);

  const userId = user?._id || user?.id || user?.username || 'anonymous';

  // Clear, draw finalized strokes, then peer previews, then my current stroke on top
  const redrawAll = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const stroke of strokesRef.current.values()) drawStroke(ctx, stroke);
    for (const preview of peerPreviewsRef.current.values()) drawStroke(ctx, preview);
    if (currentStrokeRef.current) drawStroke(ctx, currentStrokeRef.current);
  };

  // Coalesce multiple redraw requests into one per animation frame
  const scheduleRedraw = () => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      redrawAll();
    });
  };

  useImperativeHandle(ref, () => ({
    saveToDatabase: async () => {
      try {
        await fetch(`http://localhost:5000/api/boards/${roomId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ strokes: Array.from(strokesRef.current.values()) })
        });
        alert('Board saved successfully!');
      } catch (error) {
        console.error('Error saving board:', error);
        alert('Failed to save board.');
      }
    }
  }));

  useEffect(() => {
    const canvas = canvasRef.current;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    strokesRef.current = new Map();
    peerPreviewsRef.current = new Map();
    currentStrokeRef.current = null;

    // Full board from the server when joining
    const handleCatchUp = (strokes) => {
      strokesRef.current = new Map(strokes.map((s) => [s.id, s]));
      peerPreviewsRef.current.clear();
      scheduleRedraw();
    };

    // A peer's in-progress stroke: overwrite by id with the latest full points array
    const handlePreview = (data) => {
      if (strokesRef.current.has(data.id)) return;
      peerPreviewsRef.current.set(data.id, data);
      scheduleRedraw();
    };

    // A peer's finalized stroke replaces their preview
    const handleEnd = (stroke) => {
      peerPreviewsRef.current.delete(stroke.id);
      strokesRef.current.set(stroke.id, stroke);
      scheduleRedraw();
    };

    const handleClear = () => {
      strokesRef.current.clear();
      peerPreviewsRef.current.clear();
      scheduleRedraw();
    };

    // Drop previews left behind by a peer who disconnected mid-stroke
    const handlePeerLeft = (socketId) => {
      for (const [id, preview] of peerPreviewsRef.current) {
        if (preview.socketId === socketId) peerPreviewsRef.current.delete(id);
      }
      scheduleRedraw();
    };

    // Register listeners BEFORE joining so the catch-up can't be missed
    socket.on('canvas-catch-up', handleCatchUp);
    socket.on('stroke:preview', handlePreview);
    socket.on('stroke:end', handleEnd);
    socket.on('clear-board', handleClear);
    socket.on('peer-left', handlePeerLeft);
    socket.emit('join-room', roomId);

    redrawAll();

    return () => {
      socket.off('canvas-catch-up', handleCatchUp);
      socket.off('stroke:preview', handlePreview);
      socket.off('stroke:end', handleEnd);
      socket.off('clear-board', handleClear);
      socket.off('peer-left', handlePeerLeft);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [roomId]);

  const handlePointerDown = (e) => {
    if (e.button !== 0) return;
    // Keep receiving move/up events even if the pointer leaves the canvas
    e.currentTarget.setPointerCapture(e.pointerId);

    const { offsetX, offsetY } = e.nativeEvent;
    currentStrokeRef.current = {
      id: crypto.randomUUID(),
      userId,
      color,
      width: brushSize,
      points: [offsetX, offsetY]
    };
    lastPreviewEmitRef.current = 0;
    scheduleRedraw();
  };

  const handlePointerMove = (e) => {
    const { offsetX: x, offsetY: y } = e.nativeEvent;

    socket.emit('cursor-move', {
      roomId,
      x,
      y,
      username: user?.username || 'Unknown'
    });

    const stroke = currentStrokeRef.current;
    if (!stroke) return;

    // 1px radial prefilter: drop points too close to the last kept one
    const pts = stroke.points;
    const dx = x - pts[pts.length - 2];
    const dy = y - pts[pts.length - 1];
    if (dx * dx + dy * dy < MIN_POINT_DISTANCE * MIN_POINT_DISTANCE) return;

    pts.push(x, y);

    // Throttled live preview: send the whole stroke so far so peers can smooth it
    const now = performance.now();
    if (now - lastPreviewEmitRef.current >= PREVIEW_INTERVAL_MS) {
      lastPreviewEmitRef.current = now;
      socket.emit('stroke:preview', {
        id: stroke.id,
        userId: stroke.userId,
        socketId: socket.id,
        color: stroke.color,
        width: stroke.width,
        points: pts.slice()
      });
    }

    scheduleRedraw();
  };

  const handlePointerUp = () => {
    const stroke = currentStrokeRef.current;
    if (!stroke) return;
    currentStrokeRef.current = null;

    // Douglas-Peucker, then round to 1 decimal place
    const finalStroke = {
      ...stroke,
      points: simplify(stroke.points, SIMPLIFY_EPSILON).map(round1)
    };

    strokesRef.current.set(finalStroke.id, finalStroke);
    socket.emit('stroke:end', finalStroke);
    scheduleRedraw();
  };

  return (
    <canvas
      ref={canvasRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      className="bg-white cursor-crosshair touch-none"
    />
  );
});

export default Canvas;