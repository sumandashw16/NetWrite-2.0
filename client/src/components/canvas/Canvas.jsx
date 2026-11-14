import { useRef, useEffect, useState, forwardRef, useImperativeHandle, useContext } from 'react';
import { socket } from '../../services/socket';
import { AuthContext } from '../../context/AuthContext';

const MIN_POINT_DISTANCE = 1;     // 1px radial prefilter
const PREVIEW_INTERVAL_MS = 40;   // throttle for stroke:preview
const UPDATE_INTERVAL_MS = 40;    // throttle for stroke:update while dragging/scaling/rotating
const SIMPLIFY_EPSILON = 1.0;     // Douglas-Peucker tolerance (px)
const MIN_SCALE = 0.1;            // camera zoom clamp
const MAX_SCALE = 10;
const MIN_OBJECT_SCALE = 0.05;    // per-stroke scaleX/scaleY clamp (stays inside server's 0.01-100)
const MAX_OBJECT_SCALE = 20;
const HIT_TOLERANCE_PX = 4;       // extra click slop around a stroke (screen px)
const DRAG_THRESHOLD_PX = 3;      // pointer must move this far before a click becomes a drag
const SELECTION_COLOR = '#2563eb';
const ERASER_RADIUS_PX = 8;       // eraser reach around the pointer (screen px)
const OUTLINE_PAD_PX = 3;         // gap between the ink edge and the dashed outline (screen px)
const SELECTION_DASH_PX = [6, 4]; // dash, gap (screen px)
const MARCH_SPEED_PX = 20;        // how fast the ants crawl (screen px per second)
const HANDLE_SIZE_PX = 9;         // resize handle square, screen px
const MIN_GROUP_SIZE_PX = 12;     // selection box can't be resized smaller than this, screen px
const ROTATE_HANDLE_OFFSET_PX = 24; // distance above the box, screen px
const ROTATE_HANDLE_RADIUS_PX = 7;  // rotate handle hit/draw radius, screen px
const ROTATE_SNAP_RAD = Math.PI / 12; // 15°, used when Shift is held

// Per-handle sign for (pointer - anchor) along each axis, so the correct side always grows
// and dragging past the anchor clamps instead of flipping/regrowing.
const HANDLE_SIGNS = { nw: [-1, -1], ne: [1, -1], se: [1, 1], sw: [-1, 1] };

const round1 = (n) => Math.round(n * 10) / 10;
const round4 = (n) => Math.round(n * 10000) / 10000;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

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
// Raw points are never modified. Rendering transforms POINTS, not the canvas context,
// so line width stays constant in world units regardless of an object's own scale.
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

// Raw points -> world-space points, flat array. Used for rendering, hit testing and the outline,
// so a stroke never needs ctx.scale()/ctx.rotate() to show its transform (keeps width constant).
function transformPointsToWorld(stroke) {
  const b = getLocalBounds(stroke);
  const pts = stroke.points;
  const t = getTransform(stroke);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const cos = Math.cos(t.rotation);
  const sin = Math.sin(t.rotation);

  const out = new Array(pts.length);
  for (let i = 0; i < pts.length; i += 2) {
    const sx = (pts[i] - cx) * t.scaleX;
    const sy = (pts[i + 1] - cy) * t.scaleY;
    out[i] = cx + t.x + sx * cos - sy * sin;
    out[i + 1] = cy + t.y + sx * sin + sy * cos;
  }
  return out;
}

// The 4 corners of the local AABB, transformed into world space (no padding).
function getWorldCorners(stroke) {
  const b = getLocalBounds(stroke);
  if (!b) return null;

  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const { x, y, scaleX, scaleY, rotation } = getTransform(stroke);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  const locals = [[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY]];
  return locals.map(([lx, ly]) => {
    const sx = (lx - cx) * scaleX;
    const sy = (ly - cy) * scaleY;
    return [cx + x + sx * cos - sy * sin, cy + y + sx * sin + sy * cos];
  });
}

// Axis-aligned world-space bounds, optionally padded by a constant WORLD-unit amount
// (e.g. half the stroke width, which no longer scales with the object).
function getWorldBounds(stroke, pad = 0) {
  const b = getLocalBounds(stroke);
  if (!b) return null;

  const t = getTransform(stroke);
  let minX, minY, maxX, maxY;

  if (isIdentity(t)) {
    ({ minX, minY, maxX, maxY } = b);
  } else {
    const corners = getWorldCorners(stroke);
    minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
    for (const [cx, cy] of corners) {
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;
    }
  }
  if (pad) { minX -= pad; minY -= pad; maxX += pad; maxY += pad; }
  return { minX, minY, maxX, maxY };
}

// Union of getWorldBounds over a set of stroke ids (the "group" box for the selection).
// Always axis-aligned, even if members are rotated (a "loose" box in that case).
function getGroupBoundsWorld(strokesMap, ids) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const id of ids) {
    const s = strokesMap.get(id);
    if (!s) continue;
    const b = getWorldBounds(s, (s.width ?? 1) / 2);
    if (!b) continue;
    if (b.minX < minX) minX = b.minX;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.minY < minY) minY = b.minY;
    if (b.maxY > maxY) maxY = b.maxY;
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY };
}

// Topmost stroke under the pointer (iterates in reverse draw order).
// Broad phase: padded world AABB. Narrow phase: distance to the world-space polyline.
function hitTestStrokes(strokesMap, wx, wy, tolWorld) {
  const list = Array.from(strokesMap.values());
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i];
    const t = getTransform(s);
    const hitRadius = (s.width ?? 1) / 2 + tolWorld;

    const b = getWorldBounds(s, hitRadius);
    if (!b) continue;
    if (wx < b.minX || wx > b.maxX || wy < b.minY || wy > b.maxY) continue;

    const world = isIdentity(t) ? s.points : transformPointsToWorld(s);
    const n = world.length / 2;
    const hitRadiusSq = hitRadius * hitRadius;

    if (n === 1) {
      const dx = wx - world[0], dy = wy - world[1];
      if (dx * dx + dy * dy <= hitRadiusSq) return s;
      continue;
    }

    let hit = false;
    for (let j = 0; j < n - 1; j++) {
      const ax = world[j * 2], ay = world[j * 2 + 1];
      const bx = world[j * 2 + 2], by = world[j * 2 + 3];
      if (sqSegDist(wx, wy, ax, ay, bx, by) <= hitRadiusSq) { hit = true; break; }
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
    const b = getWorldBounds(s, (s.width ?? 1) / 2);
    if (!b) continue;
    if (b.minX <= rMaxX && b.maxX >= rMinX && b.minY <= rMaxY && b.maxY >= rMinY) hits.push(s.id);
  }
  return hits;
}

// Which corner handle (if any) of a world-space box the pointer is over
function hitTestHandles(bounds, wx, wy, cameraScale) {
  const hs = HANDLE_SIZE_PX / cameraScale / 2;
  const corners = {
    nw: [bounds.minX, bounds.minY],
    ne: [bounds.maxX, bounds.minY],
    se: [bounds.maxX, bounds.maxY],
    sw: [bounds.minX, bounds.maxY]
  };
  for (const [key, [hx, hy]] of Object.entries(corners)) {
    if (Math.abs(wx - hx) <= hs && Math.abs(wy - hy) <= hs) return key;
  }
  return null;
}

function oppositeCorner(handle, bounds) {
  switch (handle) {
    case 'nw': return [bounds.maxX, bounds.maxY];
    case 'ne': return [bounds.minX, bounds.maxY];
    case 'se': return [bounds.minX, bounds.minY];
    case 'sw': return [bounds.maxX, bounds.minY];
    default: return [bounds.minX, bounds.minY];
  }
}

const cursorForHandle = (handle) => (handle === 'nw' || handle === 'se' ? 'nwse-resize' : 'nesw-resize');

// Rotate handle position: centered above the box
function getRotateHandlePos(bounds, cameraScale) {
  const cx = (bounds.minX + bounds.maxX) / 2;
  const hy = bounds.minY - ROTATE_HANDLE_OFFSET_PX / cameraScale;
  return [cx, hy];
}

function hitTestRotateHandle(bounds, wx, wy, cameraScale) {
  const [hx, hy] = getRotateHandlePos(bounds, cameraScale);
  const r = ROTATE_HANDLE_RADIUS_PX / cameraScale;
  const dx = wx - hx, dy = wy - hy;
  return dx * dx + dy * dy <= r * r;
}

// Closed outline polygon hugging the stroke's ink, in WORLD space. Offsets the
// (already world-space) polyline by a constant radius and joins with round caps.
function getStrokeOutlineWorld(stroke, padPx, cameraScale) {
  const t = getTransform(stroke);
  const worldPts = isIdentity(t) ? stroke.points : transformPointsToWorld(stroke);
  const r = (stroke.width ?? 1) / 2 + padPx / cameraScale; // constant world-space radius

  // Drop duplicate points (rounding to 1 decimal can create them)
  const pts = [];
  for (let i = 0; i < worldPts.length; i += 2) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(worldPts[i] - last[0], worldPts[i + 1] - last[1]) > 1e-6) {
      pts.push([worldPts[i], worldPts[i + 1]]);
    }
  }
  if (pts.length === 0) return null;

  const outline = [];
  const CAP_STEPS = 10;
  const arc = (cx, cy, a0, a1, steps) => {
    for (let i = 0; i <= steps; i++) {
      const a = a0 + ((a1 - a0) * i) / steps;
      outline.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  };

  if (pts.length === 1) {
    arc(pts[0][0], pts[0][1], 0, Math.PI * 2, 24);
    return outline;
  }

  const normals = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i + 1][0] - pts[i][0];
    const dy = pts[i + 1][1] - pts[i][1];
    const len = Math.hypot(dx, dy) || 1;
    normals.push([-dy / len, dx / len]);
  }

  const left = [], right = [];
  for (let i = 0; i < pts.length; i++) {
    let nx, ny, scale = 1;
    if (i === 0) [nx, ny] = normals[0];
    else if (i === pts.length - 1) [nx, ny] = normals[normals.length - 1];
    else {
      const [ax, ay] = normals[i - 1];
      const [bx, by] = normals[i];
      nx = ax + bx; ny = ay + by;
      const len = Math.hypot(nx, ny) || 1;
      nx /= len; ny /= len;
      const d = nx * bx + ny * by;
      scale = Math.min(2, 1 / Math.max(d, 0.5)); // clamp so sharp corners don't spike
    }
    left.push([pts[i][0] + nx * r * scale, pts[i][1] + ny * r * scale]);
    right.push([pts[i][0] - nx * r * scale, pts[i][1] - ny * r * scale]);
  }

  const last = pts.length - 1;
  const endA = Math.atan2(normals[normals.length - 1][1], normals[normals.length - 1][0]);
  const startA = Math.atan2(normals[0][1], normals[0][0]);

  for (const p of left) outline.push(p);
  arc(pts[last][0], pts[last][1], endA, endA - Math.PI, CAP_STEPS);
  for (let i = right.length - 1; i >= 0; i--) outline.push(right[i]);
  arc(pts[0][0], pts[0][1], startA + Math.PI, startA, CAP_STEPS);

  return outline;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// Draws a flat points array, smoothed with quadratic curves through midpoints
function drawRawStroke(ctx, points, color, width) {
  const n = points.length / 2;
  if (n === 0) return;

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

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

// Draw one stroke with its non-destructive transform applied. Transforms the POINTS
// (not the canvas context), so lineWidth never gets stretched by an object's own scale.
function drawStroke(ctx, stroke) {
  if (!stroke.points || stroke.points.length === 0) return;
  const t = getTransform(stroke);
  const pts = isIdentity(t) ? stroke.points : transformPointsToWorld(stroke);
  drawRawStroke(ctx, pts, stroke.color, stroke.width);
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
  const undoStackRef = useRef([]);             // entries: { type:'draw', id } | { type:'transform', changes }
  const redoStackRef = useRef([]);             // entries: { type:'draw', stroke } | { type:'transform', changes }
  const lastPreviewEmitRef = useRef(0);
  const lastUpdateEmitRef = useRef(0);
  const rafRef = useRef(null);

  // Tool + selection. State drives React UI; the refs are the source of truth for
  // redrawAll and the pointer handlers (long-lived closures would read stale state).
  const [activeTool, setActiveTool] = useState('select');
  const activeToolRef = useRef('select');
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const selectedIdsRef = useRef(new Set());

  // Active drag / scale / rotate / marquee. Mutated on every pointer move, so a ref.
  //   { type: 'drag',   startWorld, startClient, starts: Map(id -> {x,y}), moved, collapseTo }
  //   { type: 'scale',  handle, anchor: [x,y], startBounds, starts: Map(id -> {x,y,scaleX,scaleY,centerX,centerY}) }
  //   { type: 'rotate', pivot: [x,y], startAngle, starts: Map(id -> {x,y,rotation,centerX,centerY}) }
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

    const selected = selectedIdsRef.current;

    // Selection outlines: animated dashed border hugging each selected stroke's ink
    if (selected.size) {
      const period = SELECTION_DASH_PX[0] + SELECTION_DASH_PX[1];
      const phase = ((performance.now() / 1000) * MARCH_SPEED_PX) % period; // wrap to avoid huge numbers

      ctx.save();
      ctx.strokeStyle = SELECTION_COLOR;
      ctx.lineWidth = 1 / scale;
      ctx.setLineDash(SELECTION_DASH_PX.map((d) => d / scale));
      ctx.lineDashOffset = -phase / scale;      // negative = dashes travel forward along the path
      ctx.lineJoin = 'round';
      for (const id of selected) {
        const stroke = strokesRef.current.get(id);
        if (!stroke) continue;
        const outline = getStrokeOutlineWorld(stroke, OUTLINE_PAD_PX, scale);
        if (!outline || outline.length < 3) continue;
        ctx.beginPath();
        ctx.moveTo(outline[0][0], outline[0][1]);
        for (let i = 1; i < outline.length; i++) ctx.lineTo(outline[i][0], outline[i][1]);
        ctx.closePath();
        ctx.stroke();
      }
      ctx.restore();

      const bounds = getGroupBoundsWorld(strokesRef.current, selected);
      if (bounds) {
        // Corner (resize) handles
        const hs = HANDLE_SIZE_PX / scale / 2;
        const corners = [
          [bounds.minX, bounds.minY], [bounds.maxX, bounds.minY],
          [bounds.maxX, bounds.maxY], [bounds.minX, bounds.maxY]
        ];
        ctx.save();
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = SELECTION_COLOR;
        ctx.lineWidth = 1.5 / scale;
        for (const [hx, hy] of corners) {
          ctx.beginPath();
          ctx.rect(hx - hs, hy - hs, hs * 2, hs * 2);
          ctx.fill();
          ctx.stroke();
        }
        ctx.restore();
        // Rotate handle: small circle above the box, with a connecting line
        const [rhx, rhy] = getRotateHandlePos(bounds, scale);
        const topCenterX = (bounds.minX + bounds.maxX) / 2;
        const r = ROTATE_HANDLE_RADIUS_PX / scale;
        ctx.save();
        ctx.strokeStyle = SELECTION_COLOR;
        ctx.lineWidth = 1 / scale;
        ctx.beginPath();
        ctx.moveTo(topCenterX, bounds.minY);
        ctx.lineTo(rhx, rhy);
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(rhx, rhy, r, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.stroke();
        ctx.restore();

        // Degree readout while rotating
        const rotIt = interactionRef.current;
        if (rotIt?.type === 'rotate') {
          ctx.save();
          ctx.fillStyle = SELECTION_COLOR;
          ctx.font = `${12 / scale}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.fillText(`${rotIt.degreesLabel}°`, rhx, rhy - 14 / scale);
          ctx.restore();
        }
      }
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

    // Marching ants: keep requesting frames only while something is selected.
    // When the selection empties, the loop stops by itself.
    if (selectedIdsRef.current.size && !prefersReducedMotion()) scheduleRedraw();
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

  // Send absolute x/y/scaleX/scaleY/rotation for the given ids as one batched message
  const emitUpdates = (ids, final) => {
    const updates = [];
    for (const id of ids) {
      const s = strokesRef.current.get(id);
      if (!s) continue;
      updates.push({
        id,
        x: s.x ?? 0, y: s.y ?? 0,
        scaleX: s.scaleX ?? 1, scaleY: s.scaleY ?? 1,
        rotation: s.rotation ?? 0
      });
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

  // Set x/y/scaleX/scaleY/rotation on existing strokes from a transform entry
  // ('from' = undo, 'to' = redo), then sync peers. Returns false if nothing applied
  // (e.g. every stroke in the entry was erased since).
  const applyTransform = (changes, key) => {
    const ids = [];
    for (const c of changes) {
      const s = strokesRef.current.get(c.id);
      if (!s) continue;
      const v = c[key];
      s.x = v.x;
      s.y = v.y;
      if (v.scaleX !== undefined) s.scaleX = v.scaleX;
      if (v.scaleY !== undefined) s.scaleY = v.scaleY;
      if (v.rotation !== undefined) s.rotation = v.rotation;
      ids.push(c.id);
    }
    if (!ids.length) return false;
    emitUpdates(ids, true);
    scheduleRedraw();
    return true;
  };

  const undo = () => {
    while (undoStackRef.current.length) {
      const entry = undoStackRef.current.pop();

      if (entry.type === 'draw') {
        const stroke = strokesRef.current.get(entry.id);
        if (!stroke) continue;                         // already gone, try the next entry
        strokesRef.current.delete(entry.id);
        redoStackRef.current.push({ type: 'draw', stroke });
        socket.emit('stroke:delete', { id: entry.id });
        pruneSelection();
        scheduleRedraw();
        return;
      }

      if (entry.type === 'transform') {
        if (!applyTransform(entry.changes, 'from')) continue;
        redoStackRef.current.push(entry);
        return;
      }
    }
  };

  const redo = () => {
    while (redoStackRef.current.length) {
      const entry = redoStackRef.current.pop();

      if (entry.type === 'draw') {
        strokesRef.current.set(entry.stroke.id, entry.stroke);
        undoStackRef.current.push({ type: 'draw', id: entry.stroke.id });
        socket.emit('stroke:end', entry.stroke); // server and peers already handle this (transform included)
        scheduleRedraw();
        return;
      }

      if (entry.type === 'transform') {
        if (!applyTransform(entry.changes, 'to')) continue;
        undoStackRef.current.push(entry);
        return;
      }
    }
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

    // A peer moved/scaled/rotated some strokes: absolute values, so just assign
    const handleUpdate = ({ updates }) => {
      if (!Array.isArray(updates)) return;
      const interacting = interactionRef.current?.starts ?? null; // my own drag/scale/rotate in progress
      for (const u of updates) {
        if (interacting?.has(u.id)) continue; // I'm transforming it right now; my local state wins, no jitter
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
    socket.on('stroke:delete', handleRemove);
    socket.emit('join-room', roomId);

    redrawAll();

    return () => {
      socket.off('canvas-catch-up', handleCatchUp);
      socket.off('stroke:preview', handlePreview);
      socket.off('stroke:end', handleEnd);
      socket.off('stroke:update', handleUpdate);
      socket.off('clear-board', handleClear);
      socket.off('peer-left', handlePeerLeft);
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
      const selected = selectedIdsRef.current;

      // Handles take priority over everything else when a selection exists
      if (selected.size) {
        const bounds = getGroupBoundsWorld(strokesRef.current, selected);

        const handle = bounds ? hitTestHandles(bounds, wx, wy, cameraRef.current.scale) : null;
        if (handle) {
          const starts = new Map();
          for (const id of selected) {
            const s = strokesRef.current.get(id);
            const b = s && getLocalBounds(s);
            if (!b) continue;
            starts.set(id, {
              x: s.x ?? 0, y: s.y ?? 0,
              scaleX: s.scaleX ?? 1, scaleY: s.scaleY ?? 1,
              centerX: (b.minX + b.maxX) / 2, centerY: (b.minY + b.maxY) / 2
            });
          }
          interactionRef.current = {
            type: 'scale', handle, anchor: oppositeCorner(handle, bounds), startBounds: bounds, starts
          };
          lastUpdateEmitRef.current = 0;
          canvasRef.current.style.cursor = cursorForHandle(handle);
          return;
        }

        if (bounds && hitTestRotateHandle(bounds, wx, wy, cameraRef.current.scale)) {
          const pivotX = (bounds.minX + bounds.maxX) / 2;
          const pivotY = (bounds.minY + bounds.maxY) / 2;
          const starts = new Map();
          for (const id of selected) {
            const s = strokesRef.current.get(id);
            const b = s && getLocalBounds(s);
            if (!b) continue;
            starts.set(id, {
              x: s.x ?? 0, y: s.y ?? 0,
              rotation: s.rotation ?? 0,
              centerX: (b.minX + b.maxX) / 2, centerY: (b.minY + b.maxY) / 2
            });
          }
          interactionRef.current = {
            type: 'rotate',
            pivot: [pivotX, pivotY],
            startAngle: Math.atan2(wy - pivotY, wx - pivotX),
            starts
          };
          lastUpdateEmitRef.current = 0;
          canvasRef.current.style.cursor = 'grabbing';
          return;
        }
      }

      const tolWorld = HIT_TOLERANCE_PX / cameraRef.current.scale;
      const hit = hitTestStrokes(strokesRef.current, wx, wy, tolWorld);

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

    const it = interactionRef.current;

    // Hover feedback for resize/rotate handles, when idle with a selection
    if (!it && activeToolRef.current === 'select' && selectedIdsRef.current.size) {
      const bounds = getGroupBoundsWorld(strokesRef.current, selectedIdsRef.current);
      if (bounds) {
        const handle = hitTestHandles(bounds, x, y, cameraRef.current.scale);
        if (handle) canvasRef.current.style.cursor = cursorForHandle(handle);
        else if (hitTestRotateHandle(bounds, x, y, cameraRef.current.scale)) canvasRef.current.style.cursor = 'grab';
        else canvasRef.current.style.cursor = '';
      } else {
        canvasRef.current.style.cursor = '';
      }
    }

    // ---- Select tool interactions ----
    if (it) {
      if (it.type === 'scale') {
        const { minX, minY, maxX, maxY } = it.startBounds;
        const startW = Math.max(maxX - minX, 1e-6);
        const startH = Math.max(maxY - minY, 1e-6);
        const [ax, ay] = it.anchor;
        const [signX, signY] = HANDLE_SIGNS[it.handle];
        const minSize = MIN_GROUP_SIZE_PX / cameraRef.current.scale;

        // Directional (not abs) diffs: dragging past the anchor clamps at minSize
        // instead of shrinking to 0 and re-growing (which would look like a flip).
        const newW = Math.max(signX * (x - ax), minSize);
        const newH = Math.max(signY * (y - ay), minSize);
        let gsx = newW / startW;
        let gsy = newH / startH;
        if (e.shiftKey) { const g = Math.max(gsx, gsy); gsx = gsy = g; } // uniform scale

        for (const [id, st] of it.starts) {
          const s = strokesRef.current.get(id);
          if (!s) continue;
          const worldCenterX0 = st.centerX + st.x;
          const worldCenterY0 = st.centerY + st.y;
          const newCenterX = ax + (worldCenterX0 - ax) * gsx;
          const newCenterY = ay + (worldCenterY0 - ay) * gsy;
          s.x = round1(newCenterX - st.centerX);
          s.y = round1(newCenterY - st.centerY);
          s.scaleX = round4(clamp(st.scaleX * gsx, MIN_OBJECT_SCALE, MAX_OBJECT_SCALE));
          s.scaleY = round4(clamp(st.scaleY * gsy, MIN_OBJECT_SCALE, MAX_OBJECT_SCALE));
        }

        const now = performance.now();
        if (now - lastUpdateEmitRef.current >= UPDATE_INTERVAL_MS) {
          lastUpdateEmitRef.current = now;
          emitUpdates(it.starts.keys(), false);
        }
        scheduleRedraw();
      } else if (it.type === 'rotate') {
        const [px, py] = it.pivot;
        const angle = Math.atan2(y - py, x - px);
        let delta = angle - it.startAngle;
        if (e.shiftKey) delta = Math.round(delta / ROTATE_SNAP_RAD) * ROTATE_SNAP_RAD;
        it.degreesLabel = Math.round((delta * 180) / Math.PI);
        const cos = Math.cos(delta), sin = Math.sin(delta);
        for (const [id, st] of it.starts) {
          const s = strokesRef.current.get(id);
          if (!s) continue;
          const worldCenterX0 = st.centerX + st.x;
          const worldCenterY0 = st.centerY + st.y;
          const dx = worldCenterX0 - px;
          const dy = worldCenterY0 - py;
          const newCenterX = px + dx * cos - dy * sin;
          const newCenterY = py + dx * sin + dy * cos;
          s.x = round1(newCenterX - st.centerX);
          s.y = round1(newCenterY - st.centerY);
          s.rotation = round4(st.rotation + delta);
        }

        const now = performance.now();
        if (now - lastUpdateEmitRef.current >= UPDATE_INTERVAL_MS) {
          lastUpdateEmitRef.current = now;
          emitUpdates(it.starts.keys(), false);
        }
        scheduleRedraw();
      } else if (it.type === 'drag') {
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

      if (it.type === 'scale') {
        const changes = [];
        for (const [id, st] of it.starts) {
          const s = strokesRef.current.get(id);
          if (!s) continue;
          const from = { x: st.x, y: st.y, scaleX: st.scaleX, scaleY: st.scaleY };
          const to = { x: s.x ?? 0, y: s.y ?? 0, scaleX: s.scaleX ?? 1, scaleY: s.scaleY ?? 1 };
          if (to.x !== from.x || to.y !== from.y || to.scaleX !== from.scaleX || to.scaleY !== from.scaleY) {
            changes.push({ id, from, to });
          }
        }
        if (changes.length) {
          undoStackRef.current.push({ type: 'transform', changes });
          redoStackRef.current = []; // a new action discards redo history
        }
        emitUpdates(it.starts.keys(), true); // guaranteed trailing emit: peers end exactly in sync
      } else if (it.type === 'rotate') {
        const changes = [];
        for (const [id, st] of it.starts) {
          const s = strokesRef.current.get(id);
          if (!s) continue;
          const from = { x: st.x, y: st.y, rotation: st.rotation };
          const to = { x: s.x ?? 0, y: s.y ?? 0, rotation: s.rotation ?? 0 };
          if (to.x !== from.x || to.y !== from.y || to.rotation !== from.rotation) {
            changes.push({ id, from, to });
          }
        }
        if (changes.length) {
          undoStackRef.current.push({ type: 'transform', changes });
          redoStackRef.current = [];
        }
        emitUpdates(it.starts.keys(), true);
      } else if (it.type === 'drag') {
        if (it.moved) {
          const changes = [];
          for (const [id, start] of it.starts) {
            const s = strokesRef.current.get(id);
            if (!s) continue;
            const to = { x: s.x ?? 0, y: s.y ?? 0, scaleX: s.scaleX ?? 1, scaleY: s.scaleY ?? 1 };
            const from = { x: start.x, y: start.y, scaleX: to.scaleX, scaleY: to.scaleY }; // drag never changes scale
            if (to.x !== from.x || to.y !== from.y) changes.push({ id, from, to });
          }
          if (changes.length) {
            undoStackRef.current.push({ type: 'transform', changes });
            redoStackRef.current = [];
          }
          emitUpdates(it.starts.keys(), true);
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
    undoStackRef.current.push({ type: 'draw', id: finalStroke.id });
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