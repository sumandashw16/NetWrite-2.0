import { useRef, useEffect, useState, forwardRef, useImperativeHandle, useContext } from 'react';
import { socket } from '../../services/socket';
import { AuthContext } from '../../context/AuthContext';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { SHAPES, SHAPE_BOUNDS, ICON_BOUNDS, ICON_SIZE } from './shapes';
import { MDI_PATHS } from './mdiSubset';

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
const YJS_URL = 'ws://localhost:5000/yjs';
const STROKE_FIELDS = [
  'id', 'userId', 'color', 'width', 'points', 'ts',
  'x', 'y', 'scaleX', 'scaleY', 'rotation',
  'type', 'shapeType', 'iconName','text', 'fontSize'
];

const num = (v, d) => (Number.isFinite(v) ? v : d);
const scaleOk = (v) => (Number.isFinite(v) && Math.abs(v) >= 0.01 && Math.abs(v) <= 100 ? v : 1);
const validPoints = new WeakSet();
function pointsOk(p) {
  if (!Array.isArray(p)) return false;
  if (validPoints.has(p)) return true;
  if (p.length % 2 === 0 && p.length <= 100000 && p.every(Number.isFinite)) { validPoints.add(p); return true; }
  return false;
}

function toPlain(ys) {
  const type = ys.get('type') || 'path';
  const points = ys.get('points');
  if (!ys.get('id')) return null;
  if (type === 'path' && !pointsOk(points)) return null;
  const shapeType = ys.get('shapeType') || null;
  const iconName = ys.get('iconName') || null;
  if (type === 'shape' && !(shapeType && Object.hasOwn(SHAPES, shapeType))) return null;
  if (type === 'icon' && !/^[a-z0-9-]{1,40}$/.test(iconName ?? '')) return null;
  const textVal = ys.get('text') ?? null;
  if (type === 'text' && typeof textVal !== 'string') return null;
  return {
    id: ys.get('id'),
    userId: ys.get('userId'),
    color: ys.get('color') || '#000000',
    width: num(ys.get('width'), 1),
    points: points || [],
    ts: num(ys.get('ts'), 0),
    x: num(ys.get('x'), 0),
    y: num(ys.get('y'), 0),
    scaleX: scaleOk(ys.get('scaleX')),
    scaleY: scaleOk(ys.get('scaleY')),
    rotation: num(ys.get('rotation'), 0),
    type, shapeType, iconName,
    text: textVal,
    fontSize: num(ys.get('fontSize'), 20),
  };
}

// Same order on every peer: timestamp, then id as a tiebreak
const byOrder = (a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1);
// Per-handle sign for (pointer - anchor) along each axis, so the correct side always grows
// and dragging past the anchor clamps instead of flipping/regrowing.
const HANDLES = { nw: [-1, -1], ne: [1, -1], se: [1, 1], sw: [-1, 1], n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] };

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

const measureCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
const measureCtx = measureCanvas?.getContext('2d') ?? null;
const textBoundsCache = new Map();

function getTextBounds(stroke) {
  const fontSize = stroke.fontSize || 20;
  const key = `${fontSize}|${stroke.text}`;
  let b = textBoundsCache.get(key);
  if (b) return b;

  const lines = (stroke.text || '').split('\n');
  let maxW = 10;
  if (measureCtx) {
    measureCtx.font = `${fontSize}px Inter, system-ui, sans-serif`;
    for (const line of lines) maxW = Math.max(maxW, measureCtx.measureText(line || ' ').width);
  } else {
    maxW = Math.max(maxW, ...lines.map((l) => l.length * fontSize * 0.6));
  }
  const lineHeight = fontSize * 1.3;
  b = { minX: 0, minY: 0, maxX: maxW, maxY: lineHeight * Math.max(lines.length, 1) };
  textBoundsCache.set(key, b);
  if (textBoundsCache.size > 500) textBoundsCache.clear(); // cheap unbounded-growth guard
  return b;
}

function drawText(ctx, stroke) {
  const b = getLocalBounds(stroke);
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  const t = getTransform(stroke);
  const fontSize = stroke.fontSize || 20;
  const lineHeight = fontSize * 1.3;

  ctx.save();
  ctx.translate(cx + t.x, cy + t.y);
  ctx.rotate(t.rotation);
  ctx.scale(t.scaleX, t.scaleY);
  ctx.translate(-cx, -cy);
  ctx.font = `${fontSize}px Inter, system-ui, sans-serif`;
  ctx.fillStyle = stroke.color;
  ctx.textBaseline = 'top';
  (stroke.text || '').split('\n').forEach((line, i) => ctx.fillText(line, b.minX, b.minY + i * lineHeight));
  ctx.restore();
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
  if (stroke.type === 'shape') return SHAPE_BOUNDS;
  if (stroke.type === 'icon') return ICON_BOUNDS;
  if (stroke.type === 'text') return getTextBounds(stroke);
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
function transformPointsToWorld(stroke, pts = stroke.points) {
  const b = getLocalBounds(stroke);
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

function polyHit(world, closed, wx, wy, rSq) {
  const n = world.length / 2;
  for (let j = 0; j < (closed ? n : n - 1); j++) {
    const k = (j + 1) % n;
    if (sqSegDist(wx, wy, world[j * 2], world[j * 2 + 1], world[k * 2], world[k * 2 + 1]) <= rSq) return true;
  }
  return false;
}

function hitTestStrokes(strokesMap, wx, wy, tolWorld) {
  const list = Array.from(strokesMap.values());
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i];
    const hitRadius = (s.width ?? 1) / 2 + tolWorld;
    const b = getWorldBounds(s, hitRadius);
    if (!b) continue;
    if (wx < b.minX || wx > b.maxX || wy < b.minY || wy > b.maxY) continue;

    if (s.type === 'icon' || s.type === 'text') return s;   // solid glyph: the box is fine
    const rSq = hitRadius * hitRadius;

    if (s.type === 'shape') {          // border only
      const poly = Object.hasOwn(SHAPES, s.shapeType) ? SHAPES[s.shapeType] : null;
      if (poly && polyHit(transformPointsToWorld(s, poly.points), poly.closed, wx, wy, rSq)) return s;
      continue;
    }

    const world = isIdentity(getTransform(s)) ? s.points : transformPointsToWorld(s);
    if (world.length === 2) {
      const dx = wx - world[0], dy = wy - world[1];
      if (dx * dx + dy * dy <= rSq) return s;
      continue;
    }
    if (polyHit(world, false, wx, wy, rSq)) return s;
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

function frameToWorld(f, lx, ly) {
  const c = Math.cos(f.rot), s = Math.sin(f.rot);
  return [f.cx + lx * c - ly * s, f.cy + lx * s + ly * c];
}
function worldToFrame(f, wx, wy) {
  const dx = wx - f.cx, dy = wy - f.cy, c = Math.cos(f.rot), s = Math.sin(f.rot);
  return [dx * c + dy * s, -dx * s + dy * c];
}

// One object: its ORIENTED box (so handles follow rotation). Several: the axis-aligned group box.
function getSelectionFrame(strokesMap, ids) {
  const list = [];
  for (const id of ids) { const s = strokesMap.get(id); if (s) list.push(s); }
  if (!list.length) return null;
  if (list.length === 1) {
    const s = list[0], b = getLocalBounds(s);
    if (!b) return null;
    const t = getTransform(s), pad = (s.width ?? 1) / 2;
    return {
      cx: (b.minX + b.maxX) / 2 + t.x, cy: (b.minY + b.maxY) / 2 + t.y, rot: t.rotation,
      hw: Math.abs(t.scaleX) * (b.maxX - b.minX) / 2 + pad,
      hh: Math.abs(t.scaleY) * (b.maxY - b.minY) / 2 + pad
    };
  }
  const g = getGroupBoundsWorld(strokesMap, ids);
  if (!g) return null;
  return { cx: (g.minX + g.maxX) / 2, cy: (g.minY + g.maxY) / 2, rot: 0, hw: (g.maxX - g.minX) / 2, hh: (g.maxY - g.minY) / 2 };
}

function hitTestHandles(f, wx, wy, cameraScale) {
  const [px, py] = worldToFrame(f, wx, wy);
  const hs = HANDLE_SIZE_PX / cameraScale / 2;
  for (const [key, [hx, hy]] of Object.entries(HANDLES)) {   // corners come first, so they win on tiny boxes
    if (Math.abs(px - hx * f.hw) <= hs && Math.abs(py - hy * f.hh) <= hs) return key;
  }
  return null;
}

const cursorForHandle = (h) =>
  h === 'n' || h === 's' ? 'ns-resize' : h === 'e' || h === 'w' ? 'ew-resize' : h === 'nw' || h === 'se' ? 'nwse-resize' : 'nesw-resize';

const getRotateHandlePos = (f, cameraScale) => frameToWorld(f, 0, -f.hh - ROTATE_HANDLE_OFFSET_PX / cameraScale);

function hitTestRotateHandle(f, wx, wy, cameraScale) {
  const [hx, hy] = getRotateHandlePos(f, cameraScale);
  const r = ROTATE_HANDLE_RADIUS_PX / cameraScale;
  return (wx - hx) ** 2 + (wy - hy) ** 2 <= r * r;
}

// Closed outline polygon hugging the stroke's ink, in WORLD space. Offsets the
// (already world-space) polyline by a constant radius and joins with round caps.
function getStrokeOutlineWorld(stroke, padPx, cameraScale) {

  if (stroke.type === 'shape' || stroke.type === 'icon' || stroke.type === 'text') {
    const pad = padPx / cameraScale;
    const b = getLocalBounds(stroke);
    if (!b) return null;

    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    const { x, y, scaleX, scaleY, rotation } = getTransform(stroke);
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);

    // Pad the local bounds, then transform them to world space
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

const iconPathCache = new Map();
function getIconPath(name) {
  if (!Object.hasOwn(MDI_PATHS, name)) return null;
  let p = iconPathCache.get(name);
  if (!p) { p = new Path2D(MDI_PATHS[name]); iconPathCache.set(name, p); }
  return p;
}

function drawShape(ctx, stroke) {
  if (!Object.hasOwn(SHAPES, stroke.shapeType)) return;
  const poly = SHAPES[stroke.shapeType];
  const pts = isIdentity(getTransform(stroke)) ? poly.points : transformPointsToWorld(stroke, poly.points);
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.width || 2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  if (poly.closed) ctx.closePath();
  ctx.stroke();
}

function drawIcon(ctx, stroke) {
  const t = getTransform(stroke);
  const k = ICON_SIZE / 24;
  ctx.save();
  ctx.translate(t.x, t.y);
  ctx.rotate(t.rotation);
  ctx.scale(t.scaleX, t.scaleY);
  ctx.scale(k, k);
  ctx.translate(-12, -12);
  const p = getIconPath(stroke.iconName);
  if (p) { ctx.fillStyle = stroke.color; ctx.fill(p); }
  else { ctx.strokeStyle = '#9ca3af'; ctx.lineWidth = 1; ctx.setLineDash([2, 2]); ctx.strokeRect(2, 2, 20, 20); } // unknown icon
  ctx.restore();
}

function drawStroke(ctx, stroke) {
  if (stroke.type === 'shape') return drawShape(ctx, stroke);
  if (stroke.type === 'icon') return drawIcon(ctx, stroke);
  if (stroke.type === 'text') return drawText(ctx, stroke);
  if (!stroke.points || stroke.points.length === 0) return;
  const t = getTransform(stroke);
  drawRawStroke(ctx, isIdentity(t) ? stroke.points : transformPointsToWorld(stroke), stroke.color, stroke.width);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const Canvas = forwardRef(({ color = '#000000', brushSize = 5, roomId, onCameraChange, onToolChange, onSelectionChange }, ref) => {
  const lastCursorEmitRef = useRef(0);
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
  const undoManagerRef = useRef(null);
  const lastPreviewEmitRef = useRef(0);
  const lastUpdateEmitRef = useRef(0);
  const rafRef = useRef(null);

  // Tool + selection. State drives React UI; the refs are the source of truth for
  // redrawAll and the pointer handlers (long-lived closures would read stale state).
  const [activeTool, setActiveTool] = useState('select');
  const activeToolRef = useRef('select');
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [editingTextId, setEditingTextId] = useState(null);
  const selectedIdsRef = useRef(new Set());
  const ydocRef = useRef(null);
  const yStrokesRef = useRef(null);
  const providerRef = useRef(null);
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

            const frame = getSelectionFrame(strokesRef.current, selected);
      if (frame) {
        const hs = HANDLE_SIZE_PX / scale / 2;
        ctx.save();
        ctx.strokeStyle = SELECTION_COLOR;
        ctx.fillStyle = '#fff';
        ctx.lineWidth = 1 / scale;

        ctx.beginPath();                                   // frame box
        [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([hx, hy], i) => {
          const [px, py] = frameToWorld(frame, hx * frame.hw, hy * frame.hh);
          i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
        });
        ctx.closePath();
        ctx.stroke();

        const [rhx, rhy] = getRotateHandlePos(frame, scale);   // rotate handle
        const [tx, ty] = frameToWorld(frame, 0, -frame.hh);
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(rhx, rhy); ctx.stroke();
        ctx.beginPath(); ctx.arc(rhx, rhy, ROTATE_HANDLE_RADIUS_PX / scale, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

        ctx.lineWidth = 1.5 / scale;                        // 8 resize handles
        for (const [hx, hy] of Object.values(HANDLES)) {
          const [px, py] = frameToWorld(frame, hx * frame.hw, hy * frame.hh);
          ctx.save();
          ctx.translate(px, py);
          ctx.rotate(frame.rot);
          ctx.beginPath();
          ctx.rect(-hs, -hs, hs * 2, hs * 2);
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        }
        ctx.restore();

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

  // All writes go to Yjs. The observer updates the strokesRef mirror and redraws.
  const addStroke = (s) => {
    const ydoc = ydocRef.current;
    if (!ydoc) return;
    ydoc.transact(() => {
      const m = new Y.Map();
      for (const k of STROKE_FIELDS) if (s[k] !== undefined) m.set(k, s[k]);
      yStrokesRef.current.set(s.id, m);
    });
  };

  const removeStroke = (id) => {
    ydocRef.current?.transact(() => yStrokesRef.current.delete(id));
  };

  // patches: [{ id, x?, y?, scaleX?, scaleY?, rotation? }]. Writes only the fields that changed.
  const patchStroke = (patches) => {
    const ydoc = ydocRef.current;
    if (!ydoc) return;
    ydoc.transact(() => {
      for (const { id, ...fields } of patches) {
        const ys = yStrokesRef.current.get(id);
        if (!ys) continue; // erased by someone in the meantime
        for (const [k, v] of Object.entries(fields)) if (ys.get(k) !== v) ys.set(k, v);
      }
    });
  };

  // Delete every stroke under (wx, wy). Loops because strokes can overlap.
  const eraseAt = (wx, wy) => {
    const tolWorld = ERASER_RADIUS_PX / cameraRef.current.scale;
    let erased = false;
    let hit;
    while ((hit = hitTestStrokes(strokesRef.current, wx, wy, tolWorld))) {
      strokesRef.current.delete(hit.id); // keeps the loop terminating even before Yjs echoes back
      removeStroke(hit.id);
      erased = true;
    }
    if (erased) {
      pruneSelection();
      scheduleRedraw();
    }
  };

    // Drop a new shape/icon at the center of the current view, sized ~1x on screen, and select it
  const spawn = (fields) => {
    const canvas = canvasRef.current;
    const [wx, wy] = screenToWorld(canvas.width / 2, canvas.height / 2);
    const k = round4(clamp(1 / cameraRef.current.scale, MIN_OBJECT_SCALE, MAX_OBJECT_SCALE));
    const s = {
      id: crypto.randomUUID(), userId, color, width: brushSize, points: [], ts: Date.now(),
      x: round1(wx), y: round1(wy), scaleX: k, scaleY: k, rotation: 0, ...fields
    };
    undoManagerRef.current?.stopCapturing();
    addStroke(s);
    setTool('select');
    setSelection(new Set([s.id]));
  };

  const undo = () => { undoManagerRef.current?.undo(); };
  const redo = () => { undoManagerRef.current?.redo(); };

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
      else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIdsRef.current.size) {
        e.preventDefault();
        const ids = [...selectedIdsRef.current];
        undoManagerRef.current?.stopCapturing();
        for (const id of ids) removeStroke(id);
        setSelection(new Set());
      }
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
    addShape: (shapeType) => { if (Object.hasOwn(SHAPES, shapeType)) spawn({ type: 'shape', shapeType }); },
    addIcon: (iconName) => { if (Object.hasOwn(MDI_PATHS, iconName)) spawn({ type: 'icon', iconName, width: 1 }); },
    addText: () => {
      const canvas = canvasRef.current;
      const [wx, wy] = screenToWorld(canvas.width / 2, canvas.height / 2);
      const k = round4(clamp(1 / cameraRef.current.scale, MIN_OBJECT_SCALE, MAX_OBJECT_SCALE));
      const id = crypto.randomUUID();
      const s = {
        id, userId, color, width: 1, points: [], ts: Date.now(),
        x: round1(wx), y: round1(wy), scaleX: k, scaleY: k, rotation: 0,
        type: 'text', text: 'Text', fontSize: 20
      };
      undoManagerRef.current?.stopCapturing();
      addStroke(s);
      setTool('select');
      setSelection(new Set([id]));
      setEditingTextId(id);
    },
    clearBoard: () => {
      const ydoc = ydocRef.current;
      if (!ydoc) return;
      ydoc.transact(() => {
        yStrokesRef.current.clear();
        const meta = ydoc.getMap('meta');
        meta.set('clearEpoch', (meta.get('clearEpoch') ?? 0) + 1); // tells every client to reset undo/redo
      });
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
    },
    exportPNG: () => {
      const strokes = [...strokesRef.current.values()];
      if (!strokes.length) return alert('Nothing to export');

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const s of strokes) {
        const b = getWorldBounds(s, (s.width ?? 1) / 2);
        if (!b) continue;
        minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY);
        maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY);
      }


      const PAD = 20;
      const w = Math.ceil(maxX - minX) + PAD * 2;
      const h = Math.ceil(maxY - minY) + PAD * 2;

      const off = document.createElement('canvas');
      off.width = w;
      off.height = h;
      const ctx = off.getContext('2d');
      ctx.fillStyle = '#fff';           // omit this line for a transparent background
      ctx.fillRect(0, 0, w, h);
      ctx.translate(-minX + PAD, -minY + PAD);
      for (const s of strokes) drawStroke(ctx, s);

      off.toBlob((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `board-${roomId}.png`;
        a.click();
        URL.revokeObjectURL(url);
      });
    },
    deleteSelected: () => {
      const ids = [...selectedIdsRef.current];
      if (!ids.length) return;
      undoManagerRef.current?.stopCapturing();
      for (const id of ids) removeStroke(id);
      setSelection(new Set());
    },
    duplicateSelected: () => {
      const ids = [...selectedIdsRef.current];
      if (!ids.length) return;
      const OFFSET = 16;
      const newIds = [];
      undoManagerRef.current?.stopCapturing();
      for (const id of ids) {
        const s = strokesRef.current.get(id);
        if (!s) continue;
        const copy = { ...s, id: crypto.randomUUID(), ts: Date.now(), x: (s.x ?? 0) + OFFSET, y: (s.y ?? 0) + OFFSET };
        addStroke(copy);
        newIds.push(copy.id);
      }
      setSelection(new Set(newIds));
    },
    updateSelectedStyle: (fields) => {
      const ids = [...selectedIdsRef.current];
      if (!ids.length) return;
      undoManagerRef.current?.stopCapturing();
      patchStroke(ids.map((id) => ({ id, ...fields })));
      scheduleRedraw();
    },
    getSelectedObjects: () => [...selectedIdsRef.current].map((id) => strokesRef.current.get(id)).filter(Boolean)
    
  }));

  useEffect(() => {
    const canvas = canvasRef.current;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    // ---- Yjs document + provider (one isolated doc per roomId) ----
    const ydoc = new Y.Doc();
    const yStrokes = ydoc.getMap('strokes');
    const yMeta = ydoc.getMap('meta');
    const provider = new WebsocketProvider(YJS_URL, roomId, ydoc); // connects to ws://.../yjs/<roomId>
    const awareness = provider.awareness;
    ydocRef.current = ydoc;
    yStrokesRef.current = yStrokes;
    providerRef.current = provider;

    strokesRef.current = new Map();
    peerPreviewsRef.current = new Map();
    currentStrokeRef.current = null;
    interactionRef.current = null;

    // Keep the strokesRef mirror in sync. Fires for local AND remote changes (and initial sync).
    const onStrokesChange = (events) => {
      const ids = new Set();
      for (const ev of events) {
        if (ev.target === yStrokes) ev.keysChanged.forEach((k) => ids.add(k));
        else ids.add(ev.path[0]); // a field inside one stroke changed
      }

      let added = false;
      const map = strokesRef.current;
      for (const id of ids) {
        const ys = yStrokes.get(id);
        const plain = ys ? toPlain(ys) : null;
        if (plain) {
          if (!map.has(id)) { added = true; peerPreviewsRef.current.delete(id); }
          map.set(id, plain);
        } else {
          map.delete(id);
        }
      }
      if (added) {
        strokesRef.current = new Map([...map.values()].sort(byOrder).map((s) => [s.id, s]));
      }
      pruneSelection();
      scheduleRedraw();
    };
    yStrokes.observeDeep(onStrokesChange);

    // Board cleared by anyone: wipe undo history so nobody can resurrect strokes that were deleted for everyone
    const onMetaChange = () => {
      interactionRef.current = null;
      // microtask: lets the UndoManager finish recording the clear transaction first, then wipe it
      queueMicrotask(() => undoManagerRef.current?.clear());
      scheduleRedraw();
    };
    yMeta.observe(onMetaChange);
    // Undo/redo is per user: only changes made by THIS client are tracked (remote updates have a different origin)
    const undoManager = new Y.UndoManager(yStrokes, {
      captureTimeout: 1e9 // one gesture = one step. We end each gesture ourselves with stopCapturing()
    });
    undoManagerRef.current = undoManager;
    // Peers' in-progress strokes travel over awareness (ephemeral, never stored in the doc)
    const onAwareness = () => {
      const next = new Map();
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === ydoc.clientID) return;
        const p = state.preview;
        if (p?.id && pointsOk(p.points) && !strokesRef.current.has(p.id)) next.set(p.id, p);
      });
      peerPreviewsRef.current = next;
      scheduleRedraw();
    };
    awareness.on('change', onAwareness);

    // ---- camera + keyboard (unchanged) ----
    const onWheel = (e) => {
      e.preventDefault();
      const cam = cameraRef.current;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      const [wx, wy] = screenToWorld(sx, sy);
      const k = e.ctrlKey ? 0.01 : 0.001;
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, cam.scale * Math.exp(-e.deltaY * k)));

      cam.scale = next;
      cam.x = sx - wx * next;
      cam.y = sy - wy * next;
      cameraChanged();
    };
    const onKeyDown = (e) => {
      if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA') return;
      if (e.code !== 'Space') return;
      e.preventDefault();
      if (spaceRef.current) return;
      spaceRef.current = true;
      if (!panRef.current) canvas.style.cursor = 'grab';
    };
    const onKeyUp = (e) => {
      if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA') return;
      if (e.code !== 'Space') return;
      spaceRef.current = false;
      if (!panRef.current) canvas.style.cursor = '';
    };
    const onBlur = () => { spaceRef.current = false; canvas.style.cursor = ''; };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);

    const join = () => socket.emit('join-room', roomId);
    socket.on('connect', join);
    if (socket.connected) join();

    redrawAll();

    return () => {
      socket.off('connect', join);
      yStrokes.unobserveDeep(onStrokesChange);
      yMeta.unobserve(onMetaChange);
      awareness.off('change', onAwareness);
      awareness.setLocalState(null);
      provider.destroy();
      ydoc.destroy();
      ydocRef.current = null;
      yStrokesRef.current = null;
      providerRef.current = null;

      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      undoManager.destroy();
      undoManagerRef.current = null;
    };
  }, [roomId]);

  // ---- pointer handling -------------------------------------------------------------
  const commitTextEdit = (id, value) => {
  setEditingTextId(null);
  const text = value.trim() || 'Text';
  undoManagerRef.current?.stopCapturing();
  patchStroke([{ id, text }]);
  scheduleRedraw();
};

  const handleDoubleClick = (e) => {
    if (activeToolRef.current !== 'select') return;
    const { offsetX, offsetY } = e.nativeEvent;
    const [wx, wy] = screenToWorld(offsetX, offsetY);
    const hit = hitTestStrokes(strokesRef.current, wx, wy, HIT_TOLERANCE_PX / cameraRef.current.scale);
    if (hit?.type === 'text') {
      setSelection(new Set([hit.id]));
      setEditingTextId(hit.id);
    }
  };

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
      undoManagerRef.current?.stopCapturing();
      const selected = selectedIdsRef.current;

      if (selected.size) {
        const frame = getSelectionFrame(strokesRef.current, selected);
        const camScale = cameraRef.current.scale;
        const handle = frame ? hitTestHandles(frame, wx, wy, camScale) : null;
        if (handle) {
          const [hx, hy] = HANDLES[handle];
          const starts = new Map();
          for (const id of selected) {
            const s = strokesRef.current.get(id);
            const b = s && getLocalBounds(s);
            if (!b) continue;
            starts.set(id, {
              x: s.x ?? 0, y: s.y ?? 0, scaleX: s.scaleX ?? 1, scaleY: s.scaleY ?? 1,
              centerX: (b.minX + b.maxX) / 2, centerY: (b.minY + b.maxY) / 2
            });
          }
          interactionRef.current = { type: 'scale', handle, hx, hy, frame, starts };
          canvasRef.current.style.cursor = cursorForHandle(handle);
          return;
        }

        if (frame && hitTestRotateHandle(frame, wx, wy, camScale)) {
          const starts = new Map();
          for (const id of selected) {
            const s = strokesRef.current.get(id);
            const b = s && getLocalBounds(s);
            if (!b) continue;
            starts.set(id, {
              x: s.x ?? 0, y: s.y ?? 0, rotation: s.rotation ?? 0,
              centerX: (b.minX + b.maxX) / 2, centerY: (b.minY + b.maxY) / 2
            });
          }
          interactionRef.current = {
            type: 'rotate', pivot: [frame.cx, frame.cy],
            startAngle: Math.atan2(wy - frame.cy, wx - frame.cx), starts
          };
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
      undoManagerRef.current?.stopCapturing();
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
      points: [wx, wy],
      type: 'path'
    };
    lastPreviewEmitRef.current = 0;
    scheduleRedraw();
  };

  const handlePointerMove = (e) => {
    const { offsetX, offsetY } = e.nativeEvent;
    const [x, y] = screenToWorld(offsetX, offsetY);

    const t = performance.now();
    if (t - lastCursorEmitRef.current >= 33) { // ~30 cursor updates/s is plenty
      lastCursorEmitRef.current = t;
      socket.emit('cursor-move', { roomId, x, y, username: user?.username || 'Unknown' });
    }

    if (panRef.current) {                          // panning: move the camera by the screen delta
      const cam = cameraRef.current;
      cam.x += e.clientX - panRef.current.x;
      cam.y += e.clientY - panRef.current.y;
      panRef.current = { x: e.clientX, y: e.clientY };
      cameraChanged();
      return;
    }

    const it = interactionRef.current;

    if (!it && activeToolRef.current === 'select' && selectedIdsRef.current.size) {
      const f = getSelectionFrame(strokesRef.current, selectedIdsRef.current);
      const cs = cameraRef.current.scale;
      const handle = f ? hitTestHandles(f, x, y, cs) : null;
      canvasRef.current.style.cursor = handle ? cursorForHandle(handle) : f && hitTestRotateHandle(f, x, y, cs) ? 'grab' : '';
    }

    // ---- Select tool interactions ----
    if (it) {
      if (it.type === 'scale') {
        const { frame: f, hx, hy } = it;
        const [px, py] = worldToFrame(f, x, y);
        const minSize = MIN_GROUP_SIZE_PX / cameraRef.current.scale;
        let gsx = hx ? Math.max(hx * px + f.hw, minSize) / Math.max(2 * f.hw, 1e-6) : 1;  // an edge handle scales one axis
        let gsy = hy ? Math.max(hy * py + f.hh, minSize) / Math.max(2 * f.hh, 1e-6) : 1;
        if (e.shiftKey && hx && hy) { const g = Math.max(gsx, gsy); gsx = gsy = g; }
        const ax = -hx * f.hw, ay = -hy * f.hh;   // the opposite edge/corner stays fixed, in frame space

        const patches = [];
        for (const [id, st] of it.starts) {
          const [qx, qy] = worldToFrame(f, st.centerX + st.x, st.centerY + st.y);
          const [nx, ny] = frameToWorld(f, ax + (qx - ax) * gsx, ay + (qy - ay) * gsy);
          patches.push({
            id,
            x: round1(nx - st.centerX),
            y: round1(ny - st.centerY),
            scaleX: round4(clamp(st.scaleX * gsx, MIN_OBJECT_SCALE, MAX_OBJECT_SCALE)),
            scaleY: round4(clamp(st.scaleY * gsy, MIN_OBJECT_SCALE, MAX_OBJECT_SCALE))
          });
        }
        patchStroke(patches);
      } else if (it.type === 'rotate') {
        const [px, py] = it.pivot;
        const angle = Math.atan2(y - py, x - px);
        let delta = angle - it.startAngle;
        if (e.shiftKey) delta = Math.round(delta / ROTATE_SNAP_RAD) * ROTATE_SNAP_RAD;
        it.degreesLabel = Math.round((delta * 180) / Math.PI);
        const cos = Math.cos(delta), sin = Math.sin(delta);
        const patches = [];
        for (const [id, st] of it.starts) {
          const worldCenterX0 = st.centerX + st.x;
          const worldCenterY0 = st.centerY + st.y;
          const dx = worldCenterX0 - px;
          const dy = worldCenterY0 - py;
          const newCenterX = px + dx * cos - dy * sin;
          const newCenterY = py + dx * sin + dy * cos;
          patches.push({
            id,
            x: round1(newCenterX - st.centerX),
            y: round1(newCenterY - st.centerY),
            rotation: round4(st.rotation + delta)
          });
        }
        patchStroke(patches);
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
        const patches = [];
        for (const [id, start] of it.starts) {
          patches.push({ id, x: round1(start.x + ddx), y: round1(start.y + ddy) });
        }
        patchStroke(patches);
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
      providerRef.current?.awareness.setLocalStateField('preview', {
        id: stroke.id,
        userId: stroke.userId,
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
        if (!it.moved && it.collapseTo) setSelection(new Set([it.collapseTo]));
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
    const commitTextEdit = (id, value) => {
      setEditingTextId(null);
      const text = value.trim() || 'Text';
      undoManagerRef.current?.stopCapturing();
      patchStroke([{ id, text }]);
      scheduleRedraw();
    };

    const handleDoubleClick = (e) => {
      if (activeToolRef.current !== 'select') return;
      const { offsetX, offsetY } = e.nativeEvent;
      const [wx, wy] = screenToWorld(offsetX, offsetY);
      const hit = hitTestStrokes(strokesRef.current, wx, wy, HIT_TOLERANCE_PX / cameraRef.current.scale);
      if (hit?.type === 'text') {
        setSelection(new Set([hit.id]));
        setEditingTextId(hit.id);
      }
    };
    // ---- Pen tool (unchanged) ----

    // ---- Pen tool (unchanged) ----
    const stroke = currentStrokeRef.current;
    if (!stroke) return;
    currentStrokeRef.current = null;

    const finalStroke = {
      ...stroke,
      ts: Date.now(),
      x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0,
      points: simplify(stroke.points, SIMPLIFY_EPSILON / cameraRef.current.scale).map(round1)
    };

    undoManagerRef.current?.stopCapturing();
    addStroke(finalStroke); // the observer puts it in strokesRef and redraws
    providerRef.current?.awareness.setLocalStateField('preview', null);
    scheduleRedraw();
  };
  return (
    <>
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        onContextMenu={(e) => e.preventDefault()}
        data-selected-count={selectedIds.size}
        className={`touch-none ${activeTool === 'select' ? 'cursor-default' : activeTool === 'eraser' ? 'cursor-cell' : 'cursor-crosshair'}`}
      />
      {editingTextId && (() => {
        const s = strokesRef.current.get(editingTextId);
        if (!s) return null;
        const wb = getWorldBounds(s);
        const cam = cameraRef.current;
        const screenX = wb.minX * cam.scale + cam.x;
        const screenY = wb.minY * cam.scale + cam.y;
        const screenW = Math.max((wb.maxX - wb.minX) * cam.scale, 60);
        const screenH = Math.max((wb.maxY - wb.minY) * cam.scale, 30);
        const screenFont = (s.fontSize || 20) * (s.scaleY ?? 1) * cam.scale;
        return (
          <textarea
            autoFocus
            defaultValue={s.text}
            onBlur={(e) => commitTextEdit(editingTextId, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.target.blur(); }
              if (e.key === 'Escape') { e.target.value = s.text; e.target.blur(); }
            }}
            style={{
              position: 'absolute', left: screenX, top: screenY, width: screenW, minHeight: screenH,
              font: `${screenFont}px Inter, system-ui, sans-serif`, color: s.color,
              border: '1px dashed #2563eb', background: 'rgba(255,255,255,0.9)', padding: 0,
              resize: 'none', outline: 'none', lineHeight: 1.3, overflow: 'hidden', zIndex: 15
            }}
          />
        );
      })()}
    </>
  );
 
});

export default Canvas;