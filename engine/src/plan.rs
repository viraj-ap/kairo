//! Per-frame render plan and audio mix plan.

use crate::model::*;
use serde::Serialize;
use serde_json::Value;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Layer {
    pub clip_id: String,
    pub kind: String,
    pub media_hash: Option<String>,
    /// Frame inside the source media (project fps), and the same in seconds.
    pub source_frame: i64,
    pub source_time: f64,
    pub opacity: f64,
    pub x: f64,
    pub y: f64,
    pub scale: f64,
    /// 0..1 portion of the layer revealed left-to-right (1 = fully visible).
    pub reveal: f64,
    /// Clockwise display rotation of the source (0, 90, 180, 270), from its metadata.
    pub rotation: i64,
    /// Clip properties the compositor needs (text, color, effect...).
    pub props: Obj,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Preroll {
    pub clip_id: String,
    pub media_hash: String,
    pub source_time: f64,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RenderPlan {
    pub frame: i64,
    /// Bottom-most layer first.
    pub layers: Vec<Layer>,
    /// Video clips that start soon and should be decoded ahead of the cut.
    pub preroll: Vec<Preroll>,
}

const PASS_THROUGH: &[&str] = &[
    "text", "fontSize", "color", "fontWeight", "background", "effect", "brightness", "contrast", "saturation",
];

pub fn render_plan(tl: &Timeline, frame: i64, lookahead: i64) -> RenderPlan {
    let fps = tl.fps.max(1) as f64;
    let mut visible: Vec<(&String, &Obj)> = tl
        .clips
        .iter()
        .filter(|(_, c)| {
            let s = int(c, "start");
            frame >= s && frame < clip_end(c) && tl.clip_kind(c) != "audio" && !tl.track_flag(c, "hidden")
        })
        .collect();
    // Tracks listed first (lower order) draw on top, so paint higher orders first.
    visible.sort_by(|a, b| {
        tl.track_order(b.1)
            .cmp(&tl.track_order(a.1))
            .then(int(a.1, "start").cmp(&int(b.1, "start")))
            .then(a.0.cmp(b.0))
    });

    let layers = visible
        .into_iter()
        .map(|(id, c)| {
            let local = frame - int(c, "start");
            let source_frame = int(c, "in") + local;
            let mut opacity = num(c, "opacity", 1.0).clamp(0.0, 1.0);
            let mut x = num(c, "x", 0.0);
            let y = num(c, "y", 0.0);
            let mut scale = num(c, "scale", 1.0);
            let mut reveal = 1.0;

            if let Some(t) = c.get("transitionIn").and_then(Value::as_object) {
                let dur = int(t, "duration").max(1);
                if local < dur {
                    let p = (local as f64 + 1.0) / (dur as f64 + 1.0);
                    let e = p * p * (3.0 - 2.0 * p); // smoothstep
                    match string(t, "kind").unwrap_or("fade") {
                        "wipe" => reveal = e,
                        "slide" => x += 1.0 - e,
                        "zoom" => {
                            scale *= 0.6 + 0.4 * e;
                            opacity *= e;
                        }
                        _ => opacity *= e,
                    }
                }
            }

            let props = PASS_THROUGH
                .iter()
                .filter_map(|k| c.get(*k).map(|v| (k.to_string(), v.clone())))
                .collect();

            Layer {
                clip_id: id.clone(),
                kind: tl.clip_kind(c).to_string(),
                media_hash: string(c, "mediaHash").map(str::to_string),
                source_frame,
                source_time: source_frame as f64 / fps,
                opacity,
                x,
                y,
                scale,
                reveal,
                rotation: string(c, "mediaHash")
                    .and_then(|h| tl.media.get(h))
                    .map_or(0, |m| int(m, "rotation").rem_euclid(360)),
                props,
            }
        })
        .collect();

    let preroll = tl
        .clips
        .iter()
        .filter(|(_, c)| {
            let s = int(c, "start");
            s > frame && s <= frame + lookahead && tl.clip_kind(c) == "video"
        })
        .filter_map(|(id, c)| {
            Some(Preroll {
                clip_id: id.clone(),
                media_hash: string(c, "mediaHash")?.to_string(),
                source_time: int(c, "in") as f64 / fps,
            })
        })
        .collect();

    RenderPlan { frame, layers, preroll }
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioSegment {
    pub clip_id: String,
    pub media_hash: String,
    /// Timeline frame where the segment starts.
    pub start: i64,
    /// Source in/out, in frames.
    #[serde(rename = "in")]
    pub in_: i64,
    pub out: i64,
    pub gain: f64,
}

pub fn audio_plan(tl: &Timeline) -> Vec<AudioSegment> {
    let mut segs: Vec<AudioSegment> = tl
        .clips
        .iter()
        .filter(|(_, c)| {
            let kind = tl.clip_kind(c);
            let has_audio = match kind {
                "audio" => true,
                "video" => string(c, "mediaHash")
                    .and_then(|h| tl.media.get(h))
                    .map_or(false, |m| flag(m, "hasAudio")),
                _ => false,
            };
            has_audio && !tl.track_flag(c, "muted") && !flag(c, "muted") && clip_len(c) > 0
        })
        .filter_map(|(id, c)| {
            Some(AudioSegment {
                clip_id: id.clone(),
                media_hash: string(c, "mediaHash")?.to_string(),
                start: int(c, "start"),
                in_: int(c, "in"),
                out: int(c, "out"),
                gain: num(c, "volume", 1.0).max(0.0),
            })
        })
        .collect();
    segs.sort_by(|a, b| a.start.cmp(&b.start).then(a.clip_id.cmp(&b.clip_id)));
    segs
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tl() -> Timeline {
        serde_json::from_value(json!({
            "fps": 30,
            "media": {
                "v1": {"kind": "video", "hasAudio": true},
                "a1": {"kind": "audio", "hasAudio": true}
            },
            "tracks": {
                "top": {"kind": "video", "order": 0},
                "bottom": {"kind": "video", "order": 1},
                "music": {"kind": "audio", "order": 2, "muted": false}
            },
            "clips": {
                "a": {"trackId": "bottom", "mediaHash": "v1", "start": 0, "in": 30, "out": 90},
                "b": {"trackId": "top", "text": "Hello", "start": 10, "in": 0, "out": 20,
                      "transitionIn": {"kind": "fade", "duration": 9}},
                "m": {"trackId": "music", "mediaHash": "a1", "start": 0, "in": 0, "out": 300, "volume": 0.5}
            }
        }))
        .unwrap()
    }

    #[test]
    fn visible_layers_are_bottom_first() {
        let p = render_plan(&tl(), 15, 0);
        let ids: Vec<_> = p.layers.iter().map(|l| l.clip_id.as_str()).collect();
        assert_eq!(ids, ["a", "b"]);
    }

    #[test]
    fn source_frame_follows_in_point() {
        let p = render_plan(&tl(), 5, 0);
        assert_eq!(p.layers[0].source_frame, 35);
        assert!((p.layers[0].source_time - 35.0 / 30.0).abs() < 1e-9);
    }

    #[test]
    fn end_is_exclusive() {
        assert!(render_plan(&tl(), 60, 0).layers.is_empty());
        assert_eq!(render_plan(&tl(), 59, 0).layers.len(), 1);
    }

    #[test]
    fn fade_ramps_opacity() {
        let first = render_plan(&tl(), 10, 0).layers.into_iter().find(|l| l.clip_id == "b").unwrap();
        let later = render_plan(&tl(), 19, 0).layers.into_iter().find(|l| l.clip_id == "b").unwrap();
        assert!(first.opacity > 0.0 && first.opacity < 0.2);
        assert_eq!(later.opacity, 1.0);
        assert_eq!(first.props.get("text").unwrap(), "Hello");
    }

    #[test]
    fn hidden_tracks_are_skipped() {
        let mut t = tl();
        t.tracks.get_mut("bottom").unwrap().insert("hidden".into(), json!(true));
        assert!(render_plan(&t, 5, 0).layers.is_empty());
    }

    #[test]
    fn preroll_lists_upcoming_video() {
        let mut t = tl();
        t.clips.get_mut("a").unwrap().insert("start".into(), json!(40));
        let p = render_plan(&t, 20, 30);
        assert_eq!(p.preroll.len(), 1);
        assert_eq!(p.preroll[0].clip_id, "a");
        assert!((p.preroll[0].source_time - 1.0).abs() < 1e-9);
    }

    #[test]
    fn audio_plan_respects_mute() {
        let mut t = tl();
        assert_eq!(audio_plan(&t).len(), 2);
        t.tracks.get_mut("music").unwrap().insert("muted".into(), json!(true));
        let segs = audio_plan(&t);
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].clip_id, "a");
    }

    #[test]
    fn layers_carry_the_media_rotation() {
        let mut t = tl();
        t.media.get_mut("v1").unwrap().insert("rotation".into(), json!(90));
        let p = render_plan(&t, 5, 0);
        assert_eq!(p.layers[0].rotation, 90);
        t.media.get_mut("v1").unwrap().insert("rotation".into(), json!(-90));
        assert_eq!(render_plan(&t, 5, 0).layers[0].rotation, 270);
    }

    #[test]
    fn duration_is_last_clip_end() {
        assert_eq!(tl().duration(), 300);
    }
}
