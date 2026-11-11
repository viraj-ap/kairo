#!/usr/bin/env bash
# Generates the demo media served from public/demo (H.264 + AAC, 30 fps).
set -euo pipefail
out="$(dirname "$0")/../public/demo"
mkdir -p "$out"
enc=(-c:v libx264 -preset slow -crf 28 -pix_fmt yuv420p -g 30 -movflags +faststart)
aac=(-c:a aac -b:a 96k)

# frames.mp4: the frame number is encoded as 16 binary blocks (16x16 px, LSB first)
# along the top-left edge so /bench can verify frame-accurate seeking.
ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=960x540:rate=30:duration=20" \
  -vf "format=yuv444p,geq=lum='if(lt(Y,16)*lt(X,256), 255*mod(floor(N/pow(2,floor(X/16))),2), lum(X,Y))':cb='if(lt(Y,16)*lt(X,256),128,cb(X,Y))':cr='if(lt(Y,16)*lt(X,256),128,cr(X,Y))',format=yuv420p" \
  "${enc[@]}" -crf 22 "$out/frames.mp4"

# 1080p versions with long GOPs for far-seek and 3-track playback benchmarks (B-frames on).
for gop in 60 250; do
  ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=1920x1080:rate=30:duration=20" \
    -vf "format=yuv444p,geq=lum='if(lt(Y,16)*lt(X,256), 255*mod(floor(N/pow(2,floor(X/16))),2), lum(X,Y))':cb='if(lt(Y,16)*lt(X,256),128,cb(X,Y))':cr='if(lt(Y,16)*lt(X,256),128,cr(X,Y))',format=yuv420p" \
    -c:v libx264 -preset veryfast -crf 30 -pix_fmt yuv420p -g $gop -keyint_min $gop -sc_threshold 0 -bf 3 -movflags +faststart "$out/frames_1080_g$gop.mp4"
done

ffmpeg -y -loglevel error -f lavfi -i "gradients=size=1280x720:rate=30:duration=8:speed=0.02:c0=0x00c8ff:c1=0x2a2aff:c2=0x18ff7a:c3=0x0b0b2a:nb_colors=4" \
  -f lavfi -i "sine=frequency=220:duration=8,volume=0.25" -shortest "${enc[@]}" "${aac[@]}" "$out/aurora.mp4"

ffmpeg -y -loglevel error -f lavfi -i "mandelbrot=size=1280x720:rate=30:end_scale=0.05:outer=normalized_iteration_count" -t 8 \
  -f lavfi -i "sine=frequency=330:duration=8,volume=0.2" -shortest "${enc[@]}" "${aac[@]}" "$out/fractal.mp4"

ffmpeg -y -loglevel error -f lavfi -i "life=size=320x180:rate=30:mold=10:life_color=0x18ff7a:death_color=0x2a2aff:mold_color=0x0b0b2a,scale=1280:720:flags=neighbor" -t 6 \
  "${enc[@]}" "$out/life.mp4"

ffmpeg -y -loglevel error -f lavfi -i "aevalsrc='0.15*sin(2*PI*110*t)*(0.6+0.4*sin(2*PI*0.5*t))+0.08*sin(2*PI*165*t)':s=48000:d=20" "${aac[@]}" "$out/drone.m4a"
ls -la "$out"
