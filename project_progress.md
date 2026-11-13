### Current Progress

* **Project Structure Set Up:** Initialized the monorepo with a React + Vite frontend and a Node.js + Express backend.
* **Core Canvas Engine:** Implemented an interactive HTML5 Canvas allowing freehand drawing.
* **Drawing Tools:** Added controls for changing brush color, adjusting brush size, and an eraser function.
* **Real-Time Synchronization:** Integrated Socket.IO to instantly broadcast and receive drawing strokes across multiple browser clients.
* **Live Cursors:** Added real-time mouse tracking that displays custom SVG cursors indicating where other users are currently pointing on the canvas.
* **Client-Side Routing:** Integrated `react-router-dom` to manage navigation between different pages.
* **Lobby Interface:** Created a Home page where users can generate a new board or paste an ID to join an existing one.
* **Dynamic URLs:** Used the `uuid` library to generate unique URL links (e.g., `/board/abc-123`) for every new session.
* **Session Isolation:** Extracted the room ID from the URL and passed it to the Canvas and Socket.IO.
* **Private Workspaces:** Confirmed that drawing and cursor events are now strictly isolated to users sharing the exact same URL.
* **Room ID Display & Copy:** Updated the board toolbar to show the full Room ID along with a 1-click Copy button.
* **Database Integration & Persistence:** Connected Express backend to MongoDB Atlas with Mongoose; created the Board model and `/api/boards` routes to save and restore stroke histories across reloads.
* **Save & Restore Boards:** Added stroke history tracking and a "Save Board" button in the board UI, automatically fetching and redrawing saved strokes on page load.
* **User Authentication:** Created the User model and `/api/auth` endpoints (`/register`, `/login`) secured with `bcryptjs` password hashing and JWT tokens.
* **Auth UI & Route Protection:** Built the login/registration page (`Auth.jsx`), persistent `AuthContext` state, and `ProtectedRoute` guards for the lobby and whiteboard rooms.
* **Named Live Cursors:** Integrated authenticated usernames into cursor tracking (`Canvas.jsx` -> `cursorHandler.js` -> `LiveCursors.jsx`) so each participant's cursor displays their actual username.
* **Virtual Object Model (VOM) Engine:** Refactored the canvas from immediate-mode pixel painting to a state-driven render loop handling structured stroke objects.
* **Path Simplification:** Implemented the Iterative Douglas-Peucker algorithm alongside a 1px radial prefilter to aggressively compress coordinate data before transmission.
* **Advanced Rendering Math:** Integrated `quadraticCurveTo` smoothing through midpoints to maintain high-fidelity curves on simplified point arrays.
* **State Synchronization (Catch-Up):** Designed an authoritative server-side RAM buffer (`activeRoomsData`) to instantly serve the complete canvas history to late-joining users without hitting the database.
* **Hybrid Network Pipeline:** Upgraded the Socket pipeline to stream throttled `stroke:preview` chunks for live collaboration, committing only the finalized, mathematically smoothed `stroke:end` objects to server memory.

### Security & Technical Debt Backlog

The current MVP is functional but requires the following security hardening before production deployment:
- [ ] **Socket Rate Limiting:** Prevent DoS by capping `cursor-move` and `draw` events per second.
- [ ] **Payload Validation:** Sanitize incoming socket data (enforce strict coordinate numbers and string lengths) to prevent OOM memory crashes.
- [ ] **WSS / TLS:** Secure the WebSocket connection over HTTPS for deployment.
- [ ] **JWT Socket Handshake:** Validate the user's token during the initial socket connection upgrade.
- [ ] **RAM Buffer Flush Logic:** Implement the cold-storage routine to automatically dump the `activeRoomsData` Map to MongoDB when the last user disconnects to prevent memory leaks and data loss.