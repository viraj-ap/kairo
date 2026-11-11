#!/usr/bin/env bash
# Benchmark-only media, NOT committed (written to .cache/media, which is gitignored).
#   big_1080p.mp4  ~1 GB: 1080p30 H.264 at a constant 40 Mbit/s for 200 s, with AAC audio.
set -euo pipefail
out="$(dirname "$0")/../.cache/media"
mkdir -p "$out"
if [ ! -f "$out/big_1080p.mp4" ]; then
  ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=1920x1080:rate=30:duration=200,noise=alls=12:allf=t" \
    -f lavfi -i "sine=frequency=440:duration=200,volume=0.2" -shortest \
    -c:v libx264 -preset ultrafast -b:v 40M -minrate 40M -maxrate 40M -bufsize 20M -x264-params nal-hrd=cbr \
    -g 60 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart "$out/big_1080p.mp4"
fi
ls -la "$out"
