# Benchmarks

> The decode, seek, playback, export, collaboration and soak sections were re-measured after round 2 (see their dates). Large-asset sync, streaming audio and footage are new in round 2.

Produced by `npm run bench` (`scripts/bench.mjs`). Raw data, including every run, every statistic and all soak samples, is in [`benchmarks.json`](benchmarks.json).

- **Machine:** Apple M5 (10 cores), 24 GB, macOS (Darwin 25.6). Chrome for Testing 153, headless, WebGPU compositor, cross-origin isolated.
- **Server:** `wrangler dev` on localhost (the production runtime, workerd), with end-to-end encryption on.
- **Method:** each suite ran **3 times**. Every statistic below is the **median of the 3 runs** (p50, p95, p99, max taken separately).
- **Date:** re-measured 2026-11-10 on the final round-2 code (round-1 numbers from 2026-11-09 are kept in brackets for comparison).

## Frame accuracy and seek latency

The test files encode each frame's index as 16 binary blocks in their top-left pixels. A seek only counts if the decoded frame reads back exactly the requested number. "Cold" clears every decoded frame and decoder before each seek; the parsed sample table stays. "Far" means each target is at least ⅓ of the file (≥ 200 frames) from the previous one. All files are H.264 High with B-frames.

| Suite | Exact (every run) | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| Random seek, 540p GOP 30, warm (n=200) | 200/200 | 2.1 ms | 5.3 ms | 7.1 ms | 19.3 ms |
| Random seek, 540p GOP 30, **cold** (n=100) | 100/100 | 8.4 ms | 11.1 ms | 11.6 ms | 11.8 ms |
| Far seek, 1080p GOP 60, warm (n=60) | 60/60 | 10.9 ms | 22.3 ms | 23.9 ms | 23.9 ms |
| Far seek, 1080p GOP 60, **cold** (n=60) | 60/60 | 17.6 ms | 27.9 ms | 29.8 ms | 29.8 ms |
| Far seek, 1080p GOP 250, warm (n=40) | 40/40 | 29.4 ms | 84.8 ms | 93.2 ms | 93.2 ms |
| Far seek, 1080p GOP 250, **cold** (n=40) | 40/40 | 42.7 ms | 95.5 ms | 97.2 ms | 97.2 ms |
| Sequential decode, 1080p (300 frames) | 300/300 | 294 fps | | | |

Round 2 is within noise of round 1 (cold seeks ~2–3 ms slower at p50). Frame lookup changed in round 2 to "latest frame presented at or before *t*" (for VFR), and exactness stayed 100 % in every run.

Small samples make p99 equal max: with n=40 or n=60, p99 is the single slowest seek.

## Playback: 60 s, 3 tracks, 1080p

The player is the editor's own (AudioContext clock, drop-not-delay) on a 1920×1080 WebGPU canvas. The test timeline has three simultaneous 1080p H.264 layers (full frame GOP 60, a GOP-250 picture-in-picture at 90% opacity, and a GOP-60 picture-in-picture with duotone) plus a text layer. There are cuts on every track throughout.

| Metric | Median of 3 |
|---|---|
| Frames presented / expected | **1799 / 1800** |
| Dropped | 1 (0.06 %) in every run: frame 0 (decoder warm-up at play) |
| Frame render time (gather + composite) | p50 1.25 ms · p95 1.9 ms · p99 2.3 ms · max 26.0 ms |

## Export (3-track 1080p timeline, 10 s)

| Output | Wall time | Speed |
|---|---|---|
| **1080p30** H.264 | 1.23 s | **8.2× real time** |
| 720p30 H.264 | 0.62 s | 16.1× real time |

Audio in exports is now mixed by the streaming worker (C1); the Playwright audio test checks it's full length and audible.

Export frame counts are checked exactly against the timeline by the Playwright export test (ffprobe), at 1080p and 540p.

## Collaboration latency (real server, two isolated browser contexts)

A writes `ping = i` to the shared doc. B, in a separate browser context with no shared storage, observes it and writes `pong = i`. A measures the round trip. Both directions go through the WebSocket → Durable Object relay with AES-GCM seal/open, over localhost (200 edits per run).

| | p50 | p95 | p99 | max |
|---|---|---|---|---|
| Round trip | 3.9 ms | 6.3 ms | 7.4 ms | 8.8 ms |
| One-way estimate (RTT / 2) | 1.9 ms | 3.2 ms | 3.7 ms | 4.4 ms |

Localhost only. Internet latency adds your network round trip to the nearest Cloudflare location; that hasn't been measured.

## Memory soak (round 1: 10 minutes × 3; round 2: 10 minutes × 1)

Each run plays the 3-track 1080p timeline continuously for 10 minutes, jumps to a random point every 5 s, and restarts playback whenever it reaches the end. A sample is taken every 30 s (20 per run). Memory comes from `performance.measureUserAgentSpecificMemory()` (the page is cross-origin isolated); none of the 60 samples timed out.

| Run | Memory first → last (max) | Worker frame cache (max) | Leaked main-thread VideoFrames (max) | Frames shown | Playback restarts |
|---|---|---|---|---|---|
| 1 | 23.4 → 23.3 MB (31.7) | 129 | 0 | 15,659 | 214 |
| 2 | 15.1 → 23.4 MB (31.8) | 129 | 0 | 14,568 | 211 |
| 3 | 23.5 → 23.4 MB (23.5) | 129 | 0 | 14,946 | 272 |
| **Round 2** | 16.8 → 27.7 MB (35.9) | 129 | 0 | 14,464 | 135 |

Round 2 holds flat at 26–28 MB from 30 s to 10 min, with one 35.9 MB sample that comes back down. The ~4 MB over round 1 is the streaming audio worker and worklet. Round 2 ran one soak instead of three, as a regression check.

**No leak.**
- Page memory settles around 23 MB and stays there for 10 minutes. The brief 32 MB readings come back down at the next sample.
- The decoded-frame cache sits exactly at its cap. 129 frames is the 384 MB budget at 1080p, and that memory is GPU memory, not counted above.
- No VideoFrame was ever left open on the main thread.

The soak is a stability test, not a frame-drop test. The ~15,000 frames shown (of ~18,000 wall-clock frame slots) include time lost to the test's own 200+ restarts and 120 jumps, each of which briefly pauses playback. Drop rate is measured by the dedicated 60 s playback benchmark above.

An earlier attempt at this soak hung on run 2: Chrome's memory API waits for a garbage collection, which can take indefinitely in an idle headless browser. Every wait now has a timeout, and each run has a hard deadline.

## Large-asset sync, 1 GB (Phase A)

From `npm run bench:transfer` → `docs/benchmarks-transfer.json`, measured 2026-11-10.
- **Clip:** 1080p30 H.264 at a constant 40 Mbit/s plus AAC, 200 s, **1.003 GB** (957 chunks), generated by `scripts/make-big-media.sh` and not committed.
- **Setup:** two isolated browser contexts on one Mac, signaling through the real encrypted server (`wrangler dev`). Media goes over WebRTC through a local TURN relay (`node-turn`), because a full-tunnel VPN blocks direct connections on this machine.

| On A (the holder) | |
|---|---|
| Hash + store the 1 GB import (streaming SHA-256 + manifest) | 11.4 s |
| Generate the 540p proxy (40.9 MB) | 14.6 s |

| B opens the invite link → … (median of 3) | |
|---|---|
| **can play at the playhead** (proxy header + next 10 s) | **4.1 s** (runs: 4.1, 3.7, 4.1) |
| full proxy | 4.6 s, ~9.8 MB/s |
| full 1 GB original | 34.9 s, **31.6 MB/s** (runs: 31.6, 31.8, 30.1) |
| duplicate chunks / stored chunks re-requested | 0 / 0 |

**Resume:** A's connections were killed at 40 % (383 chunks stored) and A went offline for 3 s.
- Completed in 44.8 s with the whole-file hash verified.
- **0 already-stored chunks were sent again.** 3 chunks were sent twice: the ones in flight at the kill (B retried 4 requests).

**Two holders:** B pulled 614 chunks from A and 382 from C, exactly the 996 needed, with 0 duplicates.
- Throughput was **28.3 MB/s vs 31.6 MB/s from one holder**, so there was **no speed-up on one machine**: both senders, the receiver and the TURN relay share one CPU, so the receiver and relay are the bottleneck.
- A second holder should help when each sender's upload is the limit (real networks), but that hasn't been measured.

The first versions of these runs exposed two real bugs, both fixed and now covered by tests:
- chunks re-downloaded while being written (about 14 % wasted with two holders);
- a stuck status when importing a file you were already downloading.

## Streaming audio (Phase C1)

From `npm run bench:audio` → `docs/benchmarks-audio.json` (3 runs, medians).

**Peak memory with a 60-minute audio file** (AAC 128 kbit/s, 48 kHz stereo, 59 MB):
- Chrome's `measureUserAgentSpecificMemory` turned out **not to count decoded audio buffers at all**: it reported ~20 MB for the old path while that path held 1.4 GB of PCM. So memory is measured as the **resident memory of all browser processes** (`ps`, sampled every 0.5 s), as the increase over each phase's baseline.

| Path | Browser RSS increase (median of 3) | Runs | Notes |
|---|---|---|---|
| **Streaming** (AudioDecoder → ring → AudioWorklet): 20 s playback **and** a full 60-min waveform | **+184 MB** | 295, 184, 177 | includes the player and WebGPU setup; 0 underruns |
| Old path (`decodeAudioData` of the whole file), decode and hold | **+4,110 MB** | 5,244, 4,110, 4,088 | holds 1,382 MB of PCM, plus decode working memory |

Streaming uses **about 22× less memory** on a 60-minute file. Streamed waveform peaks for 60 minutes take ~30 s (in the worker, off the main thread).

**A/V drift over 5 minutes:** a sync clip has one white frame and a 40 ms, 1 kHz beep at every whole second. For each second we compare when the flash frame was put on screen with when the beep's first sample plays, both on the AudioContext output clock (`getOutputTimestamp`).

| | p50 | p95 | p99 | max | avg (abs) |
|---|---|---|---|---|---|
| Drift (median of 3 runs, 299 pairs each) | 12.6 ms | 19.5 ms | 20.2 ms | **20.6 ms** | **12.9 ms** |
| Target: under one frame | | | | 33.3 ms | 33.3 ms |

Per-run max: 19.0, 21.0, 20.6 ms. Video was ahead of audio by ~13 ms on average in every run (signed mean −10.9 to −13.3 ms).

The first measurement **missed the target**: average 30.3 ms, max 38.7 ms, with video consistently early.
- **Cause:** the video clock followed `AudioContext.currentTime` (where audio rendering is), which runs ahead of what's audible by the output latency.
- **Fix:** the clock now follows `getOutputTimestamp()`.

A constant ~13 ms early offset remains, which is consistent across the whole 5 minutes, so it's not accumulating drift. It's likely output buffering that `outputLatency` doesn't report.

## Footage (Phase C2)

From `e2e/footage.spec.ts`, on synthetic phone-like clips (`scripts/make-test-media.sh`). **Not real phone footage**: none was available.

| Clip | Check | Result |
|---|---|---|
| 960×540 VFR: every 7th frame dropped, +12 ms jitter on every 3rd | 48 lookups (random + around irregular frames) return the frame on screen at that time, and its timestamp | **48/48 exact** |
| Coded 1280×720 with a 90° display matrix | Displayed portrait; red marker lands in the same corner as ffmpeg's auto-rotated render | **pass** |
| 3840×2160 30 fps H.264, 30 s | 20 random seeks | **20/20 exact** |
| same | 10 s real-time playback | **298 shown, 0 dropped** |
| Real phone clips (`e2e/media/real/`) | orientation, exact timestamps, playback | **not run: no clips provided** |


## History: what these numbers looked like before fixes

The first full run of this suite exposed problems that were then fixed:

| Metric | First run | Now |
|---|---|---|
| Seek p95 (540p) | 509 ms | 5.3 ms |
| Seek exactness | 197/200, and 44/200 in one batch (decoder session leak) | 100% in every run |
| 3-track playback drops | 34% | 0.06% |
| 1080p export | 1.7× real time | 8.2× real time |
