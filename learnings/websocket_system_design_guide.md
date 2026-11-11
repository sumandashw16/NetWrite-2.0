# WebSocket Architecture & System Design Guide

This document serves as an interview-ready reference guide for WebSocket implementation, covering foundational concepts, resource trade-offs, security, and enterprise scaling.

## 1. WebSockets vs. HTTP (The Core Problem)
Traditional HTTP is unidirectional and stateless. The server can never initiate contact; the client must always ask for data.

*   **The HTTP Long Polling Problem:** To simulate real-time apps with HTTP, clients must constantly ping the server (*"Any updates?"*). This creates massive overhead because every request carries ~800 bytes of headers (cookies, user-agents, auth tokens).
*   **The WebSocket Solution:** WebSockets create a persistent, full-duplex (two-way) connection. The server can push data to clients instantly without waiting to be asked. Data frames are lightweight (2-10 bytes of overhead), stripping away heavy HTTP headers.

## 2. How the Connection Works (The Handshake)
WebSockets start as standard HTTP requests before transforming.
1.  **Upgrade Request:** The client sends an HTTP GET request with headers: `Connection: Upgrade` and `Upgrade: websocket`.
2.  **101 Status Code:** The server responds with `101 Switching Protocols`.
3.  **TCP Tunnel:** The HTTP protocol is discarded, leaving the underlying raw TCP socket open for continuous, lightweight binary/text data flow.

## 3. Native WebSockets vs. Socket.IO
In production, we rarely use the native HTML5 `new WebSocket()` API. We use wrapper libraries like **Socket.IO** because they provide enterprise features out-of-the-box:
*   **Automatic Reconnection:** Handles exponential backoff if a user's Wi-Fi drops.
*   **HTTP Fallback:** Falls back to HTTP Long Polling if corporate firewalls block WS ports.
*   **Rooms / Namespaces:** Built-in APIs (`socket.join(roomId)`) to easily isolate broadcasts.
*   **Event Emitting:** Allows labeled custom events (`socket.emit('draw', data)`) instead of parsing raw string data.

## 4. Resource Trade-Offs (Interview Cheat Sheet)

| Resource | HTTP (REST) | WebSockets | Why? |
| :--- | :--- | :--- | :--- |
| **CPU** | **High** | Low | HTTP requires constant 3-way handshakes, TLS negotiation, and string-parsing for headers. |
| **Bandwidth** | **High** | Low | HTTP sends massive, repetitive header data with every single request. |
| **Latency** | High (50-200ms) | **Low (1-10ms)** | WebSockets don't have to establish a connection before sending data. |
| **RAM (Memory)** | Low | **High** | WebSockets force the server to hold thousands of open TCP connections in active memory. |

**Key Takeaway:** WebSockets save CPU and Bandwidth to achieve sub-millisecond latency, but they are expensive on RAM. 

## 5. Security & Safety Standards
Because WebSockets remove HTTP firewalls to prioritize speed, they are highly vulnerable to Denial of Service (DoS) attacks and Memory exhaustion.

*   **Rate Limiting:** Hackers can write scripts to emit 10,000 events/second. You must track messages per `socket.id` and drop packets (or disconnect the user) if they exceed normal human limits (e.g., > 60 frames per second).
*   **Payload Validation:** Hackers can send 50MB strings instead of coordinate numbers to crash the server (Out of Memory error). Always validate data types (e.g., `typeof x === 'number'`) and size limits before broadcasting.
*   **WSS (WebSocket Secure):** Just like HTTPS, production sockets must run over WSS to encrypt the traffic via TLS.
*   **JWT Handshake:** Pass authentication tokens during the initial HTTP upgrade request to ensure only verified users can open a socket.

## 6. Advanced Scaling & System Design

### A. The "Ghost Connection" Problem (Ping/Pong)
If a user loses cell service or their battery dies, the browser cannot send a `disconnect` signal. The server keeps the connection in RAM forever. 
*   **Solution:** Heartbeats. The server sends a `ping` every ~25 seconds. If the client doesn't reply with a `pong` within 20 seconds, the server assumes they are a "ghost" and forcibly destroys the connection to free up RAM.

### B. Scaling Across Multiple Servers (Redis Pub/Sub)
When one Node.js server runs out of RAM, you spin up a second one. However, Server A cannot natively talk to Server B.
*   **Solution:** Put a **Redis** database behind them. When User 1 draws on Server A, Server A *publishes* the event to Redis. Redis instantly *broadcasts* it to Server B, which forwards it to User 2.

### C. The Load Balancer Trap (Sticky Sessions)
If you put an AWS Load Balancer in front of your servers, it might send the initial HTTP request to Server A, but route the subsequent Upgrade request to Server B (causing an instant crash).
*   **Solution:** Configure **Sticky Sessions** (IP hashing) on the Load Balancer to guarantee all requests from a specific user stay "stuck" to the exact same server during the handshake process.

### D. The State Gap (Handling Reconnection)
Socket.IO auto-reconnects offline users, but it does *not* queue missed events.
*   **Solution:** Listen for the client-side `reconnect` event. When it fires, trigger a standard HTTP `GET` request to your database to fetch the absolute latest state of the board, bridging the gap of what the user missed while offline.