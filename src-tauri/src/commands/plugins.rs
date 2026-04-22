//! Plugin-system Tauri commands.
//!
//! v0.1 surface: a single read-only `plugin_list` command the HUD
//! calls to render what's currently loaded from `~/.sunny/plugins/`.
//! The executor layer (v0.2) will add `plugin_invoke_tool`, but
//! registry inspection lands here so the HUD can build its
//! Settings → Plugins page against the foundation right away.

use serde::Serialize;
use ts_rs::TS;

use crate::agent_loop::plugins::{self, LoadedPlugin};

/// Compact, TS-exportable summary of one loaded plugin — avoids
/// shipping the raw `input_schema: serde_json::Value` trees over the
/// bridge (those can be large) while still giving the HUD everything
/// it needs to render a list row.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct PluginListEntry {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    #[ts(optional)]
    pub description: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub author: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub homepage: Option<String>,
    /// Absolute path to the plugin root directory.
    pub root_dir: String,
    /// Names of the tools the plugin declares. Useful for the HUD's
    /// "N tools" badge without shipping every schema.
    pub tool_names: Vec<String>,
}

impl From<&LoadedPlugin> for PluginListEntry {
    fn from(p: &LoadedPlugin) -> Self {
        PluginListEntry {
            id: p.manifest.id.clone(),
            name: p.manifest.name.clone(),
            version: p.manifest.version.clone(),
            description: p.manifest.description.clone(),
            author: p.manifest.author.clone(),
            homepage: p.manifest.homepage.clone(),
            root_dir: p.root_dir.display().to_string(),
            tool_names: p.manifest.tools.iter().map(|t| t.name.clone()).collect(),
        }
    }
}

/// List every plugin that successfully loaded on the last scan.
/// Runs against the `OnceLock` registry so the call is effectively
/// free — safe to poll from the HUD on a Settings-page refresh.
#[tauri::command]
pub fn plugin_list() -> Vec<PluginListEntry> {
    plugins::registered_plugins()
        .iter()
        .map(PluginListEntry::from)
        .collect()
}
