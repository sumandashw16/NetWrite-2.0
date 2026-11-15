# Native Undo/Redo vs Yjs UndoManager

*NetWrite whiteboard · interview comparison · November 2026*

## 30-second summary

> "I first built undo/redo myself with two stacks: an undo stack of actions, and a redo stack. It worked for one user, but it saved absolute before/after values, so in a shared board an undo could overwrite a collaborator's concurrent change, and erasing couldn't be undone at all. After moving the state to a Yjs CRDT, I replaced it with `Y.UndoManager`, which tracks only the changes made by the local client and reverses exactly those, so it can't destroy other people's edits. It also made erasing undoable and removed about 70 lines of code. The cost was a few behaviors I had to design deliberately: gesture grouping, what Clear Board does, and a server-side validator change."

## 1. The two designs

### Native (hand-written stacks)

- Two refs: `undoStackRef` and `redoStackRef`.
- Entries were typed actions:
  - `{ type: 'draw', id }` for a drawn stroke (the redo entry held the full stroke object, because the data is gone after undo).
  - `{ type: 'transform', changes: [{ id, from, to }] }` for a move, scale or rotate, where `from` and `to` were snapshots of `x`, `y`, `scaleX`, `scaleY` and `rotation`.
- Undo popped an entry and **wrote the saved `from` values back**. Redo wrote the `to` values.
- Drawing a new stroke cleared the redo stack.
- About 70 lines: the stacks, `applyTransform`, `undo`, `redo`, and push logic in every gesture's `pointerup`.

### Yjs (`Y.UndoManager`)

- One manager, scoped to the `strokes` map only (not `meta`): `new Y.UndoManager(yStrokes, { captureTimeout: 1e9 })`.
- `undo()` and `redo()` are one-liners that call the manager.
- It tracks only transactions whose origin is the local client. Remote updates arrive with the network provider as origin, so they are ignored. That is what makes undo per-user.
- `captureTimeout` is set very large so nothing merges by time. We call `stopCapturing()` ourselves at the start of each gesture, so one drag, scale, rotate, eraser sweep or drawn stroke is exactly one undo step.
- About 15 lines in total.

## 2. Why we moved: the concrete failure

The native design restores **saved values**. Here is where it breaks on a shared board:

1. You start rotating a stroke. The entry saves `from: { x: 100, y: 50, rotation: 0 }`.
2. A peer drags that same stroke, so `x` becomes 400.
3. You press Ctrl+Z. The native undo writes `x: 100` back, **erasing the peer's move**.

`Y.UndoManager` records which Yjs items *you* created and reverses only those. A concurrent change from someone else is left alone. The design question it answers is "undo *my* action", not "restore a snapshot".

## 3. Side-by-side comparison

|  | Native stacks | `Y.UndoManager` |
| --- | --- | --- |
| Solo drawing, moving, rotating | Works | Same |
| Concurrent edit to the same stroke | Undo can overwrite a peer's change | Protected: only your own operations are reversed |
| Undo of an erase | Not supported | Supported (the deleted stroke comes back) |
| Gesture grouping | Manual: one entry pushed at each `pointerup` | Time-based by default; we override it with `stopCapturing()` at gesture boundaries |
| Eraser sweep as one step | Not applicable | Works with the same grouping |
| Per-user isolation | By construction (each client's own stacks) | By origin tracking (local transactions only) |
| Clear Board | History wiped | Would be undoable by default, so we deliberately wipe it |
| Redo after a new action | Cleared manually | Handled by the manager |
| Undo history after refresh | Lost | Lost (in memory only) |
| Code to maintain | About 70 lines, easy to get wrong | About 15 lines |
| Dependency | None | None extra (part of `yjs`) |
| Network traffic for undo | Writes absolute values through Yjs | Writes only the reversal as normal Yjs updates |

## 4. What actually got better

1. **Correctness under concurrency.** Undo no longer clobbers a collaborator's edit. This is the main reason to switch, and it is easy to demonstrate in two tabs.
2. **Undoable erase.** An accidental erase used to be permanent. Now Ctrl+Z restores the stroke, and a whole eraser sweep returns in one step.
3. **Less code.** The removed code (`applyTransform`, both stacks, and the push logic in four `pointerup` branches) was where edge-case bugs lived.
4. **A consistent model.** Everything about shared state now goes through one mechanism instead of Yjs for data and a separate hand-made system for history.

For a single user drawing alone, the visible behavior is almost the same. The gains show up with collaboration and with erasing.

## 5. What it costs (be honest about this)

- **Grouping needs deliberate handling.** By default the manager merges changes within 500 ms, so a drag with a pause would split into two steps. We set a huge `captureTimeout` and call `stopCapturing()` at the start of select-tool gestures, eraser gestures, and when a pen stroke ends.
- **An undo can look like it did nothing.** If a peer has already overwritten the same field, your undo has nothing left to reverse for that field. This is the right trade-off for a shared board, but it can surprise a user.
- **Clear Board is a decision.** An undo would restore every stroke the clear deleted, including other people's. We chose to wipe the undo history when `meta` changes (a `clearEpoch` counter) so nobody can resurrect strokes that were deleted for everyone.
- **History is in memory only.** A refresh clears it, same as before. Strokes already on the board when you join aren't undoable, because their changes arrive as remote updates.
- **Server validation had to change.** Undoing the first-ever move of a stroke *removes* the `x` field, and our server guard read a missing field as invalid, deleted the stroke and kicked the user who pressed Ctrl+Z. The fix treats a removed mutable field as valid (clients fall back to the default). We also write default transform fields (`x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0`) on new strokes so this is rare.
- **Layer order after restoring a deleted stroke** depends on the `ts` field and the sort in our observer. This should keep the original position, but it needs a test rather than an assumption.

## 6. Bugs we hit along the way

1. **A missing line in `handlePointerUp`.** While replacing the pen-end code, the three lines that read `currentStrokeRef` and clear it were dropped. `stroke` became undefined, `pointerup` threw, and the pen never ended: every click started a stroke that never stopped. The lesson: when you replace the end of a function, keep the lines above it. Tell this one as a debugging story: the symptom (an endless stream) pointed at a thrown error in the release handler.
2. **The guard rejected an undo.** Described above. The symptom would have been a user getting kicked on Ctrl+Z. It shows why a server-side validator must understand every state the client can legitimately produce, including the ones undo creates.
3. **A `ReferenceError` in the guard.** An edit that replaced only part of a block left a variable out of scope. The Yjs library caught and logged it, so the server survived, but that validation branch wasn't running. Lesson: replace whole blocks, and watch the logs for caught errors.

## 7. When the native approach would still be right

- The app is single-user or turn-based, so concurrency isn't a concern.
- The state isn't in a CRDT, so there's no origin tracking to lean on.
- You need undo history that survives a refresh or is stored on the server. Both approaches would need extra work for that.
- You need fine control over what counts as one step beyond what `stopCapturing()` gives.

## 8. How the pieces fit (for a whiteboard explanation)

- Every write (draw, move, erase) is a Yjs transaction from the local client.
- The `UndoManager` listens to `yStrokes` and records the local transactions as stack items.
- `stopCapturing()` closes the current item at each gesture start.
- `undo()` applies the reverse operations as a new Yjs transaction, which syncs to peers like any other edit.
- Remote changes never enter the stack.
- When someone clears the board, `meta` changes, and each client clears its manager.

## 9. Likely interview questions, with answers

**Q: Why did you replace your own undo with Yjs's?** The native version restored saved before-values, so in a shared board an undo could overwrite someone else's concurrent change, and erase wasn't undoable. `Y.UndoManager` reverses only the local client's operations. It fixed both problems and removed about 70 lines.

**Q: How does `Y.UndoManager` know which changes are yours?** It tracks transactions by origin. Local writes use the default origin, which it tracks. Updates that arrive from the network carry the provider as origin, which it ignores.

**Q: What happens if a peer changed the same field you're undoing?** Your undo has nothing to reverse for that field, so it may appear to do nothing. That's deliberate: restoring your old value would erase their edit.

**Q: How did you make one drag a single undo step?** I set a very large `captureTimeout`, so nothing merges on time, and call `stopCapturing()` when a gesture begins. That closes the previous step, so each gesture becomes its own item.

**Q: Why did you scope the manager to the strokes map only?** So changes to `meta` (like the clear counter) never enter the undo stack. Otherwise undoing something would also try to undo a board clear.

**Q: What happens on Clear Board and undo?** By default an undo would restore everything the clear deleted, including other people's strokes. I chose to wipe the history on clear: a counter in `meta` changes, and each client calls `clear()` on its manager.

**Q: Did the migration cause any bugs?** Two. A refactor dropped the lines that clear the current stroke in `pointerup`, so the pen never finished. And undoing a first move removes the `x` field, which my server validator treated as invalid and kicked the user. I fixed it by treating a removed transform field as valid.

**Q: Is the undo history shared or persisted?** No. It's per client and in memory, so a refresh clears it.

**Q: Would you use it in every app?** Not in a single-user app with no CRDT. There, hand-written stacks are simpler and have no dependency. The Yjs manager pays off when state is already shared and concurrent edits are possible.

**Q: What would you improve next?** Persist undo history per user if needed, test layer order after restoring deleted strokes in more cases, and add a visible undo-redo indicator so users know why an undo sometimes does nothing.

## 10. Checks to run before you present it

1. Drag with a pause, then Ctrl+Z once. The whole drag should undo as one step.
2. Erase a stroke, then Ctrl+Z. It should return in its original layer position, in both tabs.
3. Tab A rotates a stroke, tab B moves it, then A presses Ctrl+Z. B's move should survive.
4. Clear Board, then Ctrl+Z in both tabs. Nothing should come back, and nothing should error.
5. Open an old board with strokes that have no transform fields, move one, and press Ctrl+Z. There should be no kick in the server log.
