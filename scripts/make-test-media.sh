#!/usr/bin/env bash
# Synthetic "phone-like" test footage for e2e/footage.spec.ts (NOT real phone clips).
# Written to .cache/test-media (gitignored). Each frame carries its index as 16 binary
# blocks (16x16 px, LSB first) in the top-left corner, so tests can check exact frames.
#   vfr.mp4      960x540, variable frame rate: every 7th frame dropped + 12 ms jitter on every 3rd
#   rotated.mp4  coded 1280x720 with a red marker in the coded top-left, display matrix rotated 90°
#   4k.mp4       3840x2160 30 fps, 30 s
set -euo pipefail
out="$(dirname "$0")/../.cache/test-media"
mkdir -p "$out"
bits="format=yuv444p,geq=lum='if(lt(Y,16)*lt(X,256), 255*mod(floor(N/pow(2,floor(X/16))),2), lum(X,Y))':cb='if(lt(Y,16)*lt(X,256),128,cb(X,Y))':cr='if(lt(Y,16)*lt(X,256),128,cr(X,Y))',format=yuv420p"

[ -f "$out/vfr.mp4" ] || ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=960x540:rate=30:duration=20" \
  -vf "select='not(eq(mod(n\,7)\,3))',setpts='PTS+if(eq(mod(N\,3)\,1)\,0.012/TB\,0)',$bits" \
  -fps_mode passthrough -c:v libx264 -preset veryfast -crf 22 -g 30 -movflags +faststart "$out/vfr.mp4"

if [ ! -f "$out/rotated.mp4" ]; then
  ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=5" \
    -vf "drawbox=x=0:y=0:w=200:h=200:color=red:t=fill,$bits" -c:v libx264 -preset veryfast -crf 22 -g 30 "$out/rotated_src.mp4"
  ffmpeg -y -loglevel error -display_rotation:v:0 -90 -i "$out/rotated_src.mp4" -c copy -movflags +faststart "$out/rotated.mp4"
  rm "$out/rotated_src.mp4"
fi

[ -f "$out/4k.mp4" ] || ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=3840x2160:rate=30:duration=30" \
  -f lavfi -i "nullsrc=size=256x16:rate=30:duration=30" \
  -filter_complex "[1:v]format=gray,geq=lum='255*mod(floor(N/pow(2,floor(X/16))),2)'[b];[0:v][b]overlay=0:0:shortest=1,format=yuv420p" \
  -c:v libx264 -preset veryfast -crf 30 -g 60 -movflags +faststart "$out/4k.mp4"
ls -la "$out"
