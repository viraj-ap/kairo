//! kairo-core: the timeline engine compiled to WebAssembly.
//!
//! JSON crosses the JS boundary; the parsed timeline is cached in `Engine`
//! so per-frame planning doesn't re-parse.

pub mod merge;
pub mod model;
pub mod plan;

use model::Timeline;
use wasm_bindgen::prelude::*;

fn parse(json: &str) -> Result<Timeline, JsError> {
    serde_json::from_str(json).map_err(|e| JsError::new(&format!("bad timeline: {e}")))
}

fn to_json<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_string(v).expect("serializable")
}

#[wasm_bindgen]
pub struct Engine {
    tl: Timeline,
}

#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Engine {
        Engine { tl: Timeline::default() }
    }

    #[wasm_bindgen(js_name = setTimeline)]
    pub fn set_timeline(&mut self, json: &str) -> Result<(), JsError> {
        self.tl = parse(json)?;
        Ok(())
    }

    pub fn duration(&self) -> i64 {
        self.tl.duration()
    }

    #[wasm_bindgen(js_name = renderPlan)]
    pub fn render_plan(&self, frame: i64, lookahead: i64) -> String {
        to_json(&plan::render_plan(&self.tl, frame, lookahead))
    }

    #[wasm_bindgen(js_name = audioPlan)]
    pub fn audio_plan(&self) -> String {
        to_json(&plan::audio_plan(&self.tl))
    }
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
pub fn diff(base: &str, main: &str, branch: &str) -> Result<String, JsError> {
    Ok(to_json(&merge::diff(&parse(base)?, &parse(main)?, &parse(branch)?)))
}

/// Diff plus groups of related changes (ripples, multi-select moves).
#[wasm_bindgen(js_name = diffGrouped)]
pub fn diff_grouped(base: &str, main: &str, branch: &str) -> Result<String, JsError> {
    Ok(to_json(&merge::diff_grouped(&parse(base)?, &parse(main)?, &parse(branch)?)))
}

#[wasm_bindgen]
pub fn merge(base: &str, main: &str, branch: &str, selection: &str) -> Result<String, JsError> {
    let sel: merge::Selection =
        serde_json::from_str(selection).map_err(|e| JsError::new(&format!("bad selection: {e}")))?;
    Ok(to_json(&merge::merge(&parse(base)?, &parse(main)?, &parse(branch)?, &sel)))
}
