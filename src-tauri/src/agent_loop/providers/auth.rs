//! Cached key-presence probes for the three providers the heuristic
//! router consults on every turn. Each probe bottoms out in
//! `secrets::key_present_cached`, which memoises the result
//! process-wide so the ~50-150 ms `/usr/bin/security
//! find-generic-password` subprocess spawn only runs on the first
//! cache miss (or after a `keychain_set` / `keychain_delete`
//! invalidation).
//!
//! Prior to the process-level cache, `pick_backend` re-paid the
//! subprocess cost on every turn the session cache missed — e.g. the
//! first turn on any new `session_id` or any mid-session provider
//! flip. With memoisation the subsequent probes are microsecond-cheap
//! map reads.

pub async fn anthropic_key_present() -> bool {
    crate::secrets::key_present_cached(crate::secrets::SecretKind::Anthropic).await
}

pub async fn zai_key_present() -> bool {
    crate::secrets::key_present_cached(crate::secrets::SecretKind::Zai).await
}

pub async fn moonshot_key_present() -> bool {
    crate::secrets::key_present_cached(crate::secrets::SecretKind::Moonshot).await
}
