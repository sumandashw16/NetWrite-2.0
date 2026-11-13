# Infinite Canvas: Pan and Zoom

How pan and zoom were added to the collaborative whiteboard: the theory (camera math), the implementation, the bugs we hit, and how to explain all of it in an interview.

**Stack:** React (`Canvas.jsx`, `Board.jsx`, `LiveCursors.jsx`) · HTML Canvas 2D · Socket.IO (unchanged) · MongoDB (unchanged)

---

## 1. The 30-second pitch

> "The canvas element stays viewport-sized. What's 'infinite' is the world, and each user has a local camera, `x`, `y` and `scale`, that decides which part of it they see. Strokes are stored in world coordinates. Every pointer position is converted from screen to world before it is saved or sent, and rendering applies the camera with `ctx.setTransform`. Zoom keeps the world point under the cursor fixed by recomputing the camera offset. Because the camera is local and strokes live in world space, every user can have a different view of the same board, and the server and database needed no changes."

---

## 2. The mental model

The `<canvas>` is never actually infinite. It is always window-sized, so memory use is constant. What changes is **which part of the world you're looking at**, like a camera over a giant table.

| Space | Meaning | Where it's used |
|---|---|---|
| **World space** | Where strokes actually live. Can be negative or huge. Does not change when you pan or zoom | Stored strokes, network, database |
| **Screen space** | Pixels on the canvas element | Pointer events, what the user sees |

**The camera** is three numbers: `x`, `y` (where the world origin appears on screen) and `scale` (zoom).

### The two formulas (the whole feature rests on these)

```
screen = world * scale + camera
world  = (screen - camera) / scale
```

Worked example: camera = (100, 50), scale = 2, click at screen (300, 250).

```
world = ((300-100)/2, (250-50)/2) = (100, 100)
back  = (100*2+100,   100*2+50)   = (300, 250)   (they undo each other)
```

**The one rule:** convert pointer coordinates screen -> world *before* storing or sending anything. Strokes only ever exist in world space.

---

## 3. Panning

Panning changes only the camera. When the pointer moves by `(dx, dy)` screen pixels while panning:

```js
cam.x += dx;
cam.y += dy;
```

No stroke is touched. In our app panning is triggered by **Space + left drag** or **right-click drag**. The last pointer position lives in `panRef`; `pointerup` clears it.

---

## 4. Zooming toward the cursor

If you only change `scale`, everything zooms toward the top-left corner and the thing you were looking at flies away. The rule that fixes it:

> **The world point under the cursor must stay under the cursor.**

Steps:
1. Before zooming, find the world point under the cursor: `w = (cursor - camera) / oldScale`.
2. Change the scale.
3. Solve for the new camera so `w` is still under the cursor: `newCamera = cursor - w * newScale`.

Numeric check: scale 2 -> 4, cursor (300, 250), `w = (100, 100)`:

```
newCamera = (300 - 100*4, 250 - 100*4) = (-100, -150)
check: 100*4 + (-100) = 300
```

**Multiplicative steps:** `scale *= Math.exp(-deltaY * k)`. Zoom should feel the same at 0.5x and at 5x, so each tick multiplies instead of adds. The result is clamped to `[0.1, 10]`.

**Pinch on a trackpad** arrives as a wheel event with `ctrlKey: true`, so it gets a larger `k` (0.01 vs 0.001 for a mouse wheel).

---

## 5. Rendering

```js
ctx.setTransform(1, 0, 0, 1, 0, 0);               // identity, so clearRect clears the whole screen
ctx.clearRect(0, 0, canvas.width, canvas.height);
ctx.setTransform(scale, 0, 0, scale, camera.x, camera.y);
// ...draw strokes exactly as before (world coordinates)
```

The canvas applies the camera math to every point for us, so **`drawStroke`, the smoothing, `simplify` and the stroke objects needed no changes**. Line width is multiplied by the scale automatically, so ink is "part of the world": thicker when zoomed in, like Figma.

`ctx.setTransform(a, b, c, d, e, f)` takes a 2D affine matrix. For pan plus uniform zoom it reduces to `(scale, 0, 0, scale, x, y)`, which is the formula `screen = world * scale + camera` expressed as a matrix. That's the "affine transformation" in the textbook description.

---

## 6. What is shared and what is local

| | Shared over the socket? | Why |
|---|---|---|
| Strokes | Yes, in **world** coordinates | Same board for everyone |
| Camera (x, y, scale) | **No**, local per user | Each user chooses their own view |
| Cursor positions | Yes, in **world** coordinates | The receiver converts with its own camera |

Backward compatibility: old strokes are simply world coordinates drawn by a camera at (0, 0, scale 1). Nothing needed migrating. **Server, schema and database: zero changes.**

---

## 7. What changed in the code

### `Canvas.jsx`
| Area | Change |
|---|---|
| Constants | `MIN_SCALE = 0.1`, `MAX_SCALE = 10` |
| Refs | `cameraRef`, `panRef`, `spaceRef`, `onCameraChangeRef` (all refs, so no re-render per frame) |
| `redrawAll` | identity -> `clearRect` -> `setTransform(camera)` -> draw |
| `screenToWorld` | `(sx - cam.x) / cam.scale`, same for y |
| `cameraChanged` | `scheduleRedraw()` + tell the parent via `onCameraChange` |
| `handlePointerDown` | Right click or Space held starts a pan; otherwise the first point is converted to world |
| `handlePointerMove` | Converts to world; pan branch moves the camera; prefilter distance is `1 / scale` |
| `handlePointerUp` | Ends a pan if one is active; Douglas-Peucker epsilon is `SIMPLIFY_EPSILON / scale` |
| Main `useEffect` | `wheel` listener (`{ passive: false }`), Space key down/up, window blur handling |
| `useImperativeHandle` | `resetView()` |
| `<canvas>` | `onContextMenu={(e) => e.preventDefault()}` so right-click pan doesn't open the browser menu |

### `Board.jsx`
- `const [camera, setCamera] = useState({ x: 0, y: 0, scale: 1 })`.
- `<Canvas onCameraChange={setCamera} />` and `<LiveCursors camera={camera} />`.
- "Reset view" button calling `canvasRef.current?.resetView()`.

### `LiveCursors.jsx`
- Accepts a `camera` prop.
- Converts incoming **world** cursor coordinates to screen with the viewer's own camera:
  `translate(${x * scale + camera.x}px, ${y * scale + camera.y}px)`.

---

## 8. Scale-aware details (easy to forget)

- **1px prefilter:** one screen pixel is `1 / scale` world units, so the minimum point distance is `MIN_POINT_DISTANCE / scale`. Without this, zooming in would keep far too many points, and zooming out would drop real detail.
- **Douglas-Peucker epsilon:** same idea, `SIMPLIFY_EPSILON / scale`, so simplification matches what the user sees on screen.
- **Rounding:** stored to 1 decimal place. At scale 10 that is about one screen pixel; if strokes look slightly wobbly at high zoom, use 2 decimals.

---

## 9. Design decisions and the reasoning

| Decision | Why |
|---|---|
| Camera is local, strokes are world-space | Per-user views of one shared board; the server stays unaware of cameras |
| Camera in a ref, not React state | Panning fires many events per second; a ref avoids re-rendering the component each time |
| `setTransform` instead of transforming every point in JS | The canvas does the math; existing draw code is unchanged |
| Zoom-to-cursor via recomputed offset | Keeps the content under the cursor still, the behavior users expect |
| Multiplicative zoom with a clamp | Uniform feel at every zoom level; no flipping or infinite scale |
| `addEventListener('wheel', ..., { passive: false })` | React's `onWheel` is passive, so `preventDefault()` would fail and the page would zoom or scroll too |
| Cursors sent in world coordinates | Every viewer has a different camera |
| `onCameraChange` callback to the parent | `LiveCursors` needs the camera to place remote cursors; the camera itself stays in a ref inside `Canvas` |
| `pointer capture` | Pan or draw keeps working when the pointer leaves the canvas |
| Space tracked in a ref and cleared on `blur` | Prevents "stuck Space" if the window loses focus while it is held |

---

## 10. Bugs and mistakes along the way (good interview stories)

1. **Hooks outside the component:** (from the undo/redo work) module-scope `useRef` crashed the page. Keep hooks inside the component.
2. **Misplaced line in `handlePointerUp`:** the zoom-aware `points: simplify(...)` line was added as a new statement after `socket.emit(...)` instead of replacing the existing `points:` line. JavaScript parsed it as a *label* followed by an expression, so there was no error, but it did nothing and the old fixed epsilon kept running. Lesson: silent no-ops are the worst kind of bug, and a linter (`no-unused-labels`) catches this.
3. **Duplicate handlers:** the wheel and Space handlers were first written as a separate `useEffect` and later moved into the main effect. Keeping both would double-handle every event (zoom twice as fast). One owner per listener.
4. **Passive wheel listener:** the first instinct (`onWheel` in JSX) can't call `preventDefault()`. The fix is a manually attached non-passive listener.
5. **`join-room` only on mount:** unrelated to the camera, but it shows up while testing: after a server restart, the reconnected socket joined no room, so nothing synced. Fix: emit `join-room` on every `connect` event.

---

## 11. Known limitations (say these before they ask)

- **Brush width is in world units,** so ink gets thicker when zoomed in. For a constant on-screen thickness use `brushSize / scale` when creating the stroke.
- **No viewport culling:** every stroke is drawn each frame, even off-screen. For thousands of strokes, store a bounding box per stroke and skip those outside the viewport.
- **Canvas size fixed at mount:** no window-resize handling, and no `devicePixelRatio` handling, so it looks soft on high-DPI screens.
- **Plain mouse wheel always zooms,** so a two-finger trackpad scroll zooms too. Figma-style alternative: wheel pans, Ctrl+wheel zooms.
- **`onCameraChange` puts the camera in the parent's React state,** which re-renders `Board` on every camera change. It's cheap here, but a throttle or a store would be better at scale.
- **Remote cursors lag slightly while you pan,** because of the 0.05s CSS transition in `LiveCursors`.
- **Zoom is clamped to 0.1x-10x.** "Infinite" is really bounded by this clamp and by float precision (which is vast for a whiteboard).
- **Camera isn't persisted or shared.** Refreshing resets the view, and there's no "follow another user" feature.
- **Mac trackpad Ctrl+click** sends a left-button event with `ctrlKey`, so it draws instead of panning unless handled.

## 12. Future improvements

Viewport culling · `devicePixelRatio` sharpness · window resize handling · Figma-style wheel behavior · pinch and two-finger touch gestures · fit-to-content button · mini-map · follow-mode (sharing a camera on request) · constant on-screen brush width option · scale-aware hit-testing for erase-by-stroke (tolerance `~6 / scale`).

---

## 13. How to test

1. **Regression:** at camera (0, 0), scale 1 nothing should look different from before.
2. **Zoom:** scroll over a stroke; the point under the cursor stays still while the board zooms.
3. **Pan:** Space + left drag, and right-click drag, both move the board; right-click doesn't open the context menu on the canvas.
4. **Draw after moving the camera:** strokes land exactly under the pointer.
5. **Two tabs, different zoom levels:** the same strokes appear in both, in matching places.
6. **Remote cursor:** each tab shows the other's cursor over the correct spot.
7. **Undo/redo and late join:** both still work; a third tab joining late shows the full board.
8. **Reset view:** snaps back to the start view.

---

## 14. Likely interview questions, with answers

**Q: Explain screen space vs. world space.**
Screen space is pixels on the canvas element, which is where the pointer lives. World space is where strokes are stored. The camera (x, y, scale) maps between them. I store only world coordinates, so panning and zooming never modify data.

**Q: What's the formula?**
`screen = world * scale + camera` and its inverse `world = (screen - camera) / scale`.

**Q: How does zoom-to-cursor work?**
Find the world point under the cursor before zooming, change the scale, then solve for the camera offset that keeps that world point under the cursor: `camera = cursor - world * newScale`.

**Q: Why not just call `ctx.scale()` each time?**
Because scaling alone zooms toward the origin, and I also need the camera numbers to convert pointer input and to place remote cursors. Keeping an explicit camera gives me both directions of the conversion.

**Q: Why is the camera in a ref?**
Pan and zoom events fire many times per second, and nothing in the JSX depends on the camera, so state would only cause useless re-renders.

**Q: Why did you attach the wheel listener manually?**
React registers wheel handlers as passive, so `preventDefault()` has no effect and the browser would scroll or zoom the page. A native listener with `{ passive: false }` can prevent that.

**Q: Is the camera shared between users?**
No. Strokes and cursors are shared in world coordinates, and each client converts with its own camera. That's why users can have different views of one board.

**Q: Did the server or database change?**
No. Strokes were already plain coordinate data. Old strokes are just world coordinates seen through an identity camera.

**Q: Why do you divide the prefilter and the Douglas-Peucker tolerance by the scale?**
Those thresholds are meant to be about one screen pixel, but the data is in world units. One screen pixel is `1 / scale` world units.

**Q: How would remote cursors work with different cameras?**
Each client sends its cursor in world coordinates. Each receiver converts to screen with its own camera, so the cursor lands over the right content for every viewer.

**Q: What happens to line width when zooming?**
It's stored in world units, so it scales with the content. For constant screen thickness, divide the brush size by the scale when creating a stroke.

**Q: How would you handle thousands of strokes?**
Viewport culling: store a bounding box per stroke, convert the viewport to world coordinates, and draw only strokes whose boxes intersect it. Possibly cache static strokes to an offscreen canvas.

**Q: How would you make it sharp on high-DPI displays?**
Size the canvas backing store by `devicePixelRatio`, keep the CSS size the same, and fold the ratio into `setTransform`.

**Q: Why clamp the zoom?**
At extreme scales, floating-point precision gets poor, strokes become invisible or huge, and the user can get lost. A clamp, plus a reset-view button, keeps the app usable.

**Q: What bug did you hit?**
A stray line in `handlePointerUp` (`points: simplify(...)` pasted as a statement instead of replacing the property) was parsed as a JavaScript label, so there was no error and the zoom-aware epsilon silently never applied. I'd now enable `no-unused-labels` in ESLint.

**Q: What would you improve next?**
Viewport culling, DPR support, window-resize handling, and Figma-style input handling (wheel pans, Ctrl+wheel zooms).
