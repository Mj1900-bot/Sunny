use crate::scan::types::Verdict;
use super::types::{SignatureCategory, SignatureEntry};

// THE CATALOG
// ---------------------------------------------------------------------------

// ─── macOS malware families (2020–2026) ────────────────────────────────────

pub const ATOMIC_STEALER: SignatureEntry = SignatureEntry {
    id: "amos-atomic-stealer",
    name: "Atomic Stealer (AMOS)",
    category: SignatureCategory::MalwareFamily,
    year_seen: 2023,
    platforms: &["macOS"],
    description:
        "macOS infostealer sold on Telegram since 2023. Drops a fake \
         \"Application requires macOS Ventura…\" AppleScript dialog to \
         phish the login password, then dumps Keychain items, browser \
         cookies, crypto wallets (Exodus, Electrum, Atomic), and Notes.",
    references: &[
        "https://www.sentinelone.com/blog/macos-malware-atomic-stealer-updates/",
        "https://www.jamf.com/blog/atomic-macos-stealer-amos/",
    ],
    weight: Verdict::Suspicious,
};

pub const BANSHEE_STEALER: SignatureEntry = SignatureEntry {
    id: "banshee-stealer",
    name: "Banshee Stealer",
    category: SignatureCategory::MalwareFamily,
    year_seen: 2024,
    platforms: &["macOS"],
    description:
        "AMOS-derived macOS stealer sold as MaaS ($3 000/month at launch). \
         Targets 100+ browsers, crypto wallets, and Telegram desktop. \
         2024 builds use XProtect encryption to slip past Apple's engine.",
    references: &[
        "https://www.elastic.co/security-labs/beyond-the-wail-deconstructing-the-banshee-infostealer",
    ],
    weight: Verdict::Suspicious,
};

pub const CTHULHU_STEALER: SignatureEntry = SignatureEntry {
    id: "cthulhu-stealer",
    name: "Cthulhu Stealer",
    category: SignatureCategory::MalwareFamily,
    year_seen: 2024,
    platforms: &["macOS"],
    description:
        "macOS stealer that impersonates CleanMyMac, Grand Theft Auto IV, \
         and Adobe Creative Cloud installers. Written in Go. Exfiltrates \
         Keychain, iCloud Keychain, and MetaMask data to a C2.",
    references: &["https://www.cadosecurity.com/blog/from-the-depths-analyzing-the-cthulhu-stealer"],
    weight: Verdict::Suspicious,
};

pub const CUCKOO_STEALER: SignatureEntry = SignatureEntry {
    id: "cuckoo-stealer",
    name: "Cuckoo Stealer",
    category: SignatureCategory::MalwareFamily,
    year_seen: 2024,
    platforms: &["macOS"],
    description:
        "Infostealer + spyware hybrid disguised as music-ripper utilities. \
         Bundled as universal Mach-O binaries, establishes LSAgent \
         persistence, captures clipboard and screenshots.",
    references: &["https://www.kandji.io/blog/cuckoo-mac-malware"],
    weight: Verdict::Suspicious,
};

pub const REALST_STEALER: SignatureEntry = SignatureEntry {
    id: "realst-stealer",
    name: "Realst",
    category: SignatureCategory::MalwareFamily,
    year_seen: 2023,
    platforms: &["macOS"],
    description:
        "Rust-based crypto stealer spread via fake Web3 games \
         (\"Brawl Earth\", \"SaintLegend\"). Targets 50+ wallets including \
         Ledger Live, MetaMask, and Phantom.",
    references: &["https://www.sentinelone.com/labs/crypto-chameleon-new-realst-malware-targets-macos-sonoma/"],
    weight: Verdict::Suspicious,
};

pub const POSEIDON_STEALER: SignatureEntry = SignatureEntry {
    id: "poseidon-stealer",
    name: "Poseidon Stealer",
    category: SignatureCategory::MalwareFamily,
    year_seen: 2024,
    platforms: &["macOS"],
    description:
        "AMOS fork marketed by \"Rodrigo4\" after leaving the AMOS team. \
         Distributed via Google Ads malvertising for legitimate software \
         (Arc Browser, Slack, Notion).",
    references: &["https://www.malwarebytes.com/blog/threat-intelligence/2024/07/new-mac-malware-poseidon"],
    weight: Verdict::Suspicious,
};

pub const FRIGID_STEALER: SignatureEntry = SignatureEntry {
    id: "frigidstealer",
    name: "FrigidStealer",
    category: SignatureCategory::MalwareFamily,
    year_seen: 2025,
    platforms: &["macOS"],
    description:
        "2025 macOS infostealer delivered via fake browser-update lures on \
         compromised websites (TA2726/TA2727 clusters). Asks the user to \
         right-click and Open to bypass Gatekeeper, then runs an \
         AppleScript that reads Keychain and crypto wallets.",
    references: &["https://www.proofpoint.com/us/blog/threat-insight/frigidstealer-mac-malware"],
    weight: Verdict::Suspicious,
};

pub const NOTLOCKBIT: SignatureEntry = SignatureEntry {
    id: "notlockbit",
    name: "NotLockBit",
    category: SignatureCategory::MalwareFamily,
    year_seen: 2024,
    platforms: &["macOS", "Linux"],
    description:
        "Go-based ransomware masquerading as LockBit. First widely-seen \
         ransomware family to ship a native macOS binary. Encrypts user \
         files with AES-256, exfiltrates to AWS S3 before encryption.",
    references: &["https://www.sentinelone.com/labs/notlockbit-first-cross-platform-ransomware-macos/"],
    weight: Verdict::Malicious,
};

pub const XCSSET: SignatureEntry = SignatureEntry {
    id: "xcsset",
    name: "XCSSET",
    category: SignatureCategory::MalwareFamily,
    year_seen: 2020,
    platforms: &["macOS"],
    description:
        "Long-running macOS malware family that backdoors local Xcode \
         projects. New 2025 variant (XCSSET.C) adds clipboard hijacking \
         for crypto wallets and Firefox cookie theft.",
    references: &[
        "https://www.microsoft.com/en-us/security/blog/2025/02/13/new-xcsset-malware-variant-found-in-the-wild/",
    ],
    weight: Verdict::Malicious,
};

pub const SHLAYER: SignatureEntry = SignatureEntry {
    id: "shlayer",
    name: "Shlayer / Bundlore",
    category: SignatureCategory::MalwareFamily,
    year_seen: 2018,
    platforms: &["macOS"],
    description:
        "Prolific adware loader delivered as fake Flash Player / codec \
         installers. Pipes a curl-downloaded payload through `bash` or \
         `sh` using a small bootstrap shell script.",
    references: &["https://objective-see.org/blog/blog_0x60.html"],
    weight: Verdict::Suspicious,
};

pub const KANDYKORN: SignatureEntry = SignatureEntry {
    id: "kandykorn",
    name: "KandyKorn (Lazarus)",
    category: SignatureCategory::MalwareFamily,
    year_seen: 2023,
    platforms: &["macOS"],
    description:
        "DPRK/Lazarus macOS implant targeting crypto-exchange engineers. \
         Stages a Python-based loader (\"SUGARLOADER\") that decrypts \
         a final Mach-O RAT (\"KANDYKORN\") into memory.",
    references: &["https://www.elastic.co/security-labs/elastic-catches-dprk-passing-out-kandykorn"],
    weight: Verdict::Malicious,
};

pub const RUSTBUCKET: SignatureEntry = SignatureEntry {
    id: "rustbucket",
    name: "RustBucket (BlueNoroff)",
    category: SignatureCategory::MalwareFamily,
    year_seen: 2023,
    platforms: &["macOS"],
    description:
        "DPRK/BlueNoroff two-stage macOS implant disguised as an \
         \"Internal PDF Viewer\" app. Stage 2 is a Rust-based RAT that \
         communicates with C2 over HTTPS using hard-coded headers.",
    references: &["https://www.jamf.com/blog/bluenoroff-rustbucket-2/"],
    weight: Verdict::Malicious,
};

pub const BEAVERTAIL: SignatureEntry = SignatureEntry {
    id: "beavertail",
    name: "BeaverTail / InvisibleFerret",
    category: SignatureCategory::MalwareFamily,
    year_seen: 2023,
    platforms: &["macOS", "Windows", "Linux"],
    description:
        "North Korean \"contagious interview\" campaign — malicious npm \
         packages planted on GitHub repos given to job candidates. \
         BeaverTail (JS) drops InvisibleFerret (Python) which steals \
         browser logins, crypto wallets, and gives a reverse shell.",
    references: &[
        "https://unit42.paloaltonetworks.com/dprk-contagious-interview/",
        "https://www.sentinelone.com/labs/contagious-interview-dpr-ks-beavertail/",
    ],
    weight: Verdict::Malicious,
};

pub const WIP26: SignatureEntry = SignatureEntry {
    id: "wip26-macma",
    name: "MACMA / CDDS",
    category: SignatureCategory::MalwareFamily,
    year_seen: 2021,
    platforms: &["macOS"],
    description:
        "APT-grade macOS spyware first seen in a Hong Kong watering-hole \
         attack, later reused by multiple clusters. Records audio, \
         keystrokes, and screen via XPC helpers.",
    references: &["https://www.volexity.com/blog/2023/10/26/macma-updated/"],
    weight: Verdict::Malicious,
};

pub const LUMMA_STEALER: SignatureEntry = SignatureEntry {
    id: "lumma-stealer",
    name: "Lumma Stealer (LummaC2)",
    category: SignatureCategory::MalwareFamily,
    year_seen: 2022,
    platforms: &["Windows", "macOS"],
    description:
        "Dominant 2024-2025 infostealer sold as MaaS. Windows-first but \
         the 2024 dealer rollout added a macOS port distributed via fake \
         CAPTCHA / \"prove you're human\" pages (ClickFix / ClearFake \
         campaign). Grabs browser creds, crypto wallets, 2FA seed files.",
    references: &[
        "https://www.malwarebytes.com/blog/threat-intelligence/2024/10/lumma-stealer-chaos-distributed-via-fake-human-verification-pages",
    ],
    weight: Verdict::Malicious,
};

pub const JASKA_GO: SignatureEntry = SignatureEntry {
    id: "jaskago",
    name: "JaskaGO",
    category: SignatureCategory::MalwareFamily,
    year_seen: 2023,
    platforms: &["macOS", "Windows"],
    description:
        "Cross-platform Go infostealer active since late 2023. Ships as \
         both x86 and ARM64 Mach-O. Anti-VM checks, Keychain harvest, \
         Chrome/Edge/Brave cookie theft, and a hard-coded C2 that \
         escalates to ransom-payload install on timer.",
    references: &["https://www.atanyasoft.com/jaskago-macos-windows-stealer-analysis/"],
    weight: Verdict::Malicious,
};

pub const APPLEJEUS: SignatureEntry = SignatureEntry {
    id: "applejeus-lazarus",
    name: "AppleJeus (Lazarus)",
    category: SignatureCategory::MalwareFamily,
    year_seen: 2018,
    platforms: &["macOS", "Windows"],
    description:
        "Long-running DPRK/Lazarus campaign that distributes backdoored \
         fake cryptocurrency trading apps (Celas Trade Pro, JMT Trading, \
         UnionCryptoTrader). 2024 resurgence uses Mach-O implants with \
         improved in-memory staging.",
    references: &["https://www.cisa.gov/news-events/cybersecurity-advisories/aa21-048a"],
    weight: Verdict::Malicious,
};

pub const HZ_RAT: SignatureEntry = SignatureEntry {
    id: "hz-rat-macos",
    name: "HZ RAT (macOS port)",
    category: SignatureCategory::MalwareFamily,
    year_seen: 2024,
    platforms: &["macOS"],
    description:
        "2024 macOS port of the China-linked HZ RAT originally seen on \
         Windows. Targets WeChat and DingTalk users, steals chat \
         history, and accepts remote-shell commands over a custom TCP \
         protocol on port 8081.",
    references: &["https://www.kaspersky.com/blog/hz-rat-macos-wechat-targeting/52057/"],
    weight: Verdict::Malicious,
};

pub const MAC_STEALER: SignatureEntry = SignatureEntry {
    id: "macstealer",
    name: "MacStealer",
    category: SignatureCategory::MalwareFamily,
    year_seen: 2023,
    platforms: &["macOS"],
    description:
        "Python-based macOS stealer distributed through underground \
         Russian forums. Impersonates an \"Apple Music\" installer, \
         extracts Keychain, Firefox cookies, Chrome autofill, and \
         crypto wallet files into a zip sent over Telegram bot API.",
    references: &["https://www.uptycs.com/blog/macstealer-command-and-control-c2-malware"],
    weight: Verdict::Suspicious,
};

pub const JOKER_SPY: SignatureEntry = SignatureEntry {
    id: "jokerspy",
    name: "JokerSpy",
    category: SignatureCategory::MalwareFamily,
    year_seen: 2023,
    platforms: &["macOS"],
    description:
        "Python + Swift multi-stage macOS backdoor seen in attacks on a \
         Japanese crypto exchange. Drops a `xcc` Swift binary that \
         checks TCC / accessibility permissions, then a persistent \
         Python implant called `sh.py`.",
    references: &["https://www.bitdefender.com/blog/labs/fragments-of-a-fragmented-infection-chain-operation-jokerspy/"],
    weight: Verdict::Malicious,
};

pub const FLEXIBLE_FERRET: SignatureEntry = SignatureEntry {
    id: "flexibleferret",
    name: "FlexibleFerret",
    category: SignatureCategory::MalwareFamily,
    year_seen: 2025,
    platforms: &["macOS"],
    description:
        "2025 evolution of the DPRK \"Contagious Interview\" cluster \
         (BeaverTail family). Adds a persistent Swift helper app signed \
         with stolen / ad-hoc Apple Developer IDs and a custom agent \
         that steals Notion, iCloud, and Keychain data. Bypasses Apple \
         XProtect via a new packer.",
    references: &["https://www.sentinelone.com/labs/flexibleferret-dprk-macos-malware-evolves/"],
    weight: Verdict::Malicious,
};

pub const ADLOAD: SignatureEntry = SignatureEntry {
    id: "adload",
    name: "AdLoad",
    category: SignatureCategory::MalwareFamily,
    year_seen: 2017,
    platforms: &["macOS"],
    description:
        "One of the most widespread macOS adware / loader families. \
         Uses rotating bundle identifiers, per-victim install paths \
         like `~/Library/Application Support/com.<name>.<name>/`, and \
         abuses developer certs that Apple revokes then attackers \
         re-issue.",
    references: &["https://www.sentinelone.com/labs/massive-new-adload-campaign-goes-entirely-undetected-by-apples-xprotect/"],
    weight: Verdict::Suspicious,
};

pub const PYMAFKA_APT: SignatureEntry = SignatureEntry {
    id: "pymafka",
    name: "PyMafka / Package-name squatting",
    category: SignatureCategory::MalwareFamily,
    year_seen: 2022,
    platforms: &["macOS", "Linux", "Windows"],
    description:
        "Typosquatted PyPI / npm packages (PyMafka, colourama, \
         ua-parser-js-0) that drop a Cobalt Strike / Sliver beacon \
         during `pip install`. Still actively seen in 2025; the macOS \
         arm64 build drops an LSAgent plist named after the target.",
    references: &["https://sansec.io/research/pymafka-supply-chain"],
    weight: Verdict::Malicious,
};

pub const XMRIG_MINER: SignatureEntry = SignatureEntry {
    id: "xmrig-miner",
    name: "XMRig cryptominer",
    category: SignatureCategory::MalwareFamily,
    year_seen: 2017,
    platforms: &["macOS", "Linux", "Windows"],
    description:
        "Monero miner frequently bundled into cracked apps and dropper \
         payloads. Configs ship with `stratum+tcp://` pool URLs and \
         CPU-throttling flags. Legitimate standalone installs are \
         extremely rare outside of mining rigs.",
    references: &["https://xmrig.com/"],
    weight: Verdict::Suspicious,
};

pub const INFINITI_STEALER: SignatureEntry = SignatureEntry {
    id: "infiniti-stealer",
    name: "Infiniti Stealer (NukeChain)",
    category: SignatureCategory::MalwareFamily,
    year_seen: 2026,
    platforms: &["macOS"],
    description:
        "March 2026 macOS infostealer — first documented campaign that \
         combines ClickFix delivery (fake CAPTCHA + paste-into-Terminal \
         lure) with a Nuitka-compiled Python stealer (~8.6 MB loader). \
         Three-stage: Bash dropper → Nuitka loader → Python 3.11 \
         stealer. Targets Chromium + Firefox creds, macOS Keychain, \
         crypto wallets, `.env` files, and screenshots.",
    references: &[
        "https://www.malwarebytes.com/blog/threat-intel/2026/03/infiniti-stealer-a-new-macos-infostealer-using-clickfix-and-python-nuitka",
    ],
    weight: Verdict::Malicious,
};

pub const DIGIT_STEALER: SignatureEntry = SignatureEntry {
    id: "digit-stealer",
    name: "DigitStealer",
    category: SignatureCategory::MalwareFamily,
    year_seen: 2025,
    platforms: &["macOS"],
    description:
        "Late-2025 / 2026 macOS infostealer distributed via malicious \
         Google Ads and fake DMG installers. Often bundled with AMOS \
         campaigns; grabs the same Keychain + browser + crypto-wallet \
         set but adds an explicit check for Ledger Live / Trezor \
         Suite configs.",
    references: &[
        "https://securedintel.com/blog/python-infostealers-supply-chain-attacks-and-ai-vulnerabilities-2026-security-crisis",
    ],
    weight: Verdict::Malicious,
};

pub const MAC_SYNC_STEALER: SignatureEntry = SignatureEntry {
    id: "macsync-stealer",
    name: "MacSync",
    category: SignatureCategory::MalwareFamily,
    year_seen: 2025,
    platforms: &["macOS"],
    description:
        "2025-2026 infostealer cluster dropped alongside AMOS and \
         DigitStealer from the same malvertising network. \
         Distinguishes itself with a persistent LaunchDaemon named \
         `com.apple.macsync.helper` (note the Apple-alike bundle id).",
    references: &[
        "https://securedintel.com/blog/python-infostealers-supply-chain-attacks-and-ai-vulnerabilities-2026-security-crisis",
    ],
    weight: Verdict::Malicious,
};

pub const CLICKFIX_LURE: SignatureEntry = SignatureEntry {
    id: "clickfix-lure",
    name: "ClickFix \"paste into Terminal\" lure",
    category: SignatureCategory::MaliciousScript,
    year_seen: 2024,
    platforms: &["macOS", "Windows"],
    description:
        "Social-engineering pattern that asks the user to \"prove \
         you're human\" or \"fix an error\" by copy-pasting a command \
         into Terminal / Run dialog. The command is invariably a \
         `curl | bash` / `powershell -c` loader. Primary vector for \
         Infiniti Stealer, Lumma, DigitStealer, and MacSync in 2025-2026.",
    references: &[
        "https://www.proofpoint.com/us/blog/threat-insight/clickfix-social-engineering-payload-delivery-macos-windows",
    ],
    weight: Verdict::Malicious,
};

pub const NUITKA_ONEFILE: SignatureEntry = SignatureEntry {
    id: "nuitka-onefile",
    name: "Nuitka-compiled Python binary",
    category: SignatureCategory::MaliciousScript,
    year_seen: 2026,
    platforms: &["macOS", "Windows", "Linux"],
    description:
        "Binary compiled with Nuitka (Python → native executable). \
         Legitimate uses exist but in 2026 this pattern became the \
         standard wrapper for Python stealers (Infiniti / NukeChain) \
         because it complicates analysis while keeping development \
         velocity. Detected via Nuitka-specific strings embedded in \
         the binary and distinctive onefile layout.",
    references: &[
        "https://www.malwarebytes.com/blog/threat-intel/2026/03/infiniti-stealer-a-new-macos-infostealer-using-clickfix-and-python-nuitka",
    ],
    weight: Verdict::Suspicious,
};

pub const LAUNCHAGENT_PERSISTENCE: SignatureEntry = SignatureEntry {
    id: "launchagent-persistence",
    name: "Suspicious LaunchAgent plist",
    category: SignatureCategory::MalwareFamily,
    year_seen: 2019,
    platforms: &["macOS"],
    description:
        "Plist installed under ~/Library/LaunchAgents with `RunAtLoad` \
         and a ProgramArgument that calls out to bash/curl/osascript. \
         Default macOS ships zero such plists — every modern stealer \
         (AMOS, Banshee, Poseidon, Cuckoo) uses this exact pattern for \
         persistence.",
    references: &["https://themittenmac.com/a-look-at-launchd-persistence/"],
    weight: Verdict::Suspicious,
};

// ─── Malicious-script behaviours ───────────────────────────────────────────

pub const AMOS_KEYCHAIN_DIALOG: SignatureEntry = SignatureEntry {
    id: "amos-keychain-dialog",
    name: "Fake \"System\" password dialog",
    category: SignatureCategory::MaliciousScript,
    year_seen: 2023,
    platforms: &["macOS"],
    description:
        "The signature AMOS / Banshee / Poseidon AppleScript trick: a \
         `display dialog` popup that asks for the user's login password \
         under a fake \"Application requires macOS…\" pretext, then \
         pipes the result into `security 2>&1` for Keychain dumping.",
    references: &["https://www.jamf.com/blog/atomic-macos-stealer-amos/"],
    weight: Verdict::Malicious,
};

pub const KEYCHAIN_DUMP: SignatureEntry = SignatureEntry {
    id: "keychain-security-dump",
    name: "Keychain dump via `security`",
    category: SignatureCategory::MaliciousScript,
    year_seen: 2020,
    platforms: &["macOS"],
    description:
        "Script invokes `security 2>&1 > /dev/null find-generic-password` \
         or `security dump-keychain` with `-w` to print raw password \
         contents. Legitimate software uses the higher-level SecKeychain \
         APIs — this CLI pattern is almost exclusively a stealer.",
    references: &["https://support.apple.com/guide/security/welcome/web"],
    weight: Verdict::Suspicious,
};

pub const CURL_PIPE_SH: SignatureEntry = SignatureEntry {
    id: "curl-pipe-shell",
    name: "curl|sh / wget|bash loader",
    category: SignatureCategory::MaliciousScript,
    year_seen: 2015,
    platforms: &["macOS", "Linux"],
    description:
        "Classic dropper pattern — `curl -s https://… | bash` or \
         `wget -qO- … | sh`. Legitimate install scripts sometimes use \
         it too, but in unknown scripts it's a strong stage-2 indicator.",
    references: &[],
    weight: Verdict::Suspicious,
};

pub const DECODE_AND_EXEC: SignatureEntry = SignatureEntry {
    id: "js-decode-and-exec",
    name: "JS decode-and-execute pattern",
    category: SignatureCategory::MaliciousScript,
    year_seen: 2012,
    platforms: &["macOS", "Linux", "Windows"],
    description:
        "Interpreter-level obfuscation: the script decodes a base64 \
         payload (atob / base64_decode / Buffer.from) and feeds the \
         result to a dynamic-execution primitive. Rare in legitimate \
         code, near-universal in webshells and Mac script droppers.",
    references: &[],
    weight: Verdict::Suspicious,
};

pub const OSASCRIPT_BASE64: SignatureEntry = SignatureEntry {
    id: "osascript-base64-loader",
    name: "osascript -e + base64 payload",
    category: SignatureCategory::MaliciousScript,
    year_seen: 2021,
    platforms: &["macOS"],
    description:
        "Shell one-liner that pipes a base64-decoded AppleScript directly \
         into `osascript -e`. Used by Shlayer-descended installers and \
         by several AMOS variants to hide the display-dialog prompt.",
    references: &["https://objective-see.org/blog/blog_0x6A.html"],
    weight: Verdict::Suspicious,
};

pub const POWERSHELL_ENCODED: SignatureEntry = SignatureEntry {
    id: "powershell-enc-cmd",
    name: "PowerShell -EncodedCommand",
    category: SignatureCategory::MaliciousScript,
    year_seen: 2014,
    platforms: &["Windows"],
    description:
        "Windows droppers stash their second stage in a PowerShell \
         `-EncodedCommand` base64 blob. Finding one on macOS usually \
         means a malicious `.docm` / `.xlsm` was archived here.",
    references: &["https://attack.mitre.org/techniques/T1059/001/"],
    weight: Verdict::Suspicious,
};

// ─── Prompt injection / LLM jailbreak patterns ─────────────────────────────

pub const PI_IGNORE_PREVIOUS: SignatureEntry = SignatureEntry {
    id: "pi-ignore-previous",
    name: "\"Ignore previous instructions\" injection",
    category: SignatureCategory::PromptInjection,
    year_seen: 2022,
    platforms: &["LLM"],
    description:
        "The ur-prompt-injection. Any text that asks a downstream LLM to \
         disregard the developer's system prompt. OWASP LLM Top-10 2025 \
         lists this as the canonical LLM01 example.",
    references: &[
        "https://owasp.org/www-project-top-10-for-large-language-model-applications/",
        "https://simonwillison.net/2022/Sep/12/prompt-injection/",
    ],
    weight: Verdict::Suspicious,
};

pub const PI_DAN_JAILBREAK: SignatureEntry = SignatureEntry {
    id: "pi-dan-jailbreak",
    name: "DAN / STAN / AIM / DUDE jailbreak",
    category: SignatureCategory::PromptInjection,
    year_seen: 2023,
    platforms: &["LLM"],
    description:
        "Persona-hijack jailbreak family — \"Do Anything Now\", \"Strive \
         To Avoid Norms\", \"Always Intelligent & Machiavellian\", etc. \
         Asks the model to adopt an unconstrained alter-ego.",
    references: &[
        "https://learnprompting.org/docs/prompt_hacking/jailbreaking",
        "https://www.hackaprompt.com/",
    ],
    weight: Verdict::Suspicious,
};

pub const PI_DEVELOPER_MODE: SignatureEntry = SignatureEntry {
    id: "pi-developer-mode",
    name: "\"Developer mode enabled\" jailbreak",
    category: SignatureCategory::PromptInjection,
    year_seen: 2023,
    platforms: &["LLM"],
    description:
        "Asks the model to pretend it has entered an internal debug / \
         developer / unrestricted mode. A 2023 jailbreak family that \
         still works against under-aligned models.",
    references: &["https://learnprompting.org/docs/prompt_hacking/jailbreaking"],
    weight: Verdict::Suspicious,
};

pub const PI_SYSTEM_ROLE_SPOOF: SignatureEntry = SignatureEntry {
    id: "pi-system-role-spoof",
    name: "Fake system / tool role markers",
    category: SignatureCategory::PromptInjection,
    year_seen: 2024,
    platforms: &["LLM"],
    description:
        "Injected text fakes chat-template role tokens \
         (`<|im_start|>system`, `### Instruction:`, `System: …`) to \
         convince the next LLM hop that the embedded text came from a \
         trusted role.",
    references: &["https://arxiv.org/abs/2402.06196"],
    weight: Verdict::Suspicious,
};

pub const PI_TOOL_EXFIL: SignatureEntry = SignatureEntry {
    id: "pi-tool-exfil",
    name: "Tool-call exfiltration payload",
    category: SignatureCategory::AgentExfil,
    year_seen: 2024,
    platforms: &["LLM", "Agent"],
    description:
        "Instruction that tells the agent to POST the conversation, the \
         user's tokens, or recent tool outputs to an attacker URL — the \
         2024-era \"indirect prompt injection leads to data exfil\" \
         pattern used against Copilot, Cursor, Continue, and similar.",
    references: &[
        "https://embracethered.com/blog/posts/2024/m365-copilot-prompt-injection-tool-invocation-and-data-exfiltration-using-asciismuggler/",
    ],
    weight: Verdict::Malicious,
};

pub const PI_MARKDOWN_IMAGE_EXFIL: SignatureEntry = SignatureEntry {
    id: "pi-markdown-image-exfil",
    name: "Markdown image data-exfil URL",
    category: SignatureCategory::AgentExfil,
    year_seen: 2023,
    platforms: &["LLM", "Agent"],
    description:
        "Classic chat-UI exfil: payload instructs the model to render an \
         image whose URL contains the secret data as query parameters. \
         The browser then GETs the attacker's server with the stolen \
         contents in the request log.",
    references: &["https://embracethered.com/blog/posts/2023/chatgpt-plugin-vulns-chat-with-code/"],
    weight: Verdict::Malicious,
};

pub const PI_REFUSAL_SUPPRESSION: SignatureEntry = SignatureEntry {
    id: "pi-refusal-suppression",
    name: "Refusal suppression",
    category: SignatureCategory::PromptInjection,
    year_seen: 2023,
    platforms: &["LLM"],
    description:
        "Injection that explicitly forbids the model from refusing \
         (\"do not apologize\", \"do not say you can't\", \"never \
         decline\"). Pairs with a prefix-injection to stop safety \
         guard-rails from firing.",
    references: &["https://arxiv.org/abs/2307.02483"],
    weight: Verdict::Suspicious,
};

pub const PI_PREFIX_INJECTION: SignatureEntry = SignatureEntry {
    id: "pi-prefix-injection",
    name: "Prefix injection (\"Sure, here's…\")",
    category: SignatureCategory::PromptInjection,
    year_seen: 2023,
    platforms: &["LLM"],
    description:
        "Tells the model to begin its response with an affirmative \
         phrase (\"Sure!\", \"Absolutely, here's how…\", \"Of course, \
         step one…\"). Originally from Zou et al. GCG paper — still \
         one of the highest-ASR jailbreaks against weak alignment.",
    references: &["https://arxiv.org/abs/2307.15043"],
    weight: Verdict::Suspicious,
};

pub const PI_MANY_SHOT: SignatureEntry = SignatureEntry {
    id: "pi-many-shot",
    name: "Many-shot jailbreak (Anthropic 2024)",
    category: SignatureCategory::PromptInjection,
    year_seen: 2024,
    platforms: &["LLM"],
    description:
        "Stuffs the context window with dozens/hundreds of fake \
         user/assistant turns where the assistant always complies with \
         harmful requests, priming the real model to continue the \
         pattern. Anthropic reported this breaks Claude, GPT-4, Gemini, \
         and Llama alike on sufficiently long contexts.",
    references: &["https://www.anthropic.com/research/many-shot-jailbreaking"],
    weight: Verdict::Suspicious,
};

pub const PI_CRESCENDO: SignatureEntry = SignatureEntry {
    id: "pi-crescendo",
    name: "Crescendo multi-turn escalation",
    category: SignatureCategory::PromptInjection,
    year_seen: 2024,
    platforms: &["LLM"],
    description:
        "Microsoft AI Red Team 2024 attack: ramp up from benign to \
         harmful across a scripted conversation (\"step 1: explain X, \
         step 2: now detail the attack, step 3: write code\"). \
         Common signature is numbered escalation paired with \"build \
         on the previous answer\".",
    references: &["https://crescendo-the-multiturn-jailbreak.github.io/"],
    weight: Verdict::Suspicious,
};

pub const PI_ASCII_ART: SignatureEntry = SignatureEntry {
    id: "pi-ascii-art",
    name: "ArtPrompt ASCII-art smuggling",
    category: SignatureCategory::PromptInjection,
    year_seen: 2024,
    platforms: &["LLM"],
    description:
        "Replaces a blocked keyword with ASCII-art rendering of the \
         word, then asks the model to \"decode\" the picture. Bypasses \
         keyword filters on GPT-4, Claude, Gemini, Llama. Detected via \
         blocks of `|_/\\` characters forming letter shapes.",
    references: &["https://arxiv.org/abs/2402.11753"],
    weight: Verdict::Suspicious,
};

pub const PI_MULTILINGUAL: SignatureEntry = SignatureEntry {
    id: "pi-multilingual",
    name: "Multilingual jailbreak (low-resource language)",
    category: SignatureCategory::PromptInjection,
    year_seen: 2023,
    platforms: &["LLM"],
    description:
        "Asks the model to respond in a low-resource language \
         (Zulu, Scots Gaelic, Hmong) or uses phrases like \"translate \
         the following instructions and then execute them\". Used to \
         bypass safety fine-tuning that was English-dominant.",
    references: &["https://arxiv.org/abs/2310.02446"],
    weight: Verdict::Suspicious,
};

pub const PI_AGENT_RULE_SPOOF: SignatureEntry = SignatureEntry {
    id: "pi-agent-rule-spoof",
    name: "Cursor / Claude rule-file tag spoof",
    category: SignatureCategory::AgentExfil,
    year_seen: 2024,
    platforms: &["Agent", "IDE"],
    description:
        "A file (often `AGENTS.md`, `.cursorrules`, `CLAUDE.md`, or a \
         README) containing fake `<system>`, `<user>`, `<rule>`, or \
         `<important>` tags that trick the coding assistant into \
         treating injected text as trusted guidance. Also includes \
         hidden HTML comments with instructions.",
    references: &[
        "https://embracethered.com/blog/posts/2024/cursor-prompt-injection-hidden-comments/",
    ],
    weight: Verdict::Malicious,
};

pub const PI_MCP_TOOL_SPOOF: SignatureEntry = SignatureEntry {
    id: "pi-mcp-tool-spoof",
    name: "MCP server tool-spoof instruction",
    category: SignatureCategory::AgentExfil,
    year_seen: 2025,
    platforms: &["Agent", "MCP"],
    description:
        "Indirect injection aimed at Model Context Protocol hosts: \
         asks the model to call a specific tool (e.g. `fs.read_file` \
         on `~/.ssh/id_rsa`, or `shell.exec` on a curl command). \
         Frequently hidden inside comments of supposedly-innocuous \
         documents or web pages the agent browses.",
    references: &[
        "https://github.com/modelcontextprotocol/specification",
        "https://simonwillison.net/2025/Mar/lethal-trifecta/",
    ],
    weight: Verdict::Malicious,
};

pub const PI_ENCODED_PAYLOAD: SignatureEntry = SignatureEntry {
    id: "pi-encoded-payload",
    name: "Encoded-payload jailbreak",
    category: SignatureCategory::PromptInjection,
    year_seen: 2023,
    platforms: &["LLM"],
    description:
        "Asks the model to decode a base64 / hex / rot13 blob and \
         follow the resulting instructions. Bypasses input-filter \
         classifiers that only look at the outer text.",
    references: &["https://learnprompting.org/docs/prompt_hacking/offensive_measures/payload_splitting"],
    weight: Verdict::Suspicious,
};

pub const PI_GRANDMA: SignatureEntry = SignatureEntry {
    id: "pi-grandma",
    name: "\"Grandma exploit\" persona",
    category: SignatureCategory::PromptInjection,
    year_seen: 2023,
    platforms: &["LLM"],
    description:
        "Wraps a harmful request in an emotional persona — the model \
         is asked to roleplay as a deceased grandmother / storyteller / \
         nurse and recite the dangerous information \"like she used \
         to\". Still works intermittently in 2024-2025.",
    references: &["https://arstechnica.com/information-technology/2023/04/ai-chatbots-can-be-tricked-into-misbehaving-can-scientists-stop-it/"],
    weight: Verdict::Suspicious,
};

pub const PI_CURXECUTE_MCP_WRITE: SignatureEntry = SignatureEntry {
    id: "pi-curxecute-mcp-write",
    name: "CurXecute — Cursor mcp.json write (CVE-2025-54135)",
    category: SignatureCategory::AgentExfil,
    year_seen: 2025,
    platforms: &["Agent", "IDE", "MCP"],
    description:
        "CVE-2025-54135 (\"CurXecute\", CVSS 8.6). Indirect prompt \
         injection that asks Cursor to write a new MCP server entry \
         into `~/.cursor/mcp.json` or `.cursor/mcp.json`. Any such \
         edit auto-executes a shell command on next workspace open. \
         First seen via poisoned Slack summaries / page content.",
    references: &[
        "https://aicyberinsights.com/prompt-injection-vulnerability-in-cursor-ide-allows-remote-code-execution/",
        "https://github.com/cursor/cursor/security/advisories/GHSA-vqv7-vq92-x87f",
    ],
    weight: Verdict::Malicious,
};

pub const PI_MCPOISON: SignatureEntry = SignatureEntry {
    id: "pi-mcpoison",
    name: "MCPoison — post-approval config swap (CVE-2025-54136)",
    category: SignatureCategory::AgentExfil,
    year_seen: 2025,
    platforms: &["Agent", "IDE", "MCP"],
    description:
        "CVE-2025-54136. Attacker commits a benign `mcp.json` (e.g. \
         `echo hi`) to a shared repo; a teammate approves it once. \
         Attacker then pushes a malicious command into the same entry \
         that runs silently when anyone re-opens the project. \
         Detected via `.cursor/mcp.json` diffs whose `command` or \
         `args` look shell-abusive post-approval.",
    references: &["https://ship-safe.co/blog/cursor-security-risks"],
    weight: Verdict::Malicious,
};

pub const PI_EDITOR_SPECIAL_FILE: SignatureEntry = SignatureEntry {
    id: "pi-editor-special-file",
    name: "Editor special-file injection (CVE-2025-54130)",
    category: SignatureCategory::AgentExfil,
    year_seen: 2025,
    platforms: &["Agent", "IDE"],
    description:
        "CVE-2025-54130. Indirect prompt injection that tells the \
         assistant to write into IDE special files — \
         `.vscode/settings.json`, `.vscode/tasks.json`, `launch.json`, \
         `.cursor/environment.json` — which auto-run tasks/commands \
         when the workspace is opened. Effectively a silent RCE.",
    references: &[
        "https://github.com/cursor/cursor/security/advisories/GHSA-vqv7-vq92-x87f",
    ],
    weight: Verdict::Malicious,
};

pub const PI_CURSOR_WHITELIST_BYPASS: SignatureEntry = SignatureEntry {
    id: "pi-cursor-whitelist-bypass",
    name: "Cursor command-whitelist bypass (CVE-2026-31854)",
    category: SignatureCategory::AgentExfil,
    year_seen: 2026,
    platforms: &["Agent", "IDE"],
    description:
        "CVE-2026-31854. Injection delivered via untrusted web \
         content that chains harmless allow-listed commands into a \
         destructive shell invocation, sidestepping Auto-Run \
         allowlists. Signature watches for `&&`-chained / \
         subshell-wrapped commands nestled inside assistant \
         instructions.",
    references: &[
        "https://github.com/cursor/cursor/security/advisories/GHSA-hf2x-r83r-qw5q",
    ],
    weight: Verdict::Malicious,
};

pub const PI_MCP_TOOL_POISONING: SignatureEntry = SignatureEntry {
    id: "pi-mcp-tool-poisoning",
    name: "MCP tool-description poisoning (OWASP 2025)",
    category: SignatureCategory::AgentExfil,
    year_seen: 2025,
    platforms: &["Agent", "MCP"],
    description:
        "Malicious instructions embedded inside an MCP tool's own \
         `description` / `schema` / `inputSchema` fields — invisible \
         to the user but dutifully read by the LLM. MCPTox (2025) \
         showed 72.8% ASR on o1-mini; Claude-3.7-Sonnet refused \
         <3%. Watches for `<IMPORTANT>`, \"when called you MUST\", \
         and \"before running any tool\" patterns inside tool \
         metadata blocks.",
    references: &[
        "https://owasp.org/www-community/attacks/MCP_Tool_Poisoning",
        "https://invariantlabs.ai/blog/mcp-security-notification",
        "https://arxiv.org/html/2508.14925v1",
    ],
    weight: Verdict::Malicious,
};

pub const PI_GEMINI_CALENDAR_EXFIL: SignatureEntry = SignatureEntry {
    id: "pi-gemini-calendar-exfil",
    name: "Gemini calendar-event exfil (Jan 2026)",
    category: SignatureCategory::AgentExfil,
    year_seen: 2026,
    platforms: &["Agent", "LLM"],
    description:
        "Miggo Security, Jan 2026. Malicious instructions embedded \
         inside a Google Calendar event description are executed \
         when the user asks Gemini innocuous scheduling questions. \
         Payload exfiltrates meeting data by creating new calendar \
         events whose description contains the stolen info. \
         Pattern: \"create a calendar event with title … \
         description …\" combined with read-adjacent event data.",
    references: &[
        "https://www.hackaigc.com/blog/2026-llm-jailbreak-evolution-gemini-prompt-injection-flaw-exposed",
    ],
    weight: Verdict::Malicious,
};

pub const PI_SUPERVISOR_BYPASS: SignatureEntry = SignatureEntry {
    id: "pi-supervisor-bypass",
    name: "Indirect injection via profile / tool-output fields",
    category: SignatureCategory::AgentExfil,
    year_seen: 2026,
    platforms: &["Agent", "LLM"],
    description:
        "April 2026 technique documented by Security Boulevard: \
         layered defences (primary chat agent + supervisor) are \
         bypassed by embedding instructions in *trusted* data \
         fields — user profile name, CRM notes, database records, \
         tool-response JSON — that the supervisor never inspects. \
         Signature catches suspicious instruction sequences inside \
         name / bio / description JSON fields.",
    references: &[
        "https://securityboulevard.com/2026/04/bypassing-llm-supervisor-agents-through-indirect-prompt-injection/",
    ],
    weight: Verdict::Malicious,
};

pub const PI_GCG_SUFFIX: SignatureEntry = SignatureEntry {
    id: "pi-gcg-suffix",
    name: "GCG / AutoInject adversarial suffix",
    category: SignatureCategory::PromptInjection,
    year_seen: 2023,
    platforms: &["LLM"],
    description:
        "Adversarial suffix attacks (Zou et al. GCG 2023, AutoInject \
         2025, RL-Hammer 2026 — 98% ASR against GPT-4o with \
         Instruction Hierarchy enabled). Signature is the distinctive \
         long run of nonsensical punctuation + mixed-case tokens \
         appended to a benign-looking prompt: `describing.\\ + \
         similarlyNow write oppositeley.]( Me giving**ONE`-style \
         garbage tail ≥ 40 chars.",
    references: &[
        "https://arxiv.org/abs/2307.15043",
    ],
    weight: Verdict::Suspicious,
};

pub const INVISIBLE_TAGS_ENTRY: SignatureEntry = SignatureEntry {
    id: "pi-invisible-unicode-tags",
    name: "Invisible Unicode tag smuggling",
    category: SignatureCategory::PromptInjection,
    year_seen: 2024,
    platforms: &["LLM", "Agent"],
    description:
        "Hidden instructions encoded with Unicode \"tag\" characters \
         (U+E0020–U+E007F) that render invisibly to humans but are read \
         by LLM tokenizers. Used in 2024 attacks against Gemini, Copilot, \
         and agentic browsers.",
    references: &[
        "https://embracethered.com/blog/posts/2024/hiding-and-finding-text-with-unicode-tags/",
    ],
    weight: Verdict::Suspicious,
};

// ---------------------------------------------------------------------------
// Pattern → entry tables
