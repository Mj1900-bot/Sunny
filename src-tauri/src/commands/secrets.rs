//! Secret management and API key commands.

use crate::secrets;
use crate::ai;

/// Report which provider API keys are currently reachable — env or
/// Keychain, in that order. We never return the actual key material to
/// the webview; only a boolean per provider.
#[tauri::command]
pub async fn secrets_status() -> secrets::SecretsStatus {
    secrets::status_all().await
}

/// Write an API key to the macOS Keychain under the provider-specific
/// service namespace. Validates format before invoking the keychain CLI
/// and never echoes the candidate value back to the webview.
///
/// `provider` must be one of the snake_case ids exposed by
/// `SecretKind::from_id` (`anthropic`, `zai`, `openai`, `openrouter`,
/// `elevenlabs`, `wavespeed`). Unknown ids return a structured error
/// rather than panicking.
#[tauri::command]
pub async fn secret_set(provider: String, value: String) -> Result<(), String> {
    let kind = secrets::SecretKind::from_id(&provider)
        .ok_or_else(|| format!("unknown provider '{provider}'"))?;
    secrets::keychain_set(kind, &value).await
}

/// Remove the stored Keychain entry for the given provider. Idempotent —
/// a missing entry is treated as success.
#[tauri::command]
pub async fn secret_delete(provider: String) -> Result<(), String> {
    let kind = secrets::SecretKind::from_id(&provider)
        .ok_or_else(|| format!("unknown provider '{provider}'"))?;
    secrets::keychain_delete(kind).await
}

/// Make a real API call with the stored key and report whether the
/// provider accepts it. Goes beyond `secrets_status` (which only reports
/// Keychain presence) to answer "will my next agent run actually
/// authenticate".
#[tauri::command]
pub async fn secret_verify(provider: String) -> Result<secrets::VerifyResult, String> {
    let kind = secrets::SecretKind::from_id(&provider)
        .ok_or_else(|| format!("unknown provider '{provider}'"))?;
    Ok(secrets::verify(kind).await)
}

/// Walk every provider's env-var aliases and persist anything set in the
/// process environment into the Keychain. Returns one outcome row per
/// provider so the UI can render a dry-run-style summary.
#[tauri::command]
pub async fn secret_import_env() -> Vec<secrets::ImportOutcome> {
    secrets::import_env_to_keychain().await
}

/// List the names of every Ollama model currently pulled on the local
/// daemon. Used by the Settings → MODELS tab to populate "quick picks"
/// with real installed models instead of a static hardcoded list.
///
/// Returns an empty list when the Ollama daemon isn't reachable — the
/// UI then falls back to a curated default set so the tab still works
/// on machines without Ollama.
#[tauri::command]
pub async fn ollama_list_models() -> Vec<String> {
    ai::list_ollama_models().await
}
