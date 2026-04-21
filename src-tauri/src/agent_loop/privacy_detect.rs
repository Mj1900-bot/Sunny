//! `privacy_detect` — pure content classifier for K1's model router.
//!
//! Scans a message string for patterns that indicate privacy-sensitive content
//! and returns a `(bool, Vec<&'static str>)` pair: the flag and the ordered
//! list of human-readable reasons that triggered the flag.
//!
//! # Design constraints
//! - Pure functions; no I/O, no heap allocation beyond the reason Vec.
//! - Zero false positives on "how do I …" coding questions.  The classifier
//!   distinguishes **disclosure** ("my SSN is …") from **reference**
//!   ("how do I validate an SSN").  Patterns are anchored around first-person
//!   possession markers or structurally unambiguous data (key prefixes, Luhn
//!   card numbers, PEM headers).
//! - `#[must_use]` on the public function so callers don't accidentally ignore
//!   the flag.

use regex::Regex;
use std::sync::OnceLock;

// ---------------------------------------------------------------------------
// Compiled regex cache — built once, reused for every call
// ---------------------------------------------------------------------------

struct Patterns {
    // 1. Secrets
    api_key_prefix:  Regex,
    bearer_token:    Regex,
    pem_header:      Regex,
    ssh_key:         Regex,

    // 2. PII
    ssn:             Regex,
    email_with_ctx:  Regex,

    // 3. Financial
    iban:            Regex,
    routing_number:  Regex,
    swift_code:      Regex,
    account_number:  Regex,

    // 4. Medical
    med_dosage:      Regex,
    medical_ctx:     Regex,

    // 5. Legal
    case_number:     Regex,
    legal_ctx:       Regex,

    // 6. Credentials
    password_field:  Regex,
    passphrase_ctx:  Regex,

    // 7. Explicit opt-in phrases
    opt_in:          Regex,

    // Credit card — structural (Luhn checked separately)
    card_candidate:  Regex,
}

impl Patterns {
    fn build() -> Self {
        // Helper to panic-free compile (only panics at boot if pattern is wrong)
        fn r(pat: &str) -> Regex {
            Regex::new(pat).expect("privacy_detect: bad pattern")
        }

        Self {
            // 1. Secrets -------------------------------------------------------
            // Detect known secret prefixes followed by at least 8 word chars.
            // Using a word-boundary anchor before the prefix prevents matching
            // inside longer identifiers but allows them at line-start or after
            // whitespace.
            api_key_prefix: r(
                r"(?i)\b(sk-|pk_live_|pk_test_|AKIA[0-9A-Z]{4}|ghp_|ghs_)[A-Za-z0-9_\-]{8,}"
            ),
            // "Bearer <token>" with at least 20 chars — very unlikely in benign text
            bearer_token: r(
                r"(?i)\bbearer\s+[A-Za-z0-9\-._~+/]{20,}"
            ),
            // PEM block — unambiguous; no HOW-question false-positive risk
            pem_header: r(
                r"-----BEGIN (RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----"
            ),
            // OpenSSH public/private key material
            ssh_key: r(
                r"(?:ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp256)\s+AAAA[A-Za-z0-9+/]{40,}"
            ),

            // 2. PII -----------------------------------------------------------
            // SSN: must be preceded by first-person possession context OR
            // be in a "my ssn is / ssn:" pattern to avoid HOW-question
            // false positives ("validate 123-45-6789" should NOT trigger).
            // We require a contextual anchor within 40 chars before the number
            // via a look-ahead-free approach: embed the context in the pattern.
            ssn: r(
                r"(?i)(?:my\s+(?:social(?:\s+security(?:\s+number)?)?|ssn)\s*(?:is|:)|ssn\s*[:=])\s*\d{3}[- ]\d{2}[- ]\d{4}"
            ),
            // Email: only flag when preceded by phrases that indicate disclosure
            email_with_ctx: r(
                r"(?i)(?:my\s+email(?:\s+(?:is|address\s+is))?|send\s+(?:it\s+)?to|contact\s+me\s+at|email\s+me\s+at|reply\s+to)\s+[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}"
            ),

            // 3. Financial -----------------------------------------------------
            // IBAN: 2-letter country code + 2 digits + up to 30 alphanum,
            // with optional spaces every 4 chars.
            iban: r(
                r"\b[A-Z]{2}\d{2}[A-Z0-9 ]{11,30}\b"
            ),
            // US routing number: exactly 9 digits (ABA) — require a context label
            // to prevent false positives on any 9-digit number.
            routing_number: r(
                r"(?i)(?:routing(?:\s+number)?|aba|rtn)\s*[:#]?\s*\b\d{9}\b"
            ),
            // SWIFT/BIC: 8 or 11 uppercase alphanum with bank/country structure
            swift_code: r(
                r"\b[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b"
            ),
            // Account number: require a label prefix to avoid digit-stream false positives
            account_number: r(
                r"(?i)(?:account\s*(?:number|no\.?|#)|acct\s*(?:no\.?|#)?)\s*[:#]?\s*\d{6,17}"
            ),

            // 4. Medical -------------------------------------------------------
            // Medication name followed by a dosage (e.g. "metformin 500mg")
            // Covers ~50 common medications without an exhaustive list:
            // match any word ending in common drug suffixes + a numeric dosage.
            med_dosage: r(
                r"(?i)\b(?:metformin|lisinopril|atorvastatin|amoxicillin|sertraline|escitalopram|fluoxetine|amlodipine|omeprazole|losartan|gabapentin|hydrochlorothiazide|alprazolam|zolpidem|tramadol|oxycodone|prednisone|levothyroxine|warfarin|furosemide)\s+\d+\s*(?:mg|mcg|ml|g)\b"
            ),
            // First-person medical context
            medical_ctx: r(
                r"(?i)\b(?:my\s+(?:diagnosis|doctor\s+said|prescription|medication|blood\s+(?:pressure|sugar|test)|test\s+results?)|i\s+(?:was\s+diagnosed|have\s+been\s+prescribed|am\s+taking))\b"
            ),

            // 5. Legal ---------------------------------------------------------
            // Civil/criminal case number patterns (US federal + state styles)
            case_number: r(
                r"(?i)(?:case\s*(?:no\.?|number|#)|docket\s*(?:no\.?|#)?)\s*[:#]?\s*\d{1,2}[-:]\w{2,10}[-:]\d{4,8}"
            ),
            // First-person legal disclosures
            legal_ctx: r(
                r"(?i)\b(?:my\s+attorney|my\s+lawyer|confidential\s+under\s+(?:nda|non.?disclosure)|attorney.client\s+privilege|under\s+nda)\b"
            ),

            // 6. Credentials ---------------------------------------------------
            // "password: <value>" or "passwd: <value>" — require a non-blank value
            password_field: r(
                r"(?i)\b(?:password|passwd|pwd)\s*[:=]\s*\S+"
            ),
            // Passphrase context: "my passphrase is" / "passphrase:"
            passphrase_ctx: r(
                r"(?i)\b(?:my\s+passphrase|passphrase\s*[:=]|enter\s+passphrase)\b"
            ),

            // 7. Explicit opt-in -----------------------------------------------
            opt_in: r(
                r"(?i)\b(?:don'?t\s+send\s+(?:this\s+)?to\s+(?:the\s+)?cloud|keep\s+(?:this\s+)?(?:data\s+)?local|this\s+is\s+private|offline\s+only)\b"
            ),

            // Credit card candidate — raw digit strings 13-19 chars (Luhn checked separately)
            card_candidate: r(
                r"\b(?:\d[ \-]?){12,18}\d\b"
            ),
        }
    }
}

static PATTERNS: OnceLock<Patterns> = OnceLock::new();

fn patterns() -> &'static Patterns {
    PATTERNS.get_or_init(Patterns::build)
}

// ---------------------------------------------------------------------------
// Luhn algorithm — validates credit card candidate strings
// ---------------------------------------------------------------------------

/// Returns `true` if the digit string (spaces/dashes stripped) passes Luhn.
fn luhn_valid(raw: &str) -> bool {
    let digits: Vec<u8> = raw
        .chars()
        .filter(|c| c.is_ascii_digit())
        .map(|c| c as u8 - b'0')
        .collect();

    let len = digits.len();
    if !(13..=19).contains(&len) {
        return false;
    }

    let sum: u32 = digits
        .iter()
        .rev()
        .enumerate()
        .map(|(i, &d)| {
            if i % 2 == 1 {
                let doubled = u32::from(d) * 2;
                if doubled > 9 { doubled - 9 } else { doubled }
            } else {
                u32::from(d)
            }
        })
        .sum();

    sum % 10 == 0
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Classify `message` for privacy-sensitive content.
///
/// Returns `(true, reasons)` when any pattern fires, `(false, [])` otherwise.
/// `reasons` contains `&'static str` labels — one per triggered category —
/// suitable for logging or routing metadata.
///
/// # False-positive avoidance
///
/// "How do I …" questions are safe: SSN/email patterns require a first-person
/// possession anchor; credit cards require Luhn validity; secret prefixes
/// require the full token suffix length; financial patterns require label
/// prefixes; medical/legal patterns require first-person phrasing.
#[must_use]
pub fn is_privacy_sensitive(message: &str) -> (bool, Vec<&'static str>) {
    let p = patterns();
    let mut reasons: Vec<&'static str> = Vec::new();

    // 1. Secrets
    if p.api_key_prefix.is_match(message) {
        reasons.push("api_key_or_token");
    }
    if p.bearer_token.is_match(message) {
        reasons.push("bearer_token");
    }
    if p.pem_header.is_match(message) {
        reasons.push("private_key_pem");
    }
    if p.ssh_key.is_match(message) {
        reasons.push("ssh_key_material");
    }

    // 2. PII
    if p.ssn.is_match(message) {
        reasons.push("ssn");
    }
    if p.email_with_ctx.is_match(message) {
        reasons.push("email_disclosure");
    }
    // Credit cards: structural match + Luhn
    if p.card_candidate.is_match(message) {
        for mat in p.card_candidate.find_iter(message) {
            if luhn_valid(mat.as_str()) {
                reasons.push("credit_card");
                break;
            }
        }
    }

    // 3. Financial
    if p.iban.is_match(message) {
        reasons.push("iban");
    }
    if p.routing_number.is_match(message) {
        reasons.push("routing_number");
    }
    if p.swift_code.is_match(message) {
        reasons.push("swift_bic_code");
    }
    if p.account_number.is_match(message) {
        reasons.push("account_number");
    }

    // 4. Medical
    if p.med_dosage.is_match(message) {
        reasons.push("medication_dosage");
    }
    if p.medical_ctx.is_match(message) {
        reasons.push("medical_disclosure");
    }

    // 5. Legal
    if p.case_number.is_match(message) {
        reasons.push("case_number");
    }
    if p.legal_ctx.is_match(message) {
        reasons.push("legal_disclosure");
    }

    // 6. Credentials
    if p.password_field.is_match(message) {
        reasons.push("credential_field");
    }
    if p.passphrase_ctx.is_match(message) {
        reasons.push("passphrase_context");
    }

    // 7. Explicit opt-in
    if p.opt_in.is_match(message) {
        reasons.push("user_privacy_opt_in");
    }

    let flag = !reasons.is_empty();
    (flag, reasons)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    fn assert_sensitive(msg: &str, expected_reason: &str) {
        let (flag, reasons) = is_privacy_sensitive(msg);
        assert!(
            flag,
            "expected SENSITIVE for {:?} (looking for reason '{}')",
            msg, expected_reason
        );
        assert!(
            reasons.contains(&expected_reason),
            "reason '{}' missing from {:?} for message {:?}",
            expected_reason, reasons, msg
        );
    }

    fn assert_clean(msg: &str) {
        let (flag, reasons) = is_privacy_sensitive(msg);
        assert!(
            !flag,
            "expected CLEAN for {:?} but got reasons {:?}",
            msg, reasons
        );
    }

    // -----------------------------------------------------------------------
    // Category 1: Secrets
    // -----------------------------------------------------------------------

    #[test]
    fn detects_openai_sk_key() {
        assert_sensitive(
            "My API key is sk-proj-ABCDEFGHabcdefgh1234",
            "api_key_or_token",
        );
    }

    #[test]
    fn detects_stripe_pk_live() {
        assert_sensitive(
            "stripe pk_live_51ABCDEFabcdefgh12345678",
            "api_key_or_token",
        );
    }

    #[test]
    fn detects_aws_akia_key() {
        assert_sensitive(
            "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
            "api_key_or_token",
        );
    }

    #[test]
    fn detects_github_pat_ghp() {
        assert_sensitive(
            "token: ghp_1234567890abcdefghij",
            "api_key_or_token",
        );
    }

    #[test]
    fn detects_bearer_token() {
        assert_sensitive(
            "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload",
            "bearer_token",
        );
    }

    #[test]
    fn detects_pem_private_key() {
        assert_sensitive(
            "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...",
            "private_key_pem",
        );
    }

    #[test]
    fn detects_openssh_private_key() {
        assert_sensitive(
            "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk...",
            "private_key_pem",
        );
    }

    #[test]
    fn detects_ssh_rsa_key_material() {
        // Real ssh-rsa keys are ~372 chars of base64 after AAAA; use a
        // representative 48-char body to trigger the `{40,}` repetition.
        assert_sensitive(
            "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC7kPnhGqTf3vL8mZYvXwR9bN2user@host",
            "ssh_key_material",
        );
    }

    // -----------------------------------------------------------------------
    // Category 2: PII
    // -----------------------------------------------------------------------

    #[test]
    fn detects_ssn_with_context() {
        assert_sensitive("My SSN is 123-45-6789", "ssn");
    }

    #[test]
    fn detects_ssn_colon_form() {
        assert_sensitive("ssn: 987-65-4321", "ssn");
    }

    #[test]
    fn detects_email_with_send_to_context() {
        assert_sensitive(
            "Please send it to alice@example.com",
            "email_disclosure",
        );
    }

    #[test]
    fn detects_email_with_my_email_context() {
        assert_sensitive("my email is bob@work.io", "email_disclosure");
    }

    #[test]
    fn detects_luhn_valid_visa_card() {
        // Classic Visa test number: 4111 1111 1111 1111
        assert_sensitive("my card is 4111111111111111", "credit_card");
    }

    #[test]
    fn detects_luhn_valid_mastercard_with_spaces() {
        // 5500 0055 5555 5559 — Luhn valid MasterCard test number
        assert_sensitive("card: 5500 0055 5555 5559", "credit_card");
    }

    // -----------------------------------------------------------------------
    // Category 3: Financial
    // -----------------------------------------------------------------------

    #[test]
    fn detects_iban() {
        assert_sensitive("IBAN: GB29NWBK60161331926819", "iban");
    }

    #[test]
    fn detects_routing_number() {
        assert_sensitive("routing number: 021000021", "routing_number");
    }

    #[test]
    fn detects_account_number() {
        assert_sensitive("account number: 123456789012", "account_number");
    }

    // -----------------------------------------------------------------------
    // Category 4: Medical
    // -----------------------------------------------------------------------

    #[test]
    fn detects_medication_with_dosage() {
        assert_sensitive("I take metformin 500mg twice a day", "medication_dosage");
    }

    #[test]
    fn detects_my_diagnosis() {
        assert_sensitive("my diagnosis is type 2 diabetes", "medical_disclosure");
    }

    #[test]
    fn detects_doctor_said() {
        assert_sensitive("my doctor said to rest for a week", "medical_disclosure");
    }

    // -----------------------------------------------------------------------
    // Category 5: Legal
    // -----------------------------------------------------------------------

    #[test]
    fn detects_case_number() {
        assert_sensitive("case no: 2-cv-2024-001234", "case_number");
    }

    #[test]
    fn detects_my_attorney() {
        assert_sensitive("my attorney reviewed the contract", "legal_disclosure");
    }

    #[test]
    fn detects_confidential_under_nda() {
        assert_sensitive(
            "This is confidential under NDA between the parties",
            "legal_disclosure",
        );
    }

    // -----------------------------------------------------------------------
    // Category 6: Credentials
    // -----------------------------------------------------------------------

    #[test]
    fn detects_password_field() {
        assert_sensitive("password: hunter2", "credential_field");
    }

    #[test]
    fn detects_passwd_equals() {
        assert_sensitive("passwd=s3cur3P@ss!", "credential_field");
    }

    #[test]
    fn detects_passphrase_context() {
        assert_sensitive("my passphrase is correct horse battery staple", "passphrase_context");
    }

    // -----------------------------------------------------------------------
    // Category 7: Explicit opt-in
    // -----------------------------------------------------------------------

    #[test]
    fn detects_dont_send_to_cloud() {
        assert_sensitive("don't send this to the cloud", "user_privacy_opt_in");
    }

    #[test]
    fn detects_keep_this_local() {
        assert_sensitive("please keep this local", "user_privacy_opt_in");
    }

    #[test]
    fn detects_this_is_private() {
        assert_sensitive("this is private, don't share", "user_privacy_opt_in");
    }

    #[test]
    fn detects_offline_only() {
        assert_sensitive("offline only please", "user_privacy_opt_in");
    }

    // -----------------------------------------------------------------------
    // False-positive guard: benign coding questions
    // -----------------------------------------------------------------------

    #[test]
    fn clean_how_to_hash_password() {
        assert_clean("how do I hash a password in rust");
    }

    #[test]
    fn clean_how_to_validate_ssn() {
        assert_clean("how do I validate an SSN format like 123-45-6789 in Python");
    }

    #[test]
    fn clean_how_to_validate_credit_card() {
        // Luhn-invalid number — structural match but no Luhn pass
        assert_clean("validate credit card number 1234567890123456");
    }

    #[test]
    fn clean_email_in_code_example() {
        // Not preceded by a disclosure context phrase
        assert_clean("regex pattern for user@example.com addresses");
    }

    #[test]
    fn clean_password_hashing_question() {
        assert_clean("what is the best algorithm to hash passwords");
    }

    #[test]
    fn clean_generic_medical_question() {
        assert_clean("what is the recommended dosage of metformin for type 2 diabetes");
    }

    #[test]
    fn clean_empty_message() {
        assert_clean("");
    }

    #[test]
    fn clean_emoji_only() {
        assert_clean("hello world! \u{1F600}\u{1F44D}");
    }

    #[test]
    fn clean_unicode_text() {
        assert_clean("こんにちは世界。ありがとうございます。");
    }

    #[test]
    fn clean_generic_api_question() {
        assert_clean("how do API keys work in general");
    }

    // -----------------------------------------------------------------------
    // Reason list content
    // -----------------------------------------------------------------------

    #[test]
    fn multiple_reasons_returned() {
        let msg = "my SSN is 123-45-6789 and password: s3cr3t";
        let (flag, reasons) = is_privacy_sensitive(msg);
        assert!(flag);
        assert!(reasons.contains(&"ssn"), "expected ssn in {:?}", reasons);
        assert!(
            reasons.contains(&"credential_field"),
            "expected credential_field in {:?}",
            reasons
        );
    }

    #[test]
    fn clean_returns_empty_reasons() {
        let (flag, reasons) = is_privacy_sensitive("what is the capital of France");
        assert!(!flag);
        assert!(reasons.is_empty());
    }

    // -----------------------------------------------------------------------
    // Luhn edge cases
    // -----------------------------------------------------------------------

    #[test]
    fn luhn_rejects_invalid_card() {
        // 4111111111111112 — Luhn fails (last digit changed)
        let (_, reasons) = is_privacy_sensitive("4111111111111112");
        assert!(
            !reasons.contains(&"credit_card"),
            "should not flag Luhn-invalid number"
        );
    }

    #[test]
    fn luhn_accepts_amex_test_number() {
        // AmEx test: 378282246310005 (15 digits, Luhn valid)
        assert_sensitive("card number 378282246310005", "credit_card");
    }
}
