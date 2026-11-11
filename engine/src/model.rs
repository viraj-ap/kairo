//! Timeline model shared with the TypeScript side.
//!
//! Clips and tracks are kept as JSON objects so the merge code can work
//! field-by-field without knowing every property. Typed accessors live here.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

pub type Obj = Map<String, Value>;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Timeline {
    #[serde(default = "default_fps")]
    pub fps: u32,
    #[serde(default)]
    pub media: BTreeMap<String, Obj>,
    #[serde(default)]
    pub tracks: BTreeMap<String, Obj>,
    #[serde(default)]
    pub clips: BTreeMap<String, Obj>,
}

fn default_fps() -> u32 {
    30
}

pub fn int(o: &Obj, k: &str) -> i64 {
    o.get(k).and_then(Value::as_i64).unwrap_or(0)
}

pub fn num(o: &Obj, k: &str, d: f64) -> f64 {
    o.get(k).and_then(Value::as_f64).unwrap_or(d)
}

pub fn string<'a>(o: &'a Obj, k: &str) -> Option<&'a str> {
    o.get(k).and_then(Value::as_str)
}

pub fn flag(o: &Obj, k: &str) -> bool {
    o.get(k).and_then(Value::as_bool).unwrap_or(false)
}

/// Length of a clip on the timeline, in frames.
pub fn clip_len(c: &Obj) -> i64 {
    (int(c, "out") - int(c, "in")).max(0)
}

pub fn clip_end(c: &Obj) -> i64 {
    int(c, "start") + clip_len(c)
}

impl Timeline {
    pub fn duration(&self) -> i64 {
        self.clips.values().map(clip_end).max().unwrap_or(0)
    }

    /// "video" | "audio" | "image" | "text"
    pub fn clip_kind(&self, c: &Obj) -> &str {
        if c.get("text").map_or(false, |t| t.is_string()) {
            return "text";
        }
        string(c, "mediaHash")
            .and_then(|h| self.media.get(h))
            .and_then(|m| string(m, "kind"))
            .unwrap_or("video")
    }

    pub fn track_order(&self, c: &Obj) -> i64 {
        string(c, "trackId")
            .and_then(|t| self.tracks.get(t))
            .map_or(i64::MAX, |t| int(t, "order"))
    }

    pub fn track_flag(&self, c: &Obj, k: &str) -> bool {
        string(c, "trackId")
            .and_then(|t| self.tracks.get(t))
            .map_or(false, |t| flag(t, k))
    }
}
