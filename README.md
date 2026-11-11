<p align="center"><img src="public/logo.png" alt="Kairo" width="96" /></p>
<h1 align="center">Kairo</h1>
<p align="center">
  <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white" alt="React">
  <img src="https://img.shields.io/badge/TypeScript-7-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white" alt="Vite">
  <img src="https://img.shields.io/badge/Rust-WASM-000000?logo=rust&logoColor=white" alt="Rust and WebAssembly">
  <img src="https://img.shields.io/badge/WebGPU-Rendering-005A9C" alt="WebGPU">
  <img src="https://img.shields.io/badge/WebCodecs-Media-4285F4" alt="WebCodecs">
  <img src="https://img.shields.io/badge/Yjs-CRDT-2D8CFF" alt="Yjs">
  <img src="https://img.shields.io/badge/WebRTC-P2P-333333?logo=webrtc&logoColor=white" alt="WebRTC">
  <img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white" alt="Cloudflare Workers">
</p>
<p align="center"><b>A browser video editor with real-time co-editing, git-style branches, and end-to-end encryption.</b><br>Decoding, compositing, and export all run on your device. Video never touches a server.</p>

---

Kairo is a multi-track non-linear editor that runs entirely in Chrome. Multiple people can edit one timeline at once and see each other's cursors live. Any editor can branch a cut, work on it in isolation, review a visual three-way diff, and merge selected changes back into the main timeline.

The only server is a Cloudflare Worker with Durable Objects, and it relays encrypted edits — it cannot read project names, clip contents, text, file names, or presence. Media moves directly between browsers over WebRTC.

| | |
|---|---|
| **Frame-accurate seek** | 500/500 random and far seeks land on the exact frame (p50 2–43 ms, depending on GOP length) |
| **3-track 1080p playback** | 1799/1800 frames shown over 60 s, frame render p95 1.9 ms (WebGPU) |
| **On-device export** | 1080p H.264 at 8.2× real time |
| **Live co-editing** | 3.9 ms median round trip through the encrypted relay |
| **1 GB file to a collaborator** | playable at the playhead in 4.1 s via proxy; full original transfers at 31.6 MB/s |

<sub>Medians of 3 runs, Apple M5, Chrome for Testing 153. Full method and raw data in <code>benchmarks.md</code>.</sub>

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [Deploy](#deploy)
- [System design](#system-design)
- [Benchmarks](#benchmarks)
- [Testing](#testing)
- [Project layout](#project-layout)
- [Scripts](#scripts)
- [Limitations](#limitations)
- [Roadmap](#roadmap)

## Features

**Editing**
- Multi-track timeline (video, image, text, audio) with trim, split, snapping, ripple and multi-select moves, transitions, effects, color, undo/redo
- Frame-accurate seeking — time is stored as integer frames everywhere
- MP4 export (H.264 + AAC, up to 1080p), rendered and encoded locally with WebCodecs

**Playback**
- WebCodecs decoding in a worker, with decode-ahead, pre-roll before cuts, and a decode-order frame cache
- WebGPU compositing, with a Canvas 2D fallback
- Streaming audio through an AudioWorklet on the same clock as video (A/V drift under 21 ms max over 5 minutes)
- Handles rotated phone footage, variable frame rate, and 4K

**Collaboration**
- Live edits, cursors, and selections over a Yjs CRDT, with a timeline hash that proves every client has converged
- End-to-end encrypted (AES-256-GCM) — the key lives only in the invite link's `#k=` fragment
- Works offline (IndexedDB) and merges automatically on reconnect

**Large media, peer to peer**
- A 540p proxy is generated on import, so collaborators can start playing a file within seconds
- Originals transfer in 1 MiB, SHA-256-verified chunks from multiple holders at once, and resume after a disconnect
- Chunks around each collaborator's playhead are fetched first; export fetches any missing originals before rendering

**Version control**
- Branches with a visual three-way diff and selective merge
- Conflicts described in plain language (e.g. *"You trimmed 'Aurora.mp4' to 0:03.8 · Viraj trimmed it to 0:03.4"*), with thumbnails and a looping preview of the affected range
- Ripple and multi-select moves grouped into a single change; named versions you can restore or undo

## Quick start

Requirements: desktop Chrome (WebCodecs, WebGPU, OPFS) and Node.js 24+. Rust and `wasm-pack` are only needed if you're changing the engine — the compiled WASM is committed.

```bash
npm install
npm run dev        # sync server (:8787) + local TURN relay (:3478) + Vite (:5173)
```

Open `http://localhost:5173` and click **Open demo reel**. To collaborate, use **Share → Copy** and open the invite link in another browser profile. The `#k=…` part of the link is the encryption key.

For a production-like local run, where one Worker serves both the app and sync:

```bash
npm run serve      # vite build && wrangler dev --port 8787
```

**Configuration** — all optional. The `VITE_*` values go in `.env` (see `.env.example`); the TURN key is a Worker secret.

| Variable | Default | Purpose |
|---|---|---|
| `VITE_SYNC_URL` | the page's own origin | Sync server origin (`wss://…`) if it isn't the same host as the app |
| `VITE_ICE_SERVERS` | none | JSON `RTCIceServer[]` for your own STUN/TURN (e.g. coturn), baked in at build time |
| `TURN_KEY_ID`, `TURN_KEY_API_TOKEN` | unset (STUN only) | Cloudflare Realtime TURN key used by `/ice` — see [Peer-to-peer media needs TURN](#peer-to-peer-media-needs-turn) |

## Deploy

```bash
npx wrangler login
npm run deploy     # build + wrangler deploy (Worker + Durable Object + static assets)
```

Durable Objects use built-in SQLite storage, so there's no database to provision.

### Peer-to-peer media needs TURN

Edits sync through the Worker, but media files move directly between browsers over WebRTC. Out of the box the app gets only Cloudflare's STUN server, which works across many home NATs but not across symmetric NATs or corporate networks. Without a route, collaborators see a "Can't connect to a collaborator directly" message — demo-reel files still arrive from their public URL regardless.

To make transfers work everywhere, give the Worker a Cloudflare Realtime TURN key. The Worker mints short-lived TURN credentials, only for clients that hold the room key:

1. In the Cloudflare dashboard, go to **Realtime → TURN Server → Create** and copy the Turn Token ID and API Token.
2. Store them as Worker secrets:

   ```bash
   npx wrangler secret put TURN_KEY_ID
   npx wrangler secret put TURN_KEY_API_TOKEN
   ```
3. Deploy (`npm run deploy`). New sessions fetch TURN credentials automatically and refresh them before they expire.

The relay only ever carries DTLS-encrypted WebRTC traffic; files are never stored on a server. To use your own TURN server (e.g. coturn) instead, set `VITE_ICE_SERVERS` before building.

## System design

**Core principle:** compute stays on the client; only encrypted intent is synced.

| Heavy — stays on each device | Light — goes over the network, encrypted |
|---|---|
| Video files, decoding, frames, compositing, audio, export | Yjs timeline updates (tens of bytes each), presence (throttled to 20 Hz), WebRTC signaling |

Server cost doesn't grow with media size, and the server operator can't read projects.

### Architecture

```
┌──────────────── Browser (each user) ─────────────────┐
│ React UI → Yjs doc → Rust/WASM engine                 │
│              │        (render plan, diff/merge)       │
│              │        WebCodecs worker → WebGPU        │
│              │        OPFS media (by SHA-256)          │
│   IndexedDB ◀┤ (offline copy)                          │
│              ▼                                         │
│  WsProvider: AES-256-GCM seal/open                     │
└──────────────┬───────────────────────────────────────┘
               │ wss://<host>/sync/<roomHash>?t=<token>   (binary frames, ciphertext only)
┌──────────────▼──────────────── Cloudflare ────────────┐
│ Worker: serves static assets + routes /sync            │
│ Durable Object "Room" per roomHash (SQLite storage):    │
│   • token check (trust on first use)                   │
│   • relay frames to the other sockets                  │
│   • append encrypted updates; client snapshots          │
│     replace them on compaction                          │
└────────────────────────────────────────────────────────┘

Browser A ◀══ WebRTC DataChannel (DTLS) ══▶ Browser B     media bytes, peer to peer
```

| Component | Where | Responsibility |
|---|---|---|
| React UI | Browser | Dashboard, editor panels, timeline, merge screen |
| Yjs doc | Browser (replicated) | Source of truth for the timeline (CRDT) |
| Rust/WASM engine | Browser | Per-frame render plan, audio mix plan, three-way diff/merge |
| Decoder worker | Browser → hardware | WebCodecs H.264 decode, frame cache, pre-roll |
| Compositor | Browser → GPU | WebGPU layers, transitions, effects; Canvas 2D fallback |
| OPFS store | Browser disk | Media files and proxies, keyed by SHA-256 |
| WsProvider | Browser | Encrypted Yjs updates, awareness, and signaling |
| Worker + Durable Object | Cloudflare | Serves the app; relays and stores ciphertext per room |

### Security model

The project secret is 32 random bytes, created with the project. It travels only in the invite link's fragment (`/p/KAI-XXXXX#k=…`), which browsers never send to servers.

Per-room keys are derived with HKDF-SHA-256 over `kairo:{code}:{branch}`:

- **roomHash** — the room's id on the server, so the server never sees room codes or branch names
- **token** — proves you hold the key; the Durable Object stores its hash on first use and rejects any other token
- **enc** — the AES-256-GCM key for every frame

Every frame is `iv(12) ‖ ciphertext ‖ tag`. The IV is a random per-session prefix plus a counter, so it never repeats, and the AAD binds the message type and room so a frame can't be replayed as another type or into another room.

The server sees room hash, token hash, frame types and sizes, timing, and connection ids. It never sees content, names, or the key — it could drop or reorder frames, but it can't read or forge them.

### Key flows

**Playback and seek** — `seek(frame)` asks the WASM engine for a render plan (visible clips, source frame, transforms, transition progress). Per clip, a cache hit returns the frame directly; a miss restarts the decoder at the nearest keyframe and decodes forward. Frames are composited on WebGPU via `importExternalTexture` and drawn to the canvas. The clock follows the audio output clock; late frames are dropped, never delayed. One `VideoDecoder` is reused per active clip across jumps. The frame cache evicts in decode order under a fixed memory budget, so frames decoded ahead survive and already-shown frames go first.

**Real-time editing** — an edit becomes a Yjs update, which is sealed and sent to the Durable Object, which appends and relays it; the other client opens and applies it. Each clip is its own `Y.Map`, so concurrent edits to different fields both survive; for the same field, the last writer wins, and delete beats edit. On reconnect, the client works out what the server is missing and sends exactly that diff — no special offline queue. After 200 stored updates, the server asks a client for an encrypted snapshot to replace them, since the server can't merge Yjs itself.

**Media transfer** — a manifest (hash, size, chunk size, chunk hashes, time index) lives in the encrypted doc. A collaborator missing a file broadcasts "need"; holders answer "have," and a WebRTC DataChannel opens per peer pair. Chunks are requested from multiple holders at once, verified by SHA-256, and written to OPFS. Files taller than 540p get a 540p proxy generated locally first — playable within seconds — while the original continues transferring, prioritized by each collaborator's current playhead.

**Branch and merge** — creating a branch snapshots main into a new room, storing the snapshot as the merge base. Merging runs a three-way diff against that base, groups related changes (e.g. a ripple edit across several clips), and lets the user pick and resolve conflicts before applying the result as a single Yjs transaction. After a merge, the base advances, so merging again only shows what's new since.

### Data model

```
Room "kairo:{code}:{branch}"     // server only sees HKDF(roomName) → roomHash
  meta     { projectId, name, branch, parent, baseSnapshot, fps, width, height }
  media    { [sha256]: { kind, name, durationFrames, width, height, fps, hasAudio, codec } }
  tracks   { [id]: Y.Map { kind, name, order, muted, locked, hidden } }
  clips    { [id]: Y.Map { trackId, mediaHash?, text?, start, in, out, opacity, x, y, scale, … } }
  branches { [slug]: { name, createdAt, createdBy, mergedAt? } }   // main room only
  versions { … named snapshots … }
Awareness (ephemeral): { user, playhead, selection, cursor, hash }
```

### Scaling and failure modes

| Situation | Behaviour |
|---|---|
| More users | Compute scales with them; one Durable Object per room, rooms independent |
| Bigger videos | No server impact — bounded by the user's disk, GPU, and frame-cache budget |
| Network drop | Edits continue locally and merge on reconnect |
| Wrong or missing key | Server refuses the connection; a link without `#k=` asks for the invite link |
| Tampered frame | GCM authentication fails; the frame is dropped and the document is unaffected |
| Media holder offline | Clip shows "unavailable" and retries periodically; re-adding the file relinks it |
| No route between peers | The user is told a TURN server is needed; media with a public URL falls back to it |
| No WebGPU / WebCodecs | Canvas 2D fallback, or an "Open in Chrome" screen |

### Trade-offs

| Decision | Chosen | Alternative | Why |
|---|---|---|---|
| Sync backend | Own Worker + Durable Object | Hosted CRDT relay, y-websocket on a VM | No third party, per-room isolation, hibernating sockets, built-in SQLite |
| Confidentiality | E2E AES-GCM, key in URL fragment | TLS only | The server operator can't read projects |
| Compaction | Client-built encrypted snapshots | Server merges Yjs directly | The server never needs to read updates |
| Frame cache | Decode order + byte budget | LRU | LRU evicted look-ahead frames during playback |
| Time unit | Integer frames | Float seconds | Exact seeks and merges |
| Media storage | Peer to peer only | Central server/object storage | Zero storage cost, nothing readable at rest |

## Benchmarks

Selected results — full method and raw runs are in `benchmarks.md`.

| Suite | Result |
|---|---|
| Random seek, 540p, warm / cold | 100% exact; p50 2.1 / 8.4 ms, p95 5.3 / 11.1 ms |
| Far seek, 1080p GOP 60, warm / cold | 100% exact; p50 10.9 / 17.6 ms |
| Far seek, 1080p GOP 250, warm / cold | 100% exact; p50 29.4 / 42.7 ms |
| Sequential 1080p decode | 294 fps |
| 3-track 1080p playback, 60 s | 1799/1800 frames shown |
| Export, 3-track 1080p, 10 s | 1080p 8.2× real time · 720p 16.1× |
| Collaboration round trip | p50 3.9 ms · p99 7.4 ms |
| 10-minute playback soak with seeks | flat memory (~23 MB JS heap), no leaked frames |
| 1 GB file to a collaborator | playable in 4.1 s · full original at 31.6 MB/s · resumes with 0 wasted re-transfers |
| 60-minute audio track | 22× less memory streaming than decoding the whole file |
| A/V drift over 5 minutes | avg 12.9 ms · max 20.6 ms (under one frame) |

Measured on a single machine over localhost; real-world internet latency and NAT conditions will differ.

## Testing

| Layer | Tool | What it checks |
|---|---|---|
| Engine | `cargo test` + proptest | Render planner, merge rule table, merge laws |
| Crypto | Vitest | Key derivation, wrong key, tampered IV/ciphertext/tag, replay protection |
| CRDT | Vitest fuzz | Random ops across multiple docs converge to identical hashes |
| Collaboration | Playwright, two isolated browser contexts | Concurrent edits converge, remote cursors, offline → reconnect, P2P media, branch and merge |
| Large media | Playwright | Proxy generation, editing on proxies, resume after reload, multi-holder transfer, playhead-first ordering |
| Security | Playwright + storage inspection | No plaintext stored or relayed; wrong key can't join; tampered frames rejected |
| Export | Playwright + ffprobe | Exported frame counts match the timeline exactly |
| Visual | Playwright + SSIM | Rendered frames vs. golden frames, SSIM ≥ 0.99 |

```bash
npm test               # Vitest
npm run test:engine    # cargo test
npm run e2e            # Playwright (starts its own dev server and TURN relay)
```

## Project layout

```
server/src/index.ts  Worker: serves the app, routes /sync/<roomHash> to a Room Durable Object
src/sync/            wire protocol, HKDF + AES-GCM, encrypted Yjs provider, room connection
src/model/           Yjs schema and ops, editor session, branches, conflicts, versions, store
src/media/           OPFS store, MP4 demux, decoder/proxy/audio workers, P2P chunked transfer
src/render/          WebGPU compositor (Canvas 2D fallback), player, MP4 export
src/ui/              dashboard, editor, timeline, merge screen
src/engine/pkg/      compiled WASM engine (committed, so deploys need no Rust toolchain)
engine/              Rust source: render plan, audio mix plan, three-way diff/merge
tests/               Vitest unit and fuzz tests
e2e/                 Playwright end-to-end tests and SSIM golden frames
public/demo/         demo reel and benchmark media
scripts/             dev runner, benchmarks, media generators
```

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Sync server + local TURN relay + Vite dev server |
| `npm run serve` | Build, then serve app + sync from one local Worker |
| `npm run deploy` | Build and deploy to Cloudflare |
| `npm test` / `npm run test:engine` / `npm run e2e` | Vitest / cargo test / Playwright |
| `npm run bench` | Decode, playback, export, and collaboration benchmarks → `docs/benchmarks.json` |
| `npm run bench:transfer` | Large-file proxy and chunked-transfer benchmark |
| `npm run bench:audio` | Streaming-audio memory and A/V drift benchmark |
| `npm run golden` | Re-render the SSIM golden frames |
| `npm run engine` | Rebuild the WASM engine (needs `wasm-pack`) |
| `npm run demo-media` | Regenerate demo reel assets |

Large benchmark and test media is generated locally and isn't committed.

## Limitations

- **Chrome desktop only.** Safari and Firefox are untested; without WebCodecs and OPFS the app shows an "Open in Chrome" screen.
- **Media needs a holder online.** There's no server-side storage, so a file can only be fetched while someone who has it is connected.
- **Peers on different networks need TURN.** Without a TURN key (or a custom `VITE_ICE_SERVERS`), media transfers only where STUN finds a route. The app surfaces this clearly rather than hanging, and demo media falls back to its public URL.
- **Access is all-or-nothing.** Anyone with the invite link can read and edit. There are no roles, revocation, or key rotation yet — rotating a key means creating a new project.
- **H.264/AAC only.** Other formats WebCodecs can't stream are decoded in full, on the main thread.
- **Branches come from main only**, and a merge can't be undone yet.
- **Benchmarks are local.** All latency and throughput numbers are measured on one machine over localhost; real internet conditions will differ.
- **Real phone footage is lightly tested.** Rotation, variable frame rate, and 4K handling are verified on synthetic phone-like clips; drop real clips into `e2e/media/real/` to extend coverage.
- No WebGPU device-loss recovery yet.

## Roadmap

- Production TURN server and key rotation / roles
- Broader codec support for streamed audio decode
- Undoable merges and multi-parent branches
- A canvas-based timeline for very large projects