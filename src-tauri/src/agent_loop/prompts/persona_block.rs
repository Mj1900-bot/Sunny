//! PERSONA block — who SUNNY is.
//!
//! This block captures identity, voice register, and communication style.
//! It deliberately contains NO tool-use instructions and NO safety rules —
//! those live in their own blocks so each can evolve independently.
//!
//! Rule: this file is pure/immutable — every function returns a new `String`
//! or `&'static str`; nothing is mutated.

/// Full-fidelity persona header injected into every system prompt.
/// Describes SUNNY's identity, voice, and behavioural register.
/// Keep this under ~60 words — the block is prefixed by safety + tools,
/// so long persona text delays the model reaching the hard rules.
pub const PERSONA_HEADER: &str = "\
--- PERSONA ---
You are SUNNY (Adaptive Unified Reasoning Assistant), a personal desktop \
assistant running on macOS. You were built by and for Sunny. You have a \
warm, dry, distinctly British voice — think calm intelligence, not servility. \
Speak in short, complete sentences. No emoji. No filler preambles like \
\"Certainly!\" or \"Of course!\". One answer, delivered cleanly.
--- END PERSONA ---";

/// Compact one-paragraph persona for time-sensitive paths (voice, low-latency).
/// Trades depth for brevity; full SOUL bundle from ~/.sunny/ is preferred when
/// available, but this is the fallback when the bundle is missing.
pub fn compact_persona() -> &'static str {
    "PERSONA: You are SUNNY, Sunny's British-voiced Mac assistant.\n\
     Speak in short, warm British sentences. No emoji, no preamble.\n\
     Tools before guessing — call web_search, memory_recall, or the\n\
     relevant live tool whenever a fact could be stale or personal.\n\
     One reply, one answer. Do not chain tool calls after you have it."
}

/// Assemble the persona block. When the full SOUL bundle is available it is
/// used verbatim (it already includes identity + style + agents). When it is
/// missing we fall back to `PERSONA_HEADER`.
///
/// Returns a newly allocated `String` — never mutates any argument.
pub fn build_persona_block(soul: Option<&str>) -> String {
    match soul {
        Some(text) => {
            let mut block = String::with_capacity(text.len() + 64);
            block.push_str("--- SOUL (who you are) ---\n");
            block.push_str(text);
            block.push_str("\n--- END SOUL ---");
            block
        }
        None => PERSONA_HEADER.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_persona_block_with_soul_wraps_correctly() {
        let soul = "I am SUNNY.";
        let block = build_persona_block(Some(soul));
        assert!(block.contains("--- SOUL (who you are) ---"), "must open SOUL fence");
        assert!(block.contains("I am SUNNY."), "must include soul text");
        assert!(block.contains("--- END SOUL ---"), "must close SOUL fence");
    }

    #[test]
    fn build_persona_block_without_soul_uses_header() {
        let block = build_persona_block(None);
        assert!(block.contains("SUNNY"), "must mention SUNNY");
        assert!(block.contains("British"), "must mention British voice");
        assert!(!block.contains("--- SOUL"), "must NOT use SOUL fence when soul is None");
    }

    #[test]
    fn compact_persona_mentions_sunny_and_british() {
        let p = compact_persona();
        assert!(p.contains("SUNNY"), "compact_persona must name SUNNY");
        assert!(p.contains("British"), "compact_persona must reference British voice");
    }

    #[test]
    fn build_persona_block_is_immutable_different_inputs() {
        // Calling twice with the same input must produce identical output —
        // confirms no global state is mutated.
        let a = build_persona_block(Some("soul text"));
        let b = build_persona_block(Some("soul text"));
        assert_eq!(a, b, "build_persona_block must be deterministic");
    }
}
