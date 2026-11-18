# NetWrite RBAC: Complete Technical Documentation and Interview Guide

*Collaborative whiteboard: React, Socket.IO, Yjs (y-websocket), Express, MongoDB. Written for interview preparation. Every claim maps to code built in this project.*

## How to use this document

This guide has three parts.

- **Part 1, Foundations (sections 1 to 7):** what was built, the architecture, principles, roles, identity, admission, and write enforcement. If you only have an hour, read these.
- **Part 2, Internals (sections 8 to 15):** room state, host failover, kick versus revoke, clear, guest rules, persistence, REST, and the client.
- **Part 3, Reference and interview (sections 16 to 24):** event and close-code tables, the threat model, the bugs we hit, design trade-offs, limits, testing, a large interview Q&A, and a one-page cheat sheet.

A rule for interviews: never overclaim. Section 1 lists what was verified and what was not. Say it honestly. Interviewers trust candidates who know the edges of their own work.

---

# PART 1: FOUNDATIONS

## 1. What we built

### The 30-second pitch

NetWrite is a real-time collaborative whiteboard. I added role-based access control with three roles: Host, Co-host, and Joiner. Private rooms use a waiting lobby where the host approves each person. Permissions are enforced on the server at two boundaries: an admission ticket checked at the WebSocket upgrade, and a per-message write gate in front of the Yjs document. The client UI only reflects permissions. It never grants them.

### The problem before RBAC

- Any client that knew a room id (a UUID) could connect and draw.
- Rooms were implicit: a board appeared the first time someone used its id.
- REST routes for reading and saving boards had no authentication.
- The server trusted client-supplied values such as roomId and username on cursor events.
- There was no concept of an owner, a moderator, or a view-only user.

### Requirements we implemented

- **Roles:** Host (full control), Co-host (admit, deny, kick Joiners, toggle Joiner write), Joiner (view-only unless granted write).
- **Private rooms:** a Joiner waits in a lobby. The server notifies Host and Co-hosts. On Allow the server moves the socket into the real room and issues a signed, short-lived admission ticket.
- **Yjs boundary:** the WebSocket server independently verifies the ticket before completing the upgrade. A client that connects directly, skipping Socket.IO, is rejected at the WS layer.
- **Read/write enforcement:** the server looks up each connection's permission on every mutating message. Pan, zoom, cursors, and presence are unaffected.
- **Kick:** closes both the Socket.IO connection and the Yjs connection, correlated by a server-verified identity.
- **Host failover:** a 15-second grace window, then the earliest-promoted co-host becomes acting host. With no co-host, the room stays open but everyone is forced read-only until a host returns. The original owner reclaims Host on return.
- **Guests:** ephemeral server-issued identities. Guest-hosted rooms never touch MongoDB. Guests see no history.
- **Dashboard:** Managed Boards (Host or Co-host) and Shared with me (admitted Joiners, persisted boards only).

### Honest status (important for interviews)

| Area | Status |
| --- | --- |
| Join flow, public and private lobby, Allow/Deny | Built and working |
| Write toggle, revoke, grant without reload | Built and working |
| Kick with cooldown | Built and working |
| Ticket gate at /yjs, direct connection refused | Built and working |
| Dashboards, guest sessions | Built and working |
| Pre-merge write gate, bulk-delete limit, meta lock, awareness preview block | Implemented; not yet covered by automated tests |
| Host failover timing, no-co-host lock, owner reclaim | Implemented; not yet exercised end to end |
| Guest room leaves nothing in MongoDB | Implemented; verify with a database check |
| Automated unit and integration tests | Not written yet (planned) |

When asked, say: the design and code are complete, the core flows were tested manually, and the next step is an automated integration suite around the /yjs boundary.

---

## 2. Architecture

### Three connections, two planes

```
Browser
  |-- HTTPS REST (Express) ----------> auth, boards, dashboards, snapshot, delete
  |-- Socket.IO  (control plane) ----> join, lobby, roster, management, cursors, clear
  |-- WebSocket /yjs/:roomId?ticket -> data plane: Yjs sync + awareness (strokes)

One Node process, one http.Server shared by:
  Express + Socket.IO + the ws 'upgrade' handler for /yjs

In-memory authority: rooms/roomState.js
Persistence:         MongoDB (Board collection)
```

**Control plane (Socket.IO):** who is in the room, who may do what, join requests, and management actions. These are small JSON messages that need acknowledgements.

**Data plane (Yjs over WebSocket):** the strokes themselves. y-websocket speaks a binary CRDT sync protocol. Drawing traffic is high volume and merge-based, so it travels on its own connection and its own server handlers.

The two planes are separate connections to separate handlers. That is why admission needed a bridge (the ticket) and why kick needed to close both sockets.

### File map

| File | Responsibility |
| --- | --- |
| middleware/authMiddleware.js | verifyToken, signGuestToken, requireAuth, requireUser, socketAuth |
| socket/tickets.js | issue and redeem admission tickets |
| rooms/permissions.js | roleOf, canWrite, can(actor, action, target): the whole matrix |
| rooms/roomState.js | in-memory rooms, members, presence, failover, kick, cooldown, events |
| socket/roomHandler.js | Socket.IO events: join, lobby, management, clear, room end |
| socket/cursorHandler.js | cursor relay using server-held room and identity |
| socket/yjsServer.js | upgrade handler, ticket check, persistence hooks, connection registration |
| socket/yjsGuard.js | per-message write gate, rate limits, post-merge validation |
| models/Board.js | owner, isPrivate, members, ydocState |
| routes/boardRoutes.js | create, read, snapshot, delete, dashboard queries |
| routes/authRoutes.js | register, login, guest |
| Client: session.js, api.js, socket.js, AuthContext, Home, Board, Canvas | sessions, joins, UI gating, Yjs provider with tickets |

---

## 3. Core security principles

These are the ideas to repeat in an interview. Each one is backed by specific code.

1. **The server is the authority; the client is feedback.** The UI greys out the pen for a view-only user so they get instant feedback. A malicious client can ignore that. Enforcement lives where the client cannot touch it.
2. **Identity is verified, never claimed.** A user id comes from a verified JWT (handshake) or from a signed ticket (Yjs upgrade). No role decision ever reads an id, roomId, or username from a client payload.
3. **Check at the boundary, before the effect.** The write gate runs before the Yjs message reaches the document, so rejected data is never merged and never relayed to peers.
4. **Look up permission live.** The gate reads current state on every message. Nothing about permissions is cached on the connection, so a change takes effect on the next message.
5. **Fail closed.** Missing ticket, bad ticket, unknown room, unparseable frame: refuse. Unknown actions in the matrix return false.
6. **Defense in depth.** Several independent layers: ticket, membership check, per-message gate, rate limits, post-merge structural validation.
7. **One place for the rules.** The role matrix is a single pure function, easy to read, review, and test as a table.
8. **Decouple side effects with events.** roomState emits events (permission, roster, pending, membersDirty, end). It does not import Mongo, Socket.IO, or Yjs. The handlers listen and act.

### Why the Yjs permission map is not enforcement

The original idea was a shared Yjs map holding read/write flags so clients see changes instantly. A Yjs map is just shared data. Any client can write to it, and a CRDT will merge the write. So using it for decisions would let a user grant themselves write access.

What we built instead:

- **UI feedback:** the server pushes a `roster` event over Socket.IO with each member's role and canWrite. The client derives its own pen enable/disable from that.
- **Enforcement:** the Yjs WebSocket server checks the connection's permission, looked up server-side from roomState, on every mutating message.

That deviation is a good talking point: I recognized that a convenient shared structure is the wrong trust anchor, and moved the decision to server memory.

---

## 4. Roles and permissions

### Definitions

- **Host:** the acting host of the room. Normally the owner (the user who created the board). If the owner is away, a promoted co-host becomes acting host.
- **Co-host:** a member promoted by the Host. Always has write access. Has a `grantedAt` timestamp that decides failover order.
- **Joiner:** a member with role joiner and a `canWrite` flag, default false.

Two separate fields in a room: `ownerId` (the original Host, never changes) and `actingHostId` (who currently holds Host powers). This split is what makes reclaim cheap: when the owner returns, set `actingHostId = ownerId` and the acting co-host falls back to co-host automatically.

### Permission matrix

| Action | Host | Co-host | Joiner |
| --- | --- | --- | --- |
| View, pan, zoom, move cursor | yes | yes | yes |
| Draw, erase, edit (Yjs writes) | yes | yes | only if canWrite and room not locked |
| Admit or deny a join request | yes | yes | no |
| Kick a Joiner | yes | yes | no |
| Kick a Co-host | yes | no | no |
| Kick the Host | no | no | no |
| Toggle a Joiner's write access | yes | yes | no |
| Promote a Joiner to Co-host | yes | no | no |
| Demote a Co-host | yes | no | no |
| Clear the board | yes | yes | no |
| Take a snapshot (save) | any admitted member, only on persisted boards |  |  |
| Delete the board or end a guest room | owner only | no | no |

### The two functions that matter

```js
// permissions.js (shape)
roleOf(room, id)   // 'host' if id === actingHostId, else members.get(id).role, else null
canWrite(room, id) // false if room.locked; true for host/cohost; joiner => canWrite flag
can(room, actorId, action, targetId) // the whole matrix as a switch
```

`canWrite` is the only function the Yjs gate calls. It runs per message and costs two Map lookups. `can` is used by every Socket.IO management action and by REST routes.

Example rules inside `can`:

- **kick:** target must differ from actor. A Host may kick any member. A Co-host may kick only a target whose role is joiner.
- **setWrite:** actor is a manager and the target is a joiner. Co-hosts always write, so there is nothing to toggle on them. To strip a co-host's write access, demote first.
- **delete:** actor is host and actorId equals ownerId. A promoted co-host who is acting host cannot delete the board.

### Decisions we locked in with the product owner

- Co-hosts always have write access.
- Demoting a co-host makes them a Joiner with canWrite false.
- Take control over a co-host means demote or kick only. No impersonation or overriding their actions.
- Clear board: Host and Co-host only. Everyone can snapshot.
- Kick is not a ban. The user can re-request, after a 60 second cooldown.
- Logged-in users who were admitted before skip the lobby on return, unless they were kicked.

---

## 5. Identity

### Two kinds of identity

|  | Logged-in user | Guest |
| --- | --- | --- |
| Token payload | userId, username | guestId, guest true, username |
| Issued by | POST /api/auth/login | POST /api/auth/guest |
| Lifetime | 24 hours | 12 hours |
| Stored in browser | localStorage | sessionStorage (per tab, survives refresh) |
| Namespaced id | `u:<mongoId>` | `g:<uuid>` |
| Persisted in MongoDB | yes (as member of a board) | never |

The prefix matters. It guarantees a guest id can never collide with a user id, and it lets code tell them apart from the id alone.

### authMiddleware.js

- `verifyToken(token)` uses `jwt.verify` with `algorithms: ['HS256']` pinned (blocks algorithm-confusion attacks), caps token length at 2048, never throws, and returns `{ id, isGuest, username }` or null.
- `requireAuth` reads `Authorization: Bearer <token>` for Express and sets `req.identity`.
- `requireUser` is `requireAuth` plus a rejection of guests (403). Dashboard routes use it because guests have no history.
- `socketAuth` is Socket.IO middleware. It verifies `socket.handshake.auth.token` and stores `socket.data.identity`. The connection is refused if the token is invalid.
- The secret is read lazily inside functions. Reason: `dotenv.config()` runs after ES imports are evaluated, so reading `process.env` at module load would see nothing.

### Guest identity details

The server generates the guestId with `crypto.randomUUID()` and signs it. The client cannot choose or claim one. A refresh keeps the guest because the token is in sessionStorage. Closing the tab loses it, and a guest host who closes the tab cannot reclaim the room.

### Why the Yjs endpoint does not take the JWT

A WebSocket handshake from a browser cannot set an Authorization header, so the token would have to go in the query string. Query strings leak into logs and proxies, and a 24 hour JWT in a URL is replayable. Instead the Yjs endpoint accepts only a short-lived, single-use, room-bound ticket (section 6). The ticket carries the already-verified identity, so the Yjs layer never handles the JWT.

---

## 6. Admission and tickets

### Join flow, step by step

1. The client opens the board page. The Board component emits `join-room` with the roomId.
2. The server validates the roomId against a regex and loads the room: from memory, or rebuilt from MongoDB for persisted boards. Guest rooms exist only in memory.
3. `requestJoin` decides:
   - Already admitted (owner or in members): admitted.
   - In kick cooldown: refused with status cooldown.
   - Public room: add as joiner and admit immediately.
   - Private room: add to the pending map and hold the socket in a holding state.
4. A pending socket is not in the real Socket.IO room and has no ticket. It receives no strokes and no cursors.
5. The server emits `lobby:pending` to every Host and Co-host currently online.
6. A manager clicks Allow. The server checks `can(admit)`, creates the member, then in `admit()`:
   - issues a ticket for this roomId and identity (first, so a failure changes no state),
   - joins the socket into the real Socket.IO room,
   - registers the connection,
   - emits `admitted` with `{ you, ticket, roster }`.
7. Only now does the client mount the canvas and open `ws://.../yjs/<roomId>?ticket=...`.

Deny emits `join:denied` and clears the pending entry.

### The admission ticket

A JWT signed with a separate `TICKET_SECRET` (different from JWT\_SECRET so one leak does not break both):

| Claim | Value | Purpose |
| --- | --- | --- |
| sub | identity id (`u:...` or `g:...`) | who it was issued to |
| rid | roomId | bound to one room |
| aud | yjs | cannot be used as an API token |
| jti | random UUID | enables single use |
| exp | 60 seconds | limits replay window |

`redeemTicket` verifies signature, audience, expiry, and room match, then records the jti in a spent map. A second use of the same ticket fails. A cleanup interval removes expired entries.

### The upgrade handler (the real security boundary)

The `server.on('upgrade')` handler for paths starting with `/yjs/` runs these checks in order, cheapest first, and the ticket is redeemed last so a refusal for a full room does not burn it:

| Check | Refusal |
| --- | --- |
| URL parses | 400 |
| roomId matches regex | 400 |
| Origin is in the allow-list | 403 |
| IP is not banned (strikes) | 429 |
| Per-IP connection cap (20) | 429 |
| Per-room connection cap (50) | 429 |
| Global room cap (500) for new docs | 503 |
| Room exists in roomState | 404 |
| Ticket valid, unexpired, right room, unused | 401 |
| Ticket identity is currently admitted | 403 |
| Otherwise | complete the upgrade |

The handler must stay synchronous. Socket.IO's engine ends upgrade sockets it does not recognize if nothing is written quickly, so no database call can sit in this path. Both ticket verification and the roomState lookup are in-memory.

The final membership check is what stops a kicked user from reconnecting with a still-valid ticket: kick deletes them from members, so `isAdmitted` fails.

### Reconnects

A ticket is single use, but y-websocket reconnects automatically with its original URL. So the client disables auto-reconnect: on any Yjs close it stops the provider, requests a fresh ticket over Socket.IO (`ticket:request`, which the server grants only to admitted members), and rebuilds the provider. This is also how a revoked writer resyncs.

---

## 7. Write enforcement

### The layers

| Layer | Where | What it stops |
| --- | --- | --- |
| 1. Ticket and membership | upgrade handler | anyone not admitted |
| 2. Size and rate limits | per-message in yjsGuard | floods, oversized frames |
| 3. Envelope check | per-message | malformed frames |
| 4. Write gate | per-message, pre-merge | view-only users mutating the doc |
| 5. Update inspection | per-message, pre-merge | bulk deletes, meta writes |
| 6. Awareness filter | per-message | fake live strokes from non-writers |
| 7. Structural validation | post-merge observer | malformed or illegal stroke data |

### The Yjs message format (needed to explain the gate)

Every y-websocket binary message starts with a type byte:

- `0` sync, followed by a subtype: `0` sync step 1 (a request for state), `1` sync step 2 (a state reply), `2` update (a mutation).
- `1` awareness (cursors, presence, live-stroke previews).
- `3` query awareness.

So a mutation is a sync message with subtype 1 or 2. Reads (subtype 0) and awareness are not mutations.

### The pre-merge gate

In `guardConnection`, the server wraps y-websocket's message listener. Before the real handlers run, for every frame:

1. Reject text frames, oversize frames (4 MB for sync, 64 KB otherwise), and rate violations.
2. Check the envelope parses (type, subtype, length prefix).
3. Compute `writer = canWrite(room, ws.identityId)` from roomState, live.
4. If it is a mutation (sync, subtype not 0):
   - Not a writer: an empty update is ignored (a read-only client's normal reply). Anything else closes the socket with 4403. Nothing reaches the document.
   - Writer: decode the update with `Y.decodeUpdate` before merging and reject it if it writes to the `meta` map or deletes more than 100 live strokes. Reject means close 4403 with no strike.
5. If it is awareness and the sender is not a writer, drop frames whose state contains a `preview`.

Because the check happens before `setupWSConnection`'s handler, rejected data is never merged into the server doc and never relayed to peers.

### Why pre-merge, not revert-after

The older guard observed the doc after the update merged, then deleted offending strokes in a microtask. By then peers already had the update. For permissions that is wrong, and reverting a view-only user's patch by deleting the stroke would also destroy another user's work. Pre-merge dropping has neither problem.

### Revoke applies instantly

When `setWrite`, `promote`, `demote`, or a lock change happens, roomState emits `permission`. A listener in yjsServer recomputes canWrite for the affected user's Yjs sockets. If a socket lost write, it is closed with 4403 so the client discards its diverged local doc and resyncs with a fresh ticket. A grant needs no reconnect because the gate looks permission up live on the next message.

### Layer 7: structural validation after merge

Still kept as a second line. An observer on the strokes map validates every remotely-originated change: each stroke must have an id equal to its key, only allowed field names, values in range (coordinates under one million, widths, colors as hex, point arrays of limited length), and a valid type (path, shape, icon, text). Only transform and style fields may change after creation. A total stroke cap of 20,000 applies. Offenders are removed under a `guard` origin and the connection is terminated, with an IP strike. Three strikes bans the IP for ten minutes (loopback exempt in development).

### Honest limits of write enforcement

- A writer can still erase strokes one at a time. Erasing is writing. The remedy is revoking write access or kicking.
- A writer can delete up to 100 strokes per message, repeatedly. A tighter limit or rate cap on deletes is possible future work.
- Root-type creation and unexpected root types are rejected after the fact, not pre-merge.

---

# PART 2: INTERNALS

## 8. Room state (rooms/roomState.js)

roomState is the in-memory authority for everything about a live room. It is deliberately free of I/O: no Mongo, no Socket.IO, no Yjs imports. It mutates state and emits events. This keeps it testable and keeps the rules in one place.

### The room object

```js
room = {
  roomId, isPrivate, persisted,         // persisted = false when the owner is a guest
  ownerId, ownerName,                   // original Host, never changes
  actingHostId,                         // who holds Host powers right now
  hostless, locked,                     // failover flags
  members: Map(id -> { role, canWrite, grantedAt, isGuest, username }),
  pending: Map(id -> { socket, username, requestedAt }),   // the lobby
  conns:   Map(id -> { io: Set(sockets), yjs: Set(ws) }),  // connection registry
  cooldown: Map(id -> untilMs),         // kick cooldown
  lastGrant, hostTimer, emptyTimer
}
```

- **members is the admission list.** There is no separate admitted set. A kicked user is deleted from members, which instantly invalidates their admission everywhere (socket join, ticket redemption at the upgrade).
- **The owner is not stored in members.** ownerId is the source of truth, which is why the owner can reclaim even when members changed.
- **conns is the registry that makes kick work.** Both the Socket.IO socket (identity from the handshake JWT) and the Yjs ws (identity from the ticket) register under the same verified identity id.

### Events emitted

| Event | Meaning | Listener |
| --- | --- | --- |
| permission(room, id or null) | someone's write ability changed (null means everyone) | yjsServer closes revoked Yjs sockets with 4403 |
| roster(room) | roles, presence, or lock changed | roomHandler broadcasts the roster to the room |
| pending(room) | the lobby changed | roomHandler pushes the list to managers |
| membersDirty(room) | persistent membership changed | roomHandler saves to Mongo (debounced 500 ms, persisted rooms, guests excluded) |
| end(room) | room closed | yjsServer drops the guest stash, roomHandler tells pending sockets |

### Presence

A user is online if they have at least one Socket.IO connection in the room. Yjs sockets do not count: failover depends on the control-plane connection being alive, and a user can hold several tabs.

### Lifecycle timers

- **emptyTimer (10 minutes):** starts when nobody is online, and also when a room is first opened, so a room nobody ever joins does not leak. Expiry calls `endRoom`, which closes every connection with 4410 and emits `end`.
- **hostTimer (15 seconds):** the failover grace window (section 9).
- **cooldown (60 seconds):** per kicked identity (section 10).

### The public API of roomState

`openRoom`, `getRoom`, `endRoom`, `addConn`, `removeConn`, `closeAll`, `isAdmitted`, `requestJoin`, `resolveJoin`, `setWrite`, `promote`, `demote`, `kick`, `roster`, and the `roomEvents` emitter. Every management function takes `(room, actorId, targetId)` and runs through one helper, `act`, that calls `can()` first. That single choke point is why a Joiner cannot perform a management action even if they emit the event: the check happens in the shared helper, not in each handler.

---

## 9. Host failover

### The rules

1. If the Host disconnects, wait a 15 second grace window. Nothing changes during it, so a page refresh is invisible.
2. On expiry, promote the online co-host with the earliest `grantedAt`. First granted wins.
3. If there is no co-host, do not close the room. Set `locked = true` so everyone, including users with write access, becomes read-only.
4. If the owner reconnects at any time, they reclaim Host immediately. The acting co-host drops back to co-host and keeps their original grantedAt. The lock clears.

### How the code does it

`checkHost(room)` runs whenever a Socket.IO connection is added or removed:

```
owner online?
  yes -> if acting host is not the owner, or room is locked: setActing(owner)
         (this is the reclaim); clear any pending grace timer; done
acting host online?
  yes -> clear timer; done
room already hostless?
  yes -> if a co-host is online, setActing(that co-host); done
else start the 15 s hostTimer -> failover(room)

failover(room):
  acting host back online, or nobody online -> do nothing
  nextCohost exists -> setActing(nextCohost)
  otherwise -> hostless = true, locked = true, emit permission + roster
```

`nextCohost` filters members to role cohost, not already acting, and online, then sorts by `grantedAt`. `nextGrant` returns a strictly increasing number (`max(Date.now(), last + 1)`), so two promotions in the same millisecond still have a defined order.

### Why a locked flag instead of editing permissions

`locked` overrides `canWrite` at check time. It does not erase any member's canWrite value. When a host returns and the flag clears, the previous write grants are intact. If we had written canWrite = false onto every member, we would have destroyed that state and could not restore it.

### Timeline example

```
t=0    Host (owner) tab closes. Grace timer starts.
t=5s   Host reopens within grace -> owner online -> timer cleared, nothing visible.

t=0    Host tab closes. Co-host A (promoted first) and B are online.
t=15s  failover -> A becomes acting host. Roster updates for everyone.
t=40s  Owner returns -> reclaim: actingHostId = owner, A is a co-host again.

t=0    Host closes. No co-hosts online.
t=15s  hostless + locked: everyone read-only, banner shown, room stays open.
       A new join request queues in memory. Nobody can self-promote.
t=90s  Owner returns -> unlock, previous write grants take effect again.
```

### Edge cases to know

- **Reclaim survives a server restart for logged-in hosts**, because ownerId is rebuilt from `Board.owner` in MongoDB.
- **A guest host can reclaim only while their sessionStorage token survives.** Closing the tab loses the guest identity for good.
- **While locked, only the owner returning (or, for a guest room, the 10 minute empty timer) ends the lock.** Nobody can assign a host, because Joiners must never be able to promote themselves.
- **A promoted acting host has every Host power except deleting the board**, which is owner-only.
- **Known quirk:** while a co-host is acting, the owner holds no role in the matrix until they reconnect. That is acceptable because reconnect restores it immediately.

---

## 10. Kick versus revoke

These look similar in the UI and are completely different operations.

|  | Revoke write | Kick |
| --- | --- | --- |
| What it is | a permission state change | removal from the room |
| State change | member.canWrite = false (or demote) | member deleted, pending deleted, cooldown set |
| Socket.IO connection | stays open | closed (client gets a closed event with code 4401 first) |
| Yjs connection | closed with 4403 so the client resyncs | closed with 4401 |
| Can rejoin | n/a, still a member | after 60 s; membership must be re-requested |
| Cursors, view, pan | still work | gone |

### How kick closes two connections on two servers

Socket.IO and the Yjs WebSocket server are separate handlers with separate connection objects. The link between them is the verified identity id.

- The Socket.IO socket registers with `addConn(room, id, 'io', socket)` where id comes from the JWT verified at the handshake.
- The Yjs ws registers with `addConn(room, id, 'yjs', ws)` where id comes from the redeemed ticket.
- `kick` calls `closeAll(room, target, 4401)`, which walks `room.conns.get(target)` and closes every socket in both sets.

An attacker cannot register under someone else's id, because both ids come from signatures the server checked, not from anything the client reported.

### Why the kicked user cannot sneak back in

- Reconnecting to Socket.IO goes through `requestJoin`, which refuses during cooldown.
- Reconnecting to Yjs with a ticket they already hold fails the upgrade's `isAdmitted` check, because the member entry is gone.
- Asking for a new ticket over Socket.IO is refused for non-members.

Why a cooldown rather than a ban: a public-room kick would otherwise be a no-op because the user could rejoin instantly. A short cooldown makes a kick meaningful without a permanent ban, which the requirements did not ask for.

---

## 11. Clearing the board

Originally the client cleared by deleting every stroke in one Yjs transaction and bumping `meta.clearEpoch`. The server cannot tell a clear from a long sequence of erases by looking at the message type, only by size. So clear became a server action:

1. The client emits `clear-board` over Socket.IO.
2. The server checks `can(clear)`, which means Host or Co-host.
3. The server gets the live doc from `docs.get(roomId)` and wipes the strokes map and bumps `meta.clearEpoch` in one transaction with its own origin (the string server, not a websocket).
4. Clients observe the `clearEpoch` change and reset their undo history, so nobody can resurrect strokes deleted for everyone.

The Yjs gate then rejects any client update that deletes more than 100 live strokes or writes to `meta`. The server's own transaction is not a client message, so it bypasses the gate by construction.

Honest limit: a Joiner with write access can still erase strokes one at a time. Erase is part of write. The control is revoking or kicking, not a finer permission.

---

## 12. Guests and persistence

### The Board schema

- `roomId` (unique), `ydocState` (Buffer holding the Yjs state), and a legacy `strokes` array kept for migration.
- `owner` (raw user id, indexed), `ownerName`, `isPrivate`.
- `members: [{ userId, username, role, canWrite, grantedAt }]` with an index on `members.userId`. Guests are never stored here.

### Explicit room creation

Previously any UUID became a room. Now rooms are created deliberately:

- **Logged-in:** `POST /api/boards` creates the Board document with owner and isPrivate. The server chooses the roomId.
- **Guest:** the `room:create-guest` socket event opens a room in memory only. The server picks the id (`crypto.randomUUID`), so nobody can squat on an id.

Because rooms now exist deliberately, `persist()` became update-only (no upsert). A deleted board cannot be resurrected by a late autosave, and a guest room can never be created in Mongo by accident.

### How a room is loaded

`ensureRoom(roomId, identity)` returns a live room if one exists, de-duplicates concurrent loads through an `opening` map of in-flight promises, and otherwise rebuilds from MongoDB: owner, privacy, and members. Boards with no owner (legacy) can be claimed atomically by the first logged-in user to open them, using a conditional findOneAndUpdate so only one claimant wins.

### The persistence path for the strokes

- On the first Yjs connection, `bindState` loads `ydocState` from Mongo into the Y.Doc, or seeds from the legacy array.
- Edits schedule a debounced autosave (5 seconds). `persist` encodes the doc and runs `updateOne`, with a 12 MB cap under Mongo's 16 MB limit.
- When the last connection leaves, `writeState` runs a final save.
- The snapshot route saves on demand. The body is ignored: the server serializes its own authoritative state, so a read-only user cannot inject data through Save.

### Guest rooms: never persisted

- `room.persisted = false` when the owner is a guest. The snapshot route returns 403 for these.
- `bindState` marks the room ephemeral. y-websocket evicts a doc when the last connection closes, so for ephemeral rooms `writeState` stashes the encoded doc in RAM instead of Mongo. A guest host who refreshes alone does not lose the board.
- The stash is deleted when the room ends: empty for 10 minutes, or the host explicitly ends it (`room:end`).
- The members saver skips rooms where `persisted` is false.

### Visibility rules and how each is enforced

| Rule | Enforcement |
| --- | --- |
| A guest never sees any history | Dashboard routes use `requireUser`, which returns 403 for guests; the client also does not render the lists |
| A guest-hosted room is not in anyone's history | Never written to Mongo, and the members saver skips non-persisted rooms |
| Guests never see session lists, even on user-hosted boards | Same 403 on dashboard routes |
| A guest co-host or joiner is never written to a persisted board | The members saver filters out isGuest members |

---

## 13. REST API

Every route requires `Authorization: Bearer <token>` unless stated.

| Route | Who | What |
| --- | --- | --- |
| POST /api/auth/register | public | create a user; credentials validated as plain strings |
| POST /api/auth/login | public | returns a 24 h JWT |
| POST /api/auth/guest | public (own rate limit) | returns a 12 h guest JWT |
| POST /api/boards | logged-in users | create a board with owner and isPrivate |
| GET /api/boards/dashboard/managed | logged-in users | boards where I am Host or Co-host |
| GET /api/boards/dashboard/shared | logged-in users | boards where I am an admitted Joiner |
| GET /api/boards/:roomId | admitted members | read strokes; live memory first, else Mongo |
| POST /api/boards/:roomId | admitted members | snapshot; rate limited to 10 per minute; 403 if not persisted |
| DELETE /api/boards/:roomId | owner only | ends the live room, then deletes the document |

Authorization for read: if a live room exists, the caller must be admitted. Otherwise they must be the owner or a member in Mongo. Guests are refused when no live room exists.

Rate limits: 120 requests per minute on `/api`, 20 per 15 minutes on login and register, and a separate higher limit (200 per 15 minutes) for the guest route so many guests behind one NAT are not blocked.

Input hardening: JSON bodies are capped at 100 KB, and login and register accept only strings (`typeof` checks), which blocks NoSQL injection payloads like `{ $ne: '' }`.

---

## 14. Dashboard queries

**Managed Boards:** boards where the user is the owner, or a member whose role is cohost.

```js
Board.find({ $or: [ { owner: uid }, { members: { $elemMatch: { userId: uid, role: 'cohost' } } } ] })
```

**Shared with me:** boards the user did not create where they are a member with role joiner.

```js
Board.find({ owner: { $ne: uid }, members: { $elemMatch: { userId: uid, role: 'joiner' } } })
```

Notes for interviews:

- `$elemMatch` is required so userId and role must match on the same array element. Without it, a user who is a joiner on one entry and appears elsewhere could match wrongly.
- A co-host sees a board in Managed, exactly like a host, which was a stated requirement.
- Promoting a Joiner moves the board from Shared to Managed automatically because the query is role-based.
- Only persisted boards appear, because only they exist in Mongo.
- Both queries are sorted by updatedAt, limited to 200, and use `.lean()`. The index on `members.userId` supports them.

---

## 15. The client

### Sessions

- `session.js` keeps logged-in sessions in localStorage and guest sessions in sessionStorage, and exposes get, save, and clear.
- `api.js` wraps fetch and attaches the Bearer token.
- `socket.js` creates the Socket.IO client with `autoConnect: false` and an `auth` callback that reads the current token on every connection attempt, so reconnects always send the current identity. `emitAck` wraps an event in a Promise with a timeout and waits for the connection if needed.
- `AuthContext` connects the socket when an identity exists and reconnects when the token changes. On a connect error with message unauthorized it logs out.

### The Board page: a join state machine

States: joining, pending, denied, cooldown, kicked, ended, notfound, error, and active. The server answers `join-room` with an acknowledgement status. Admission arrives as the `admitted` event, which carries the roster and the ticket. The component also listens for `roster`, `lobby:pending`, `join:denied`, and `closed`.

The page emits `join-room` on mount and again on every Socket.IO `connect` (so it recovers from a network drop), and emits `leave-room` on unmount so navigating away does not leave a phantom online user (which would break failover and the empty timer). A sequence counter on the server drops stale joins, such as React StrictMode's double mount.

### UI permissions are derived, not trusted

```js
canWrite = status === 'active' && me && !roster.locked && me.canWrite
```

The toolbar greys out and a View only badge shows. Managers see a People panel with Allow and Deny, a draw toggle per Joiner, promote, demote, and kick buttons, and the Clear button. The locked state shows a banner. All of this is feedback. The server enforces regardless.

### The canvas

- A `canWriteRef` guards every write path (addStroke, removeStroke, patchStroke, eraseAt, spawn, undo, redo, the pen, and tool switching). It is a UI guard only. A client that bypassed it would be closed with 4403 by the server.
- An effect watches `canWrite`. When permission is revoked mid-gesture it cancels the in-progress stroke, drag, text edit, and live preview, and switches to the select tool.
- Pan, zoom, selection, and cursors work for everyone. A read-only user can select but cannot drag, scale, rotate, or edit.

### The ticket-driven Yjs provider

The Yjs effect runs only once a ticket exists and depends on `[roomId, ticket]`, so a new ticket rebuilds the doc and provider. Details that matter:

- The provider is created with `connect: false` and connected on a zero-delay timer. React StrictMode mounts, unmounts, and remounts effects in development. Without the delay, the first mount's request could reach the server and spend the single-use ticket, and the second mount would get a 401.
- On any `connection-close`, the client stops the provider (guarded with a once-flag, see the bug story in Part 3) and reports the close code to the Board.
- The Board fetches a fresh ticket with exponential backoff (300 ms doubling to a 5 second cap) and sets it, which rebuilds the provider. Codes 4401 and 4410 are left to the Socket.IO `closed` handler, which shows the kicked or ended screen.

---

# PART 3: REFERENCE AND INTERVIEW MATERIAL

## 16. Socket.IO event reference

### Client to server

| Event | Payload | Who may use it | Notes |
| --- | --- | --- | --- |
| room:create-guest | { isPrivate } | guests only | opens an in-memory room; ack returns { roomId } |
| join-room | roomId | any authenticated socket | ack status: admitted, pending, cooldown, not-found, error |
| leave-room | none | any | clears the socket's room membership and presence |
| ticket:request | none | admitted members | returns a fresh single-use Yjs ticket, otherwise null |
| join:resolve | { targetId, allow } | Host or Co-host | can(admit) or can(deny) checked inside |
| member:setWrite | { targetId, value } | Host or Co-host | target must be a Joiner |
| member:promote | { targetId } | Host | target must be a Joiner |
| member:demote | { targetId } | Host | target must be a Co-host |
| member:kick | { targetId } | Host, or Co-host on Joiners | closes both connections |
| clear-board | none | Host or Co-host | server wipes the strokes map |
| room:end | none | owner of a guest room | persisted boards use REST delete |
| cursor-move | { x, y } | admitted members | server supplies room and username |

Every event that changes state goes through `can()`. The client never sends a roomId or an identity for these. They come from `socket.data`, which the server set at the handshake and at admission.

### Server to client

| Event | Payload | Purpose |
| --- | --- | --- |
| admitted | { you, ticket, roster } | you are in; here is your Yjs ticket |
| roster | { roomId, locked, persisted, isPrivate, actingHostId, members } | the UI feedback channel |
| lobby:pending | \[{ id, username }\] | sent only to managers who may admit |
| join:denied | none | the request was declined |
| closed | code (4401 or 4410) | why you were removed |
| receive-cursor | { socketId, x, y, username } | peers' cursors |
| user-disconnected | socketId | remove a cursor, scoped to that room only |

---

## 17. Close codes and HTTP statuses

### WebSocket close codes (application range 4000 to 4999)

| Code | Meaning | Client behavior |
| --- | --- | --- |
| 4401 | kicked | show the removed screen; do not reconnect |
| 4403 | write revoked, or a forbidden update was sent | destroy the local doc and provider, fetch a new ticket, rebuild and resync |
| 4410 | room ended or deleted | show the ended screen |
| 1006 | abnormal closure (network, or the handshake was refused) | fetch a new ticket with backoff, rebuild |

### Refusals during the /yjs upgrade

| Status | Reason |
| --- | --- |
| 400 | bad URL or room id |
| 401 | missing, invalid, expired, wrong-room, or already-used ticket |
| 403 | origin not allowed, or identity not admitted |
| 404 | no such room in memory |
| 429 | banned IP, per-IP cap, or per-room cap |
| 503 | global room limit reached |

A useful interview detail: a refused upgrade shows in the browser as a failed WebSocket with no readable status, because browsers hide the HTTP reason. The server log is where you see which check fired.

---

## 18. Threat model

Format: what an attacker tries, and which control stops it.

| Attack | Defense |
| --- | --- |
| Connect to /yjs directly, skipping Socket.IO | The upgrade handler requires a valid ticket. Refused with 401 before the WebSocket completes. |
| Steal and replay a ticket | Single use (jti), 60 second expiry, bound to one room and one identity. A kicked identity also fails the membership check. |
| Forge or tamper with a JWT | HS256 pinned, signature verified. Tokens using the none algorithm or another algorithm are rejected. |
| Join a private room without approval | A pending socket is not in the real room and holds no ticket, so it gets no strokes and no cursors. |
| View-only user sends a raw Yjs update | The pre-merge gate closes the socket with 4403. Nothing reaches the doc or the peers. |
| Forge meta.clearEpoch to wipe peers' undo history | The update inspector rejects client writes to meta. |
| Delete the whole board in one transaction | The update inspector rejects a delete set over 100 live strokes. Clear is server-only. |
| Show fake live strokes via awareness while read-only | Awareness frames containing preview are dropped for non-writers. |
| Joiner emits member:kick or promote directly | The shared act helper calls can() on the server. Returns false. |
| Spoof another user's name or broadcast cursors into a room not joined | The cursor handler ignores the payload's roomId and username. It uses socket.data set at handshake and admission. |
| Impersonate a guest or claim a guest id | Guest ids are generated and signed by the server. |
| NoSQL injection on login | Credentials must be plain strings, validated before the query. |
| Cross-site WebSocket hijacking | Origin allow-list at the upgrade. |
| Flood the server with messages or large frames | Token-bucket rate limits, size caps (maxPayload and per-type limits), IP strikes, then a 10 minute ban. |
| Exhaust memory with rooms or connections | Caps per IP (20), per room (50), globally (500 rooms); rooms expire 10 minutes after the last user leaves. |
| Squat on a room id or probe ids | The server generates ids; ids are regex-validated; unknown rooms are 404. |
| Inject data through the Save button | The snapshot body is ignored. The server serializes its own state. |
| Read another user's board by id (IDOR) | mayRead checks live admission or Mongo ownership or membership. |
| A revoked user keeps writing | Live permission lookup per message, plus a forced 4403 close that discards their diverged doc. |
| A kicked user reconnects | Member entry deleted (ticket fails isAdmitted), cooldown on re-request. |
| Race: the host disconnects and a Joiner grabs control | Only a promoted co-host or the returning owner can become acting host. Joiners can never self-assign. |

### Trust boundaries (draw this on a whiteboard)

```
UNTRUSTED                      |  TRUSTED (server memory and verified tokens)
-------------------------------+---------------------------------------------
Browser UI state               |  roomState (roles, canWrite, locked)
Client-sent roomId, username   |  socket.data.identity (from JWT at handshake)
The Yjs doc contents/maps      |  ticket claims (signed, single use)
Awareness payloads             |  permissions.js decisions
```

Everything left of the line is treated as data to validate. Everything right of it makes decisions.

---

## 19. Bugs we hit and what they taught

These make excellent interview stories because each one shows a debugging method. Use the format: symptom, cause, fix, lesson.

### 19.1 TICKET\_SECRET is not set

- **Symptom:** the server threw when issuing a ticket, even after the key was added to .env.
- **Cause:** in ES modules, imports are hoisted, so `dotenv.config()` in server.js runs after other modules are evaluated. Code reading `process.env` at import time sees nothing. (Also, the server must be restarted to pick up .env changes.)
- **Fix:** read secrets lazily inside functions. Outstanding: ALLOWED\_ORIGINS in yjsServer is still read at import time and should be made lazy, or dotenv should load first.
- **Lesson:** know module evaluation order. A config that works for one module can silently fail for another.

### 19.2 Cannot access 'id' before initialization

- **Symptom:** ReferenceError inside `admit()`.
- **Cause:** the ticket call was moved above the line that declared id, which put id in its temporal dead zone.
- **Fix:** declare id first, then issue the ticket, then mutate state.
- **Lesson:** order operations so that anything that can throw runs before any state change. A failure then leaves no half-admitted socket.

### 19.3 target is not defined (process crash)

- **Symptom:** an uncaught exception inside `act` when kicking.
- **Cause:** the cooldown line was pasted into the shared helper, where the parameter is named targetId, instead of into `kick`'s callback, where target exists.
- **Fix:** move the line into kick.
- **Lesson:** shared helpers are a single point of failure, so keep them generic. It also showed why a process-level uncaughtException logger matters in a long-running server.

### 19.4 Duplicate const room

- **Symptom:** a SyntaxError in join-room.
- **Cause:** a patch was applied on top of the old handler instead of replacing it. The result declared `room` twice, and also ran ensureRoom before the roomId was validated.
- **Fix:** replace the whole handler. Validate input first, then leave the old room, then load, then decide.
- **Lesson:** when a handler's order matters, replace it whole. Always validate before doing work.

### 19.5 Cursors worked but strokes did not sync

- **Symptom:** you could see the other person's pointer, but no strokes.
- **Cause:** cursors travel over Socket.IO. Strokes travel over Yjs, which now required a ticket. The old Canvas connected without one, so the server refused every handshake (401 and 404 in the log). The debug endpoint `/debug/rooms` returned an empty list, which meant no Yjs handshake ever completed.
- **Fix:** the Board gets the ticket from the admitted event and passes it to the Canvas, which creates the provider only when it has a ticket.
- **Lesson:** reason about planes. One plane working and the other failing narrows the problem to one subsystem. This is also proof the security boundary works: the old unauthenticated client was refused.

### 19.6 Maximum call stack size exceeded

- **Symptom:** a RangeError at the line calling `provider.disconnect()`.
- **Cause:** y-websocket fires `connection-close` before it clears its socket. Calling disconnect from inside the handler closed the same socket again and fired the event again, forever. The overflow also stopped the code that fetches a fresh ticket.
- **Fix:** a once-flag so the handler runs one time per provider.
- **Lesson:** a handler that triggers the event it handles needs a re-entrancy guard.

### 19.7 StrictMode burned the single-use ticket

- **Symptom:** a ticket was used twice, the second use got 401, and the browser logged that the WebSocket closed before the connection was established.
- **Cause:** in development React mounts an effect, unmounts it, and mounts it again. The first provider's request reached the server and spent the single-use ticket, then the second reused it.
- **Fix:** create the provider with `connect: false` and connect on a zero-delay timer that the cleanup cancels, so the throwaway first mount never touches the network. The reconnect logic is the backstop.
- **Lesson:** single-use credentials interact badly with anything that retries or double-invokes. Design the client for it.

### 19.8 Leftover join emit in the Canvas

- **Symptom risk:** a loop where each admission produced a new ticket, which rebuilt the effect, which joined again.
- **Cause:** the Canvas still emitted join-room after the Board took over joining.
- **Fix:** exactly one component owns joining.
- **Lesson:** one owner per side effect.

### 19.9 A debugging detour worth mentioning

When an AI coding assistant was asked to find the sync bug, it listed two bugs that were actually intended design: update-only persistence (a guest room must never reach Mongo) and an in-flight-room map. It also added logs that print ticket details. Takeaways: check every claimed bug against design intent, prefer logs and the network tab over theory, and never print or paste credentials, even short-lived ones.

---

## 20. Design decisions and trade-offs

| Decision | Why | Cost or alternative |
| --- | --- | --- |
| Ticket at /yjs instead of the JWT | Browsers cannot set headers on a WebSocket handshake. A long-lived JWT in a URL leaks into logs and is replayable. A 60 second, single-use, room-bound ticket limits the damage of a leak. | An extra round trip, and client logic to refresh tickets on every reconnect. |
| Separate TICKET\_SECRET | A leak of one signing key does not compromise the other credential type. | One more secret to manage. |
| Single-use ticket (jti) | Replay is useless. | The client cannot use y-websocket's automatic reconnect, so it rebuilds the provider with a fresh ticket. |
| Pre-merge write gate | Rejected data is never merged or relayed. No need to undo other people's work. | We inspect frames before the library does, which depends on the y-websocket frame format. |
| Live permission lookup per message | Revocation is instant. No stale cached grants. | Two Map lookups per message. Negligible. |
| Close with 4403 instead of silently dropping | A dropped update leaves the client with a diverged local doc that would push stale operations if write were later regranted. Closing forces a clean resync. | The user sees a brief reconnect. |
| Roster over Socket.IO for UI instead of a Yjs map | A Yjs map can be written by any client, so it can never be trusted for decisions, and putting it in the doc complicates the guard. | Two channels to keep in step, which the roster event handles. |
| In-memory roomState | Simple, fast, and enough for one process. The rooms are small. | A restart loses live state (persisted rooms rebuild from Mongo; guest rooms are ephemeral by design). Multiple processes would need Redis or sticky sessions. |
| Single Node process | Shared state is trivial. | Horizontal scaling is a future project. |
| members is the admission list | A kick is one delete and takes effect everywhere. | The owner is a special case outside members. |
| owner vs actingHost split | Makes reclaim a one-line operation and keeps grantedAt order intact. | Two concepts to explain. |
| locked flag for hostless rooms | Restores previous grants on return. | One extra condition in canWrite. |
| Server-side clear | The server cannot distinguish clear from erase in a Yjs message. A server action is unambiguous. | A new socket event. |
| Cooldown, not ban, after a kick | Meaningful in public rooms without being permanent. | In-memory only; ends with the room. |
| Guest JWT, not cookies | One verification path for everyone. | Refresh survives via sessionStorage, tab close does not. |
| Synchronous upgrade handler | The engine ends unrecognized upgrade sockets quickly. | No database call is allowed on that path. Everything it needs is in memory. |
| Update-only persist | Deleted boards cannot be resurrected and guest rooms cannot leak into Mongo. | Rooms must be created explicitly. |

---

## 21. Known limitations and future work

Knowing your own system's weak points is a strength in an interview. Own them calmly.

### Security and abuse

- **Erasing is writing.** A Joiner with write access can erase stroke by stroke. The control is revoke or kick. Possible improvement: a delete-rate cap per connection and an audit trail.
- **100 deletes per message, repeatedly.** The bulk limit applies per message, not per time window. A per-user delete budget would close this.
- **JWTs cannot be revoked.** A 24 hour token stays valid until it expires. Options: shorter access tokens with refresh tokens, or a per-user token version checked on verify.
- **Tokens in browser storage.** localStorage and sessionStorage are readable by any script that runs on the page, so an XSS bug would expose them. The alternative is httpOnly cookies with CSRF protection.
- **Rate limits are per IP.** Adding per-identity limits would help against distributed abuse.
- **No audit log.** Kicks, promotions, clears, and permission changes should be recorded with actor, target, and time.
- **The roster exposes raw identity ids** (`u:<mongoId>`) to every member. Low risk, but they could be replaced with opaque ids.
- **Awareness filtering is narrow.** It blocks the preview field from non-writers. Other awareness fields are not otherwise validated (cursor names travel over Socket.IO, where the server supplies them).

### Correctness and robustness

- **Owner has no role while a co-host is acting.** Reconnecting restores it immediately. A stricter model would give the owner a standing role.
- **Spent-ticket set and cooldowns live in process memory.** Fine for one process and a 60 second ticket life. A restart clears them.
- **Pending lobby requests are lost** if the server restarts or the joiner's socket drops. The client re-requests on reconnect.
- **No lobby timeout.** A pending request waits until a manager acts or the joiner leaves.
- **Large documents.** Yjs history can grow. Periodic compaction or a size warning would be needed for long-lived boards.

### Scaling

- State is in one process. Going multi-process needs a shared store (Redis) for roomState, the Socket.IO Redis adapter, and shared ticket-spent tracking, or sticky sessions routing a room to one process.

### Housekeeping items still open in the code

- Remove the temporary DEBUG-LOG lines from the server and the Canvas.
- Delete the duplicate commitTextEdit and handleDoubleClick definitions inside handlePointerUp.
- Load dotenv before other imports in server.js, or read ALLOWED\_ORIGINS lazily.
- Move origins and URLs to environment variables, serve over https and wss, set NODE\_ENV to production so the debug route is off, and restrict MongoDB network access.

---

## 22. Testing strategy

Manual testing cannot cover security. A security bug is a case nobody thought to try, and nobody retries every case after every change. Automated tests make the rules permanent.

### Layer 1: unit tests (fast, pure)

- **permissions.js:** a table of every role by every action by every target, with the expected yes or no. canWrite with locked on and off.
- **tickets.js:** valid ticket redeems once; second use fails; wrong room fails; expired fails; wrong secret fails; wrong audience fails.
- **roomState.js with fake timers:**
  - grace window: reconnect at 5 seconds changes nothing
  - after 15 seconds the earliest grantedAt co-host becomes acting host
  - with no co-host the room locks
  - owner returning reclaims and unlocks
  - kick removes membership and sets a cooldown
  - requestJoin during cooldown is refused
  - the empty timer ends the room

### Layer 2: integration tests (the real security tests)

Start the server on a random port and attack it with real clients (ws and socket.io-client). In a test you can build a genuine Yjs update with a Y.Doc and send it as a raw frame, something impractical by hand in devtools.

- /yjs with no ticket, a wrong-room ticket, or a reused ticket: refused (401).
- /yjs with a valid ticket for a kicked identity: refused (403).
- A view-only client sends an update: socket closed with 4403, document unchanged, a second client sees nothing.
- A view-only client sends only a sync step 1: allowed.
- A writer's update that writes to meta: rejected.
- A writer deletes 200 strokes in one message: rejected.
- A view-only awareness frame with preview: dropped.
- A Joiner emits member:kick: nothing happens.
- A Co-host tries to kick another Co-host: refused.
- Kick closes both the Socket.IO and the Yjs connection.
- Granting write takes effect on the next message with no reconnect.
- Revoking write closes the Yjs socket with 4403.
- Clear by a Host works; clear by a Joiner does not.
- A guest-hosted room: after activity, no Board document exists in Mongo.
- Dashboard queries: guest gets 403; a co-host sees the board under Managed; a promoted Joiner moves from Shared to Managed.

### Layer 3: regression tests

Every bug gets one test that would have caught it. For this project: a startup test that fails if issuing a ticket throws; a test that join-room validates before loading; a test that the Yjs provider does not recurse on close.

### What industry adds

- Tests run on every push in CI (GitHub Actions), and a failing test blocks the merge.
- Static analysis: CodeQL or Semgrep.
- Dependency scanning: npm audit and Dependabot.
- Secret scanning to catch a committed .env.
- Dynamic scanning against a running instance: OWASP ZAP.
- A short written threat model reviewed with the code (section 18 is a starting point).
- For serious products: an external penetration test and sometimes a bug bounty.

### Manual checklist (until automated tests exist)

1. Public room, two windows: Joiner is View only; host ticks draw; Joiner draws immediately with no reload.
2. Host unticks draw: Joiner's tools grey out, earlier strokes remain.
3. Private room: Joiner sees Waiting; host sees Allow and Deny; Allow enters.
4. In a Joiner's devtools, open a raw WebSocket to /yjs/\<room> without a ticket: it fails.
5. Kick: Joiner sees removed; Request again says to wait; works after a minute.
6. Close the host tab for about 15 seconds: the earliest co-host becomes host. With no co-host, the banner shows and everyone is read-only; the owner's return unlocks.
7. Guest-hosted room: nothing appears in MongoDB, and no history shows for anyone.

---

## 23. Interview questions and model answers

Answer shape that works: one sentence with the conclusion, then the reason, then the trade-off. Keep each answer to about 30 to 60 seconds.

### A. The big picture

**Q: Describe the RBAC system in two minutes.** It is a real-time whiteboard with three roles: Host, Co-host, and Joiner. Identity comes from verified JWTs, with server-issued guest tokens for guests. Private rooms have a lobby where managers approve joiners. On approval the server issues a short-lived, single-use, room-bound ticket. The Yjs WebSocket server verifies that ticket at the upgrade, so a client that skips Socket.IO cannot connect. Write permission is checked server-side on every mutating Yjs message before it is merged. The UI only mirrors permissions for feedback.

**Q: Where exactly is the security boundary?** Two places on the server: the upgrade handler, which decides who may connect to the data plane at all, and the pre-merge gate, which decides what a connected user may change. Client-side greying out is only usability.

**Q: What did you build versus what already existed?** The whiteboard and Yjs sync already existed, with rate-limiting and structural validation. I designed and added identity verification, the role matrix, the lobby and tickets, the write gate, failover, kick, guest handling, persistence rules, REST authorization, the dashboards, and the client state machine and gating.

**Q: What was the hardest part?** The boundary between two servers. Socket.IO and the Yjs WebSocket handler are separate connections, so admission needed a signed bridge, and kick needed a shared identity registry to close both. Close behind that was making revocation correct: a revoked user must stop writing instantly and must not push stale operations later.

**Q: What would you do differently?** Write the integration tests for the /yjs boundary first, before the client work. I would also read environment variables lazily from the start, which cost me a debugging session.

**Q: Is the system finished?** The design and code are complete and the core flows were tested by hand. Automated tests, failover verification under load, and a multi-process story are the next steps, and I can say exactly what each would involve.

### B. Identity and tickets

**Q: How do you verify identity?** A JWT is checked with a pinned algorithm on every Express request and on the Socket.IO handshake. The Yjs endpoint does not take the JWT. It takes a ticket that carries the already verified identity. No role decision reads an id from a client payload.

**Q: Why pin the algorithm?** To stop algorithm-confusion attacks, where a token claims the none algorithm or switches algorithm to bypass signature verification. The server states which algorithm it accepts rather than trusting the token header.

**Q: Why a separate ticket instead of the JWT on the WebSocket URL?** Browsers cannot set headers on a WebSocket handshake, so the JWT would go in the query string, where logs and proxies capture it, and a 24 hour token is replayable. The ticket lives 60 seconds, works once, and is tied to one room and one identity.

**Q: What stops a stolen ticket from being replayed?** The jti is recorded when redeemed, so a second use fails. It also expires in 60 seconds, is bound to one room, and the identity must still be admitted at the moment of the upgrade.

**Q: Why a different secret for tickets?** Separation of concerns. A leaked ticket secret cannot forge login tokens, and vice versa. Different audience claims also stop one type being accepted as the other.

**Q: How do guests work?** POST /api/auth/guest returns a signed token with a server-generated guest id and a generated name. The client keeps it in sessionStorage, so refresh keeps the identity and closing the tab loses it. Guest ids are namespaced with g: so they cannot collide with user ids, and guests are never stored in MongoDB.

**Q: What is the downside of a stateless JWT here?** It cannot be revoked before expiry. For this app the exposure is small, but options are short expiry with refresh tokens or a token-version check.

### C. Yjs and enforcement

**Q: What is a CRDT, and why does it matter for security?** A conflict-free replicated data type merges concurrent edits deterministically without a central lock. Yjs applies any valid update it receives. So the doc itself has no concept of permission: any client with a connection can try to change anything. That is why authorization must happen before the update reaches the doc.

**Q: Why not store permissions in a Yjs map?** Any client can write to a Yjs map and the CRDT will merge it. A user could grant themselves write access. We use Socket.IO roster events for UI feedback and server memory for decisions.

**Q: How does the write gate work?** It wraps the y-websocket message listener. For each frame it parses the type byte and sync subtype. Reads (subtype 0) and awareness pass. Mutations (subtypes 1 and 2) require canWrite from roomState, looked up live. A view-only user's mutation closes the socket with 4403 before the update is merged.

**Q: Why check before merging instead of reverting afterward?** After a merge, peers already received the change, and reverting means deleting data, which can destroy someone else's work. Rejecting before the merge means bad data never exists.

**Q: Why close the socket instead of ignoring the bad update?** Ignoring it leaves the client holding a diverged local document. If write access were granted later, that client would send stale operations. Closing forces it to discard the doc and resync from the server.

**Q: What are sync step 1, step 2, and update?** Step 1 is a request containing the sender's state vector. Step 2 is the reply with the updates the requester is missing. Update is an incremental change. Step 1 is a read, so it is allowed for everyone. Step 2 and update carry data, so they are gated. An empty update from a read-only client is the normal reply and is ignored.

**Q: How do you detect a bulk delete before merging?** Decode the update with Y.decodeUpdate to get its delete set, then look up the targeted items in the server doc and count the live top-level stroke entries. If the count exceeds 100, reject. The scan is capped so a hostile delete set cannot make the server spin.

### D. Roles, failover, and kick

**Q: Why are owner and acting host separate fields?** Owner is the permanent identity of the board's creator. Acting host is whoever currently holds Host powers. Keeping them apart makes failover and reclaim trivial: promote a co-host by changing actingHostId, and give control back by setting it to ownerId again. The co-host never lost its co-host entry or its grantedAt order.

**Q: How does failover choose the new host?** After a 15 second grace window, the server picks the online co-host with the earliest grantedAt. A monotonic counter guarantees a strict order even for promotions in the same millisecond. If there is none, the room locks instead of closing.

**Q: Why a grace window?** A page refresh disconnects and reconnects within a second or two. Without a grace window, every refresh would demote the host and flicker the whole room.

**Q: What happens with no co-host?** The room stays open but locked: canWrite returns false for everyone. Nobody can assign a host, because that would let a Joiner promote themselves. The owner returning unlocks it. For guest rooms the 10 minute empty timer is the other exit.

**Q: Why a lock flag instead of setting everyone's canWrite to false?** The flag overrides at check time and leaves stored grants intact. When a host returns, the previous write permissions come back with no bookkeeping.

**Q: How does kick close two connections on two different servers?** Both connections register in a registry keyed by the same server-verified identity id: the Socket.IO socket from the handshake JWT, and the Yjs socket from the ticket. Kick walks the registry for the target and closes every socket in both sets. A client cannot register under another identity because both ids come from signatures.

**Q: What is the difference between kick and revoking write?** Revoke is a permission change: the user stays in the room, keeps cursors and view, and only their Yjs socket is cycled with 4403 so they resync as read-only. Kick removes membership, closes both connections, and starts a 60 second cooldown.

**Q: Why must a co-host be unable to kick another co-host?** Otherwise co-hosts could remove each other, and the Host's ability to manage moderators would be undermined. The matrix lets a co-host kick only a target whose role is joiner.

### E. Persistence, guests, and dashboards

**Q: Why is persist update-only, with no upsert?** Rooms are now created explicitly. With an upsert, a late autosave could recreate a deleted board, and a guest room could be written to Mongo by accident. Update-only makes both impossible.

**Q: How do guest-hosted rooms avoid persistence?** The room carries persisted = false. bindState marks it ephemeral, writeState stashes the encoded doc in RAM instead of Mongo, the snapshot route returns 403, and the members saver skips it. The stash is deleted when the room ends.

**Q: What happens if a logged-in user joins a guest-hosted board?** They can draw if allowed, but it never reaches the database, so it never appears in their Shared with me list. The members saver skips non-persisted rooms.

**Q: Why $elemMatch in the dashboard queries?** To require userId and role to match on the same array element. Without it, conditions can match across different members of the array and return wrong boards.

**Q: How does a co-host see a board in Managed Boards?** The query is role-based: owner equals me, or I appear in members with role cohost. Promotion updates the member's role, so the board moves from Shared to Managed with no extra logic.

### F. Scaling, testing, and production

**Q: How would you scale this beyond one process?** Room state would move to Redis or be partitioned with sticky routing so each room lives on one process. Socket.IO would use the Redis adapter, ticket-spent tracking would move to a shared store, and y-websocket would need a shared persistence strategy. The pure permissions module and the event-based roomState make that migration easier.

**Q: Why in-memory state?** One process, small rooms, and the need for synchronous checks in the upgrade handler. Persisted data is in Mongo, and live state rebuilds from it. The trade-off is that a restart drops live presence and guest rooms.

**Q: How would you test the security boundary?** Integration tests that start the server and attack it with real ws and socket.io-client connections: no ticket, a reused ticket, a kicked identity, a raw update from a view-only client, a bulk delete, a meta write. Plus a permission-matrix unit test and fake-timer tests for failover. Everything runs in CI.

**Q: What would you check before going to production?** HTTPS and wss, origins and URLs from environment variables, NODE\_ENV set to production so the debug route is off, long random secrets kept out of git, MongoDB network access restricted, debug logs removed, dotenv loaded first, and the /yjs integration tests passing.

**Q: What about CSRF and XSS?** API calls use a Bearer header, not cookies, so classic CSRF does not apply. XSS is the real risk because tokens live in browser storage. Mitigations are a strict CSP, careful rendering of user text, and possibly httpOnly cookies. The WebSocket upgrade checks Origin to prevent cross-site WebSocket hijacking.

**Q: What is IDOR and where did you prevent it?** Insecure direct object reference: accessing a resource by guessing its id. Board reads check live admission or Mongo ownership or membership before returning anything, so knowing a roomId is not enough.

### G. Behavioral and debugging

**Q: Tell me about a hard bug.** Strokes did not sync but cursors did. Cursors use Socket.IO and strokes use Yjs, so that split pointed at the Yjs plane. The debug endpoint showed no rooms, meaning no handshake ever completed. The cause was a client without a ticket being refused, which was also proof the boundary worked. Fixing the client exposed two more: a recursive close handler (the disconnect call re-fired the event it was handling) and React StrictMode spending the single-use ticket. I fixed them with a once-flag and a deferred connect.

**Q: How do you debug across multiple services?** Isolate by plane, add logs at each refusal point with the reason, check the network tab for the handshake status, and compare what each side believes. Never paste secrets into logs or chats.

**Q: How did you make decisions with the product owner?** I listed ambiguities as explicit questions: what take control means, whether co-hosts always write, whether a kick is a ban, who can clear, what counts as room end. Their answers became the permission matrix and the failover rules, written down once so code and tests match.

**Q: What did you learn?** Authorization belongs at the boundary and on the server; shared client-writable structures are never a trust anchor; order operations so failures leave no partial state; and tests are the only way a security rule stays true after the next change.

---

## 24. Cheat sheet

### The two-minute script

1. **What:** a collaborative whiteboard with Host, Co-host, and Joiner roles, private rooms with a lobby, and guest access.
2. **Identity:** JWT verified on every request and on the Socket.IO handshake; server-issued guest tokens; namespaced ids.
3. **Admission:** Socket.IO holds joiners in a lobby; on approval the server issues a 60 second, single-use, room-bound ticket; the Yjs upgrade handler verifies it and checks live membership.
4. **Enforcement:** a pre-merge gate looks up canWrite live per mutating message; bulk deletes and meta writes are rejected; read-only users keep cursors; revocation closes the Yjs socket with 4403.
5. **Operations:** failover with a 15 second grace and an owner who can reclaim; kick closes both connections through a shared identity registry; clear is server-only.
6. **Persistence:** logged-in boards and members in Mongo; guest rooms memory-only and deleted at room end.
7. **Honesty:** core flows tested by hand; automated integration tests are the next step.

### The one diagram to draw

```
 Joiner            Server (Socket.IO)         Manager         Server (/yjs upgrade)
   |--join-room------->|                         |                     |
   |   (private)       |--lobby:pending--------->|                     |
   |<--status pending--|                         |                     |
   |                   |<------join:resolve------|  (can admit?)       |
   |                   | add member, join room, issue ticket           |
   |<--admitted{ticket}|                         |                     |
   |--WS /yjs/room?ticket=...------------------------------------------>|
   |                   |      redeem ticket, check isAdmitted, 101      |
   |<=========== Yjs sync; every mutation passes canWrite =============>|
```

### Numbers to remember

| Setting | Value |
| --- | --- |
| Ticket lifetime | 60 seconds, single use |
| Login JWT / guest JWT | 24 hours / 12 hours |
| Host failover grace | 15 seconds |
| Empty room expiry | 10 minutes |
| Kick cooldown | 60 seconds |
| Bulk delete limit | 100 strokes per client message |
| Max strokes per board | 20,000 |
| Message rate | 200 per second, burst 400 |
| Bandwidth | 512 KB per second, burst 4 MB |
| Frame size limits | 4 MB sync, 64 KB other |
| Connection caps | 20 per IP, 50 per room, 500 rooms |
| Strikes | 3 strikes, then a 10 minute IP ban |
| Autosave / members save | 5 seconds / 500 ms debounce |
| Document cap | 12 MB (Mongo limit 16 MB) |
| Snapshot route | 10 per minute |
| API / login / guest limits | 120 per minute / 20 per 15 min / 200 per 15 min |
| Close codes | 4401 kicked, 4403 write denied or revoked, 4410 room ended |

### Glossary

- **RBAC:** role-based access control. Permissions attach to roles, and users get roles.
- **JWT:** a signed token carrying claims. jti is its unique id; sub is the subject; aud is the audience; exp is the expiry.
- **CRDT / Yjs:** a data type that merges concurrent edits without a central lock. Yjs is the library; y-websocket is its WebSocket sync server and client.
- **State vector:** a summary of which updates a peer already has. Sync step 1 sends it.
- **Delete set:** the part of a Yjs update that lists deleted items.
- **Awareness:** ephemeral presence data (cursors, live previews). Not stored in the document.
- **Upgrade handler:** the server code that decides whether an HTTP request becomes a WebSocket.
- **Control plane / data plane:** management traffic (Socket.IO) versus bulk content traffic (Yjs).
- **Acting host:** whoever currently holds Host powers. The owner is the permanent Host.
- **Hostless / locked:** no host and no co-host is available, so everyone is read-only.
- **Pending / lobby:** a join request waiting for approval; the socket is not in the real room.
- **IDOR:** accessing another user's resource by guessing its id.
- **CSWSH:** cross-site WebSocket hijacking, stopped by checking the Origin header.
- **TDZ:** temporal dead zone, the error when a const is used before its declaration line runs.

### Interview do and do not

- **Do** lead with the principle: the server is the authority and the client is feedback.
- **Do** name the two boundaries and what each one stops.
- **Do** explain one real bug with symptom, cause, fix, and lesson.
- **Do** state what is verified and what is planned.
- **Do not** claim automated test coverage, load testing, or multi-server support you have not built.
- **Do not** call it unhackable. Say what it defends against and list the known limits in section 21.

*End of document.*
