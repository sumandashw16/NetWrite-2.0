# Real-Time Collaborative Whiteboard

A multi-user whiteboard where people in the same room draw together and see each other's strokes live.

**Stack:** React (Vite) · Socket.IO · Node/Express (ES modules) · MongoDB Atlas (Mongoose)

---

## 1. The 30-second pitch (memorize this)

> "It's a real-time collaborative whiteboard. I originally built it as a dumb relay: every mouse move painted pixels and was forwarded as a raw coordinate. I re-architected it into a **retained-mode, object-based system with an authoritative server**. Strokes are now data objects, simplified with Douglas-Peucker and rendered with quadratic curves. The server keeps active rooms in RAM, streams disposable live previews, stores only finalized strokes, and flushes to MongoDB when a room empties. Result: less bandwidth, smoother lines, late joiners get the full board instantly, and the design supports undo, per-stroke erase and replay later."

---

## 2. Before vs. After

| | Before (immediate mode) | After (retained mode) |
|---|---|---|
| Drawing | Paint pixels directly on every mouse move | Strokes are objects; canvas is a render of state |
| Network | One `draw` event per mouse move `{x, y, color, size, isStartingPoint}` | `stroke:preview` (throttled, disposable) + one `stroke:end` per stroke |
| Server | Dumb router (`draw` -> `receive-draw`) | Stateful, authoritative (RAM Map per active room) |
| Late joiner | Client fetched from REST on mount | Server pushes `canvas-catch-up` on `join-room` |
| Persistence | Client POSTed its own array | Server flushes its own copy when room empties + every 30s if changed |
| Input | `onMouse*` | `onPointer*` (mouse, touch, stylus) |
| Data stored | List of points with `isStartingPoint` flags | Stroke objects with a flat `points: [x0,y0,x1,y1,...]` array |
| Extensible? | No (only pixels / point soup) | Yes: strokes have IDs, so undo, erase-by-stroke, replay are possible |

**The key idea:** once you only have pixels, you cannot know *what* was drawn. Once you have stroke objects, you can reason about, modify, compress and replay them.

---

## 3. Architecture

```
 Client A (Canvas.jsx)             Server (Node + Socket.IO)               MongoDB
 ─────────────────────             ─────────────────────────               ───────
 pointer events
   │ 1px prefilter
   │ build currentStroke
   ├─ stroke:preview (40ms) ─────► relay only ──────────► Client B (peerPreviews)
   │                               (NOT stored)
   └─ pointer up:
      Douglas-Peucker + round
      stroke:end ──────────────► validate → push into
                                  activeRoomsData[roomId]  ── flush when room empties
                                  broadcast to others ───►  + autosave every 30s ──► Board doc
                                                                                    (strokes[])
 join-room ───────────────────► RAM hit? else load from Mongo
        ◄── canvas-catch-up ───  (only to the joining socket)
```

### Lifecycle of one stroke

1. **Pointer down:** generate `crypto.randomUUID()`, create `currentStroke = {id, userId, color, width, points:[x,y]}`.
2. **Pointer move:** drop the point if it is less than 1px from the last kept point (radial prefilter). Otherwise push `x, y`. Every ~40ms emit `stroke:preview` with the *entire stroke so far*. Schedule a redraw.
3. **Pointer up:** run iterative Douglas-Peucker, round to 1 decimal, add to local `strokes` Map, emit `stroke:end`.
4. **Server:** validate the stroke, push into the room's array in RAM, mark the room dirty, broadcast `stroke:end` to everyone else.
5. **Peers:** delete the preview with that `id` from `peerPreviews`, add the final stroke to `strokes`, redraw. The rough preview is replaced by the smooth final line.

---

## 4. Files and what each one does

| File | Role |
|---|---|
| `Canvas.jsx` | Pointer pipeline, stroke state, render loop, socket listeners |
| `Board.jsx` | Toolbar (color, size, eraser, save). **Unchanged.** |
| `socket/roomStore.js` (new) | The RAM Map, MongoDB cold-start loader, flush logic, autosave timer |
| `socket/drawHandler.js` | `stroke:preview`, `stroke:end`, `clear-board`, `disconnecting` handlers |
| `server.js` | `join-room` now loads the room and emits `canvas-catch-up`; debug route |
| `models/Board.js` | Typed `Stroke` sub-schema instead of `Array` |
| `routes/boardRoutes.js` | GET reads RAM if room is live; POST means "flush now" |

---

## 5. Frontend deep dive (`Canvas.jsx`)

### State lives in refs, not React state
`strokesRef` (Map of finalized strokes), `currentStrokeRef` (my active stroke), `peerPreviewsRef` (Map of other people's active strokes keyed by stroke id).

**Why refs?** Drawing is imperative. A pointer move can fire 100+ times per second, and `useState` would re-render the component each time for no visual benefit, since the canvas is drawn via the 2D context, not JSX.

### Render loop: `redrawAll()`
```
clearRect → draw all finalized strokes → draw peer previews → draw my current stroke
```
Order matters: finalized at the bottom, live previews on top.

### `scheduleRedraw()` (requestAnimationFrame coalescing)
Many events can arrive within one frame (pointer moves, incoming previews). Instead of redrawing for each one, I set a flag and redraw **once per animation frame**. This caps rendering at the display's refresh rate.

### The 1px radial prefilter
Drop a point if `dx² + dy² < 1`. Uses squared distance, so no `Math.sqrt`. Removes jitter and duplicates before they cost anything.

### Douglas-Peucker (line simplification)
Keep the first and last point. Find the point farthest from the line between them. If that distance is greater than epsilon (1.0px), keep it and recurse on both halves. Otherwise discard everything in between.

- **Iterative, not recursive:** I use an explicit stack, so a very long stroke cannot overflow the call stack.
- Works on the flat array using index math (`points[i*2]`, `points[i*2+1]`).
- Complexity: about O(n log n) average, O(n²) worst case. Fine because n is small after the prefilter.
- Epsilon is the tradeoff dial: higher = smaller data but more visible shape loss.

### Curve smoothing (`quadraticCurveTo` through midpoints)
Simplification leaves sparse, angular points. To smooth them: for each interior point, use that point as the **control point** and the **midpoint to the next point** as the curve's end. Consecutive curves share tangents at the midpoints, so the joins are seamless. The final segment is a straight line to the last point. Special cases: 1 point draws a dot (`arc`), 2 points draw a line.

### Pointer events
`onPointerDown/Move/Up` unify mouse, touch and pen. `setPointerCapture` keeps events flowing if the pointer leaves the canvas, which is why `onMouseLeave` is no longer needed. `onPointerCancel` ends the stroke cleanly (for example, a touch interrupted by the OS). `touch-none` in CSS stops the browser from scrolling during touch drawing.

### Peer previews and ghost-line prevention
- Each preview carries the stroke `id`. The receiver **overwrites** that id in `peerPreviews`.
- On `stroke:end`, the receiver **deletes** that id from `peerPreviews` and adds it to `strokes` in the same step, so no duplicate line is left behind.
- If a peer disconnects mid-stroke, the server emits `peer-left`, and the client removes any preview with that `socketId`.

### Listener order
Listeners are registered **before** emitting `join-room`, so the `canvas-catch-up` reply cannot arrive before anyone is listening.

---

## 6. Backend deep dive

### Authoritative RAM Map: `activeRoomsData`
`Map<roomId, Stroke[]>`. While a room has users, the server's array is the source of truth. A Map gives O(1) lookup by room.

### Socket events

| Event | Direction | What happens |
|---|---|---|
| `join-room` | client → server | Join socket room, load the room (RAM, else MongoDB, else empty), send `canvas-catch-up` to **that socket only** |
| `canvas-catch-up` | server → one client | Full stroke array |
| `stroke:preview` | client → server → others | Pure relay. **Never stored.** Server stamps `socketId` itself so clients can't spoof it |
| `stroke:end` | client → server → others | Validate, push to RAM, mark dirty, broadcast to others |
| `clear-board` | client → server → **everyone** | Empty the array, mark dirty, broadcast |
| `peer-left` | server → others | Clean up that peer's orphaned previews |
| `cursor-move` / `user-disconnected` | unchanged | Live cursors |

### Validation (`isValidStroke`)
Never trust client input: `id` must be a string, `points` an even-length array, every value a finite number, and a cap on total points. This protects RAM, the database and other clients.

### Cold storage: the flush / evict cycle
- **Dirty tracking:** `dirtyRooms` is a Set of rooms that changed since the last save.
- **Flush:** `findOneAndUpdate({roomId}, {$set:{strokes}}, {upsert:true})`.
- **Autosave:** every 30 seconds, flush all dirty rooms. This limits crash loss to about 30 seconds of work.
- **On last user leaving:** use the `disconnecting` event (not `disconnect`), because `socket.rooms` is still populated then. If the room size is 1 (this socket is the last), flush, **then** delete from RAM.
- **Eviction safety:** after the flush completes, re-check that the room is still empty before deleting, in case someone rejoined during the save.
- **On flush failure:** keep the room in RAM and keep it dirty, so the data is not lost and the next flush retries.

### Cold start and the double-load race
If a room is not in RAM, it is "asleep", not empty. Load from MongoDB. `loadingRooms` (a Map of in-flight Promises) makes simultaneous joins share **one** database read instead of each creating its own copy and overwriting each other.

### Legacy filter
Old-format documents (`x, y, isStartingPoint`) are filtered out on load, so they cannot crash the new renderer.

### REST routes
- `GET /api/boards/:roomId`: if the room is live, return RAM (fresher than MongoDB). Otherwise read MongoDB. It deliberately does not use `loadRoom`, which would put an unattended room into RAM with nothing to evict it.
- `POST /api/boards/:roomId`: now means **"save now"**. The request body is ignored. The server's copy is authoritative, so a stale client can no longer overwrite the board.

---

## 7. Database

```js
Stroke { id: String (required), userId: String, color: String, width: Number, points: [Number] }  // _id: false
Board  { roomId: String (required, unique), strokes: [Stroke], timestamps }
```

- `points` is a **flat number array**, which is compact and maps directly to the render code.
- `_id: false` on strokes because we already have our own UUID.
- One document per room. Limit is 16 MB per document. Simplification keeps strokes small, so this is far away for normal use. If needed later, move strokes to their own collection.

---

## 8. Design decisions and the reasoning (interviewers love "why")

| Decision | Why |
|---|---|
| Retained mode (objects) over pixels | Enables undo, per-stroke erase, replay; smaller storage; consistent state |
| Two-phase streaming (preview vs end) | Previews give live feel but are disposable; only finalized data is permanent and stored |
| Send full points array in preview | Curve math needs 3+ points; isolated deltas break smoothing on the receiver. Throttled to 40ms so cost is bounded |
| Prefilter, then Douglas-Peucker, then rounding | Three cheap stages cut data at different points: capture time, finalize time, serialization |
| Server authoritative | One source of truth, instant late-join catch-up, no client can overwrite the board |
| RAM + MongoDB (cache/cold storage pattern) | RAM is fast for active rooms; DB gives durability; evicting empty rooms prevents memory leaks |
| `disconnecting` not `disconnect` | Rooms are still readable, so we know which rooms to check |
| Refs not state | Avoid a re-render per pointer move |
| rAF coalescing | At most one redraw per frame |
| Pointer events | One code path for mouse, touch and pen |
| Server stamps `socketId` | Prevent spoofing |

---

## 9. Race conditions I handled

1. Two users join a cold room at the same time -> `loadingRooms` shares one load.
2. Someone rejoins while the last user's flush is in progress -> re-check room size before evicting.
3. Flush fails -> room stays in RAM and stays dirty.
4. Edit happens during a flush -> `dirtyRooms.delete` happens *before* the await, so any change during the save re-marks the room.
5. Peer disconnects mid-stroke -> `peer-left` removes the ghost preview.
6. Catch-up arrives before listeners exist -> listeners registered first.
7. Preview arrives after the stroke's final version -> ignored if `strokes` already has that id.

---

## 10. Known limitations (say these before they ask)

- **Single server instance:** the RAM Map lives in one process. To scale horizontally you need sticky sessions plus the Socket.IO Redis adapter and shared state (for example Redis) instead of an in-process Map.
- **Crash window:** up to 30s of unsaved strokes can be lost if the server crashes (autosave interval).
- **No socket authentication/authorization or rate limiting yet:** anyone who knows a room ID can join.
- **Eraser is a white stroke,** so it adds data instead of removing strokes. Proper fix: erase-by-stroke using stroke IDs (now possible).
- **No undo/redo UI yet** (the data model supports it).
- **`clear-board` has no button** in the UI yet.
- **Preview bandwidth** is O(n) per message, because the full array is sent. Bounded by the 40ms throttle and short pre-simplification strokes.
- **Fixed canvas size** set once at mount: no window-resize or high-DPI (devicePixelRatio) handling.
- **Concurrency on clear:** last event wins; a stroke in flight during a clear can reappear.
- **Old boards in the legacy format were dropped.** A migration script could convert them.
- **One document per room** has a 16 MB cap.

## 11. Future improvements

Undo/redo using stroke IDs and a per-user stack · erase-by-stroke · Redis adapter for multi-instance · socket auth with JWT · rate limiting · canvas resize and DPR handling · stroke replay/timelapse · move strokes to their own collection · optimistic UI conflict handling.

---

## 12. How to verify it works

1. Two tabs, same room: draw in one, see live preview in the other, replaced by the smooth line on release.
2. Third tab joins late: sees full board immediately (`canvas-catch-up`).
3. `GET /debug/rooms` (dev only): room listed while connected.
4. Close all tabs: server logs `evicted ... In RAM: 0`, `/debug/rooms` returns `[]`.
5. Reopen room: log shows `loaded ... (N strokes)`, drawing restored from MongoDB.
6. Crash test: draw, wait 30s, kill the server, restart, reopen: strokes from before the last autosave are back.

**To quantify the savings (do this before the interview):** log `stroke.points.length / 2` before and after `simplify()` for a few real strokes, and compare the JSON size of old-style per-point events against one `stroke:end` payload. Quote your own measured numbers instead of guessing.

---

## 13. Likely interview questions, with answers

**Q: Why did you rewrite it?**
The original painted pixels and relayed raw points, so the app couldn't know what had been drawn. That made late-join, undo, erase and compact storage hard. Stroke objects fix that.

**Q: Why send previews at all if only `stroke:end` is stored?**
Latency. Waiting for pointer-up would make collaboration feel laggy. Previews are disposable, so they cost no storage.

**Q: Why send the whole array in each preview instead of deltas?**
Quadratic smoothing needs at least three points of context. Deltas would also break if a packet were dropped or reordered. A full snapshot per id is idempotent: the receiver just overwrites.

**Q: Explain Douglas-Peucker.**
Recursively keep the point farthest from the segment between the endpoints if it's beyond epsilon; otherwise drop everything between. I implemented it iteratively with a stack to avoid recursion limits.

**Q: How does the smoothing work?**
Each remaining point becomes a quadratic Bezier control point, and the curve ends at the midpoint to the next point. Neighboring curves share tangent direction at the midpoints, so the path is continuous and smooth.

**Q: Why is the server authoritative?**
Single source of truth: late joiners get state instantly, and clients can't overwrite each other's work. It's also the foundation for validation and later auth.

**Q: What happens when the server restarts?**
RAM is lost, but rooms were flushed on empty and autosaved every 30s while dirty. On the next join the room is cold-loaded from MongoDB. Worst case is losing up to 30s of strokes.

**Q: How do you avoid a memory leak?**
Rooms are evicted from the Map when the last user leaves, after a successful flush.

**Q: Why `disconnecting` instead of `disconnect`?**
At `disconnect`, the socket has already left its rooms. `disconnecting` still exposes `socket.rooms`.

**Q: What if two people join an unloaded room at the same moment?**
`loadingRooms` stores the in-flight Promise so both await the same load. Without it, both would read the DB and the second `set` could clobber changes from the first.

**Q: How would you scale this?**
Move room state out of process (Redis), use the Socket.IO Redis adapter, add sticky sessions, and consider one writer per room (consistent hashing) so flushes don't conflict.

**Q: Security concerns?**
Currently: validated payload shape and size, server-stamped socketId. Missing: authentication on sockets, room authorization, rate limits. I'd add JWT handshake auth and per-socket event limits.

**Q: Why refs instead of state?**
No JSX depends on stroke data. State updates would re-render on every pointer move for no benefit.

**Q: How would you add undo?**
Keep a per-user stack of stroke IDs. Undo emits `stroke:remove {id}`; server removes from the array and broadcasts; clients delete the id and redraw. Redo re-adds the stored stroke. It's cheap because strokes have IDs.

**Q: What would you do differently?**
Add resize/DPR handling and erase-by-stroke earlier, and write a migration for old boards rather than dropping them.

---

## 14. Running locally

```bash
# server
cd server && npm install && npm run dev    # needs MONGODB_URI in .env, runs on :5000

# client
cd client && npm install && npm run dev    # Vite on :5173
```

Make sure the file is named `models/Board.js` (capital B), so the imports resolve on case-sensitive systems.
