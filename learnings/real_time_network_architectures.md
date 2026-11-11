# Real-Time Network Architectures: P2P vs. Client-Server

When designing distributed real-time systems, choosing how users connect dictates the scalability, cost, and latency of your application. The two fundamental architectures are **Peer-to-Peer (Mesh Topology)** and **Client-Server (Star Topology)**.

---

## 1. Peer-to-Peer (Mesh Topology)
In this model, every client connects directly to every other client in the room without a central server acting as a middleman. On the modern web, this is implemented using **WebRTC** (Web Real-Time Communication).

### The Math (Graph Theory)
If you treat the network as a graph, a fully connected mesh has an $O(N^2)$ time/space complexity for network links. The exact formula for the total number of connections is $\frac{N(N-1)}{2}$.
* **4 users:** 6 total connections (each user maintains 3).
* **10 users:** 45 total connections (each user maintains 9).
* **100 users:** 4,950 total connections.

### Pros
* **Zero Server Costs:** Data flows directly between browsers. You do not pay for cloud infrastructure to route the traffic.
* **Absolute Lowest Latency:** Data takes the shortest physical path across the internet.
* **Native Privacy:** Connections are natively end-to-end encrypted. A server cannot intercept the data because it never touches one.

### Cons
* **Client CPU/Bandwidth Death:** In a 50-person WebRTC room, a user's laptop must encode and upload their data stream 49 separate times simultaneously. This drains battery rapidly and chokes standard network cards.
* **No Central Truth:** Without a server, saving the final state (like a collaborative document) to a database is highly complex due to synchronization conflicts.

---

## 2. Client-Server (Star Topology)
In this model, every user opens exactly one connection to a central server. When User A acts, they send the data once to the server, which then duplicates and broadcasts it to the rest of the room. This is implemented using **WebSockets** (e.g., Socket.IO).

### The Math (Graph Theory)
This architecture scales linearly at $O(N)$. The total number of connections is exactly $N$.
* **4 users:** 4 connections.
* **10 users:** 10 connections.
* **100 users:** 100 connections.

### Pros
* **Extremely Lightweight for Clients:** A user uploads their data stream exactly once, regardless of whether there are 3 people in the room or 3,000.
* **Absolute Control & State:** The central server acts as the single source of truth. It makes it trivial to save data to a database (like MongoDB), authenticate users, and validate payloads.

### Cons
* **The Server Pays the Bill:** Your infrastructure must absorb the bandwidth and CPU costs of duplicating and routing all messages.
* **Single Point of Failure:** If the central server crashes, every user instantly disconnects.
* **Slightly Higher Latency:** Data must travel to the data center and back, rather than traveling straight to the peer.

---

## 3. System Design Verdict (Interview Cheat Sheet)

**Choose Peer-to-Peer (WebRTC) for:**
* 1-on-1 video or audio calls (e.g., WhatsApp).
* File sharing applications (e.g., BitTorrent).
* Scenarios requiring ultra-low latency with very small user counts (under 5 people) where you want to minimize hosting costs.

**Choose Client-Server (WebSockets) for:**
* Collaborative whiteboards and document editing (e.g., NetWrite, Figma).
* Multiplayer tactical games (e.g., Valorant) where a server must act as a referee to prevent cheating.
* Chat applications (e.g., Discord, Slack) where rooms can have hundreds of participants.

---

## 4. Advanced Architectural Patterns

To bridge the gaps between these two models, enterprise systems use hybrid architectures:

1. **The SFU (Selective Forwarding Unit) for Video:** 
   How does Google Meet host 100 people without melting phones? It uses WebRTC, but connects each client to a central SFU server (Star Topology). You upload your video once, and the SFU acts as a massive router, sending it down 99 separate WebRTC pipes. It provides WebRTC latency without the $O(N^2)$ client bandwidth penalty.
2. **Concurrency Control (CRDTs vs. OT):** 
   If two people edit a document at the exact same millisecond, network latency causes sync issues. **Operational Transformation (OT)** (used by Google Docs) requires a central server to calculate latency and referee the exact order of operations. **CRDTs (Conflict-free Replicated Data Types)** (used by Figma) use advanced math so operations can be applied in *any* order locally, and the final state will mathematically always match, allowing for seamless merge resolution.
3. **Server-Sent Events (SSE):** 
   If data only flows one way (e.g., live sports scores, stock tickers), WebSockets are overkill. SSE keeps a standard HTTP connection open to continuously stream text data down to the client. It saves RAM, works natively with load balancers, and utilizes built-in browser reconnection logic.