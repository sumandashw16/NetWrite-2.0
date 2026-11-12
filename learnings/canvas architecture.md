# NetWrite 2.0 Architecture: State Sync & Graphics Engine

This document outlines the architectural pivots made to transition NetWrite 2.0 from a basic "happy path" MVP to a production-ready collaborative engine. It covers how we handle state synchronization for new users and why we shifted from Immediate Mode rendering to a Virtual Object Model (VOM).

---

## 1. The "Catch-Up" Problem (State Synchronization)
**The Problem:** In a pure WebSocket routing setup, the server does not remember the past. If User A and B draw for 10 minutes and User C joins, User C sees a blank screen because the database only updates when someone manually clicks "Save".

### Alternative 1: Peer-to-Peer Catch-Up (Client-Driven)
* **How it works:** The server asks User A to convert their canvas to data and send it to User C.
* **Pros:** Extremely cheap. Costs the server zero RAM.
* **Cons:** 
  * Highly unreliable (User A's Wi-Fi might drop).
  * Slow (User A has terrible upload speed compared to AWS).
  * Security risk (User A's client can be manipulated to send malicious payloads).

### Alternative 2: Server RAM Buffering (Authoritative Server) - 🏆 CHOSEN
* **How it works:** The Node.js server maintains a JavaScript `Map` in RAM (`activeRoomsData`). Every time a user draws, the server broadcasts it AND pushes the data into this Map. When User C joins, the server instantly sends them the array from RAM.
* **Pros:** Blazing fast, highly secure (Server is the Single Source of Truth), and immune to client disconnects.
* **Cons:** Consumes server memory (manageable with path simplification and auto-save on disconnect).

---

## 2. The Eraser Problem (Memory Bloat)
**The Problem:** In a raw HTML5 Canvas, an "Eraser" tool does not actually delete data; it just paints white lines over existing ones. 
* **The Consequence:** If a user scribbles and erases for an hour, the RAM buffer grows infinitely. User C would have to download 50MB of hidden/erased lines just to see a blank board.
* **The Solution:** We must stop storing raw pixel actions and start storing manipulatable objects.

---

## 3. The Graphics Engine Pivot
To solve the eraser memory bloat and allow for advanced tools (Select, Move, perfect Undo), we had to fundamentally change how the canvas handles graphics.

### Alternative 1: The Layered Cake (Canvas + SVG)
* **How it works:** A raw `<canvas>` at the bottom for fast handwriting, and a transparent `<svg>` layer on top for draggable shapes (rectangles, circles).
* **Pros:** Fast handwriting performance; browser handles shape hit-detection.
* **Cons:** Complex to sync two entirely different DOM paradigms to the server; does not solve the handwriting eraser problem.

### Alternative 2: Virtual Object Model (VOM) - 🏆 CHOSEN
* **How it works:** The canvas no longer paints pixels directly from the mouse. Instead, React maintains a master array of JSON objects representing every stroke and shape. The canvas clears itself and redraws the entire array 60 times a second.
* **Pros:** 
  * **True Eraser/Delete:** Deleting a line means simply filtering its object ID out of the array. The next frame, it is gone. User C never downloads deleted data.
  * **Perfect Undo:** Just `array.pop()` the last object.
  * **Select/Move:** Users can click and drag anything they drew 5 minutes ago.
* **Cons:** Requires a custom render-loop engine and slightly more CPU on the client side.

---

## 4. Implementation Blueprint: How VOM Works

### Data Structure (Paths, not Pixels)
To prevent RAM from exploding, we store mathematical anchor points, not pixel grids.
```json
{
  "id": "stroke_55",
  "type": "freehand",
  "color": "#FF0000",
  "points": [{"x": 10, "y": 15}, {"x": 12, "y": 18}, {"x": 15, "y": 22}]
}