//! `memory_skill_*` Tauri commands — procedural skill surface.
//!
//! Also owns `UpdateSkillOpts` and `PatchRecipe`, the patch-semantics helpers
//! that live alongside the `memory_skill_update` command they serve.

use crate::memory;

// ---------------------------------------------------------------------------
// Patch helpers
// ---------------------------------------------------------------------------

/// Inline-edit a skill. Each `Option` field represents "patch or skip":
/// `None` → keep current value, `Some(...)` → overwrite. `recipe` uses a
/// double-option so the caller can distinguish "don't touch the recipe"
/// from "clear the recipe" (convert a recipe-backed skill into a
/// script-only one).
#[derive(serde::Deserialize)]
pub struct UpdateSkillOpts {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub trigger_text: Option<String>,
    /// Present with `null` → clear recipe; present with object → replace;
    /// absent → don't touch. Serde sees absent vs present-null the same
    /// way, so we wrap in a custom `With::Patch` sentinel below.
    #[serde(default, deserialize_with = "patch_recipe")]
    pub recipe: PatchRecipe,
}

#[derive(Default)]
pub enum PatchRecipe {
    #[default]
    Skip,
    Set(Option<serde_json::Value>),
}

fn patch_recipe<'de, D>(deserializer: D) -> Result<PatchRecipe, D::Error>
where
    D: serde::Deserializer<'de>,
{
    // Present value (including `null`) → Set(Option). Absent key → Skip
    // via serde `#[serde(default)]`.
    let v: serde_json::Value = serde::Deserialize::deserialize(deserializer)?;
    if v.is_null() {
        Ok(PatchRecipe::Set(None))
    } else {
        Ok(PatchRecipe::Set(Some(v)))
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn memory_skill_add(
    name: String,
    description: String,
    trigger_text: String,
    skill_path: Option<String>,
    recipe: Option<serde_json::Value>,
    // Sprint-12 η — provenance fields. If the frontend signs the manifest
    // (the default path in the SkillEditor), both values are populated.
    // Script-only and test callers may still omit them and get an unsigned
    // row.
    signature: Option<String>,
    signer_fingerprint: Option<String>,
) -> Result<memory::ProceduralSkill, String> {
    memory::procedural_add(
        name,
        description,
        trigger_text,
        skill_path.unwrap_or_default(),
        recipe,
        signature,
        signer_fingerprint,
    )
}

#[tauri::command]
pub fn memory_skill_list() -> Result<Vec<memory::ProceduralSkill>, String> {
    memory::procedural_list()
}

#[tauri::command]
pub fn memory_skill_get(id: String) -> Result<Option<memory::ProceduralSkill>, String> {
    memory::procedural_get(id)
}

#[tauri::command]
pub fn memory_skill_bump_use(
    id: String,
    success: Option<bool>,
) -> Result<memory::ProceduralSkill, String> {
    // Default to `true` for backward compatibility with any caller that
    // hasn't been updated — historical behavior treated every bump as a
    // success. Callers that know better pass `success: false`.
    memory::procedural_bump_use(id, success.unwrap_or(true))
}

#[tauri::command]
pub fn memory_skill_delete(id: String) -> Result<(), String> {
    memory::procedural_delete(id)
}

#[tauri::command]
pub fn memory_skill_update(
    id: String,
    patch: UpdateSkillOpts,
) -> Result<memory::ProceduralSkill, String> {
    let recipe: Option<Option<serde_json::Value>> = match patch.recipe {
        PatchRecipe::Skip => None,
        PatchRecipe::Set(opt) => Some(opt),
    };
    memory::procedural_update(
        id,
        patch.name,
        patch.description,
        patch.trigger_text,
        recipe,
    )
}
