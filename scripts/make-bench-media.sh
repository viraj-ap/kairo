#!/usr/bin/env bash
# Benchmark-only media, NOT committed (written to .cache/media, which is gitignored).
#   audio_60min.m4a  60 min AAC 48 kHz stereo — peak-memory comparison
#   sync_5min.mp4    5 min 640x360: one white frame at every whole second + a 40 ms 1 kHz beep at the same instant
set -euo pipefail
out="$(dirname "$0")/../.cache/media"
mkdir -p "$out"
[ -f "$out/audio_60min.m4a" ] || ffmpeg -y -loglevel error -f lavfi -i "aevalsrc='0.2*sin(2*PI*220*t)|0.2*sin(2*PI*330*t)':s=48000:d=3600" -c:a aac -b:a 128k "$out/audio_60min.m4a"
[ -f "$out/sync_5min.mp4" ] || ffmpeg -y -loglevel error \
  -f lavfi -i "color=black:s=640x360:r=30:d=300,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='eq(mod(n\,30)\,0)'" \
  -f lavfi -i "aevalsrc='if(lt(mod(t\,1)\,0.04)\, 0.8*sin(2*PI*1000*t)\, 0)':s=48000:d=300" \
  -c:v libx264 -preset veryfast -g 30 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart -shortest "$out/sync_5min.mp4"
ls -la "$out"
