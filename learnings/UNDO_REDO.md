# Undo / Redo in the Collaborative Whiteboard

How per-user undo and redo works on top of the object-based, server-authoritative architecture, why it was designed this way, and how to explain it in an interview.

**Stack:** React (`Canvas.jsx`) · Socket.IO (`drawHandler.js`) · RAM Map + MongoDB (`roomStore.js`)

---

## 1. The 30-second pitch

> "Undo is per-user. Each client keeps an undo stack of the ids of its own strokes and a redo stack holding the full stroke objects it has undone. Undo removes the stroke locally, pushes it to the redo stack and emits `stroke:remove`. The server is authoritative, so it checks that the requester owns that stroke, deletes it from the room's RAM array and broadcasts the removal. Redo pops the stroke back, re-adds it locally and re-emits the existing `stroke:end`. Drawing a new stroke clears the redo stack. It's cheap only because strokes are objects with ids, which wasn't possible when we painted pixels."

---

## 2. Why this was possible at all

The earlier rewrite turned strokes into data: `{ id, userId, color, width, points }`. Undo needs to answer "which thing do I remove?" With pixels or an anonymous list of points there is no answer. With stroke ids there is. Undo and redo are a direct payoff of the retained-mode design.

---

## 3. The core idea

Undo cannot mean "destroy the stroke", because redo needs it back. So we keep two structures:

| Structure | Holds | Purpose |
|---|---|---|
| `strokes` (Map) | Strokes currently visible | What gets drawn |
| `undoStack` | **Ids** of my strokes, in drawing order | Tells undo which stroke is mine and latest |
| `redoStack` | **Full stroke objects** I undid | The only place the data survives after removal |

**Why full objects in the redo stack, not ids?** Once a stroke is deleted from `strokes`, nothing else holds its `points`, `color` and `width`. If the redo stack stored only the id, redo would have nothing to restore.

**Why only ids in the undo stack?** The stroke is still in `strokes`, so the id is enough to find it.

---

## 4. Three design rules

### Rule 1: Undo is per-user, not global
If Ali presses Ctrl+Z, it must remove **Ali's last stroke**, not whatever stroke anyone drew last. Otherwise people erase each other's work. That is why each stroke carries a `userId`, and why each client keeps its own stacks.

### Rule 2: A new action clears the redo stack
If you undo twice and then draw something new, the redo history is discarded. Redoing afterwards would create a board state that never existed. Word, Figma and Photoshop all behave this way.

### Rule 3: The server is authoritative
Undo is not a local-only change. The server owns the truth, so removal is an event the server validates and broadcasts. Otherwise a late joiner would receive the stroke from the server's array and see something the other users had removed.

---

## 5. Flow, step by step

### Undo (Ctrl+Z or Undo button)
1. Client pops the last id from `undoStack`. If the stroke is no longer in `strokes` (for example, the board was cleared), skip it and pop again.
2. Client deletes the stroke from `strokes`, pushes the **full object** onto `redoStack`, and redraws.
3. Client emits `stroke:remove { id }`.
4. Server checks the requester owns that id, removes it from `activeRoomsData[roomId]`, marks the room dirty, and broadcasts `stroke:remove` to the other sockets.
5. Peers delete that id from `strokes` (and from `peerPreviews`, in case it was mid-preview) and redraw.

### Redo (Ctrl+Shift+Z, Ctrl+Y or Redo button)
1. Client pops a stroke from `redoStack`.
2. Client puts it back in `strokes`, pushes its id onto `undoStack`, and redraws.
3. Client emits the **existing** `stroke:end`. No new event is needed. The server and peers already know how to add a finished stroke.

### Drawing a new stroke
On pointer-up, the stroke's id is pushed to `undoStack` and `redoStack` is emptied.

### Clearing the board
`clear-board` empties both stacks on every client, because the strokes they refer to no longer exist.

---

## 6. Events

| Event | Direction | Purpose |
|---|---|---|
| `stroke:remove { id }` | client → server → others | Undo. **New** |
| `stroke:end` | client → server → others | Redo reuses it. **Changed** on the server: ignores duplicate ids |
| `clear-board` | client → server → everyone | Now also resets undo/redo stacks on clients |

---

## 7. What changed in the code

### `Canvas.jsx`
- Two refs **inside the component**: `undoStackRef`, `redoStackRef`.
- `undo()` and `redo()` functions (inside the component, after `scheduleRedraw`).
- A `useEffect` registering a `keydown` listener: Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl/Cmd+Y, with `preventDefault()` so the browser doesn't also undo.
- `undo` and `redo` exposed through `useImperativeHandle`, so `Board.jsx` buttons can call them.
- Socket: new `handleRemove`; `handleClear` also resets both stacks; `stroke:remove` registered and cleaned up.
- `handlePointerUp`: push id to `undoStack`, empty `redoStack`.

### `socket/drawHandler.js`
- `stroke:end`: ignore an id that already exists in the room (prevents duplicates), and record the id in `socket.data.ownIds`.
- New `stroke:remove` handler: validates the payload, checks ownership via `ownIds`, splices the stroke from RAM, marks dirty, broadcasts.

### `Board.jsx`
- Undo and Redo buttons calling `canvasRef.current?.undo()` and `.redo()`.

---

## 8. Design decisions and the reasoning

| Decision | Why |
|---|---|
| Per-user stacks | Shared board; avoid erasing others' work |
| Redo stack stores full objects | The data is gone from `strokes` after undo |
| Redo reuses `stroke:end` | Fewer events and less code; server and peers already handle it |
| Undo is a server event | Server is the single source of truth; late joiners stay consistent |
| Ownership check on the server | Never trust the client; stops anyone deleting anyone's strokes |
| Duplicate-id check on `stroke:end` | A repeated redo can't insert the same stroke twice |
| New stroke clears redo | Prevents impossible board states |
| Redo stack kept on the client | Simplest; losing it on refresh matches most apps |
| Undo loop skips missing ids | Handles strokes already gone after a clear |

---

## 9. Alternatives considered

**Soft delete (`deleted: true` flag).** Mark the stroke as deleted instead of moving it to a stack. Draw code skips deleted strokes; undo and redo flip the flag.
- Pros: keeps the original layer position, keeps a history.
- Cons: data keeps growing, every draw and flush must filter, and the stored board is no longer clean.
- Chosen: the stack approach, because it is simpler and keeps storage clean.

**Redo stack on the server, per user.** More robust across refreshes, but adds state and complexity for little gain.

**Global undo (last stroke by anyone).** Simple, but users would undo each other's work. Rejected.

---

## 10. Behaviors worth knowing

- **The eraser is undoable with no extra code.** It is a white stroke, which is a stroke object like any other. Undoing it removes the white stroke and the strokes underneath reappear, since they were only painted over, never deleted. (A separate limitation: the white eraser *adds* data instead of removing it. Erase-by-stroke using `stroke:remove` would fix that.)
- **Layer order on redo.** A redone stroke is re-inserted at the end of the Map (and pushed to the end of the server array), so it draws on top. If you undo a stroke that was underneath others, then redo it, it comes back on top. Client and server agree on this order, so late joiners see the same result.
- **Redo uses `Map.set` on a deleted key,** so it is appended at the end, as above.

---

## 11. Bugs we hit while implementing (good stories for interviews)

### Bug 1: `useRef` at module scope -> blank page
The two refs were pasted outside the `Canvas` component, at the top of the file. React hooks may only be called inside a component or custom hook, so React threw `Invalid hook call` and the whole page went blank.
- **Fix:** move the refs (and `undo`, `redo`, and the keyboard `useEffect`) **inside** the component.
- **Lesson:** module scope is for constants and plain helpers; hooks live inside components.

### Bug 2: Strokes not appearing in the other tab
Editing server files restarts the server (nodemon). Open tabs reconnect automatically, but `join-room` was emitted only once, on mount. The new connection joined no room, so `socket.data.roomId` was `undefined` and the server silently ignored every event.
- **Fix:** emit `join-room` on every `connect` event, not just once:
  ```jsx
  const join = () => socket.emit('join-room', roomId);
  socket.on('connect', join);
  if (socket.connected) join();
  // cleanup: socket.off('connect', join);
  ```
- A related cause to rule out: if `socket.on('stroke:remove', handleRemove)` is placed above the `const handleRemove` definition, the effect throws before `join-room` runs.
- **Debug technique:** log `socket.data.roomId` at the top of the handler. `undefined` means the socket never joined a room.

---

## 12. Known limitations (say these before they ask)

- **Ownership is tracked per socket (`socket.data.ownIds`), not per user.** If a connection drops and reconnects, the user can no longer undo strokes drawn before the reconnect: the client removes the stroke locally but the server ignores the request, so tabs can disagree. Fix: identify users by a verified `userId` (JWT on the socket handshake), and check `stroke.userId === socket.data.userId`.
- **Redo stack is lost on refresh or disconnect.** Acceptable, and common.
- **Redone strokes return on top,** not at their original layer position.
- **Memory growth:** `ownIds` and the undo stack grow with every stroke; a history cap (for example 100 steps) would bound them.
- **Keyboard shortcuts are global** (`window` listener). They would also fire while typing in a text field if one is added later; guard on `e.target` if so.
- **No undo of `clear-board`.** Clearing wipes everyone's stacks.
- **Concurrent edge cases:** two users undoing and redoing at the same moment are handled by the server's order of arrival; last event wins.

## 13. Future improvements

JWT socket authentication and user-based ownership · history cap · undo for clear-board · erase-by-stroke · preserving layer position on redo (store the original index in the stack) · a `reconnect` resync that re-fetches the board.

---

## 14. How to test

1. Two tabs, same room, both draw.
2. Ctrl+Z in tab A: only A's last stroke disappears, in both tabs.
3. Ctrl+Shift+Z in tab A: it reappears in both tabs.
4. Undo twice, draw something new: Redo does nothing (redo stack cleared).
5. Draw, erase with the white eraser, Ctrl+Z: the original stroke is visible again.
6. Tab B presses Ctrl+Z: removes only B's stroke, never A's.
7. Open a third tab late after some undos: it shows the correct current board (server's array is authoritative).
8. Close all tabs and reopen: the board restored from MongoDB reflects the undos.

---

## 15. Likely interview questions, with answers

**Q: How does your undo work?**
Per-user stacks. An undo stack of my stroke ids and a redo stack of full stroke objects. Undo removes locally, moves the stroke to the redo stack and emits `stroke:remove`; the server validates ownership, deletes from its RAM array and broadcasts.

**Q: Why per-user and not global?**
It's a shared board. Global undo would let one user erase another's work.

**Q: Why store full objects in the redo stack but only ids in the undo stack?**
After undo, the stroke no longer exists anywhere else, so redo needs the full data. Before undo, the stroke is still in the Map, so an id is enough.

**Q: Why does drawing a new stroke clear the redo stack?**
Otherwise redo could produce a board state that never existed. That's the standard behavior in editors.

**Q: Why not just delete the stroke?**
Redo would be impossible. Either keep it in a stack (my choice) or soft-delete with a flag.

**Q: Soft delete vs. stack?**
Soft delete keeps layer position and history, but storage grows and every draw/flush must filter. The stack keeps the stored board clean and is simpler.

**Q: Why does redo reuse `stroke:end`?**
From the server's point of view, redo is just adding a finished stroke. Reusing the event meant no new server code beyond a duplicate-id guard.

**Q: Why is undo a server event? Couldn't each client just hide the stroke?**
The server is the source of truth. Late joiners get the server's array, and the database is flushed from it. A local-only undo would make clients and server disagree.

**Q: How do you stop one user from deleting another user's strokes?**
The server tracks which stroke ids each socket created and rejects `stroke:remove` for ids it doesn't own.

**Q: What's the weakness of that ownership check?**
It's per socket, so a reconnect loses ownership of earlier strokes. The proper fix is verified user identity from JWT auth, checking `stroke.userId`.

**Q: What if two users undo at the same time?**
The server processes events in arrival order. Removing an id that is already gone is a no-op (`findIndex` returns -1), so it's safe.

**Q: Is the eraser undoable?**
Yes, with no special code: it's a white stroke with an id. Undo removes the white stroke and the covered strokes reappear. The separate limitation is that it adds data rather than removing it; erase-by-stroke would fix that.

**Q: What happens to undo when someone clears the board?**
`clear-board` resets every client's stacks, because the ids they hold no longer exist. The undo loop also skips ids missing from the Map as a safeguard.

**Q: What bug did you hit?**
Hooks declared at module scope caused `Invalid hook call` and a blank page. Another time, strokes didn't sync because `join-room` ran only on mount and a server restart left the reconnected socket in no room. I fixed it by joining on every `connect` event.

**Q: How would you scale this?**
Same as the rest of the app: move room state to Redis, use the Socket.IO Redis adapter with sticky sessions, and keep ownership by `userId` rather than per-socket memory.

**Q: What would you improve next?**
Authenticated user-based ownership, a history cap, preserving layer position on redo, and erase-by-stroke.
