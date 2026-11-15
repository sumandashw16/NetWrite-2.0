# Security Hardening: Whiteboard Backend

What was hardened, why, how each defense works, the bugs we hit while building it, what is verified and what is not, and how to explain it all in an interview.

**Stack:** Node/Express · `ws` + `y-websocket` (Yjs relay) · Socket.IO (cursors only) · MongoDB (Mongoose)

> **Honest status note:** the guard layers were tested with a script (`test-guard.mjs`). The envelope (frame) check had a bug that was diagnosed but **not yet re-verified** against real traffic, and **authentication is not implemented**. Both are listed in section 12. Say this plainly in an interview; it shows you know what is done versus what is claimed.

---

## 1. The 30-second pitch

> "The whiteboard server is a Yjs relay, so the main risk is an untrusted client sending binary CRDT updates. I put layered defenses in front of it. Layer one drops any WebSocket frame over 64 KB before it is parsed. Layer two is a token-bucket rate limiter on messages and bytes per connection. Layer three validates what actually lands in the server's Y.Doc, including field types, ranges, and sizes, and removes and disconnects the sender if it's invalid. Around that I added origin checks, connection caps, room-id validation, a strike-based ban, error handlers that stop a bad packet from crashing the process, and standard Express hardening. A try/catch alone isn't enough, because a malformed update can be perfectly valid CRDT binary and still contain nonsense, so the semantic check is the important layer."

---

## 2. Threat model

| Attacker goal | Example | Defense |
|---|---|---|
| Crash the server | Oversize frame, malformed bytes, bad URL, unhandled promise rejection | Size cap, error handlers, try/catch, process safety nets |
| Exhaust memory | Huge strokes, millions of strokes, thousands of rooms, giant JSON body | Stroke/point caps, room cap, per-IP/room connection caps, body limit |
| Exhaust CPU / bandwidth | 10,000 tiny messages per second | Message and byte rate limits |
| Corrupt shared data | Stroke with `NaN`, wrong types, 5 million points, junk fields | Semantic validation + removal |
| Hijack from another site | Malicious web page opens a WebSocket to your server | Origin allow-list, CORS restriction |
| Brute-force login | Password guessing | Strict limiter on `/api/auth` |
| Keep coming back | Reconnect loop after being kicked | Strike counter and temporary IP ban |
| Read/modify someone's board | Guess a room id | **Not solved yet: needs authentication** (section 12) |

---

## 3. Defense in depth (the layers)

```
 Client ──► [HTTP upgrade gate] ──► [Layer 1: size] ──► [Layer 2: rate] ──► [Frame envelope check]
                                                                                    │
            kick + strike  ◄──── [Layer 3: doc guard: validate what lands in Y.Doc] ◄┘
```

The upgrade gate runs once per connection. Layers 1 and 2 run on every message, before anything is decoded. Layer 3 runs on what the CRDT actually applies. Cheap checks come first so an attacker costs the server as little as possible.

---

## 4. Layer 1: size limit

- **What:** the WebSocket server is created with `maxPayload: 64 KB`. The `ws` library rejects larger frames and closes with code `1009`. The guard also checks `data.byteLength` and kicks on anything oversize.
- **Why 64 KB and not 10 KB:** a drag or rotate update is a few bytes, but a long simplified stroke, or a client reconnecting after being offline, can be 20-60 KB. A 10 KB cap would disconnect legitimate users. If you want it tighter, change `MAX_MESSAGE_BYTES`.
- **The crash bug I introduced and fixed:** `ws` reports an oversize frame as an `error` event. With no listener, Node throws on an unhandled `error` event and the process dies, so my first version let an attacker crash the server with one big packet. The fix is `ws.on('error', ...)` that logs a warning. Verified by test 1: the log shows `ws error: Max payload size exceeded` and the server stays up.
- **Also:** text frames are rejected (the protocol is binary only).

## 5. Layer 2: rate limit

- **What:** two token buckets per connection:
  - messages: 200/s sustained, 400 burst
  - bytes: 512 KB/s sustained, 1 MB burst
- **Token bucket in one sentence:** the bucket refills at a steady rate up to a burst capacity, each message spends tokens, and an empty bucket means "too fast". It allows normal bursts but stops sustained floods.
- **Why 200/s and not 60/s:** the client writes to Yjs on every pointer move, which can reach 144 per second on a high-refresh monitor. 60/s would kick real users.
- **Why a byte budget too:** 200 messages of 64 KB each is still 12 MB/s, so the message count alone doesn't bound bandwidth.
- **Verified by test 2:** a flood of valid messages produced exactly one `message rate limit` kick.
- **Socket.IO (cursors):** a per-socket limiter of 60/s sustained, 120 burst, plus `maxHttpBufferSize: 10 KB`. The client cursor emit was throttled to about 30/s so legitimate users stay well under it.

## 6. Layer 3: the document guard (structure and meaning)

The server keeps a `Y.Doc` per room in RAM (for persistence), so every update is applied to it. `installDocGuard` hooks that doc.

**What it checks:**
- **Root types:** only `strokes` and `meta` may exist. A client can't create an extra giant root map.
- **Stroke shape:** each stroke must be a `Y.Map` whose key equals its `id`, has `points`, and contains only known fields.
- **Field validation:**

  | Field | Rule |
  |---|---|
  | `id` | string, 1-64 chars |
  | `userId` | string, up to 128 chars |
  | `color` | `#` plus 3-8 hex digits (blocks `javascript:` and other junk) |
  | `width` | number, greater than 0, up to 200 |
  | `x`, `y` | finite, within ±1,000,000 |
  | `scaleX`, `scaleY` | finite, absolute value between 0.01 and 100 |
  | `rotation` | finite, absolute value up to 10,000 |
  | `points` | array, even length, 2 to 20,000 values, all finite and within ±1,000,000 |

- **Counts:** at most 20,000 strokes per room.
- **Edits to existing strokes:** only transform fields (`x`, `y`, `scaleX`, `scaleY`, `rotation`) may change, and only to valid values. You can't rewrite someone's `points` or `id`.
- **Deletes** are always allowed (the eraser uses them).
- **Only remote clients are policed:** updates the server itself makes (loading from MongoDB, cleanup) carry a non-connection origin and are skipped.

**What happens on violation:** the connection is kicked (and a strike recorded), and the invalid strokes are removed from the doc in a microtask, so the bad data doesn't stay in RAM or reach MongoDB.

**Why this is the real defense:** the original idea was "wrap the update in try/catch". That only catches structurally broken bytes. A well-formed update can contain `color: 'javascript:alert(1)'` or a 5-million-point array and apply perfectly. try/catch never fires for it. **Verified by test 5:** a valid update containing an invalid stroke was caught and the sender kicked.

**Malformed bytes:** observed in our logs, `y-protocols` catches decode errors itself and logs `Caught error while handling a Yjs update`, so the state is unchanged and the server survives. That means try/catch around `applyUpdate` was never going to produce a kick, and it is why we validate the envelope separately (next section).

## 7. Frame envelope check (and the bug that took three rounds)

- **What:** before y-websocket sees a message, parse just the envelope: message type (sync, awareness, query-awareness), sync subtype (0-2), and the length-prefixed body. Reject unknown types and truncated frames. The Yjs update inside is **not** decoded here.
- **Why:** to kick a client that sends malformed frames, which y-protocols would silently drop.
- **The bug:** the check flagged every valid browser message as `Unexpected end of array`. `y-websocket` sets `binaryType = 'arraybuffer'`, so `ws` delivers an `ArrayBuffer`. lib0's decoder expects a `Uint8Array`, so every read returned `undefined`. The code converted to `bytes` but still called `frameError(data)`, which was caught by Antigravity's review. The fix is `frameError(bytes)`.
- **How the diagnosis went wrong first:** my first guess blamed `Y.decodeUpdate` and `Y.decodeStateVector` misparsing valid frames, and I removed them. That wasn't the cause. Decoding the logged hex by hand showed the frames were valid, which pointed at the input type instead. **Lesson:** log the real bytes and decode by hand before theorizing.
- **Rollout safety:** an `ENFORCE_FRAME_CHECK` flag. While `false`, bad frames are only logged, so a parser bug can't kick real users. Procedure: fix, confirm zero `bad frame` lines during normal drawing, then set it to `true`.
- **Status:** the fix is applied but **not yet confirmed against real traffic**. Garbage packets are still dropped by y-protocols while the flag is off.

## 8. Connection-level defenses (the upgrade gate)

All checked before the WebSocket handshake completes, so refused clients cost almost nothing:

| Check | Value | Result |
|---|---|---|
| Path | must start with `/yjs/` (others are left to Socket.IO) | skip |
| URL parsing | wrapped in try/catch (`decodeURIComponent` throws on `%`) | 400 |
| Room id | `^[A-Za-z0-9_-]{1,64}$` | 400 |
| Origin | must be in `ALLOWED_ORIGINS` (default `http://localhost:5173`) | 403 |
| Banned IP | see strikes | 429 |
| Connections per IP | 20 | 429 |
| Connections per room | 50 | 429 |
| Total rooms in RAM | 500 | 503 |

- **Origin check:** stops cross-site WebSocket hijacking. Browsers always send `Origin`, and a page on another site can't forge it. Non-browser clients can, so this isn't authentication.
- **Raw-socket error handler:** `socket.on('error', () => {})` on the upgrade socket, since `ECONNRESET` there would otherwise be an unhandled error.
- **Refusals log their reason** (a debugging aid added after a confusing 429 run).

## 9. Strikes and temporary bans

- **Why:** `y-websocket` clients auto-reconnect, so a bare disconnect does nothing against a hostile client.
- **How:** each kick adds a strike. Three strikes within an hour means a 10-minute IP ban (refused at the upgrade gate). Strikes older than an hour expire, so one old mistake doesn't ban someone months later.
- **Bugs found and fixed:**
  1. **One kick counted many times.** `terminate()` doesn't stop messages already received, so one flood produced about 45 kicks and banned `::1` instantly. Fixed with a `kicked` flag: one kick and one strike per connection, and later messages on that connection are ignored.
  2. **Strikes never decayed** (Antigravity's review): counts of 1 or 2 lived forever. Fixed with a time window.
  3. **Localhost bans** blocked local development. Loopback addresses are exempt unless `GUARD_BAN_LOOPBACK=1` is set.
- **Limitation:** bans are per IP, in memory, and lost on restart. Many IPs or a shared NAT make this imperfect; real protection needs a proxy or CDN.

## 10. Crash-proofing the process

| Crash path | Fix |
|---|---|
| Unhandled `error` on `ws` (oversize frame) | `ws.on('error')` handler |
| `decodeURIComponent` throwing in the upgrade handler | try/catch, 400 response |
| `ECONNRESET` on the raw upgrade socket | no-op error handler |
| Mongo failure in `bindState` or `writeState` (unhandled rejection, which crashes Node 15+) | try/catch around load and save; failures are logged |
| Handler throwing while processing a message | try/catch in the guard wrapper, then kick |
| Anything else | `process.on('unhandledRejection')` and `'uncaughtException'` log instead of dying |

The process-level handlers are a last resort, not a design. In production, run under a supervisor (pm2 or systemd) so a genuinely bad state restarts cleanly.

## 11. Persistence safety and Express hardening

**Persistence**
- **Never overwrite a good board with an empty one:** `writeState` awaits the load task first. If loading failed, it refuses to save.
- **Size cap:** state over 12 MB isn't saved (Mongo's document limit is 16 MB), and the failure is logged instead of failing silently forever.
- **No junk boards:** an empty doc for a room that doesn't exist in Mongo isn't saved, so random room ids don't create empty documents.
- **Autosave** is debounced (5 s) and flushes when the last client leaves.

**Express**
- `helmet()`: standard security headers.
- CORS restricted to the client origin (was open to everyone).
- JSON body limit lowered from 50 MB to 100 KB (the save route ignores the body now).
- `express-rate-limit`: 120 requests/minute on `/api`, and a stricter **20 per 15 minutes on `/api/auth`** against brute force. Limiters must be registered **before** the routes they protect.
- Behind a reverse proxy, set `app.set('trust proxy', 1)` so each user gets their own limit.

## 12. What is NOT done (say this before they ask)

- **No authentication.** Anyone who knows a room id can connect, and `GET /api/boards/:roomId` returns any board. The fix: issue a JWT at login, pass it as a query param to `WebsocketProvider`, verify it in the `upgrade` handler and on the REST routes, and check board membership.
- **Frame check not yet verified against real traffic** (section 7). Keep the enforce flag off until two real tabs produce zero `bad frame` lines.
- **`cursorHandler.js` and `authRoutes.js` weren't reviewed.** In the cursor handler: use `socket.data.roomId`, not the payload's room id, validate `x`/`y` as numbers, cap `username` length. In auth: check password hashing, input types, and token handling.
- **Per-IP controls are weak against many IPs;** real protection needs a proxy/CDN.
- **Stray root types** from an attacker stay in the doc's internal structures after the sender is kicked (they're kicked once per root name so later users aren't punished). The 12 MB save cap and 64 KB message cap limit the damage but don't remove it.
- **A failed room load** leaves clients editing an empty doc that `writeState` then refuses to save. This is the safe choice, but those edits are lost.
- **No audit log or alerting** beyond console warnings.

---

## 13. Bugs and lessons (good "tell me about a bug" stories)

1. **Unhandled `error` event on oversize frames:** my own code created a one-packet crash. Lesson: any EventEmitter without an `error` listener is a crash waiting to happen.
2. **try/catch was the wrong tool for layer 3.** y-protocols swallows decode errors itself, and valid binary can carry invalid data. Lesson: validate meaning, not just structure.
3. **One kick counted ~45 times and banned my own machine:** `terminate()` isn't instant. Lesson: make actions idempotent per connection.
4. **ArrayBuffer vs Uint8Array in the frame check:** a type mismatch looked like a protocol parser bug. Lesson: print the actual bytes and the actual types before changing logic. (The first diagnosis was wrong, and I removed correct code for no reason.)
5. **Duplicate Yjs copies (ESM vs CJS):** `y-websocket/bin/utils` is CommonJS, so it loads Yjs's CJS build, while `import * as Y from 'yjs'` loads ESM. Two copies in one process mean constructor checks fail. Fixed by loading Yjs through `createRequire` in `yjsShared.js` so the whole server uses one copy. `npm ls` showed a single version, because it was one package loaded twice at runtime.
6. **Test-only noise:** 429s in test runs came from the ban system working. Logging the refusal reason made it visible.

---

## 14. How to test

`test-guard.mjs` (start the server first; restart between runs to clear bans):

| Test | Expected |
|---|---|
| 1 oversize (200 KB) | closes `1009`, server stays up |
| 2 flood of valid messages | one `message rate limit` line, closes `1006` |
| 3 garbage frame `[0,2,255,255,255,255]` | one `malformed frame` kick (once the enforce flag is on) |
| 4 bad origin | refused with `403` |
| 5 valid update with an invalid stroke | `invalid stroke data` kick, closes `1006` |

Also check:
- **Normal use:** two real tabs, draw, move, rotate and erase for a minute. Expect **zero** `bad frame` and no `[guard] disconnecting` lines.
- **Ban:** start with `GUARD_BAN_LOOPBACK=1`, run the tests twice, expect `429` with `is banned` in the log. Then unset it.
- **Rate limiter on login:** call `/api/auth/login` about 25 times quickly; expect `429` after 20.
- **Persistence:** after tests, confirm no `guard-test` board document exists in Atlas.

---

## 15. Likely interview questions, with answers

**Q: How do you protect the server from malicious Yjs updates?**
Three layers. A size cap before parsing, a token-bucket rate limit on messages and bytes, and a document-level guard that validates every stroke that lands in the server's Y.Doc, including types, ranges, and lengths, then removes the bad data and disconnects the sender. The first two protect resources; the third protects data integrity.

**Q: Why isn't try/catch around `applyUpdate` enough?**
It only catches structurally broken binary. A well-formed update can still contain invalid values like a bad color or a huge array. Also, in our setup y-protocols catches decode errors itself and just logs them, so nothing would reach my catch block.

**Q: What's a token bucket?**
A counter that refills at a fixed rate up to a maximum. Each message costs a token. Normal bursts pass, sustained floods drain it and get cut off.

**Q: Why 64 KB and 200 messages per second?**
They were chosen from real behavior: long simplified strokes or an offline reconnect can reach tens of KB, and the client sends an update per pointer move, which can be 144 per second. Tighter numbers would disconnect legitimate users. They're constants in one file, so they're easy to tune with real data.

**Q: How do you stop cross-site WebSocket hijacking?**
I check the `Origin` header against an allow-list at the upgrade request. Browsers always send it and pages can't forge it. It isn't authentication, since a non-browser client can set any header.

**Q: What stops someone reconnecting after being kicked?**
A strike counter per IP. Three strikes in an hour gives a 10-minute ban, refused at the HTTP upgrade before any WebSocket resources are allocated. It's in-memory and per IP, so against many IPs you'd need a proxy or CDN.

**Q: What was the trickiest security bug?**
The frame validator rejecting all valid browser traffic. It looked like a protocol-parsing bug, and I wrongly blamed the Yjs decoders first. The real cause was that y-websocket delivers messages as an ArrayBuffer, but lib0's decoder needs a Uint8Array. I found it by decoding the logged bytes by hand: the frames were valid, so the input type had to be wrong. A reviewer then spotted that I'd computed the converted value but passed the original variable.

**Q: Why did you roll out the frame check in log-only mode?**
A false positive disconnects real users, which is worse than missing a malformed packet. So the check logged at first and I only enable enforcement after confirming normal traffic passes with zero flags.

**Q: How do you prevent a crash from one bad packet?**
Error handlers on every emitter that can throw (ws, raw upgrade socket), try/catch around URL parsing, message handling, and the Mongo calls, and process-level handlers as a last resort. In production I'd also run under a supervisor.

**Q: Why were there two copies of Yjs even though `npm ls` showed one?**
One installed package can be loaded twice at runtime: once as ESM through my imports and once as CommonJS through y-websocket's `bin/utils`. They have different class objects, so constructor checks fail. I load Yjs through `createRequire` in one shared module so the whole server uses the CJS build.

**Q: How would you add authentication?**
Issue a JWT at login. The client passes it as a query parameter to `WebsocketProvider`. The server verifies it in the `upgrade` handler before accepting the connection, and checks the user's access to that room. The REST board routes get the same middleware. I'd also move the user id from the client-supplied `userId` field to the verified token.

**Q: What are the remaining weaknesses?**
No authentication, so room ids act like passwords. Per-IP defenses are weak against distributed attacks. A stray root type remains in the doc after the sender is kicked. And the cursor and auth handlers still need a review. I'd fix auth first.

**Q: How do you know it works?**
A test script covering oversize, flood, garbage, bad origin, and a semantically invalid update, plus a normal-use check that nothing legitimate is kicked. The log shows each kick with its reason. One test, the garbage frame, only passes after the enforce flag is turned on, and I treat that as unverified until then.

**Q: What would you monitor in production?**
Counts of kicks by reason, refused upgrades by reason, active rooms and connections, memory per room, save failures, and rejected state sizes, with alerts on spikes.
