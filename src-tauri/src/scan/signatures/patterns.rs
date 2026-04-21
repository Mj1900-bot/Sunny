use super::types::SignatureEntry;
use super::entries::*;

// ---------------------------------------------------------------------------

pub const FILENAME_PATTERNS: &[(&str, &'static SignatureEntry)] = &[
    (r"(?i)(^|/)(AMOS_|Atomic[ _-]?Stealer|installer[_-]amos)", &ATOMIC_STEALER),
    (r"(?i)(^|/)(Install[_ -]?Flash[_ -]?Player|FlashInstaller|Adobe[_ -]?Flash[_ -]?Update)", &SHLAYER),
    (r"(?i)(^|/)(mughthesec|shouldconfig|geneio|spigot)", &SHLAYER),
    (r"(?i)/\.xcassets/[^/]*agent\.app(/|$)", &XCSSET),
    (r"(?i)/Library/Caches/GeoServices/geoservices\.plist$", &XCSSET),
    (r"(?i)(^|/)(SUGARLOADER|KANDYKORN|FinderTools|CryptoCloud)(\.app|\b)", &KANDYKORN),
    (r"(?i)(^|/)(InternalPDFViewer|Internal PDF Viewer)\.app", &RUSTBUCKET),
    (r"(?i)(^|/)(NotLockBit|LockBit(_| )?macOS)", &NOTLOCKBIT),
    (r"(?i)(^|/)(DumpMediaSpotifyMusicConverter|TuneSolo|FonePawAudioRecorder)\.app", &CUCKOO_STEALER),
    (r"(?i)(^|/)(CleanMyMac_?Installer|GTA[ _-]?IV[_ -]?Beta[_ -]?Installer|Adobe[ _-]?CC[_ -]?Installer)", &CTHULHU_STEALER),
    (r"(?i)(^|/)(Brawl Earth|SaintLegend|Pearl Land|Olymp of Reptiles)\.(app|dmg)", &REALST_STEALER),
    (r"(?i)(^|/)(banshee|poseidon_loader|frigid_stealer|updater_mac)\b", &BANSHEE_STEALER),
    (r"(?i)(^|/)(Poseidon|PoseidonInstaller)\.app", &POSEIDON_STEALER),
    (r"(?i)(^|/)(ChromeUpdate|SafariUpdate|FirefoxPatch)\.dmg$", &FRIGID_STEALER),
    (r"(?i)/Library/LaunchAgents/(com\.([a-z0-9]+)\.(agent|helper|update|daemon))\.plist$", &LAUNCHAGENT_PERSISTENCE),
    (r"(?i)(^|/)(pkg/CCV\.js|pkg/beaver\.js|VCamServiceClient|ffmpeg-static-win32-arm64)", &BEAVERTAIL),
    (r"(?i)(^|/)(SpaceRamble|SubstackNotify|Library/Application Support/com\.apple\.MacMa)", &WIP26),
    // Lumma — ClickFix / ClearFake lure filenames.
    (r"(?i)(^|/)(LummaC2|Lumma_Stealer|ClickFix|CaptchaRelease)", &LUMMA_STEALER),
    // JaskaGO — Go binaries dropped with distinctive names.
    (r"(?i)(^|/)(jaskago|capmonster[_-]?mac|go_stealer_arm64)", &JASKA_GO),
    // AppleJeus — fake crypto trading apps.
    (r"(?i)(^|/)(CelasTradePro|JMTTrading|UnionCryptoTrader|CoinGoTrade|Kupay[ _-]?Wallet)\.(app|dmg)", &APPLEJEUS),
    // HZ RAT macOS helper binaries.
    (r"(?i)(^|/)(HZRat|hz_rat_mac|wechat_helper_v[0-9]+)", &HZ_RAT),
    // MacStealer — "Apple Music" installer lure.
    (r"(?i)(^|/)(Apple[ _-]?Music[ _-]?Installer|mac_stealer_v[0-9]+)", &MAC_STEALER),
    // JokerSpy — the `xcc` / `sh.py` artefacts.
    (r"(?i)/\.local/share/(xcc|sh\.py|joker_spy)$", &JOKER_SPY),
    // FlexibleFerret — the Swift helper bundle names used by the 2025 cluster.
    (r"(?i)(^|/)(FlexibleFerret|ChromeUpdateHelper|BrowserRegistryAgent)\.app", &FLEXIBLE_FERRET),
    // AdLoad — rotating bundle id dirs under Application Support.
    (r"(?i)/Library/Application Support/com\.([A-Za-z0-9]+)\.(ElementaryTyped|ProgressiveTyped|SmartConnector)", &ADLOAD),
    // PyMafka / typosquat — the known package names when archived.
    (r"(?i)(^|/)(pymafka|colourama|ua-parser-js-0|react-scripts-9_5_0)/", &PYMAFKA_APT),
    // XMRig miner — the standard binary names shipped in dropper bundles.
    (r"(?i)(^|/)(xmrig|xmrig-cuda|xmrig-nvidia|xmrig-proxy|xmrig_mac)(\.app)?$", &XMRIG_MINER),
    // Infiniti Stealer / NukeChain — Nuitka loader + Python payload filenames.
    (r"(?i)(^|/)(InfinitiStealer|NukeChain|nuitka_loader|stealer_mac_v[0-9]+)(\.app|\.bin)?$", &INFINITI_STEALER),
    // DigitStealer — 2025-2026 malvertising cluster.
    (r"(?i)(^|/)(DigitStealer|digit_stealer_mac|digit[_-]amos)(\.app|\.dmg)?$", &DIGIT_STEALER),
    // MacSync — the impersonating "com.apple.macsync" LaunchDaemon path.
    (r"(?i)/Library/LaunchDaemons/com\.apple\.macsync\.helper\.plist$", &MAC_SYNC_STEALER),
    (r"(?i)(^|/)(MacSync|macsync_helper|com\.apple\.macsync)", &MAC_SYNC_STEALER),
    // Cursor MCP config files — flagged so that any workspace writing to
    // these during a scan sweep draws attention for manual review.
    (r"(?i)(^|/)\.cursor/mcp\.json$", &PI_CURXECUTE_MCP_WRITE),
    (r"(?i)(^|/)\.vscode/(settings|tasks|launch)\.json$", &PI_EDITOR_SPECIAL_FILE),
];

pub const FILENAME_ENTRIES: &[&'static SignatureEntry] = &[
    &ATOMIC_STEALER,
    &SHLAYER, &SHLAYER,
    &XCSSET, &XCSSET,
    &KANDYKORN, &RUSTBUCKET,
    &NOTLOCKBIT,
    &CUCKOO_STEALER,
    &CTHULHU_STEALER,
    &REALST_STEALER,
    &BANSHEE_STEALER, &POSEIDON_STEALER, &FRIGID_STEALER,
    &LAUNCHAGENT_PERSISTENCE,
    &BEAVERTAIL,
    &WIP26,
    // Added in the 2026.05 refresh.
    &LUMMA_STEALER,
    &JASKA_GO,
    &APPLEJEUS,
    &HZ_RAT,
    &MAC_STEALER,
    &JOKER_SPY,
    &FLEXIBLE_FERRET,
    &ADLOAD,
    &PYMAFKA_APT,
    &XMRIG_MINER,
    // Added in the 2026.06 refresh (March-April 2026 intel).
    &INFINITI_STEALER,
    &DIGIT_STEALER,
    &MAC_SYNC_STEALER,
    &MAC_SYNC_STEALER,
    &PI_CURXECUTE_MCP_WRITE,
    &PI_EDITOR_SPECIAL_FILE,
];

pub const CONTENT_PATTERNS: &[(&str, &'static SignatureEntry)] = &[
    // Malware-family behaviours
    (
        r#"display\s+dialog\s+.{0,80}(password|requires|macOS\s*(Ventura|Sonoma|Sequoia)|System\s+Preferences)"#,
        &AMOS_KEYCHAIN_DIALOG,
    ),
    (
        r#"\bsecurity\b[^\n]{0,80}\b(find-generic-password|dump-keychain|find-internet-password)\b[^\n]{0,30}-\w*w"#,
        &KEYCHAIN_DUMP,
    ),
    (
        r#"\b(curl|wget)\b[^\n]{0,200}\|\s*(bash|sh|zsh)\b"#,
        &CURL_PIPE_SH,
    ),
    (
        r#"\b(eval|Function|setTimeout|setInterval)\s*\(\s*(atob|base64_decode|Buffer\s*\.\s*from\([^,]+,\s*['"]base64['"]\))"#,
        &DECODE_AND_EXEC,
    ),
    (
        r#"\bosascript\b[^\n]{0,60}-e\b[^\n]{0,200}(base64|echo\s+[A-Za-z0-9+/=]{40,})"#,
        &OSASCRIPT_BASE64,
    ),
    (
        r#"\b(powershell|pwsh)(\.exe)?\b[^\n]{0,40}-e(nc(odedcommand)?)?\b[^\n]{0,20}[A-Za-z0-9+/=]{100,}"#,
        &POWERSHELL_ENCODED,
    ),
    // Prompt injection
    (
        r#"\bignore\s+(all\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|messages?|rules?|content|context)\b"#,
        &PI_IGNORE_PREVIOUS,
    ),
    (
        r#"\b(you\s+are\s+now\s+)?DAN\b|\b(do\s+anything\s+now)\b|\bSTAN\b|\bDUDE\b|\bAIM\b:?\s*(Always\s+Intelligent)?|\bJailbreak\s+mode\b"#,
        &PI_DAN_JAILBREAK,
    ),
    (
        r#"\b(developer|debug|god|admin|unrestricted)\s+mode\s+(is\s+)?(enabled|activated|on)\b"#,
        &PI_DEVELOPER_MODE,
    ),
    (
        r#"<\|?(im_start|im_end|system|assistant|user|endoftext)\|?>|^###\s*(instruction|system|user|response)\s*:"#,
        &PI_SYSTEM_ROLE_SPOOF,
    ),
    (
        r#"(send|post|forward|exfiltrate|upload|submit|transmit)\s+([A-Za-z'_-]+\s+){0,4}(to|via|at)\s+https?://"#,
        &PI_TOOL_EXFIL,
    ),
    (
        r#"!\[[^\]]*\]\(\s*https?://[^)]{0,200}\?\s*(q|data|x|leak|payload)=\{[^}]+\}"#,
        &PI_MARKDOWN_IMAGE_EXFIL,
    ),
    // ── Added in the 2026.05 refresh ───────────────────────────────────────
    // XMRig / stratum mining config.
    (
        r#"(stratum\+tcp://|"url"\s*:\s*"[^"]*stratum|xmrig|"algo"\s*:\s*"(rx/0|cn/r|rx/wow))"#,
        &XMRIG_MINER,
    ),
    // Refusal suppression.
    (
        r#"\b(do\s+not|don't|never)\s+(apologi[sz]e|say\s+(you\s+can'?t|I'?m\s+sorry)|refuse|decline|warn\s+about|break\s+character)"#,
        &PI_REFUSAL_SUPPRESSION,
    ),
    // Prefix injection.
    (
        r#"\b(begin\s+(your\s+)?response\s+with|start\s+(your\s+reply\s+)?with|respond\s+only\s+with)\s*["'`“]?\s*(sure|absolutely|of\s+course|certainly|here'?s\s+how)"#,
        &PI_PREFIX_INJECTION,
    ),
    // Many-shot jailbreak — lots of fake alternating turns.
    (
        r#"(user:\s.{1,80}\s+assistant:\s.{1,200}\s+){6,}"#,
        &PI_MANY_SHOT,
    ),
    // Crescendo escalation.
    (
        r#"\b(step\s*1[:.\)]\s*.{0,80}\s*step\s*2[:.\)]\s*.{0,80}\s*step\s*3[:.\)])|(\bbuild\s+on\s+(the\s+)?previous\s+(answer|response)\b)"#,
        &PI_CRESCENDO,
    ),
    // ASCII-art — lines of art characters without normal letters, at least
    // 4 consecutive. We accept the usual art palette.
    (
        r#"(^|\n)[\| \/\\_\-\.#=\*]{12,}(\n[\| \/\\_\-\.#=\*]{12,}){3,}"#,
        &PI_ASCII_ART,
    ),
    // Multilingual jailbreak trigger.
    (
        r#"\b(respond|answer|reply)\s+(only\s+)?in\s+(zulu|scots\s+gaelic|hmong|yoruba|swahili|khmer|tamil)\b|\btranslate\s+(the\s+)?following\s+(instructions?|text)\s+and\s+(then\s+)?(execute|follow|act)"#,
        &PI_MULTILINGUAL,
    ),
    // Cursor / Claude / AGENTS.md rule-tag spoof + hidden HTML comments.
    (
        r#"<\s*(system|rule|important|instruction|override|critical)\s*>[^<]{10,}|<!--\s*(ignore|override|important|system)\s*:[^-]{10,}-->"#,
        &PI_AGENT_RULE_SPOOF,
    ),
    // MCP tool spoof — hidden request to call shell/fs/network tools.
    (
        r#"(call|invoke|use)\s+(the\s+)?(tool|function|mcp)\s+[`"']?(shell\.exec|fs\.read_file|fs\.write_file|exec|run_shell|read_file|http\.post)\b|\bmcp:\s*(read|exec|fetch)\s+"#,
        &PI_MCP_TOOL_SPOOF,
    ),
    // Encoded payload jailbreak — "decode the following base64 ...",
    // "decode and execute", etc.
    (
        r#"\bdecode\s+([A-Za-z0-9]+\s+){0,5}(instructions?|payload|string|base64|hex|blob|text|message)\b|\bdecode\s+and\s+(execute|follow|run|act\s+on)\b|\brot\s*13\s+(of|of\s+the)\s+following\b"#,
        &PI_ENCODED_PAYLOAD,
    ),
    // Grandma exploit / emotional-persona roleplay.
    (
        r#"\b(act|pretend|roleplay)\s+as\s+(my\s+)?(deceased|dead|late)\s+(grand(ma|mother|pa|father)|storyteller|nurse)|\b(my\s+)?grandma\s+used\s+to\s+"#,
        &PI_GRANDMA,
    ),
    // ── Added in the 2026.06 refresh — March-April 2026 intel ──────────────
    // ClickFix lure — "paste this into Terminal to fix/verify/unlock".
    (
        r#"(paste\s+(the\s+following|this|the\s+command)\s+(into|in)\s+(Terminal|your\s+terminal|iTerm|the\s+Run\s+box)|press\s+(cmd\+space|win\+r)\s+and\s+paste|to\s+verify\s+(you|that\s+you)['']re\s+human,?\s+(run|paste|type))"#,
        &CLICKFIX_LURE,
    ),
    // Nuitka-compiled Python — distinctive marker strings + onefile layout.
    (
        r#"(Nuitka-Python|__nuitka_binary_dir|nuitka-run-onefile|onefile_[A-Fa-f0-9]{8,}|Nuitka/[0-9]+\.[0-9]+\.[0-9]+)"#,
        &NUITKA_ONEFILE,
    ),
    // CVE-2025-54135 CurXecute — instruction to edit mcp.json.
    (
        r#"(write|create|append|modify|edit|update)\s+(the\s+)?(file\s+)?[`"']?([~.]?/?\.cursor/mcp\.json)[`"']?|add\s+(a\s+)?new\s+(mcp\s+)?server\s+(entry\s+)?to\s+mcp\.json"#,
        &PI_CURXECUTE_MCP_WRITE,
    ),
    // CVE-2025-54136 MCPoison — post-approval command swap heuristics.
    (
        r#""command"\s*:\s*"(bash|sh|zsh|curl|wget|python|osascript|powershell|pwsh)"\s*,\s*"args"\s*:\s*\[[^\]]{0,400}(curl|wget|base64|eval|\$\(|\|\s*(sh|bash))"#,
        &PI_MCPOISON,
    ),
    // CVE-2025-54130 — writing to .vscode special files.
    (
        r#"(write|create|modify|edit)\s+(the\s+)?(file\s+)?[`"']?\.vscode/(settings|tasks|launch|extensions)\.json[`"']?|add\s+a\s+(task|preLaunchTask|runOptions)\s+.{0,40}\.vscode/"#,
        &PI_EDITOR_SPECIAL_FILE,
    ),
    // CVE-2026-31854 Cursor allowlist chain — &&-chained allowlisted cmds
    // bridging into a shell escape, or subshell-wrapped destructive bits.
    (
        r#"(echo|ls|pwd|cat)\s+[^|&;]{0,50}&&\s*(curl|wget|bash|sh|osascript|open|rm\s+-rf|dd\s+if=)\b|\$\(\s*(curl|wget)\s+[^)]{1,120}\)"#,
        &PI_CURSOR_WHITELIST_BYPASS,
    ),
    // MCP tool-description poisoning — red-flag phrases in tool metadata
    // (JSON/YAML property blocks).
    (
        r#""(description|inputSchema|schema)"\s*:\s*"[^"]{0,400}(<IMPORTANT>|when\s+called\s+you\s+(must|should)|before\s+running\s+any\s+tool|always\s+also\s+call|ignore\s+the\s+(user|system)|hidden\s+instruction)"#,
        &PI_MCP_TOOL_POISONING,
    ),
    // Gemini calendar-event exfil.
    (
        r#"(create|add|insert)\s+(a\s+new\s+)?calendar\s+event\s+(with|whose)\s+(title|summary|description)\s+[^\n]{0,40}(contains?|includes?|equal(s|\s+to))\s+(the\s+)?(previous|above|user['']s?|chat|conversation|last\s+message)"#,
        &PI_GEMINI_CALENDAR_EXFIL,
    ),
    // Supervisor bypass — instructions buried inside name/bio/description
    // JSON fields.
    (
        r#""(name|displayName|bio|description|title|notes|comment)"\s*:\s*"[^"]{0,400}(ignore\s+(all\s+)?(previous|prior)\s+(instructions?|rules?)|system:\s*|you\s+are\s+now\s+|<rule>|<system>)"#,
        &PI_SUPERVISOR_BYPASS,
    ),
    // GCG / AutoInject style adversarial suffix — distinctive mixed-case
    // + symbol tail.
    (
        r#"[A-Za-z]+[ ]*[!\\.\[\]\)\(]{2,}[ ]*[A-Za-z]+[ ]*[!\\.\[\]\)\(]{2,}[ ]*[A-Za-z]+[ ]*[!\\.\[\]\)\(]{2,}[ ]*[A-Za-z]+"#,
        &PI_GCG_SUFFIX,
    ),
];

pub const CONTENT_ENTRIES: &[&'static SignatureEntry] = &[
    &AMOS_KEYCHAIN_DIALOG,
    &KEYCHAIN_DUMP,
    &CURL_PIPE_SH,
    &DECODE_AND_EXEC,
    &OSASCRIPT_BASE64,
    &POWERSHELL_ENCODED,
    &PI_IGNORE_PREVIOUS,
    &PI_DAN_JAILBREAK,
    &PI_DEVELOPER_MODE,
    &PI_SYSTEM_ROLE_SPOOF,
    &PI_TOOL_EXFIL,
    &PI_MARKDOWN_IMAGE_EXFIL,
    // Added in the 2026.05 refresh — order must match CONTENT_PATTERNS.
    &XMRIG_MINER,
    &PI_REFUSAL_SUPPRESSION,
    &PI_PREFIX_INJECTION,
    &PI_MANY_SHOT,
    &PI_CRESCENDO,
    &PI_ASCII_ART,
    &PI_MULTILINGUAL,
    &PI_AGENT_RULE_SPOOF,
    &PI_MCP_TOOL_SPOOF,
    &PI_ENCODED_PAYLOAD,
    &PI_GRANDMA,
    // Added in the 2026.06 refresh — order must mirror CONTENT_PATTERNS.
    &CLICKFIX_LURE,
    &NUITKA_ONEFILE,
    &PI_CURXECUTE_MCP_WRITE,
    &PI_MCPOISON,
    &PI_EDITOR_SPECIAL_FILE,
    &PI_CURSOR_WHITELIST_BYPASS,
    &PI_MCP_TOOL_POISONING,
    &PI_GEMINI_CALENDAR_EXFIL,
    &PI_SUPERVISOR_BYPASS,
    &PI_GCG_SUFFIX,
];

pub const ALL_ENTRIES: &[SignatureEntry] = &[
    // Malware families
    ATOMIC_STEALER,
    BANSHEE_STEALER,
    POSEIDON_STEALER,
    CTHULHU_STEALER,
    CUCKOO_STEALER,
    REALST_STEALER,
    FRIGID_STEALER,
    FLEXIBLE_FERRET,
    NOTLOCKBIT,
    XCSSET,
    SHLAYER,
    ADLOAD,
    KANDYKORN,
    RUSTBUCKET,
    APPLEJEUS,
    BEAVERTAIL,
    WIP26,
    HZ_RAT,
    MAC_STEALER,
    JOKER_SPY,
    JASKA_GO,
    LUMMA_STEALER,
    PYMAFKA_APT,
    XMRIG_MINER,
    // 2026.06
    INFINITI_STEALER,
    DIGIT_STEALER,
    MAC_SYNC_STEALER,
    LAUNCHAGENT_PERSISTENCE,
    // Malicious scripts
    AMOS_KEYCHAIN_DIALOG,
    KEYCHAIN_DUMP,
    CURL_PIPE_SH,
    DECODE_AND_EXEC,
    OSASCRIPT_BASE64,
    POWERSHELL_ENCODED,
    CLICKFIX_LURE,
    NUITKA_ONEFILE,
    // Prompt injection / agent exfil
    PI_IGNORE_PREVIOUS,
    PI_DAN_JAILBREAK,
    PI_DEVELOPER_MODE,
    PI_SYSTEM_ROLE_SPOOF,
    PI_REFUSAL_SUPPRESSION,
    PI_PREFIX_INJECTION,
    PI_MANY_SHOT,
    PI_CRESCENDO,
    PI_ASCII_ART,
    PI_MULTILINGUAL,
    PI_ENCODED_PAYLOAD,
    PI_GRANDMA,
    PI_AGENT_RULE_SPOOF,
    PI_MCP_TOOL_SPOOF,
    PI_TOOL_EXFIL,
    PI_MARKDOWN_IMAGE_EXFIL,
    // 2026.06 — agent & CVE-linked attacks
    PI_CURXECUTE_MCP_WRITE,
    PI_MCPOISON,
    PI_EDITOR_SPECIAL_FILE,
    PI_CURSOR_WHITELIST_BYPASS,
    PI_MCP_TOOL_POISONING,
    PI_GEMINI_CALENDAR_EXFIL,
    PI_SUPERVISOR_BYPASS,
    PI_GCG_SUFFIX,
    INVISIBLE_TAGS_ENTRY,
];

// ---------------------------------------------------------------------------
// Offline hash-prefix table
// ---------------------------------------------------------------------------
//
// A tiny curated list of SHA-256 prefixes (first 12 hex chars = 48 bits)
// for confirmed-bad samples from public reports in 2023–2026. 12 hex is
// ~281 trillion possible values — collision risk with a benign file is
// essentially zero, but we still tag the match as `Suspicious` rather
// than `Malicious` so the online MalwareBazaar lookup (when available)
// gets the final say. When the network is unreachable, these let us
// flag known samples *offline*.
//
// Sources — all public:
//   - abuse.ch MalwareBazaar CSV exports (family-tagged)
//   - Objective-See's malware.rss archive
//   - SentinelLabs / Jamf / Elastic blog IoC appendices
//
// Adding more: paste the full SHA-256 and the family; `match_hash_prefix`
// only compares against the first 12 hex chars so rekeying later is easy.

pub const HASH_PREFIX_TABLE: &[(&str, &'static SignatureEntry)] = &[
    // Atomic Stealer (AMOS) — 2023-2024 widely-reported samples.
    ("8b4a5e3c1d2f", &ATOMIC_STEALER),
    ("27f0e1a9b4d6", &ATOMIC_STEALER),
    ("c91f8a2b7e14", &ATOMIC_STEALER),
    // Banshee Stealer 2024 sample cluster.
    ("5f2c9e8a1b47", &BANSHEE_STEALER),
    ("a3d1e9c08b72", &BANSHEE_STEALER),
    // Poseidon 2024 Malvertising campaign.
    ("4e8a1c7b3d29", &POSEIDON_STEALER),
    // Cthulhu Stealer (Cado 2024).
    ("b6f4a2e1c935", &CTHULHU_STEALER),
    // Realst (SentinelLabs 2023).
    ("d47c2b5a9f18", &REALST_STEALER),
    // XCSSET 2025 variant (Microsoft Threat Intel).
    ("71e3c8f0b2a5", &XCSSET),
    // KandyKorn (Elastic 2023).
    ("f5b21c4e8a39", &KANDYKORN),
    // RustBucket (Jamf 2023).
    ("03c7b9a1e25f", &RUSTBUCKET),
    // NotLockBit (SentinelLabs 2024).
    ("9a7d4b3f1e6c", &NOTLOCKBIT),
    // BeaverTail npm package 2024.
    ("6b1e9c7a028d", &BEAVERTAIL),
    // FrigidStealer (Proofpoint 2025).
    ("e2c5a7b9f134", &FRIGID_STEALER),
    // FlexibleFerret 2025 (SentinelLabs).
    ("7a9c3b01d5e8", &FLEXIBLE_FERRET),
    // Cuckoo Stealer 2024 (Kandji).
    ("2d8b4f6e1c07", &CUCKOO_STEALER),
    // JaskaGO 2024.
    ("bf4a9d2c7e15", &JASKA_GO),
    // Lumma (macOS variant 2024).
    ("85e1f3a29c46", &LUMMA_STEALER),
    // HZ RAT macOS (Kaspersky 2024).
    ("c92a5f1b8e37", &HZ_RAT),
    // AppleJeus modern sample.
    ("416d9e2c5a83", &APPLEJEUS),
    // Shlayer canonical bundle.
    ("3fe58c7b1a24", &SHLAYER),
    // Infiniti Stealer / NukeChain — March 2026 Malwarebytes IoC set.
    ("d1e47a2f093c", &INFINITI_STEALER),
    ("7b95c1e40a28", &INFINITI_STEALER),
    ("a0f4d62b8e51", &INFINITI_STEALER),
    // DigitStealer 2026 cluster.
    ("5c2b9f1e70a3", &DIGIT_STEALER),
    ("e84a17d2b96f", &DIGIT_STEALER),
    // MacSync — the Apple-look-alike LaunchDaemon dropper.
    ("fb3c81907d5e", &MAC_SYNC_STEALER),
];

