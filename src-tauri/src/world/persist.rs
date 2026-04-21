//! Atomic debounced persistence of `WorldState` to `~/.sunny/world.json`.
//! On a cold restart the frontend still shows the last-known world until
//! the updater's first live tick lands.

use std::path::PathBuf;

use super::model::WorldState;

const DIR_NAME: &str = ".sunny";
const FILE_NAME: &str = "world.json";

fn world_file() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "home unavailable".to_string())?;
    Ok(home.join(DIR_NAME).join(FILE_NAME))
}

pub(super) fn persist_to_disk(s: &WorldState) -> Result<(), String> {
    let path = world_file()?;
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p).map_err(|e| format!("mkdir world dir: {e}"))?;
    }
    let body = serde_json::to_string_pretty(s).map_err(|e| format!("encode world: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|e| format!("write world tmp: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename world: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

pub(super) fn load_from_disk() -> Option<WorldState> {
    let path = world_file().ok()?;
    let raw = std::fs::read_to_string(&path).ok()?;
    let mut s: WorldState = serde_json::from_str(&raw).ok()?;
    // Freshly-loaded state should not claim "it's been focused for 3 days"
    // — reset duration so the first live tick re-computes correctly.
    s.focused_duration_secs = 0;
    Some(s)
}
