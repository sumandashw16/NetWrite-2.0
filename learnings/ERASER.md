# Object Eraser

How the eraser was changed from "white paint" into a real object destroyer on top of the object-based, server-authoritative whiteboard: the problem, the design, the code, the bugs and trade-offs, and how to explain all of it in an interview.

**Stack:** React (`Canvas.jsx`, `Board.jsx`) · Socket.IO (`drawHandler.js`) · RAM Map + MongoDB (`roomStore.js`)

---

## 1. The 30-second pitch

> "The original eraser painted white strokes over existing ones. That kept the erased data forever and made the board bigger every time someone erased. Since strokes are objects, I changed the eraser into an object destroyer: as the pointer moves, I hit-test the strokes under it with a two-phase check, a bounding-box broad phase and then distance-to-polyline, and delete any that are hit. The client removes them locally and emits `stroke:delete`. The server, being authoritative, splices them out of the room's RAM array, marks the room dirty so MongoDB drops them at the next flush, and broadcasts the deletion to peers."

---

## 2. The problem with the white eraser

| | White-paint eraser (before) | Object eraser (after) |
|---|---|---|
| What an erase does | **Adds** a new white stroke on top | **Deletes** existing stroke objects |
| Stored data | Grows with every erase; "erased" content stays in RAM and MongoDB | Shrinks; deleted strokes disappear from RAM and MongoDB |
| Redraw cost | Grows (more strokes to draw) | Falls |
| Background color | Hardcoded white; breaks with any other canvas color | Independent of background |
| Correctness | Visually erased, but still there (select, move, hit-test still find it underneath) | Truly gone |
| Needs the tool to know about strokes? | No (it's just a color) | Yes (hit-testing), which our object model makes possible |

This was the limitation listed in the earlier READMEs ("the eraser adds data instead of removing it"). This feature is that fix.

---

## 3. How it works, step by step

### Client
1. The user selects the **Eraser** tool (toolbar button or the `E` key).
2. **Pointer down:** convert the pointer to world coordinates and call `eraseAt(wx, wy)`.
3. **Pointer move (while the button is held):** sample points along the path from the last position to the current one, calling `eraseAt` at each sample.
4. `eraseAt` runs `hitTestStrokes` in a loop. For each hit stroke it:
   - deletes it from `strokesRef.current`,
   - emits `stroke:delete { roomId, id }`.
5. If anything was deleted, prune the selection and call `scheduleRedraw()`.
6. **Pointer up:** clear the eraser state. **No stroke object is ever created.**

### Server
1. `stroke:delete` arrives. The room comes from `socket.data.roomId` (trusted), not from the payload.
2. Find the stroke in `activeRoomsData.get(roomId)` by id and `splice` it out. If it isn't there, ignore the event.
3. `markDirty(roomId)` so the next flush persists it.
4. `socket.to(roomId).emit('stroke:delete', { id })`.

### Peers
They receive `stroke:delete` and run the same handler as `stroke:remove`: delete from `strokes` and `peerPreviews`, prune selection, redraw.

### Persistence
`flushRoom` writes `{ $set: { strokes } }`, which **replaces the whole array**. So a deleted stroke vanishes from MongoDB on the next flush (when the room empties, or at the 30s autosave). The `Board` schema needed no change.

---

## 4. Hit detection (reused, not rewritten)

The select tool already had `hitTestStrokes`. The eraser calls the same function, so there is one hit-testing implementation to maintain.

For each stroke, from topmost to bottommost:

1. **Inverse transform:** map the world point into the stroke's local space (`worldToLocal`). This is what makes it correct for strokes that have been moved, and later scaled or rotated.
2. **Hit radius:** `width / 2 + tolerance / minScale`. The tolerance is given in world units as `ERASER_RADIUS_PX / cameraScale`, so the eraser's reach is always about 8 **screen** pixels, at any zoom.
3. **Broad phase:** is the point inside the stroke's bounding box expanded by the hit radius? Most strokes fail here and cost almost nothing. (Bounding boxes are cached per finalized stroke in a `WeakMap` keyed by the points array.)
4. **Narrow phase:** distance from the point to every segment of the polyline, using `sqSegDist`, compared against `hitRadius²`. Squared distances avoid `Math.sqrt`. A single-point stroke (a dot) is a point-distance check.

Why two phases? Checking every segment of every stroke on every pointer move would be expensive. The bounding-box check eliminates nearly all strokes cheaply.

---

## 5. Details that make it feel right

### Path sampling (fast drags don't skip strokes)
Pointer events arrive at discrete positions. If you drag quickly, the pointer can jump several pixels between events and jump right over a thin stroke. So on each move, the eraser interpolates from the last position to the new one in steps of one eraser radius and tests each step:

```js
const step = ERASER_RADIUS_PX / scale;
const n = Math.max(1, Math.ceil(Math.hypot(x - lx, y - ly) / step));
for (let i = 1; i <= n; i++) eraseAt(lerp(...));
```

### The `while` loop in `eraseAt`
`hitTestStrokes` returns only the topmost hit. Strokes overlap, so `eraseAt` keeps calling it, deleting each hit stroke, until nothing is left under the eraser. Deleting as it goes means the next call can't return the same stroke.

### Local first, then emit
The client deletes immediately and redraws, so erasing feels instant. The network event follows. The server's result is the same, so no rollback logic is needed.

### Tool state
`setTool` accepts `'eraser'`, resets the eraser state, and clears the selection when you leave the Select tool (selected strokes could otherwise be erased out from under the selection box). Panning (right-click or Space) is checked before tool logic, so you can still pan while the eraser is active.

---

## 6. Events

| Event | Direction | Purpose |
|---|---|---|
| `stroke:delete { roomId, id }` | client -> server | Erase one stroke. The server uses its own `socket.data.roomId`, so the payload `roomId` is ignored |
| `stroke:delete { id }` | server -> others | Remove it from peers' boards |

`stroke:remove` (undo) is unchanged.

---

## 7. What changed in the code

### `Canvas.jsx`
| Area | Change |
|---|---|
| Constant | `ERASER_RADIUS_PX = 8` |
| Ref | `eraserRef` (last eraser position in world coordinates while the button is down) |
| `eraseAt(wx, wy)` | New helper: loop of hit-test, delete, emit; prune selection; redraw |
| `setTool` | Accepts `'eraser'`; resets `eraserRef`; clears selection when leaving Select |
| Keyboard | `E` switches to the eraser |
| `handlePointerDown` | Eraser branch: set `eraserRef`, call `eraseAt`, return (before the pen code) |
| `handlePointerMove` | Eraser branch: interpolate along the path, call `eraseAt` at each sample |
| `handlePointerUp` | Clear `eraserRef` |
| Sockets | `socket.on('stroke:delete', handleRemove)` plus the matching `off` |
| Canvas `className` | `cursor-cell` for the eraser |

### `socket/drawHandler.js`
- New `stroke:delete` handler: validate, find by id, `splice`, `markDirty`, broadcast.

### `Board.jsx`
- The Eraser button no longer calls `setColor('#ffffff')`. It uses `toolBtn('eraser', 'Eraser')`, so it gets the same active-state highlight as Pen and Select.

### Unchanged
`models/Board.js`, `roomStore.js`, `server.js`, `hitTestStrokes`, `sqSegDist`, and the pen pipeline.

---

## 8. Design decisions and the reasoning

| Decision | Why |
|---|---|
| Delete whole objects, not pixels | We're an object model; the data should shrink, and erased things should be truly gone |
| Reuse `hitTestStrokes` | One tested implementation shared by select and erase; transform-aware for free |
| Two-phase hit test (box, then polyline) | Cheap rejection for nearly all strokes; the expensive check runs only on candidates |
| Tolerance in screen pixels (`/ scale`) | The eraser feels the same at every zoom level |
| Path interpolation | Fast drags would otherwise skip over thin strokes |
| Loop until nothing is hit | Overlapping strokes under one eraser position all get erased |
| Separate `stroke:delete` event instead of reusing `stroke:remove` | `stroke:remove` is for undo and checks ownership (you can only undo your own strokes). Erasing any stroke is a different permission, so it gets its own handler |
| Server trusts `socket.data.roomId`, not the payload | A client must not be able to delete from a room it hasn't joined |
| Idempotent server delete | If two users erase the same stroke simultaneously, the second finds nothing and is ignored: no error, no duplicate broadcast |
| Client reuses `handleRemove` for peers | Deleting a stroke by id is the same operation whether it came from undo or the eraser |
| `markDirty` instead of an immediate DB write | Same persistence path as everything else (flush on empty, 30s autosave); keeps writes batched |
| Delete locally first, then emit | Instant feedback; the server's outcome is identical |

---

## 9. Edge cases handled

1. **Two users erase the same stroke at once:** the second `stroke:delete` finds no match and returns silently.
2. **Fast drag over a thin line:** path sampling catches it.
3. **Overlapping strokes:** the `while` loop erases all of them.
4. **Zoomed in or out:** the tolerance is converted from screen pixels, so reach stays about 8px.
5. **Moved (transformed) strokes:** hit-testing inverse-transforms the pointer into stroke space first.
6. **Erasing a selected stroke:** `pruneSelection()` drops the id from the selection.
7. **Erasing your own stroke, then pressing Undo:** the undo stack still holds that id, but `undo()` skips ids no longer in `strokes` and moves on to the previous stroke.
8. **Peer's stroke already finalized vs. still previewing:** previews aren't in `strokes`, so only finalized strokes can be erased. `handleRemove` also deletes a matching preview id, which is harmless.
9. **Panning while the eraser is active:** pan is checked first in `handlePointerDown`, so right-click and Space still pan.
10. **Persistence:** the whole-array `$set` means deletions are saved with no special code.

---

## 10. Known limitations (say these before they ask)

- **Erasing is not undoable yet.** Ctrl+Z only undoes strokes you drew. To make erases undoable, switch from per-stroke stacks to an **action history**, where each entry is something like `{ type: 'draw' | 'erase' | 'move', ...payload }`. Undoing an erase would re-emit the deleted stroke objects with `stroke:end`. (This replaces the earlier note that the white eraser was undoable: that was true of the old design, but that design had the data-growth problem this feature fixes.)
- **Anyone can erase anyone's strokes.** That is the usual whiteboard behavior and what was specified. There is no ownership check on `stroke:delete`, unlike `stroke:remove`. A per-user lock would need verified user identity (the socket-auth improvement already on the list).
- **Whole-object erase only.** Touching any part of a stroke deletes the entire stroke. Partial erase (cutting a stroke into two) means splitting the polyline into new stroke objects, which is a larger feature.
- **One event per deleted stroke.** A big sweep sends many small `stroke:delete` events. Fine at this scale; they could be batched as `{ ids: [...] }` once per frame.
- **Hit-testing uses the raw polyline,** not the smoothed Bezier curve that is drawn, so it can differ from the visible line by a pixel or two. The 8px tolerance hides this.
- **No visible eraser ring.** Only the cursor changes to `cell`. A circle showing the actual reach is a nice later touch.
- **Linear scan over all strokes** per sample. The bounding-box phase makes it cheap, but thousands of strokes would benefit from a spatial index (grid or R-tree).
- **Deleted strokes aren't recoverable** once the room's flush has happened (there's no soft-delete or history).

## 11. Future improvements

Action-history undo (draw, erase, move) · partial erase (split polylines) · batched `stroke:delete` · eraser ring preview · spatial index (uniform grid) for hit-testing · optional ownership rules · soft-delete with recovery.

---

## 12. How to test

1. Draw several strokes and select the Eraser: the button gets the active border, and the cursor becomes `cell`.
2. Drag across strokes: they vanish and **no new strokes appear** (check `/debug/rooms` stroke counts, or the server logs).
3. Drag **fast** across a thin line: it still gets deleted.
4. Overlap two strokes and erase at the crossing: both are deleted.
5. Zoom in and out: the eraser's reach stays about 8 screen pixels.
6. Two tabs: erased strokes disappear live in the other tab.
7. Close all tabs and reopen the room: the erased strokes stay gone (MongoDB persisted the deletion).
8. Press `P`, `V` and `E`: the toolbar highlight follows, and the pen still draws normally in its chosen color.
9. Erase one of your own strokes, then press Ctrl+Z: nothing breaks, and the previous stroke you drew is undone instead.
10. Hold Space or right-click while on the eraser: the board pans without erasing.

---

## 13. Likely interview questions, with answers

**Q: What was wrong with the old eraser?**
It painted white strokes over existing content. That added data instead of removing it: storage and redraw cost grew, "erased" strokes were still in RAM and the database, and it only worked on a white background.

**Q: How does the new eraser work?**
It hit-tests strokes under the pointer, deletes them from the local Map, and emits `stroke:delete`. The server splices the stroke from its authoritative array, marks the room dirty and broadcasts the deletion.

**Q: How do you detect that the eraser touches a stroke?**
Two phases. First a cheap bounding-box check with the hit radius added. Then, for the stroke's that pass, the distance from the point to each polyline segment using `sqSegDist`, compared against the squared radius. The stroke's transform is inverted first, so moved strokes work.

**Q: Why squared distances?**
They avoid a `Math.sqrt` per segment, which matters when you test many segments on every pointer move.

**Q: How do you keep the eraser consistent across zoom levels?**
The tolerance is specified in screen pixels and divided by the camera scale to get world units, so the reach is always about 8 screen pixels.

**Q: What if the user drags the eraser very fast?**
I interpolate between the previous and current pointer positions in steps of one eraser radius and test each one, so thin strokes aren't skipped.

**Q: Why a separate `stroke:delete` instead of `stroke:remove`?**
Different permission rules. `stroke:remove` is undo, so it's restricted to your own strokes. The eraser can delete anyone's strokes, so it has its own handler without the ownership check. The client handling of the broadcast is identical, so it reuses one function.

**Q: What if two people erase the same stroke at the same time?**
The server delete is idempotent: the second request finds no matching id and returns without error or broadcast.

**Q: How is the deletion persisted?**
`markDirty` flags the room, and `flushRoom` writes the entire strokes array with `$set`, so deleted strokes disappear from MongoDB at the next flush.

**Q: Why trust `socket.data.roomId` instead of the roomId in the payload?**
Because a client could send any room id. The server records the room at `join-room` and uses that, so a client can only affect the room it actually joined.

**Q: Is erasing undoable?**
Not yet. Undo currently works per drawn stroke. Making erases undoable needs an action history with typed entries (draw, erase, move), so that undoing an erase re-adds the deleted strokes.

**Q: Why not erase pixels like a normal paint program?**
This app stores objects, not pixels. Pixel erasing would mean modifying stroke geometry or going back to painting white. Whole-object erase keeps data small and exact, and partial erase can be added later by splitting polylines.

**Q: How would you handle thousands of strokes?**
Add a spatial index such as a uniform grid or R-tree, so a hit test only checks strokes near the pointer, and batch `stroke:delete` ids per frame.

**Q: What would you improve next?**
Action-history undo for erase and move, partial erase, an eraser-size ring and slider, and batched delete events.
