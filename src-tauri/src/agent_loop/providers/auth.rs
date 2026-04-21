pub async fn anthropic_key_present() -> bool {
    crate::secrets::anthropic_api_key()
        .await
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
}

pub async fn zai_key_present() -> bool {
    crate::secrets::zai_api_key()
        .await
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
}
