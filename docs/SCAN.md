# SCAN — AI-assisted virus scanner

The **SCAN** module is a real on-device malware scanner for macOS. It
walks a directory (or a curated list of files), SHA-256-hashes each
inspectable file, runs eight heuristic checks in Rust, optionally
cross-references hashes against MalwareBazaar (and VirusTotal if a key
is present), and surfaces verdicts in a HUD-style live progress view.
Flagged files can be atomically moved into an isolated quarantine
vault.

This is not a fake. It catches real samples — any of the
~850 000 hashes currently tracked by MalwareBazaar will flag
immediately, and the heuristic combination can surface unsigned +
quarantined + risky-path Mach-O binaries that haven't been uploaded to
a database yet.

**Not the same as [`SECURITY.md`](./SECURITY.md).** SCAN is on-demand file
hashing + heuristics + quarantine. The **Security** page is the runtime
watchdog (tool audit, network egress, panic, TCC deltas). See [`PAGES.md`](./PAGES.md) for both.

---

## Architecture

```
Frontend (React)                   Rust backend (Tauri)
──────────────────                 ──────────────────────
ScanPage/                          scan/
  index.tsx       ── tabs + hotkeys   commands.rs   ── 13 Tauri handlers
  ScanTab.tsx     ── target picker    scanner.rs    ── orchestrator
                   + live progress    hash.rs       ── streaming SHA-256
                   + radar gauge      heuristic.rs  ── per-file signals
  FindingsTab.tsx ── search/sort      bazaar.rs     ── MalwareBazaar + VT
                   + bulk actions     vault.rs      ── quarantine store
  VaultTab.tsx    ── quarantine UI    types.rs      ── wire types
  HistoryTab.tsx  ── past scans
  api.ts          ── typed bindings   (persistence)
  types.ts        ── mirror of Rust   ~/.sunny/scan_cache.json
                                      ~/.sunny/scan_vault/
                                        <uuid>.bin   (chmod 000)
                                        <uuid>.json  (metadata)
```

All HTTP traffic is scoped to MalwareBazaar and (optionally) the
VirusTotal v3 endpoint. The scanner holds a 30-day hash-verdict cache
at `~/.sunny/scan_cache.json` so repeat scans don't re-query the
network.

---

## Detection pipeline

A file inspection runs in this order. Each step is cheap — expensive
work (hash, network lookup) is conditional on the previous steps finding
something worth escalating.

### 1. Cheap metadata heuristics (no IO beyond `stat`)

- **Path risk** — `/tmp`, `/private/tmp`, `/var/tmp`, `~/Downloads`,
  `~/Desktop`. Each contributes an `Info` signal. Droppers live here.
- **Recently modified** — mtime within 24h. Info-level.
- **Hidden in user dir** — dotfiles inside Downloads/Desktop/Documents.
  Info-level.

### 2. macOS quarantine xattr

- Runs `/usr/bin/xattr -p com.apple.quarantine <path>`.
- Parses `flags;epoch_hex;agent;uuid` — surfaces the originating agent
  (Safari, Chrome, Mail, AirDrop, …) in the signal detail.
- Info-level on its own. Escalates when combined with other signals
  (see §4).

### 3. Magic-byte classification

Reads the first 4 bytes.

| Magic | Classification | Weight |
|---|---|---|
| `FE ED FA CE` / `CE FA ED FE` / `FE ED FA CF` / `CF FA ED FE` / `CA FE BA BE` / `BE BA FE CA` | Mach-O | Info |
| `7F E L F` | ELF (Linux — unusual on macOS) | **Suspicious** |
| `M Z ..` | PE/DOS (Windows exe sitting on macOS) | **Suspicious** |
| `# ! ...` | Shebang script — if interpreter is not in a short allow-list, flags as `unusual_script` | **Suspicious** |

### 4. Codesign verification

Runs `/usr/bin/codesign --verify --deep --strict`. Only invoked on
files we've already classified as Mach-O executables or `.app` bundles
— running it on text files is slow and noisy.

- Error says "not signed" → `unsigned` signal, Info weight.
- Any other error (tampered, invalid) → `unsigned` signal,
  **Suspicious** weight.
- Verdict combination rule: `quarantined + unsigned + risky_path = suspicious`
  even if each individual signal is only `info`.

### 5. SHA-256 hash

Deferred until at least one of the above fired (unless `deep` mode is
on, in which case every file is hashed). Streaming — 64 KB buffer, polls
an `AtomicBool` cancel flag between reads so aborts are instant even on
multi-GB files.

### 6. MalwareBazaar lookup

If `online_lookup` is on (default), queries
`https://mb-api.abuse.ch/api/v1/` with `query=get_info&hash=<sha256>`.
No API key required. Cache hit → no network call.

- `query_status == "ok"` → the hash is a **known-bad** sample. Returns
  malware family (`signature`) and tags.
- `query_status == "hash_not_found"` → cached as benign for 30 days. NOT
  a guarantee of safety; just "this specific hash isn't flagged yet".

Hit → `malware_bazaar_hit` signal, **Malicious** weight.

### 7. VirusTotal (optional)

Off by default. Enable in the SCAN tab and set `SUNNY_VIRUSTOTAL_KEY` in
the environment (future work: wire this into the Keychain vault). Pulls
`last_analysis_stats` (malicious / suspicious / harmless / undetected
counts) + `popular_threat_classification.suggested_threat_label`.

- `malicious ≥ 3` → **Malicious**.
- `malicious ≥ 1 || suspicious ≥ 1` → **Suspicious**.

### 8. Verdict combination

Each finding accumulates a list of `Signal`s. Final verdict =
`max()` of all signal weights. Ordering: `Clean < Info < Unknown <
Suspicious < Malicious`. The summary text is the highest-weight
signal's detail string.

---

## Scan modes

`scan_start(target, options)` — walk a path.

- `target` — absolute file or directory.
- `options.recursive` — default `true`. When false, only direct children.
- `options.max_file_size` — default 100 MB. Skipped files count as
  `skipped`, not `unknown`.
- `options.online_lookup` — default `true`. Off gives a pure
  local/heuristic scan.
- `options.virustotal` — default `false`. Requires
  `SUNNY_VIRUSTOTAL_KEY` env var.
- `options.deep` — default `false`. Hash every file instead of just
  those that tripped a heuristic.

The walker skips symlinks (to avoid loops and root-escape), and these
dirs: `node_modules`, `.git`, `.svn`, `.hg`, `target`, `build`,
`dist`, `.next`, `.cache`.

`scan_start_many(label, targets, options)` — inspect a curated list
of files without walking. Used by preset scans like `RUNNING
PROCESSES` (enumerates live executables via
`scan_running_executables`) and anywhere else the caller already
knows which files to check.

---

## Quarantine vault

Location: `~/.sunny/scan_vault/` (mode `0700`).

Each quarantined file becomes two entries:

```
<uuid>.bin   — the original file, chmod 000 (no read, no exec)
<uuid>.json  — metadata (mode 0600)
```

The `.json` sidecar records:

```ts
{
  id: string;           // uuid matching the .bin filename
  originalPath: string; // where it lived before
  vaultPath: string;    // its absolute location in the vault
  size: number;
  sha256: string;
  verdict: Verdict;
  reason: string;       // the top signal's detail
  signals: SignalKind[];
  quarantinedAt: number;
}
```

### Atomic move

`scan_quarantine(scanId, findingId)` does:

1. `fs::rename(src, <uuid>.bin)` — atomic on same filesystem.
2. Cross-device fallback: copy + delete.
3. `chmod 000` on the moved file so a stray double-click, a curious
   Finder preview, or another agent can't run/read it.
4. Write the `.json` metadata sidecar (mode `0600`).
5. Remove the finding from the in-memory scan record so the FINDINGS
   tab reflects it's gone.

### Restore

`scan_vault_restore(id, overwrite)` chmod the file back to `0644`,
moves it to its `originalPath`, and deletes the metadata sidecar.
`overwrite=false` (default) refuses to restore if something already
sits at that path.

### Permanent delete

`scan_vault_delete(id)` chmod the file back to `0600` first (otherwise
`remove_file` fails on the `000`-moded binary), then removes both
`.bin` and `.json`. Irreversible — the 2-click confirmation in the UI
is the only user-facing gate.

---

## UI walkthrough

Four tabs, hotkeys `1/2/3/4`. `/` focuses the findings search box
from anywhere on the page.

### SCAN tab

- **Target input** — type a path, use `PICK FOLDER…` for the native
  macOS folder dialog (AppleScript `choose folder`), or drag any folder
  onto the card.
- **Smart targets** — `▸ RUNNING PROCESSES` enumerates every live
  executable via `ps -axo comm=`, dedups, and scans the binaries via
  `scan_start_many`.
- **Folder presets** — Downloads, Desktop, Applications, /tmp, and
  the three macOS persistence spots (`~/Library/LaunchAgents`,
  `/Library/LaunchAgents`, `/Library/LaunchDaemons`).
- **Options** — recursive / online-lookup / deep / virustotal toggles
  + max-file-size chips (10 MB / 100 MB / 1 GB / No limit).
- **Start / abort** — scanning is cancellable mid-hash.
- **Live progress view** — the centerpiece:
  - **Radial threat gauge** (170px) — 32 tick marks around the rim;
    the tick ring slowly rotates at 9 s/rev while scanning; a radar
    sweep cone rotates independently at 2.6 s/rev over it; filled
    270° arc grows with a 420 ms ease on threat-level changes; center
    count pulse-scales when threats > 0. Color shifts green →
    cyan → amber → red through the levels `calm → watch →
    elevated → critical`.
  - **48-cell segmented progress bar** — each cell lights up with a
    cyan/amber/red glow as the scan advances; a traveling cyan
    shimmer sweeps across the whole bar on a 2.2 s loop while
    scanning.
  - **Verdict counter cards** — CLEAN / INFO / SUSPICIOUS /
    MALICIOUS. Dim until count > 0, then glow with a gradient
    background. The MALICIOUS card additionally animates on the
    `sysCrit` keyframe.
  - **EQ meter** — 5 cyan bars next to the stats row, animated on
    the theme's `barA` keyframe, paused when the scan finishes.
  - **Current-file ticker** — CRT-style phosphor line, RTL ellipsis
    to keep the filename visible, glowing caret blinking on the
    `blink2` keyframe.
  - **Post-scan banner** — green "ALL CLEAR" / amber "N flagged" /
    animated-red "N MALICIOUS".

### FINDINGS tab

- **Search** — substring match against path / summary / SHA-256.
  Focus with `/`.
- **Filter** — ALL · MALICIOUS · SUSPICIOUS · INFO · CLEAN pills.
- **Sort** — SEVERITY / PATH / SIZE / RECENT.
- **Bulk select + quarantine** — checkbox column + `SELECT VISIBLE`
  + `QUARANTINE N SELECTED`.
- **Export JSON** — downloads a timestamped report of the currently
  filtered findings.
- **Per-row actions** — `MOVE TO VAULT`, `REVEAL IN FINDER`,
  `COPY PATH`, `COPY SHA-256`. Row expands to a detail pane showing
  every fired signal with per-signal weight chip, full metadata
  grid, and the SHA.

### VAULT tab

- **Header stats** — TOTAL / SIZE / MALICIOUS / SUSPICIOUS / INFO.
- **Row actions** — `RESTORE` (2-click), `RESTORE (OVERWRITE)`,
  `REVEAL IN FINDER` (even though chmod 000 — `open -R` works
  regardless), 2-click `DELETE FOREVER`.
- **Expanded** — signal chips, original/vault paths, SHA, quarantined
  timestamp.

### HISTORY tab

Past scans, newest first. Phase chip + elapsed + file counts.
Clicking a row reloads its findings in the FINDINGS tab.

---

## AI tool integration

Four tools registered into the agent registry so SUNNY can scan via
voice or chat:

| Tool | Dangerous? | What it does |
|---|---|---|
| `scan_start` | no | Start a scan on a target. Polls up to 45 s for completion and returns a progress summary. |
| `scan_findings` | no | Return findings for a given scan id (elides CLEAN). |
| `scan_quarantine` | **yes** | Move a finding into the vault. Passes through ConfirmGate. |
| `scan_vault_list` | no | List quarantined files. |

"Hey SUNNY, scan my downloads folder" → the agent spawns `scan_start`,
waits for the snapshot, reports verdict counts in the chat response.

---

## Files

| Path | Role |
|---|---|
| `src-tauri/src/scan/types.rs` | Wire-compatible structs |
| `src-tauri/src/scan/hash.rs` | Streaming SHA-256 |
| `src-tauri/src/scan/heuristic.rs` | Per-file inspections |
| `src-tauri/src/scan/bazaar.rs` | MalwareBazaar + VirusTotal + 30-day cache |
| `src-tauri/src/scan/vault.rs` | Quarantine storage |
| `src-tauri/src/scan/scanner.rs` | Orchestrator + walker + explicit-list mode |
| `src-tauri/src/scan/commands.rs` | 13 Tauri handlers |
| `src/pages/ScanPage/index.tsx` | Tab container + page hotkeys |
| `src/pages/ScanPage/ScanTab.tsx` | Target picker + live progress HUD |
| `src/pages/ScanPage/FindingsTab.tsx` | Search / sort / bulk / export |
| `src/pages/ScanPage/VaultTab.tsx` | Quarantine manager |
| `src/pages/ScanPage/HistoryTab.tsx` | Past scans |
| `src/pages/ScanPage/api.ts` | Typed Tauri bindings |
| `src/pages/ScanPage/types.ts` | Mirror of Rust types + format helpers |
| `src/pages/ScanPage/styles.ts` | Shared style tokens |
| `src/lib/tools/builtins/scan.ts` | Agent-loop tool bindings |

Animation classes live in `src/styles/sunny.css` under the `.scan-*`
prefix so they reuse theme tokens (`--cyan`, `--amber`, `--red`,
`--green`) and existing keyframes (`pulseDot`, `sysCrit`, `barA`,
`blink2`).

---

## Threat model & limits

- **The scanner sees what your user can see.** It runs under your uid.
  macOS paths requiring Full Disk Access or admin privileges may
  silently yield empty results.
- **MalwareBazaar is not exhaustive.** A hash miss is **not** a
  guarantee of safety. The heuristic layer exists precisely to catch
  things that haven't been uploaded yet (unsigned + quarantined +
  risky-path combos).
- **No kernel extension, no real-time protection.** SCAN is an
  on-demand tool — it scans when you (or a daemon) tell it to. Pair
  with the `Security sweep` AUTO template for periodic watchdog
  coverage.
- **Quarantine is local isolation, not eradication.** A vaulted file
  is chmod 000 and moved off its original path, but it's not
  deleted until you explicitly `DELETE FOREVER`. If the malware
  phoned home before quarantine, that horse has left — check network
  history separately.
- **`scan_running_executables`** only captures binaries that are
  currently in memory. Malware that exec'd once and exited won't show
  up here; pair with a filesystem scan of the persistence spots
  (`/Library/LaunchAgents` etc).
- **The vault is not tamper-evident.** If an attacker with uid access
  modifies `~/.sunny/scan_vault/*.json`, restores become untrustworthy.
  Treat it as soft isolation.
