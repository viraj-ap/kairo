//! Three-way diff and selective merge of timelines.
//!
//! Rule per entity and field: changed on one side -> take it; changed on both
//! sides to different values -> conflict; delete vs modify -> conflict.

use crate::model::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    /// "clip:<id>" or "track:<id>"
    pub id: String,
    pub entity: String,
    pub key: String,
    /// "added" | "removed" | "moved" | "trimmed" | "props"
    pub kind: String,
    pub fields: Vec<String>,
    /// Main also touched this entity in an incompatible way.
    pub conflict: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    /// "<changeId>.<field>", or "<changeId>.*" for delete vs modify.
    pub id: String,
    pub change_id: String,
    pub field: String,
    pub base: Value,
    pub main: Value,
    pub branch: Value,
    /// "main" | "branch" once the user picked a side.
    pub resolution: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub changes: Vec<String>,
    #[serde(default)]
    pub resolutions: BTreeMap<String, String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct MergeResult {
    pub result: Timeline,
    pub conflicts: Vec<Conflict>,
}

type Entities = BTreeMap<String, Obj>;

fn changed_fields(base: &Obj, side: &Obj) -> Vec<String> {
    let keys: BTreeSet<&String> = base.keys().chain(side.keys()).collect();
    keys.into_iter().filter(|k| base.get(*k) != side.get(*k)).cloned().collect()
}

fn classify(fields: &[String]) -> &'static str {
    let has = |f: &str| fields.iter().any(|x| x == f);
    if has("start") || has("trackId") || has("order") {
        "moved"
    } else if has("in") || has("out") {
        "trimmed"
    } else {
        "props"
    }
}

fn opt(v: Option<&Value>) -> Value {
    v.cloned().unwrap_or(Value::Null)
}

/// Does main's version of this entity collide with the branch's change?
fn collides(base: Option<&Obj>, main: Option<&Obj>, branch: Option<&Obj>) -> bool {
    match (base, main, branch) {
        (Some(b), Some(m), None) => m != b,       // branch deleted, main modified
        (Some(b), None, Some(r)) => r != b,       // main deleted, branch modified
        (Some(b), Some(m), Some(r)) => changed_fields(b, r)
            .iter()
            .any(|f| m.get(f) != b.get(f) && m.get(f) != r.get(f)),
        (None, Some(m), Some(r)) => m != r,       // same id added on both sides
        _ => false,
    }
}

fn diff_entities(entity: &str, base: &Entities, main: &Entities, branch: &Entities, out: &mut Vec<Change>) {
    let keys: BTreeSet<&String> = base.keys().chain(branch.keys()).collect();
    for key in keys {
        let (b, r) = (base.get(key), branch.get(key));
        let (kind, fields) = match (b, r) {
            (None, Some(r)) => ("added", r.keys().cloned().collect()),
            (Some(_), None) => ("removed", vec![]),
            (Some(b), Some(r)) if b != r => {
                let f = changed_fields(b, r);
                (classify(&f), f)
            }
            _ => continue,
        };
        out.push(Change {
            id: format!("{entity}:{key}"),
            entity: entity.into(),
            key: key.clone(),
            kind: kind.into(),
            fields,
            conflict: collides(b, main.get(key), r),
        });
    }
}

/// Changes the branch made relative to base, flagged where main disagrees.
pub fn diff(base: &Timeline, main: &Timeline, branch: &Timeline) -> Vec<Change> {
    let mut out = vec![];
    diff_entities("track", &base.tracks, &main.tracks, &branch.tracks, &mut out);
    diff_entities("clip", &base.clips, &main.clips, &branch.clips, &mut out);
    out
}

fn merge_entity(
    change_id: &str,
    base: Option<&Obj>,
    main: Option<&Obj>,
    branch: Option<&Obj>,
    sel: &Selection,
    conflicts: &mut Vec<Conflict>,
) -> Option<Obj> {
    let pick = |id: &str| sel.resolutions.get(id).cloned();
    let whole = |conflicts: &mut Vec<Conflict>| {
        let id = format!("{change_id}.*");
        let resolution = pick(&id);
        conflicts.push(Conflict {
            id,
            change_id: change_id.into(),
            field: "*".into(),
            base: base.map_or(Value::Null, |o| Value::Object(o.clone())),
            main: main.map_or(Value::Null, |o| Value::Object(o.clone())),
            branch: branch.map_or(Value::Null, |o| Value::Object(o.clone())),
            resolution: resolution.clone(),
        });
        resolution.as_deref() == Some("branch")
    };

    match (base, main, branch) {
        // Branch deleted it.
        (Some(_), None, None) => None,
        (Some(b), Some(m), None) => {
            if m == b || whole(conflicts) {
                None
            } else {
                Some(m.clone())
            }
        }
        // Main deleted something the branch modified.
        (Some(_), None, Some(r)) => {
            if whole(conflicts) {
                Some(r.clone())
            } else {
                None
            }
        }
        (None, None, Some(r)) => Some(r.clone()),
        (base, Some(m), Some(r)) => {
            let empty = Obj::new();
            let b = base.unwrap_or(&empty);
            let mut res = m.clone();
            for f in changed_fields(b, r) {
                let (bv, mv, rv) = (b.get(&f), m.get(&f), r.get(&f));
                let take_branch = if mv == bv || mv == rv {
                    true
                } else {
                    let id = format!("{change_id}.{f}");
                    let resolution = pick(&id);
                    conflicts.push(Conflict {
                        id,
                        change_id: change_id.into(),
                        field: f.clone(),
                        base: opt(bv),
                        main: opt(mv),
                        branch: opt(rv),
                        resolution: resolution.clone(),
                    });
                    resolution.as_deref() == Some("branch")
                };
                if take_branch {
                    match rv {
                        Some(v) => {
                            res.insert(f, v.clone());
                        }
                        None => {
                            res.remove(&f);
                        }
                    }
                }
            }
            Some(res)
        }
        (_, m, _) => m.cloned(),
    }
}

fn merge_entities(
    entity: &str,
    base: &Entities,
    main: &Entities,
    branch: &Entities,
    sel: &Selection,
    conflicts: &mut Vec<Conflict>,
) -> Entities {
    let mut result = main.clone();
    let keys: BTreeSet<&String> = base.keys().chain(branch.keys()).collect();
    for key in keys {
        let change_id = format!("{entity}:{key}");
        if base.get(key) == branch.get(key) || !sel.changes.contains(&change_id) {
            continue;
        }
        match merge_entity(&change_id, base.get(key), main.get(key), branch.get(key), sel, conflicts) {
            Some(o) => result.insert(key.clone(), o),
            None => result.remove(key),
        };
    }
    result
}

pub fn merge(base: &Timeline, main: &Timeline, branch: &Timeline, sel: &Selection) -> MergeResult {
    let mut conflicts = vec![];
    let tracks = merge_entities("track", &base.tracks, &main.tracks, &branch.tracks, sel, &mut conflicts);
    let clips = merge_entities("clip", &base.clips, &main.clips, &branch.clips, sel, &mut conflicts);
    // Media entries are immutable and content-addressed, so a union is always safe.
    let mut media = main.media.clone();
    for (k, v) in &branch.media {
        media.entry(k.clone()).or_insert_with(|| v.clone());
    }
    MergeResult {
        result: Timeline { fps: main.fps, media, tracks, clips },
        conflicts,
    }
}

/// Several changes that are really one edit, e.g. a ripple or a multi-select move.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    /// "shift": clips moved in time by the same amount, nothing else changed.
    pub kind: String,
    /// Frames the members moved by (branch start - base start).
    pub delta: i64,
    /// Change ids, ordered by their new start.
    pub members: Vec<String>,
    /// Tracks the members are on (sorted).
    pub tracks: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct GroupedDiff {
    pub changes: Vec<Change>,
    pub groups: Vec<Group>,
}

/// Post-process a diff: clips that only moved in time, all by the same amount, become one
/// group ("Shifted 12 clips +2.0 s on V1"). Conflicted changes stay separate, because each
/// needs its own resolution.
pub fn group_changes(base: &Timeline, branch: &Timeline, changes: &[Change]) -> Vec<Group> {
    let mut by_delta: BTreeMap<i64, Vec<(i64, &Change)>> = BTreeMap::new();
    for c in changes {
        if c.entity != "clip" || c.kind != "moved" || c.conflict || c.fields != ["start"] {
            continue;
        }
        let (Some(b), Some(r)) = (base.clips.get(&c.key), branch.clips.get(&c.key)) else { continue };
        let delta = int(r, "start") - int(b, "start");
        if delta != 0 {
            by_delta.entry(delta).or_default().push((int(r, "start"), c));
        }
    }
    by_delta
        .into_iter()
        .filter(|(_, m)| m.len() >= 2)
        .map(|(delta, mut m)| {
            m.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.id.cmp(&b.1.id)));
            let tracks: BTreeSet<String> = m
                .iter()
                .filter_map(|(_, c)| branch.clips.get(&c.key).and_then(|r| string(r, "trackId")).map(str::to_string))
                .collect();
            Group {
                id: format!("shift:{delta}"),
                kind: "shift".into(),
                delta,
                members: m.iter().map(|(_, c)| c.id.clone()).collect(),
                tracks: tracks.into_iter().collect(),
            }
        })
        .collect()
}

pub fn diff_grouped(base: &Timeline, main: &Timeline, branch: &Timeline) -> GroupedDiff {
    let changes = diff(base, main, branch);
    let groups = group_changes(base, branch, &changes);
    GroupedDiff { changes, groups }
}

/// Selection that takes every change in the branch.
pub fn select_all(base: &Timeline, main: &Timeline, branch: &Timeline) -> Selection {
    Selection {
        changes: diff(base, main, branch).into_iter().map(|c| c.id).collect(),
        resolutions: BTreeMap::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use serde_json::json;

    fn tl(v: Value) -> Timeline {
        serde_json::from_value(v).unwrap()
    }

    fn base() -> Timeline {
        tl(json!({
            "fps": 30,
            "tracks": {"t1": {"kind": "video", "order": 0}},
            "clips": {
                "a": {"trackId": "t1", "start": 0, "in": 0, "out": 30, "opacity": 1.0},
                "b": {"trackId": "t1", "start": 30, "in": 0, "out": 30, "opacity": 1.0}
            }
        }))
    }

    fn with(mut t: Timeline, clip: &str, field: &str, v: Value) -> Timeline {
        t.clips.get_mut(clip).unwrap().insert(field.into(), v);
        t
    }

    fn without(mut t: Timeline, clip: &str) -> Timeline {
        t.clips.remove(clip);
        t
    }

    fn all(b: &Timeline, m: &Timeline, r: &Timeline) -> MergeResult {
        merge(b, m, r, &select_all(b, m, r))
    }

    // One test per row of the merge-rule table.

    #[test]
    fn changed_only_on_branch_takes_branch() {
        let b = base();
        let r = with(b.clone(), "a", "start", json!(90));
        let m = all(&b, &b, &r);
        assert!(m.conflicts.is_empty());
        assert_eq!(m.result, r);
    }

    #[test]
    fn changed_only_on_main_keeps_main() {
        let b = base();
        let main = with(b.clone(), "a", "opacity", json!(0.5));
        let m = all(&b, &main, &b);
        assert_eq!(m.result, main);
    }

    #[test]
    fn different_fields_on_both_sides_merge_cleanly() {
        let b = base();
        let main = with(b.clone(), "a", "opacity", json!(0.5));
        let r = with(b.clone(), "a", "start", json!(60));
        let m = all(&b, &main, &r);
        assert!(m.conflicts.is_empty());
        assert_eq!(m.result.clips["a"]["opacity"], json!(0.5));
        assert_eq!(m.result.clips["a"]["start"], json!(60));
    }

    #[test]
    fn same_field_same_value_is_not_a_conflict() {
        let b = base();
        let both = with(b.clone(), "a", "start", json!(60));
        let m = all(&b, &both, &both);
        assert!(m.conflicts.is_empty());
        assert_eq!(m.result, both);
    }

    #[test]
    fn same_field_different_values_conflicts() {
        let b = base();
        let main = with(b.clone(), "a", "start", json!(45));
        let r = with(b.clone(), "a", "start", json!(60));
        let d = diff(&b, &main, &r);
        assert!(d[0].conflict);
        let m = all(&b, &main, &r);
        assert_eq!(m.conflicts.len(), 1);
        assert_eq!(m.conflicts[0].id, "clip:a.start");
        assert_eq!(m.result.clips["a"]["start"], json!(45), "unresolved keeps main");

        let mut sel = select_all(&b, &main, &r);
        sel.resolutions.insert("clip:a.start".into(), "branch".into());
        let m = merge(&b, &main, &r, &sel);
        assert_eq!(m.result.clips["a"]["start"], json!(60));
        assert_eq!(m.conflicts[0].resolution.as_deref(), Some("branch"));
    }

    #[test]
    fn branch_delete_vs_main_modify_conflicts() {
        let b = base();
        let main = with(b.clone(), "a", "opacity", json!(0.2));
        let r = without(b.clone(), "a");
        let m = all(&b, &main, &r);
        assert_eq!(m.conflicts[0].id, "clip:a.*");
        assert!(m.result.clips.contains_key("a"));
    }

    #[test]
    fn main_delete_vs_branch_modify_conflicts() {
        let b = base();
        let main = without(b.clone(), "a");
        let r = with(b.clone(), "a", "opacity", json!(0.2));
        let mut sel = select_all(&b, &main, &r);
        let m = merge(&b, &main, &r, &sel);
        assert_eq!(m.conflicts.len(), 1);
        assert!(!m.result.clips.contains_key("a"));
        sel.resolutions.insert("clip:a.*".into(), "branch".into());
        assert_eq!(merge(&b, &main, &r, &sel).result.clips["a"]["opacity"], json!(0.2));
    }

    #[test]
    fn unmodified_delete_applies() {
        let b = base();
        let r = without(b.clone(), "b");
        let m = all(&b, &b, &r);
        assert!(m.conflicts.is_empty());
        assert!(!m.result.clips.contains_key("b"));
    }

    #[test]
    fn additions_on_both_sides_are_kept() {
        let b = base();
        let mut main = b.clone();
        main.clips.insert("m".into(), json!({"trackId": "t1", "start": 90, "in": 0, "out": 10}).as_object().unwrap().clone());
        let mut r = b.clone();
        r.clips.insert("r".into(), json!({"trackId": "t1", "start": 99, "in": 0, "out": 10}).as_object().unwrap().clone());
        let m = all(&b, &main, &r);
        assert!(m.result.clips.contains_key("m") && m.result.clips.contains_key("r"));
    }

    #[test]
    fn unselected_changes_are_left_out() {
        let b = base();
        let r = with(without(b.clone(), "b"), "a", "start", json!(5));
        let sel = Selection { changes: vec!["clip:a".into()], resolutions: BTreeMap::new() };
        let m = merge(&b, &b, &r, &sel);
        assert_eq!(m.result.clips["a"]["start"], json!(5));
        assert!(m.result.clips.contains_key("b"));
    }

    #[test]
    fn diff_classifies_changes() {
        let b = base();
        let r = with(with(without(b.clone(), "b"), "a", "out", json!(20)), "a", "opacity", json!(0.4));
        let d = diff(&b, &b, &r);
        let kinds: Vec<_> = d.iter().map(|c| (c.key.as_str(), c.kind.as_str())).collect();
        assert_eq!(kinds, [("a", "trimmed"), ("b", "removed")]);
    }

    // Grouping (B3).

    fn timeline_of(clips: &[(&str, &str, i64, i64)]) -> Timeline {
        let mut t = Timeline { fps: 30, ..Default::default() };
        for (id, track, start, len) in clips {
            t.clips.insert(id.to_string(), json!({"trackId": track, "start": start, "in": 0, "out": len}).as_object().unwrap().clone());
        }
        t
    }

    #[test]
    fn ripple_edit_groups_the_shifted_clips_and_keeps_the_trim_separate() {
        let b = timeline_of(&[("a", "v1", 0, 60), ("b", "v1", 60, 30), ("c", "v1", 90, 30), ("d", "v1", 120, 30)]);
        // a trimmed by 15 frames; b, c, d rippled 15 frames earlier.
        let mut r = with(b.clone(), "a", "out", json!(45));
        for (id, s) in [("b", 45), ("c", 75), ("d", 105)] {
            r = with(r, id, "start", json!(s));
        }
        let g = diff_grouped(&b, &b, &r);
        assert_eq!(g.groups.len(), 1);
        assert_eq!(g.groups[0].delta, -15);
        assert_eq!(g.groups[0].members, ["clip:b", "clip:c", "clip:d"]);
        assert_eq!(g.groups[0].tracks, ["v1"]);
        assert!(!g.groups[0].members.contains(&"clip:a".to_string()));
    }

    #[test]
    fn multi_select_move_across_tracks_is_one_group() {
        let b = timeline_of(&[("a", "v1", 0, 30), ("t", "titles", 10, 30)]);
        let r = with(with(b.clone(), "a", "start", json!(60)), "t", "start", json!(70));
        let g = diff_grouped(&b, &b, &r);
        assert_eq!(g.groups.len(), 1);
        assert_eq!(g.groups[0].delta, 60);
        assert_eq!(g.groups[0].tracks, ["titles", "v1"]);
    }

    #[test]
    fn different_deltas_and_single_moves_are_not_grouped() {
        let b = timeline_of(&[("a", "v1", 0, 30), ("b", "v1", 30, 30), ("c", "v1", 60, 30), ("d", "v1", 90, 30)]);
        let r = with(with(with(b.clone(), "a", "start", json!(10)), "b", "start", json!(50)), "c", "start", json!(80));
        // a +10, b +20, c +20 → only b and c group.
        let g = diff_grouped(&b, &b, &r);
        assert_eq!(g.groups.len(), 1);
        assert_eq!(g.groups[0].members, ["clip:b", "clip:c"]);
        let single = with(b.clone(), "d", "start", json!(200));
        assert!(diff_grouped(&b, &b, &single).groups.is_empty());
    }

    #[test]
    fn conflicted_and_multi_field_changes_stay_separate() {
        let b = timeline_of(&[("a", "v1", 0, 30), ("b", "v1", 30, 30), ("c", "v1", 60, 30)]);
        let r = with(with(with(b.clone(), "a", "start", json!(10)), "b", "start", json!(40)), "c", "start", json!(70));
        let main = with(b.clone(), "a", "start", json!(5)); // conflicts with the branch's a
        let r2 = with(r.clone(), "c", "opacity", json!(0.5)); // c changed more than its start
        let g = diff_grouped(&b, &main, &r2);
        assert!(g.groups.is_empty(), "{:?}", g.groups);
    }

    // Property tests: merge laws over random timelines.

    fn arb_clip() -> impl Strategy<Value = Obj> {
        (0i64..300, 0i64..50, 1i64..100, 0u8..3, prop::option::of(0u8..10)).prop_map(|(s, i, l, t, o)| {
            let mut c = json!({"trackId": format!("t{t}"), "start": s, "in": i, "out": i + l});
            if let Some(o) = o {
                c["opacity"] = json!(o as f64 / 10.0);
            }
            c.as_object().unwrap().clone()
        })
    }

    fn arb_timeline() -> impl Strategy<Value = Timeline> {
        prop::collection::btree_map("[a-f]", arb_clip(), 0..6).prop_map(|clips| Timeline {
            fps: 30,
            clips,
            ..Default::default()
        })
    }

    proptest! {
        #[test]
        fn merge_base_base_b_is_b(base in arb_timeline(), b in arb_timeline()) {
            prop_assert_eq!(all(&base, &base, &b).result.clips, b.clips);
        }

        #[test]
        fn merge_base_a_base_is_a(base in arb_timeline(), a in arb_timeline()) {
            prop_assert_eq!(all(&base, &a, &base).result.clips, a.clips);
        }

        #[test]
        fn merge_identical_sides_is_idempotent(base in arb_timeline(), x in arb_timeline()) {
            let m = all(&base, &x, &x);
            prop_assert!(m.conflicts.is_empty());
            prop_assert_eq!(m.result.clips, x.clips);
        }

        #[test]
        fn empty_selection_keeps_main(base in arb_timeline(), a in arb_timeline(), b in arb_timeline()) {
            prop_assert_eq!(merge(&base, &a, &b, &Selection::default()).result.clips, a.clips);
        }

        #[test]
        fn conflicts_are_flagged_in_diff(base in arb_timeline(), a in arb_timeline(), b in arb_timeline()) {
            let flagged: BTreeSet<String> = diff(&base, &a, &b).into_iter().filter(|c| c.conflict).map(|c| c.id).collect();
            let found: BTreeSet<String> = all(&base, &a, &b).conflicts.into_iter().map(|c| c.change_id).collect();
            prop_assert_eq!(flagged, found);
        }
    }
}
