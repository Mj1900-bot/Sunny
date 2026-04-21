//! `fallback` — builds the ordered fallback chain for each tier.
//!
//! The chain always ends at `QuickThink` (cheapest / always available).
//! Callers iterate the chain in order when a tier fails to respond.

use super::tier::Tier;

/// Build the fallback chain for a chosen tier.
///
/// The chain is: `[chosen, next-lower, …, QuickThink]`.
/// `QuickThink` is already the bottom and its chain is length-1.
///
/// The function is pure; it never allocates shared state.
pub fn build_fallback_chain(chosen: Tier) -> Vec<Tier> {
    match chosen {
        Tier::QuickThink => vec![Tier::QuickThink],
        Tier::Cloud      => vec![Tier::Cloud,      Tier::QuickThink],
        Tier::DeepLocal  => vec![Tier::DeepLocal,  Tier::Cloud, Tier::QuickThink],
        Tier::Premium    => vec![Tier::Premium,    Tier::DeepLocal, Tier::Cloud, Tier::QuickThink],
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quick_think_chain_is_single_element() {
        let chain = build_fallback_chain(Tier::QuickThink);
        assert_eq!(chain, vec![Tier::QuickThink]);
    }

    #[test]
    fn cloud_chain_descends_to_quick_think() {
        let chain = build_fallback_chain(Tier::Cloud);
        assert_eq!(chain, vec![Tier::Cloud, Tier::QuickThink]);
    }

    #[test]
    fn deep_local_chain_has_three_elements() {
        let chain = build_fallback_chain(Tier::DeepLocal);
        assert_eq!(chain, vec![Tier::DeepLocal, Tier::Cloud, Tier::QuickThink]);
    }

    #[test]
    fn premium_chain_has_all_four_tiers() {
        let chain = build_fallback_chain(Tier::Premium);
        assert_eq!(chain, vec![Tier::Premium, Tier::DeepLocal, Tier::Cloud, Tier::QuickThink]);
    }

    #[test]
    fn all_chains_end_with_quick_think() {
        for t in [Tier::QuickThink, Tier::Cloud, Tier::DeepLocal, Tier::Premium] {
            let chain = build_fallback_chain(t);
            assert_eq!(*chain.last().unwrap(), Tier::QuickThink);
        }
    }

    #[test]
    fn all_chains_start_with_chosen_tier() {
        for t in [Tier::QuickThink, Tier::Cloud, Tier::DeepLocal, Tier::Premium] {
            let chain = build_fallback_chain(t);
            assert_eq!(chain[0], t);
        }
    }

    #[test]
    fn chains_have_no_duplicates() {
        for t in [Tier::QuickThink, Tier::Cloud, Tier::DeepLocal, Tier::Premium] {
            let chain = build_fallback_chain(t);
            let mut seen = std::collections::HashSet::new();
            for tier in &chain {
                assert!(seen.insert(tier), "duplicate tier in chain for {:?}", t);
            }
        }
    }
}
