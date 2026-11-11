#!/usr/bin/env bash
# Composes the recorded demo (.cache/demo/{A,B}.webm + markers.json from record-demo.ts) into
# demo/kairo-demo.mp4 (1920×1080, 30 fps, H.264 CRF 20) and a 20 s README GIF.
#
#   bash scripts/demo/compose.sh            # refuses if any scene failed while recording
#   bash scripts/demo/compose.sh --draft    # composes anyway into demo/draft/, failed scenes flagged in red
#
# A and B are side by side (each scaled 960×1080 → 922×1037 under a 43 px "Viraj (A)" / "Sam (B)"
# label bar). Each scene is cut from its start/end markers, so dead time between scenes is dropped.
# Captions are PNGs rendered with Inter by render-cards.ts (this ffmpeg has no drawtext) and faded
# in/out with alpha fades.
set -euo pipefail
cd "$(dirname "$0")/../.."

DRAFT=0
[[ "${1:-}" == "--draft" ]] && DRAFT=1
SRC=.cache/demo
CARDS=$SRC/cards
WORK=$SRC/segments
if (( DRAFT )); then DEST=demo/draft; else DEST=demo; fi
FINAL=$DEST/kairo-demo.mp4
GIF=$DEST/kairo-demo.gif
FADE=0.4      # caption fade in/out
PAD=0.25      # extra footage kept around each scene's markers
TITLE_LEN=2.5
END_LEN=6

command -v ffmpeg >/dev/null || { echo "[compose] ffmpeg not found" >&2; exit 1; }
[[ -f $SRC/A.webm && -f $SRC/B.webm && -f $SRC/markers.json ]] || { echo "[compose] run: node scripts/demo/record-demo.ts" >&2; exit 1; }

FAILED=$(node -e "const m=require('./$SRC/markers.json');console.log(m.scenes.filter(s=>s.failed).map(s=>'  scene '+s.scene+': '+s.failed.split('\n')[0]).join('\n'))")
if [[ -n $FAILED ]] && (( ! DRAFT )); then
  echo "[compose] refusing to compose: scenes failed while recording" >&2
  echo "$FAILED" >&2
  echo "[compose] fix them and re-record, or use --draft for a flagged preview in demo/draft/" >&2
  exit 1
fi

rm -rf "$CARDS" "$WORK"
mkdir -p "$WORK" "$DEST"
node scripts/demo/render-cards.ts $( (( DRAFT )) && echo --draft )
source "$CARDS/offsets.env"

ENC=(-c:v libx264 -preset veryfast -crf 14 -pix_fmt yuv420p -r 30 -an)
SIDE="fps=30,scale=922:1037:flags=lanczos,pad=960:1080:19:43:color=0x0b0b0c,setsar=1"
list=$WORK/list.txt
: >"$list"
offsets=$WORK/offsets.tsv   # scene → start time in the final cut (for the GIF)
: >"$offsets"
pos=0
calc() { awk "BEGIN { printf \"%.3f\", ($1) }"; }

card() { # card <png> <seconds> <out>
  ffmpeg -nostdin -v error -y -loop 1 -t "$2" -i "$1" \
    -vf "fps=30,format=yuv420p,fade=t=in:st=0:d=0.35,fade=t=out:st=$(calc "$2 - 0.35"):d=0.35" "${ENC[@]}" "$3"
  echo "file '$(basename "$3")'" >>"$list"
}

card "$CARDS/title.png" $TITLE_LEN "$WORK/00-title.mp4"
pos=$(calc "$pos + $TITLE_LEN")

while IFS=$'\t' read -r scene start end cap status; do
  s=$(calc "$start - $PAD < 0 ? 0 : $start - $PAD")
  dur=$(calc "$end + $PAD - $s")
  sa=$(calc "$s - $OFF_A"); sb=$(calc "$s - $OFF_B")
  out=$(printf "%s/%02d-scene.mp4" "$WORK" "$scene")
  fo=$(calc "$dur - $FADE - 0.2")
  echo "[compose] scene $scene: ${dur}s from ${s}s ($status)"
  ffmpeg -nostdin -v error -y \
    -ss "$sa" -t "$dur" -i $SRC/A.webm \
    -ss "$sb" -t "$dur" -i $SRC/B.webm \
    -i "$CARDS/label.png" \
    -loop 1 -t "$dur" -i "$CARDS/$cap" \
    -filter_complex "[0:v]$SIDE[a];[1:v]$SIDE[b];[a][b]hstack=inputs=2[v];[v][2:v]overlay=0:0[v1];\
[3:v]format=rgba,fade=t=in:st=0.2:d=$FADE:alpha=1,fade=t=out:st=$fo:d=$FADE:alpha=1[c];\
[v1][c]overlay=(W-w)/2:H-h-36:shortest=1,format=yuv420p[out]" \
    -map "[out]" -t "$dur" "${ENC[@]}" "$out"
  echo "file '$(basename "$out")'" >>"$list"
  printf "%s\t%s\t%s\n" "$scene" "$pos" "$dur" >>"$offsets"
  pos=$(calc "$pos + $dur")
done <"$CARDS/segments.tsv"

card "$CARDS/end.png" $END_LEN "$WORK/99-end.mp4"

echo "[compose] encoding $FINAL"
ffmpeg -nostdin -v error -y -f concat -safe 0 -i "$list" \
  -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -r 30 -movflags +faststart "$FINAL"

# README GIF: 20 s of the strongest moments (live co-editing, then the merge), 960 px, 12 fps.
gif_part() { awk -F'\t' -v s="$1" '$1==s {print $2, $3}' "$offsets"; }
read -r g5 d5 < <(gif_part 5)
read -r g8 d8 < <(gif_part 8)
l5=$(calc "$d5 < 10 ? $d5 : 10"); l8=$(calc "20 - $l5")
ffmpeg -nostdin -v error -y -i "$FINAL" -filter_complex "\
[0:v]trim=start=$g5:duration=$l5,setpts=PTS-STARTPTS[p];[0:v]trim=start=$g8:duration=$l8,setpts=PTS-STARTPTS[q];\
[p][q]concat=n=2:v=1,fps=12,scale=960:-2:flags=lanczos,split[x][y];[x]palettegen=max_colors=160:stats_mode=diff[pal];\
[y][pal]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" "$GIF"

dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$FINAL")
echo "[compose] $FINAL  $(printf '%.1f' "$dur")s  $(du -h "$FINAL" | cut -f1)"
echo "[compose] $GIF  $(du -h "$GIF" | cut -f1)"
[[ -n $FAILED ]] && { echo "[compose] DRAFT: contains failed scenes:"; echo "$FAILED"; }
exit 0
