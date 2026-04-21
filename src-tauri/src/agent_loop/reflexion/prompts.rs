//! Prompt builders for the Reflexion generator, critic, and refiner phases.
//!
//! Extracted from `reflexion/mod.rs` to keep the main file under 800 lines.
//! All functions are pure string transforms — no I/O, no async, easy to test.

use super::super::critic::trigger::ReplanTrigger;
use super::{triggers_preamble, Critique};

pub(super) fn build_generator_task(question: &str, replan_triggers: &[ReplanTrigger]) -> String {
    let preamble = triggers_preamble(replan_triggers);
    format!(
        "{preamble}You are the GENERATOR in a Reflexion loop. Style: thorough, specific, \
         willing to commit to a concrete answer (imagine temperature ≈ 0.7).\n\n\
         Answer the question thoroughly. Be specific. Do NOT hedge with \
         'it depends' without actually enumerating the cases. Aim for 4–12 \
         sentences of substantive prose — no bullet lists, no headings. \
         Your output will be handed to a critic for scoring.\n\n\
         QUESTION:\n{question}\n\n\
         Return ONLY the answer text — no preamble, no 'Here is my answer:', \
         no commentary about your process."
    )
}

pub(super) fn build_critic_task(question: &str, draft: &str) -> String {
    format!(
        "You are the CRITIC in a Reflexion loop. Style: conservative, literal, \
         skeptical (imagine temperature ≈ 0.2).\n\n\
         Rate the draft from 0.0 to 1.0 where 1.0 = perfect answer to the \
         question, 0.0 = completely wrong or off-topic. Be stingy — reserve \
         scores ≥ 0.8 for answers that are factually correct, specific, and \
         directly address the question.\n\n\
         Return ONLY a JSON object with these keys — no prose, no markdown \
         fences, no explanation:\n\
         {{\"score\": 0.X, \"issues\": [\"...\", \"...\"], \"suggestions\": [\"...\", \"...\"]}}\n\n\
         - score: number 0.0–1.0 (one decimal place is fine)\n\
         - issues: list of specific problems with the draft (≤5 items)\n\
         - suggestions: list of concrete improvements the refiner should apply \
           (≤5 items)\n\n\
         QUESTION:\n{question}\n\n\
         DRAFT TO SCORE:\n{draft}"
    )
}

pub(super) fn build_refiner_task(
    question: &str,
    prior_draft: &str,
    critique: &Critique,
    replan_triggers: &[ReplanTrigger],
) -> String {
    let preamble = triggers_preamble(replan_triggers);
    let issues = if critique.issues.is_empty() {
        "(no specific issues listed — the critic scored it low but vaguely; \
         focus on sharpening specifics and removing hedges)"
            .to_string()
    } else {
        critique
            .issues
            .iter()
            .enumerate()
            .map(|(i, s)| format!("  {}. {}", i + 1, s))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let suggestions = if critique.suggestions.is_empty() {
        "(none)".to_string()
    } else {
        critique
            .suggestions
            .iter()
            .enumerate()
            .map(|(i, s)| format!("  {}. {}", i + 1, s))
            .collect::<Vec<_>>()
            .join("\n")
    };
    format!(
        "{preamble}You are the REFINER in a Reflexion loop. Style: pragmatic, surgical \
         (imagine temperature ≈ 0.5).\n\n\
         Fix these issues. Apply these suggestions. Return only the improved \
         answer — no commentary, no 'here is the refined version:', no \
         markdown fences, no preamble.\n\n\
         QUESTION:\n{question}\n\n\
         PRIOR DRAFT (score {score:.2}):\n{prior_draft}\n\n\
         ISSUES:\n{issues}\n\n\
         SUGGESTIONS:\n{suggestions}",
        score = critique.score,
    )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generator_prompt_names_the_role_and_embeds_question() {
        let p = build_generator_task("Why is the sky blue?", &[]);
        assert!(p.contains("GENERATOR"));
        assert!(p.contains("Why is the sky blue?"));
        assert!(p.to_ascii_lowercase().contains("thorough"));
    }

    #[test]
    fn critic_prompt_specifies_json_shape_and_scoring_rules() {
        let p = build_critic_task("Q?", "some draft answer");
        assert!(p.contains("CRITIC"));
        assert!(p.contains("\"score\""));
        assert!(p.contains("\"issues\""));
        assert!(p.contains("\"suggestions\""));
        assert!(p.contains("0.0") && p.contains("1.0"));
        assert!(p.contains("some draft answer"));
    }

    #[test]
    fn refiner_prompt_lists_issues_and_suggestions() {
        let c = Critique {
            score: 0.3,
            issues: vec!["too vague".into(), "missing example".into()],
            suggestions: vec!["add a concrete case".into()],
        };
        let p = build_refiner_task("Q?", "prior draft here", &c, &[]);
        assert!(p.contains("REFINER"));
        assert!(p.contains("prior draft here"));
        assert!(p.contains("too vague"));
        assert!(p.contains("missing example"));
        assert!(p.contains("add a concrete case"));
        assert!(p.contains("0.30"));
    }

    #[test]
    fn refiner_prompt_handles_empty_critique_lists() {
        let c = Critique {
            score: 0.4,
            issues: vec![],
            suggestions: vec![],
        };
        let p = build_refiner_task("Q?", "draft", &c, &[]);
        assert!(p.contains("no specific issues"));
        assert!(p.contains("(none)"));
    }

    #[test]
    fn generator_prompt_includes_trigger_preamble_when_triggers_active() {
        let p = build_generator_task("Q?", &[ReplanTrigger::UserCorrection]);
        assert!(p.contains("HARD RESET"));
        assert!(p.contains("GENERATOR"));
    }

    #[test]
    fn refiner_prompt_includes_trigger_preamble_when_triggers_active() {
        let c = Critique { score: 0.3, issues: vec![], suggestions: vec![] };
        let p = build_refiner_task("Q?", "draft", &c, &[ReplanTrigger::LowConfidence]);
        assert!(p.contains("confidence threshold"));
        assert!(p.contains("REFINER"));
    }
}
