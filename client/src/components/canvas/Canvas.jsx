import { useRef, useEffect, useState, forwardRef, useImperativeHandle, useContext } from 'react';
import { socket } from '../../services/socket';
import { AuthContext } from '../../context/AuthContext';

const MIN_POINT_DISTANCE = 1;     // 1px radial prefilter
const PREVIEW_INTERVAL_MS = 40;   // throttle for stroke:preview
const UPDATE_INTERVAL_MS = 40;    // throttle for stroke:update while dragging
const SIMPLIFY_EPSILON = 1.0;     // Douglas-Peucker tolerance (px)
const MIN_SCALE = 0.1;
const MAX_SCALE = 10;
const HIT_TOLERANCE_PX = 4;       // extra click slop around a stroke (screen px)
const DRAG_THRESHOLD_PX = 3;      // pointer must move this far before a click becomes a drag
const SELECTION_COLOR = '#2563eb';
const ERASER_RADIUS_PX = 8;       // eraser reach around the pointer (screen px)

const round1 = (n) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------------------
// Geometry simplification
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Transforms and bounding boxes
//
// Convention: a stroke's pivot is the center of its raw-points AABB.
//   world = (center + [x, y]) + R(rotation) * S(scaleX, scaleY) * (local - center)
// Raw points are never modified.
// ---------------------------------------------------------------------------

// Local AABB cache, keyed by the points array. Valid ONLY for finalized strokes,
// whose points never change. Strokes with an identity transform (including the
// in-progress stroke and peer previews, whose points DO change) never touch it.
const boundsCache = new WeakMap();

function getLocalBounds(stroke) {
  const pts = stroke.points;
  if (!pts || pts.length < 2) return null;

  let b = boundsCache.get(pts);
  if (b) return b;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    const px = pts[i], py = pts[i + 1];
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  b = { minX, minY, maxX, maxY };
  boundsCache.set(pts, b);
  return b;
}

// ?? so old MongoDB documents without these fields still render
function getTransform(stroke) {
  return {
    x: stroke.x ?? 0,
    y: stroke.y ?? 0,
    scaleX: stroke.scaleX ?? 1,
    scaleY: stroke.scaleY ?? 1,
    rotation: stroke.rotation ?? 0
  };
}

const isIdentity = (t) =>
  t.x === 0 && t.y === 0 && t.scaleX === 1 && t.scaleY === 1 && t.rotation === 0;

// The 4 corners of the (padded) local AABB, transformed into world space.
// Padding is in local space, which is correct because ctx.scale also scales lineWidth.
function getWorldCorners(stroke, pad = 0) {
  const b = getLocalBounds(stroke);
  if (!b) return null;

  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const { x, y, scaleX, scaleY, rotation } = getTransform(stroke);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  const locals = [
    [b.minX - pad, b.minY - pad],
    [b.maxX + pad, b.minY - pad],
    [b.maxX + pad, b.maxY + pad],
    [b.minX - pad, b.maxY + pad]
  ];

  return locals.map(([lx, ly]) => {
    const sx = (lx - cx) * scaleX;
    const sy = (ly - cy) * scaleY;
    return [cx + x + sx * cos - sy * sin, cy + y + sx * sin + sy * cos];
  });
}

// Inverse transform: world point -> the stroke's local space. null if the scale is degenerate.
function worldToLocal(stroke, wx, wy) {
  const b = getLocalBounds(stroke);
  if (!b) return null;

  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const { x, y, scaleX, scaleY, rotation } = getTransform(stroke);
  if (!scaleX || !scaleY) return null;

  const dx = wx - (cx + x);
  const dy = wy - (cy + y);
  const cos = Math.cos(-rotation);
  const sin = Math.sin(-rotation);
  const rx = dx * cos - dy * sin;
  const ry = dx * sin + dy * cos;
  return [cx + rx / scaleX, cy + ry / scaleY];
}

// Topmost stroke under the pointer (iterates in reverse draw order).
// Two-phase: AABB broad-phase, then distance-to-polyline narrow-phase.
function hitTestStrokes(strokesMap, wx, wy, tolWorld) {
  const list = Array.from(strokesMap.values());
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i];
    const b = getLocalBounds(s);
    if (!b) continue;
    const local = worldToLocal(s, wx, wy);
    if (!local) continue;

    const t = getTransform(s);
    const minScale = Math.min(Math.abs(t.scaleX), Math.abs(t.scaleY)) || 1;
    // Tolerance in local space: half the stroke width + screen-space slop
    const hitRadius = (s.width ?? 1) / 2 + tolWorld / minScale;
    const hitRadiusSq = hitRadius * hitRadius;

    // --- Broad phase: padded AABB in local space ---
    const [lx, ly] = local;
    if (
      lx < b.minX - hitRadius || lx > b.maxX + hitRadius ||
      ly < b.minY - hitRadius || ly > b.maxY + hitRadius
    ) continue;

    // --- Narrow phase: distance to the actual polyline path ---
    const pts = s.points;
    const n = pts.length / 2;

    // Single dot: distance to the single point
    if (n === 1) {
      const dx = lx - pts[0];
      const dy = ly - pts[1];
      if (dx * dx + dy * dy <= hitRadiusSq) return s;
      continue;
    }

    // Walk every segment and test distance to it
    let hit = false;
    for (let j = 0; j < n - 1; j++) {
      const ax = pts[j * 2],     ay = pts[j * 2 + 1];
      const bx = pts[j * 2 + 2], by = pts[j * 2 + 3];
      if (sqSegDist(lx, ly, ax, ay, bx, by) <= hitRadiusSq) {
        hit = true;
        break;
      }
    }
    if (hit) return s;
  }
  return null;
}

// Ids of every stroke whose world bounds intersect the rectangle
function strokesInRect(strokesMap, x0, y0, x1, y1) {
  const rMinX = Math.min(x0, x1), rMaxX = Math.max(x0, x1);
  const rMinY = Math.min(y0, y1), rMaxY = Math.max(y0, y1);
  const hits = [];

  for (const s of strokesMap.values()) {
    const corners = getWorldCorners(s, (s.width ?? 1) / 2);
    if (!corners) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [cx, cy] of corners) {
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;
    }
    if (minX <= rMaxX && maxX >= rMinX && minY <= rMaxY && maxY >= rMinY) hits.push(s.id);
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// Draws the raw points, smoothed with quadratic curves through midpoints
function drawRawStroke(ctx, stroke) {
  const { points, color, width } = stroke;
  const n = points.length / 2;

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

// Draw one stroke with its non-destructive transform applied
function drawStroke(ctx, stroke) {
  if (!stroke.points || stroke.points.length === 0) return;

  const t = getTransform(stroke);
  if (isIdentity(t)) {
    drawRawStroke(ctx, stroke); // fast path; also covers live/preview strokes
    return;
  }

  const b = getLocalBounds(stroke);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;

  ctx.save();
  ctx.translate(cx + t.x, cy + t.y);
  ctx.rotate(t.rotation);
  ctx.scale(t.scaleX, t.scaleY);
  ctx.translate(-cx, -cy);
  drawRawStroke(ctx, stroke);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const Canvas = forwardRef(({ color = '#000000', brushSize = 5, roomId, onCameraChange, onToolChange, onSelectionChange }, ref) => {
  const canvasRef = useRef(null);
  const { user } = useContext(AuthContext);
  const cameraRef = useRef({ x: 0, y: 0, scale: 1 }); // local to each user, never sent over the socket
  const panRef = useRef(null);                        // last pointer position while panning
  const spaceRef = useRef(false);                     // is Space held?
  const onCameraChangeRef = useRef(onCameraChange);
  onCameraChangeRef.current = onCameraChange;
  const onToolChangeRef = useRef(onToolChange);
  onToolChangeRef.current = onToolChange;
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;
  const eraserRef = useRef(null);   // last eraser position (world) while the eraser button is down

  // Refs, not state: drawing is imperative, and we don't want a React re-render per point.
  const strokesRef = useRef(new Map());        // finalized strokes: id -> stroke
  const currentStrokeRef = useRef(null);       // my in-progress stroke
  const peerPreviewsRef = useRef(new Map());   // others' in-progress strokes: id -> preview
  const undoStackRef = useRef([]);             // ids of MY strokes, in drawing order
  const redoStackRef = useRef([]);             // full stroke objects I've undone
  const lastPreviewEmitRef = useRef(0);
  const lastUpdateEmitRef = useRef(0);
  const rafRef = useRef(null);

  // Tool + selection. State drives React UI; the refs are the source of truth for
  // redrawAll and the pointer handlers (long-lived closures would read stale state).
  const [activeTool, setActiveTool] = useState('select');
  const activeToolRef = useRef('select');
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const selectedIdsRef = useRef(new Set());

  // Active drag / marquee. Mutated on every pointer move, so a ref.
  //   { type: 'drag', startWorld, startClient, starts: Map(id -> {x, y}), moved, collapseTo }
  //   { type: 'marquee', start, current, base: Set }
  const interactionRef = useRef(null);

  const userId = user?._id || user?.id || user?.username || 'anonymous';

  const redrawAll = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    ctx.setTransform(1, 0, 0, 1, 0, 0);            // identity, so clearRect covers the whole screen
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const { x, y, scale } = cameraRef.current;
    ctx.setTransform(scale, 0, 0, scale, x, y);    // everything below is drawn in world space

    for (const stroke of strokesRef.current.values()) drawStroke(ctx, stroke);
    for (const preview of peerPreviewsRef.current.values()) drawStroke(ctx, preview);
    if (currentStrokeRef.current) drawStroke(ctx, currentStrokeRef.current);

    // Selection boxes: the oriented bounding box, so they stay correct once rotation exists
    const selected = selectedIdsRef.current;
    if (selected.size) {
      ctx.save();
      ctx.strokeStyle = SELECTION_COLOR;
      ctx.lineWidth = 1 / scale;               // 1 screen px regardless of zoom
      ctx.setLineDash([]);
      for (const id of selected) {
        const stroke = strokesRef.current.get(id);
        if (!stroke) continue;
        const corners = getWorldCorners(stroke, (stroke.width ?? 1) / 2);
        if (!corners) continue;
        ctx.beginPath();
        ctx.moveTo(corners[0][0], corners[0][1]);
        for (let i = 1; i < 4; i++) ctx.lineTo(corners[i][0], corners[i][1]);
        ctx.closePath();
        ctx.stroke();
      }
      ctx.restore();
    }

    // Marquee
    const it = interactionRef.current;
    if (it?.type === 'marquee') {
      const [x0, y0] = it.start;
      const [x1, y1] = it.current;
      const rx = Math.min(x0, x1), ry = Math.min(y0, y1);
      const rw = Math.abs(x1 - x0), rh = Math.abs(y1 - y0);
      ctx.save();
      ctx.fillStyle = 'rgba(37, 99, 235, 0.1)';
      ctx.strokeStyle = SELECTION_COLOR;
      ctx.lineWidth = 1 / scale;
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.restore();
    }
  };

  // Coalesce multiple redraw requests into one per animation frame
  const scheduleRedraw = () => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      redrawAll();
    });
  };

  // world = (screen - camera) / scale
  const screenToWorld = (sx, sy) => {
    const c = cameraRef.current;
    return [(sx - c.x) / c.scale, (sy - c.y) / c.scale];
  };

  const cameraChanged = () => {
    scheduleRedraw();
    onCameraChangeRef.current?.({ ...cameraRef.current }); // LiveCursors needs it to place cursors
  };

  // ---- selection / tool helpers (ref-only internals, safe to call from stale closures) ----

  // Always pass a NEW Set so React sees the change
  const setSelection = (ids) => {
    selectedIdsRef.current = ids;
    setSelectedIds(ids);
    onSelectionChangeRef.current?.(Array.from(ids));
    scheduleRedraw();
  };

  // Drop ids whose strokes no longer exist (undo, remote remove, clear, catch-up)
  const pruneSelection = () => {
    const current = selectedIdsRef.current;
    if (current.size === 0) return;
    const next = new Set();
    for (const id of current) if (strokesRef.current.has(id)) next.add(id);
    if (next.size !== current.size) setSelection(next);
  };

  const setTool = (tool) => {
    if (tool !== 'select' && tool !== 'pen' && tool !== 'eraser') return;
    activeToolRef.current = tool;
    setActiveTool(tool);
    interactionRef.current = null;
    eraserRef.current = null;
    if (tool !== 'select' && selectedIdsRef.current.size) setSelection(new Set());
    onToolChangeRef.current?.(tool);
    scheduleRedraw();
  };

  // Send absolute x/y for the given ids as one batched message
  const emitUpdates = (ids, final) => {
    const updates = [];
    for (const id of ids) {
      const s = strokesRef.current.get(id);
      if (!s) continue;
      updates.push({ id, x: s.x ?? 0, y: s.y ?? 0 });
    }
    if (updates.length) socket.emit('stroke:update', { updates, final });
  };

  // Delete every stroke under (wx, wy). Loops because strokes can overlap.
  const eraseAt = (wx, wy) => {
    const tolWorld = ERASER_RADIUS_PX / cameraRef.current.scale;
    let erased = false;
    let hit;
    while ((hit = hitTestStrokes(strokesRef.current, wx, wy, tolWorld))) {
      strokesRef.current.delete(hit.id);
      socket.emit('stroke:delete', { roomId, id: hit.id });
      erased = true;
    }
    if (erased) {
      pruneSelection();
      scheduleRedraw();
    }
  };
  const undo = () => {
    while (undoStackRef.current.length) {
      const id = undoStackRef.current.pop();
      const stroke = strokesRef.current.get(id);
      if (!stroke) continue; // already gone (e.g. board was cleared)
      strokesRef.current.delete(id);
      redoStackRef.current.push(stroke);
      socket.emit('stroke:remove', { id });
      pruneSelection();
      scheduleRedraw();
      return;
    }
  };

  const redo = () => {
    const stroke = redoStackRef.current.pop();
    if (!stroke) return;
    strokesRef.current.set(stroke.id, stroke);
    undoStackRef.current.push(stroke.id);
    socket.emit('stroke:end', stroke); // server and peers already handle this (transform included)
    scheduleRedraw();
  };

  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;

      if (e.ctrlKey || e.metaKey) {
        const k = e.key.toLowerCase();
        if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
        else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); }
        return;
      }

      const k = e.key.toLowerCase();
      if (k === 'v') setTool('select');
      else if (k === 'p') setTool('pen');
      else if (k === 'e') setTool('eraser');
      else if (e.key === 'Escape' && selectedIdsRef.current.size) setSelection(new Set());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useImperativeHandle(ref, () => ({
    undo,
    redo,
    setTool,
    getTool: () => activeToolRef.current,
    getSelectedIds: () => Array.from(selectedIdsRef.current),
    resetView: () => {
      Object.assign(cameraRef.current, { x: 0, y: 0, scale: 1 });
      cameraChanged();
    },
    clearBoard: () => {
      socket.emit('clear-board');
    },
    saveToDatabase: async () => {
      try {
        const res = await fetch(`http://localhost:5000/api/boards/${roomId}`, {
          method: 'POST'
        });
        if (!res.ok) throw new Error(`Server responded ${res.status}`);
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
    interactionRef.current = null;
    // undoStackRef.current = [];
    // redoStackRef.current = [];

    // Full board from the server when joining (strokes include x/y/scale/rotation)
    const handleCatchUp = (strokes) => {
      strokesRef.current = new Map(strokes.map((s) => [s.id, s]));
      peerPreviewsRef.current.clear();
      pruneSelection();
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

    // A peer moved some strokes: absolute values, so just assign
    const handleUpdate = ({ updates }) => {
      if (!Array.isArray(updates)) return;
      const dragging = interactionRef.current?.type === 'drag' ? interactionRef.current.starts : null;
      for (const u of updates) {
        if (dragging?.has(u.id)) continue; // I'm dragging it right now; my local state wins, no jitter
        const stroke = strokesRef.current.get(u.id);
        if (!stroke) continue;
        if (Number.isFinite(u.x)) stroke.x = u.x;
        if (Number.isFinite(u.y)) stroke.y = u.y;
        if (Number.isFinite(u.scaleX)) stroke.scaleX = u.scaleX;
        if (Number.isFinite(u.scaleY)) stroke.scaleY = u.scaleY;
        if (Number.isFinite(u.rotation)) stroke.rotation = u.rotation;
      }
      scheduleRedraw();
    };

    const handleRemove = ({ id }) => {
      strokesRef.current.delete(id);
      peerPreviewsRef.current.delete(id);
      pruneSelection();
      scheduleRedraw();
    };

    const handleClear = () => {
      strokesRef.current.clear();
      peerPreviewsRef.current.clear();
      undoStackRef.current = [];
      redoStackRef.current = [];
      interactionRef.current = null;
      pruneSelection();
      scheduleRedraw();
    };

    // Drop previews left behind by a peer who disconnected mid-stroke
    const handlePeerLeft = (socketId) => {
      for (const [id, preview] of peerPreviewsRef.current) {
        if (preview.socketId === socketId) peerPreviewsRef.current.delete(id);
      }
      scheduleRedraw();
    };

    const onWheel = (e) => {
      e.preventDefault(); // only works with { passive: false } below
      const cam = cameraRef.current;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      const [wx, wy] = screenToWorld(sx, sy);                 // world point under the cursor
      const k = e.ctrlKey ? 0.01 : 0.001;                      // trackpad pinch vs mouse wheel
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, cam.scale * Math.exp(-e.deltaY * k)));

      cam.scale = next;
      cam.x = sx - wx * next;                                  // keep that world point under the cursor
      cam.y = sy - wy * next;
      cameraChanged();
    };
    const onKeyDown = (e) => {
      if (e.code !== 'Space') return;
      e.preventDefault();
      if (spaceRef.current) return;
      spaceRef.current = true;
      if (!panRef.current) canvas.style.cursor = 'grab';
    };
    const onKeyUp = (e) => {
      if (e.code !== 'Space') return;
      spaceRef.current = false;
      if (!panRef.current) canvas.style.cursor = '';
    };
    const onBlur = () => { spaceRef.current = false; canvas.style.cursor = ''; };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    // Register listeners BEFORE joining so the catch-up can't be missed
    socket.on('canvas-catch-up', handleCatchUp);
    socket.on('stroke:preview', handlePreview);
    socket.on('stroke:end', handleEnd);
    socket.on('stroke:update', handleUpdate);
    socket.on('clear-board', handleClear);
    socket.on('peer-left', handlePeerLeft);
    socket.on('stroke:remove', handleRemove);
    socket.emit('join-room', roomId);
    socket.on('stroke:delete', handleRemove);

    redrawAll();

    return () => {
      socket.off('canvas-catch-up', handleCatchUp);
      socket.off('stroke:preview', handlePreview);
      socket.off('stroke:end', handleEnd);
      socket.off('stroke:update', handleUpdate);
      socket.off('clear-board', handleClear);
      socket.off('peer-left', handlePeerLeft);
      socket.off('stroke:remove', handleRemove);
      socket.off('stroke:delete', handleRemove);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [roomId]);

  // ---- pointer handling -------------------------------------------------------------

  const handlePointerDown = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId);

    if (e.button === 2 || spaceRef.current) {         // right-click OR space → pan (any tool)
      panRef.current = { x: e.clientX, y: e.clientY };
      canvasRef.current.style.cursor = 'grabbing';
      return;
    }

    if (e.button !== 0) return;                       // ignore middle-click etc.

    const { offsetX, offsetY } = e.nativeEvent;
    const [wx, wy] = screenToWorld(offsetX, offsetY);   // store WORLD coordinates

    // ---- Select tool ----
    if (activeToolRef.current === 'select') {
      const tolWorld = HIT_TOLERANCE_PX / cameraRef.current.scale;
      const hit = hitTestStrokes(strokesRef.current, wx, wy, tolWorld);
      const selected = selectedIdsRef.current;

      if (hit) {
        let collapseTo = null;

        if (e.shiftKey) {
          const next = new Set(selected);
          if (next.has(hit.id)) {
            next.delete(hit.id);            // shift-click on a selected object toggles it off
            setSelection(next);
            return;
          }
          next.add(hit.id);
          setSelection(next);
        } else if (!selected.has(hit.id)) {
          setSelection(new Set([hit.id]));  // select on pointer-down, so drag works immediately
        } else if (selected.size > 1) {
          collapseTo = hit.id;              // plain click (no drag) on a multi-selection narrows it
        }

        // Begin a drag of everything currently selected.
        // Offsets are computed as startOffset + total delta, so there's no accumulated drift.
        const starts = new Map();
        for (const id of selectedIdsRef.current) {
          const s = strokesRef.current.get(id);
          if (s) starts.set(id, { x: s.x ?? 0, y: s.y ?? 0 });
        }
        interactionRef.current = {
          type: 'drag',
          startWorld: [wx, wy],
          startClient: [e.clientX, e.clientY],
          starts,
          moved: false,
          collapseTo
        };
        lastUpdateEmitRef.current = 0;
      } else {
        // Empty space: start a marquee (shift keeps the existing selection)
        const base = e.shiftKey ? new Set(selected) : new Set();
        if (!e.shiftKey && selected.size) setSelection(new Set());
        interactionRef.current = { type: 'marquee', start: [wx, wy], current: [wx, wy], base };
        scheduleRedraw();
      }
      return;
    }
    // ---- Eraser tool: destroys objects, never creates strokes ----
    if (activeToolRef.current === 'eraser') {
      eraserRef.current = [wx, wy];
      eraseAt(wx, wy);
      return;
    }

    // ---- Pen tool (unchanged) ----
    currentStrokeRef.current = {
      id: crypto.randomUUID(),
      userId,
      color,
      width: brushSize,
      points: [wx, wy]
    };
    lastPreviewEmitRef.current = 0;
    scheduleRedraw();
  };

  const handlePointerMove = (e) => {
    const { offsetX, offsetY } = e.nativeEvent;
    const [x, y] = screenToWorld(offsetX, offsetY);

    // Cursor is sent in world coordinates; each viewer converts with their own camera
    socket.emit('cursor-move', { roomId, x, y, username: user?.username || 'Unknown' });

    if (panRef.current) {                          // panning: move the camera by the screen delta
      const cam = cameraRef.current;
      cam.x += e.clientX - panRef.current.x;
      cam.y += e.clientY - panRef.current.y;
      panRef.current = { x: e.clientX, y: e.clientY };
      cameraChanged();
      return;
    }

    // ---- Select tool interactions ----
    const it = interactionRef.current;
    if (it) {
      if (it.type === 'drag') {
        if (!it.moved) {
          const dxs = e.clientX - it.startClient[0];
          const dys = e.clientY - it.startClient[1];
          if (dxs * dxs + dys * dys < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
          it.moved = true;
          canvasRef.current.style.cursor = 'move';
        }

        const ddx = x - it.startWorld[0];
        const ddy = y - it.startWorld[1];
        for (const [id, start] of it.starts) {
          const s = strokesRef.current.get(id);
          if (!s) continue;
          s.x = round1(start.x + ddx);
          s.y = round1(start.y + ddy);
        }

        const now = performance.now();
        if (now - lastUpdateEmitRef.current >= UPDATE_INTERVAL_MS) {
          lastUpdateEmitRef.current = now;
          emitUpdates(it.starts.keys(), false);
        }
        scheduleRedraw();
      } else if (it.type === 'marquee') {
        it.current = [x, y];
        scheduleRedraw();
      }
      return;
    }
    // ---- Eraser tool ----
    if (eraserRef.current) {
      const [lx, ly] = eraserRef.current;
      // A fast drag skips pixels, so test along the path in steps of one eraser radius
      const step = ERASER_RADIUS_PX / cameraRef.current.scale;
      const n = Math.max(1, Math.ceil(Math.hypot(x - lx, y - ly) / step));
      for (let i = 1; i <= n; i++) {
        eraseAt(lx + ((x - lx) * i) / n, ly + ((y - ly) * i) / n);
      }
      eraserRef.current = [x, y];
      return;
    }
    // ---- Pen tool (unchanged) ----
    const stroke = currentStrokeRef.current;
    if (!stroke) return;

    // 1px on SCREEN = 1/scale in world units
    const minD = MIN_POINT_DISTANCE / cameraRef.current.scale;
    const pts = stroke.points;
    const dx = x - pts[pts.length - 2];
    const dy = y - pts[pts.length - 1];
    if (dx * dx + dy * dy < minD * minD) return;

    pts.push(x, y);

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
    if (panRef.current) {
      panRef.current = null;
      canvasRef.current.style.cursor = spaceRef.current ? 'grab' : '';
      return;
    }

    if (eraserRef.current) {
      eraserRef.current = null;
      return;
    }
    // ---- Select tool ----
    const it = interactionRef.current;
    if (it) {
      interactionRef.current = null;
      canvasRef.current.style.cursor = spaceRef.current ? 'grab' : '';

      if (it.type === 'drag') {
        if (it.moved) {
          emitUpdates(it.starts.keys(), true);   // guaranteed trailing emit: peers end exactly in sync
        } else if (it.collapseTo) {
          setSelection(new Set([it.collapseTo]));
        }
      } else if (it.type === 'marquee') {
        const [x0, y0] = it.start;
        const [x1, y1] = it.current;
        const hits = strokesInRect(strokesRef.current, x0, y0, x1, y1);
        const next = new Set(it.base);
        for (const id of hits) next.add(id);
        setSelection(next);
      }
      scheduleRedraw();
      return;
    }

    // ---- Pen tool (unchanged) ----
    const stroke = currentStrokeRef.current;
    if (!stroke) return;
    currentStrokeRef.current = null;

    // Douglas-Peucker, then round to 1 decimal place
    const finalStroke = {
      ...stroke,
      points: simplify(stroke.points, SIMPLIFY_EPSILON / cameraRef.current.scale).map(round1)
    };

    strokesRef.current.set(finalStroke.id, finalStroke);
    undoStackRef.current.push(finalStroke.id);
    redoStackRef.current = []; // a new stroke discards redo history
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
      onContextMenu={(e) => e.preventDefault()}
      data-selected-count={selectedIds.size}
      className={`bg-white touch-none ${
        activeTool === 'select' ? 'cursor-default' : activeTool === 'eraser' ? 'cursor-cell' : 'cursor-crosshair'
      }`}
    />
  );
});

export default Canvas;