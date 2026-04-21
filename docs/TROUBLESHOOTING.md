# Troubleshooting

Common issues, permission prompts, and recovery steps.

## macOS permissions

SUNNY asks for up to **seven** permissions depending on what you use.
Grant them in **System Settings → Privacy & Security**. The app's
`Info.plist` patch (`scripts/patch-info-plist.sh`) adds the required
usage-description strings; without it the prompts don't appear.

| Permission | Needed for | What breaks if you decline |
|---|---|---|
| **Accessibility** | mouse/keyboard automation, focused-app detection | `mouse_*`, `keyboard_*`, world model's focus tracking |
| **Screen Recording** | screen capture + focus-triggered OCR | `screen_capture_*`, OCR insights |
| **Full Disk Access** | reading `~/Library/Messages/chat.db` + AddressBook DBs | `messages_recent`, `list_chats`, `fetch_conversation`, SUNNY proxy, AddressBook name resolution |
| **Calendar** | EventKit queries | `calendar_*`, world.next_event |
| **Contacts** | Resolving contact names from AddressBook | `text_contact` / `call_contact` fallback when the target isn't in recent chats; list shows handles instead of names |
| **Automation (Messages)** | Sending via `osascript` | `send_imessage`, `send_sms`, `text_contact`, the quick-reply composer, and the SUNNY proxy |
| **Mail** | AppleScript to Mail.app | `mail_*`, world.mail_unread |
| **Notes** | AppleScript to Notes.app | `notes_app_*` |

### If a permission is silently denied

macOS sometimes caches a denied permission without showing you the prompt
again. To reset:

```bash
# Full list of SUNNY's permissions (redo any you want to re-prompt)
tccutil reset Accessibility ai.kinglystudio.sunny
tccutil reset ScreenCapture ai.kinglystudio.sunny
tccutil reset SystemPolicyAllFiles ai.kinglystudio.sunny
tccutil reset Calendar ai.kinglystudio.sunny
tccutil reset AddressBook ai.kinglystudio.sunny
tccutil reset AppleEvents ai.kinglystudio.sunny
# nuclear — resets every permission for SUNNY
tccutil reset All ai.kinglystudio.sunny
```

Then relaunch SUNNY. Next time it needs the permission you'll see the
prompt again.

## Ollama

SUNNY uses local Ollama for three things (each independent):

1. **Embeddings** (`nomic-embed-text`) — for memory retrieval
2. **Cheap metacognition** (`qwen2.5:3b` by default) — for introspection,
   reflection, consolidation, critic, decomposition
3. **Planning** (user's configured big model, if set to `ollama`)

### "no Ollama detected"

Check Ollama is running:

```bash
ollama list
# if command not found: https://ollama.com
# if Ollama is installed but the daemon isn't up:
ollama serve &
```

### Pull the required models

```bash
ollama pull nomic-embed-text    # ~275 MB, enables hybrid memory retrieval
ollama pull qwen2.5:3b          # ~2 GB, cheap metacognition
ollama pull qwen2.5:14b         # ~9 GB, recommended planning model
# or: ollama pull llama3.2
```

### "memory is FTS-only"

The Memory page shows `used_embeddings = false` when embeddings are
unavailable. Fix:

```bash
ollama pull nomic-embed-text
```

The embedding backfill loop runs every 30 s and will progressively fill
the BLOB columns. Check progress with:

```sql
sqlite3 ~/.sunny/memory/memory.sqlite \
  "SELECT count(*) FROM episodic WHERE embedding IS NOT NULL"
```

### "consolidator never runs"

Consolidator requires ≥ 8 new episodic rows since the last run. First
launch + light use → it just waits. Force a run:

```bash
# From the UI: open the Memory page → Insights tab; you'll see the
# "processed X rows → Y facts" console logs when it fires.
# Or manually from devtools:
window.__TAURI__.invoke('memory_consolidator_status')
```

If `pending_count >= min_floor` and the loop hasn't fired, it's waiting
for the next 15-min tick. Wait or restart the app (first tick is 60 s
after boot).

## Constitution

### "my constitution isn't taking effect"

Clients cache the constitution for 60 s. Restart the app, or call:

```ts
import { invalidateConstitutionCache } from './lib/constitution';
invalidateConstitutionCache();
```

After a `constitution_save`. The built-in Settings UI does this for you;
if you edited `~/.sunny/constitution.json` by hand, restart.

### "my constitution is broken, SUNNY won't load values"

A malformed constitution logs a warning and falls back to defaults. To
recover:

```bash
# Move the broken file aside, let SUNNY recreate a fresh default
mv ~/.sunny/constitution.json ~/.sunny/constitution.json.broken

# Next launch will write a permissive default to ~/.sunny/constitution.json
```

Compare against [`docs/CONSTITUTION.md`](./CONSTITUTION.md) example
schemas when fixing.

### "a tool I want to use is blocked"

Check the Memory → Insights tab. A `constitution_block` entry tells you
which prohibition fired:

```
BLOCKED · Blocked "run_shell" · No rm -rf root or home
```

Edit `~/.sunny/constitution.json` to narrow or remove the rule, then
restart SUNNY.

## Agent behavior

### "the agent keeps asking clarifying questions"

The introspector is returning `clarify` because your goals are
genuinely ambiguous in context or because the cheap model is being
conservative. Two fixes:

- **Disable introspection**: add `"introspectionEnabled": false` to
  `sunny.settings.v1` in localStorage (or toggle in the Settings page).
- **Be more specific** in the goal. "fix the bug" → "fix the failing
  cargo test in `web.rs`".

### "System-1 skills aren't firing"

The gate requires:

1. `used_embeddings = true` — see the "memory is FTS-only" section above
2. `matched_skills[0].score >= 0.85` — the goal must semantically match a
   learned skill's `trigger_text`

Widen the trigger text on the skill (via the Memory → Procedural tab
DELETE + recreate with more variants), or add a manually-authored skill
with better trigger phrasing.

### "the synthesizer never compiled anything"

Requires **≥ 5 successful runs** with the **identical tool_sequence**
within the last **30 days**. Confirm by checking episodic rows with the
`run` + `done` tags. Failed runs, aborted runs, and single-tool runs
don't count.

Nudge it by intentionally running the same query a few times once the
tool path is stable.

### "the critic rejected my action"

Check Insights → `constitution_block` (the critic uses the same insight
channel). You'll see the critic's reasoning. If you disagree, the
options are:

- Rephrase the goal to make the intent clearer
- Weaken the constitution values the critic is paranoid about
- Run the action via ConfirmGate (most dangerous tools still fall
  through to the user's confirmation when the critic is uncertain)

## Contacts, iMessage, and the AI proxy

### "all my contacts show as phone numbers"

The Contacts module joins `chat.db` rows against the macOS AddressBook
database (`~/Library/Application Support/AddressBook/`). If every row
renders as `+1 (604) 555-1234` instead of a name, one of these is off:

1. **Contacts permission** isn't granted. Check System Settings →
   Privacy & Security → Contacts → SUNNY enabled. If you never saw the
   prompt: `tccutil reset AddressBook ai.kinglystudio.sunny` and relaunch.
2. **Full Disk Access** covers AddressBook too, but only if it was
   granted *after* the AddressBook database moved under its current
   location. Reset FDA (`tccutil reset SystemPolicyAllFiles
   ai.kinglystudio.sunny`) and re-grant if name resolution still fails.
3. **The AddressBook index is empty** on a fresh iCloud sign-in. Open
   Contacts.app, wait for sync, then reload the Contacts page (names
   are re-indexed every 60 s).

### "new messages still show as — or [attachment]"

SUNNY extracts message text from both `message.text` (legacy column) and
`message.attributedBody` (Ventura+ typedstream BLOB). If your messages
still render as `—`:

- The message genuinely is an attachment with no text (photo reply,
  sticker, tapback). Those show as `[attachment]` when `cache_has_attachments`
  is set; otherwise they're silently skipped.
- The `attributedBody` parser is a best-effort heuristic — the fallback
  path rejects fragments with <40 % alphanumeric density to avoid
  surfacing binary glue. Very short messages (≤ 3 chars) can fall into
  that gap. Open the thread in Messages.app to confirm.

### "I enabled a proxy but nothing happens"

Check in order:

1. **Global kill switch**. Top of the Contacts page: the banner must
   read `SUNNY PROXY ACTIVE`, not `SUNNY PROXY PAUSED`.
2. **Watcher subscriptions**. The chat.db poller only runs for contacts
   with `enabled: true`. From the devtools console:
   ```ts
   window.__TAURI__.invoke('messages_watcher_subscriptions')
   ```
   should return the handles you expect.
3. **Ollama is running**. Proxy drafts use the cheap-model route by
   default (see `src/lib/modelRouter.ts`). If Ollama is off the engine
   queues an explanatory placeholder draft instead of a real reply.
4. **The 30 s auto-send cooldown**. Consecutive messages from the same
   contact within 30 s get draft-mode treatment even when `autoSend` is
   on, by design. Open the SUNNY PROXY panel in the contact's detail
   view — pending drafts are visible there.

### "I want to stop all proxies right now"

Click `PAUSE ALL` in the red banner at the top of the Contacts page.
This flips `useProxy.globalEnabled` to false, clears the watcher
subscription set, and prevents any new draft / auto-send from firing.
Individual proxies retain their per-contact toggles so you can resume
selectively.

### "I accidentally approved auto-send"

Open the contact's detail view → SUNNY PROXY panel → uncheck `AUTO-SEND`.
Auto-send always requires an explicit ConfirmGate approval to turn on,
so it can't get flipped without a HIGH-risk dialog — but the UI lets
you roll back instantly.

### "call_contact dials the wrong person"

`text_contact` / `call_contact` match in tiers:

1. Exact case-insensitive display match
2. Exact handle (phone / email) match
3. Display prefix match
4. Display substring match
5. Digit substring on handles
6. AddressBook name match (same tiers)

When multiple contacts match at the same tier, the tool returns
`ambiguous: true` with a candidate list rather than picking for you.
Ask SUNNY again with more specificity ("text Sunny Chan" instead of
"text Sunny") — the agent will pick the right handle from the returned
candidates.

### "call_contact to a group chat fails"

Group chats use synthetic `chat<id>` identifiers that the `tel:` /
`facetime:` URL schemes can't route. The tool refuses with a clear
error; open Messages.app directly for group calls, or call an
individual participant instead.

## Screen OCR

### "focus-triggered OCR isn't doing anything"

Opt-in via settings. Add:

```json
{ "screenOcrEnabled": true }
```

to `~/.sunny/settings.json` (or via the Settings UI). Then:

1. **Screen Recording permission** must be granted — see top of this doc
2. **tesseract must be installed** — `brew install tesseract`
3. Rate-limited to one capture per 90 s across all focus changes

### "tesseract isn't found even though I installed it"

If you installed via a non-Homebrew path (MacPorts, manual build), the
app can't find it because GUI apps inherit a minimal `PATH`. SUNNY's
startup augments `PATH` with standard Homebrew locations (see
`paths::augment_process_path`). If your install is elsewhere:

```bash
# Symlink into /opt/homebrew/bin (Apple Silicon) or /usr/local/bin
sudo ln -s /your/tesseract/path /opt/homebrew/bin/tesseract
```

Then relaunch SUNNY.

## Voice

### "push-to-talk doesn't record"

Requires `sox` *or* `ffmpeg` for mic capture:

```bash
brew install ffmpeg   # preferred — `sox` also works
```

Microphone permission is prompted on first use. Also check:

- System Settings → Privacy & Security → Microphone → SUNNY enabled
- Settings → pushToTalkKey: default `Space`, can change to `F19`

### "no transcriber — brew install …"

SUNNY's transcription pipeline tries `whisper-cli` (from whisper.cpp,
the fast path) and falls back to `whisper` (openai-whisper):

```bash
brew install whisper-cpp    # preferred
# or
pip install openai-whisper  # slower CPU path
```

On first voice press after install, SUNNY downloads `ggml-tiny.en.bin`
(~74 MB) into `~/Library/Caches/sunny/whisper/` from the official
whisper.cpp mirror. Once it's cached, a background task silently
upgrades to `ggml-base.en.bin` (~148 MB) so the next session uses
the more accurate model. If both are already present, `base.en`
wins. Override via env var:

```bash
# Point at a model you already have
export SUNNY_WHISPER_MODEL=/opt/homebrew/share/whisper-cpp/ggml-base.en.bin
```

If the download fails (offline, firewall), grab a model manually and
drop it in the cache dir, or set `SUNNY_WHISPER_MODEL`. Homebrew's
bundled `for-tests-ggml-tiny.bin` is a dummy — SUNNY deliberately
skips it because it returns empty transcripts.

### "I hear nothing when the AI replies"

The TTS backend is macOS `say`. If the configured voice (default
`Daniel`) isn't installed on your Mac, SUNNY automatically retries
without `-v` and falls back to the system voice. To install extra
voices: System Settings → Accessibility → Spoken Content → System
Voice → Manage Voices. To test the chain end-to-end:

```bash
say -v Daniel "Testing voice output"
```

If that works but SUNNY is still silent, check for a visible
`Speech failed:` error near the mic button — it surfaces any stderr
from `say`.

### "the AI keeps interrupting itself"

Barge-in is designed to ignore the AI's own voice leaking through
the speakers (2× threshold boost in `barge-in` mode + echo
cancellation). If it still self-triggers on a particular setup:

- Use headphones — eliminates the acoustic loop entirely.
- Check System Settings → Sound → Output: HDMI / AirPlay sinks can
  bypass the OS-level AEC that makes AEC effective.

### "recording auto-stops before I finish"

VAD waits 900 ms of silence before ending an utterance. In a quiet
room this can trigger on a long pause mid-sentence. Workarounds:

- Tap space instead of relying on auto-stop (the manual path doesn't
  use VAD).
- Keep talking — short mid-sentence breaths are below the threshold
  window and don't end the utterance.

## Browser

See [`docs/BROWSER.md`](./BROWSER.md) for the full architecture and
threat model. Problems below are the ones that cost real time to
diagnose.

### "Tor profile errors with `System Tor not running on 127.0.0.1:9050`"

The default Tor route probes the system's `tor` daemon. If it isn't
running, every Tor tab surfaces the error loudly rather than silently
falling through to clearnet.

```bash
brew install tor
brew services start tor
# confirm:
lsof -iTCP:9050 -sTCP:LISTEN
```

You should see `tor` listening on `127.0.0.1:9050`. The posture bar's
`TOR` chip flips to green on the next 15 s poll — no app restart
needed. If `lsof` shows it listening but the profile still errors,
confirm `ControlPort` is not also bound somewhere that answers 9050 —
a stray sshuttle / socat listener can steal the port.

If you'd rather bundle Tor inside Sunny (no `brew services` dependency),
enable the cargo feature:

```bash
cd src-tauri
cargo build --features bundled-tor
```

…and complete the arti wiring in
`src-tauri/src/browser/tor.rs::bootstrap()`. The stub intentionally
returns a clear "not yet implemented" rather than silently routing
clearnet — we'd rather break loudly than mislead the anonymity claim.

### "New Circuit does nothing on the Tor profile"

`browser_tor_new_circuit` only works when Tor is running as a bundled
arti client (feature flag above). System Tor exposes NEWNYM through
its ControlPort, which requires a cookie or password auth that we
don't assume is configured on a default Homebrew install. For now, to
force a new circuit on system Tor: `brew services restart tor`.

### "Downloads panel says yt-dlp / ffmpeg missing"

We probe `PATH` plus `/opt/homebrew/bin`, `/usr/local/bin`,
`/opt/local/bin`, `/usr/bin`. If Sunny launched from Finder, it inherits
a launchctl-minimal PATH that typically doesn't include Homebrew. The
fallback should catch it, but if it doesn't:

```bash
which yt-dlp ffmpeg        # must both resolve
brew install yt-dlp ffmpeg
```

Restart Sunny after installing. The `browser_downloads_probe` Tauri
command runs on every DownloadsPanel mount, so the banner updates on
next render without a full app reload.

### "Download job failed: yt-dlp exited with non-zero status"

Three common causes:

1. **Site requires login.** yt-dlp can read cookies from Safari /
   Chrome with `--cookies-from-browser safari`. We don't currently
   pass that flag because the profile semantics would be confusing
   (which browser's cookies? for which profile?). Workaround: right-
   click the video → "Open in Safari", log in there, then use Safari's
   own downloads.
2. **DRM-protected stream.** Netflix, Disney+, Apple TV+ use Widevine
   / FairPlay — yt-dlp cannot decrypt those. Expected behavior; not a
   bug.
3. **Rate-limited on the tab's profile.** If you enqueue from a Tor
   profile, many sites throttle or CAPTCHA the exit node. Retry from
   `default`, or pick a different exit circuit.

The `ANALYZE` button on a completed download row ignores the job's
profile — ffmpeg just reads a local file at that point.

### "Sandbox tab opens but looks blank"

The loopback bridge listens on `127.0.0.1:<ephemeral>`. If Little
Snitch / LuLu / a corporate firewall blocks loopback traffic to
ephemeral ports, the WebView's resource fetches hang. Whitelist
`127.0.0.1` to any ephemeral destination port for the Sunny process.

A subtler cause: if a VPN with "block all non-tunnel traffic" is
active, some implementations block loopback too. Either add a
loopback exception in the VPN client or switch the profile's route
to `custom` and point it at the VPN's SOCKS endpoint.

### "Kill switch blocks the active tab but the tab is clearnet"

Expected. The kill switch short-circuits every dispatcher call
regardless of profile, except for profiles explicitly marked
`kill_switch_bypass=true`. The built-ins (`default`, `private`, `tor`)
never bypass — the bypass flag is only meaningful for user-authored
profiles that the operator has a good reason to keep live (for
example, a local admin profile routed through `127.0.0.1:8080`).

### "Audit log is empty for the Tor profile"

By design. `ProfilePolicy::tor_default` ships with `audit=false` so
the audit SQLite never records which onion the user visited — even
inside our own log. If you genuinely want the audit trail for Tor
traffic on your own machine, upsert a custom profile with
`audit=true`:

```ts
await invoke('browser_profiles_upsert', {
  policy: { ...torDefaultPolicy, id: 'tor-audited', audit: true },
});
```

…and open tabs on `tor-audited` instead of `tor`.

### "A page I wanted to read loads empty in reader mode"

Some sites render their content entirely in client-side JS — there's
literally no article in the HTML we fetch, only a `<div id="root">`
that React fills in at runtime. Reader mode can't see through that.
Toggle to SANDBOX mode (`Cmd+J`) for those sites; the WebView runs
the JS and the hardening init-script still applies.

### "DoH resolution errors or returns no addresses"

Cloudflare, Quad9, and Google all return well-formed A/AAAA for public
names. If you see `DoH (https://1.1.1.1/dns-query) returned no A/AAAA
for <host>`, the three usual causes:

1. **Captive portal**. The anycast DoH IP is reachable but TLS fails
   because the portal is MITM'ing 443. Open Safari, accept the portal,
   come back. Alternatively switch the profile's DoH to
   `Quad9` or `Google` — some portals MITM Cloudflare only.
2. **Firewall blocks port 443 to anycast IPs**. Try a different
   provider or disable DoH for the `default` profile (Settings →
   profile editor; leaving `doh: null` falls back to the OS resolver,
   which on macOS means the system resolver's own DoH settings take
   over if you've configured them).
3. **The name actually doesn't exist**. Check `dig @1.1.1.1 <name>`
   from a terminal.

### "A URL got blocked by my constitution and I want to allow it"

Every browser fetch runs through the same gate as agent tool calls.
Edit `~/.sunny/constitution.json` → remove the offending prohibition or
narrow its `match_input_contains` filter. See
[`docs/CONSTITUTION.md`](./CONSTITUTION.md) for schema. The browser's
audit log records the exact blocked URL with
`blocked_by = "constitution:<reason>"` so you can see which rule fired.

### "Sunny is refusing to navigate to a legitimate IDN domain"

The homograph detector flags any host with `xn--` labels or non-ASCII
characters. For genuinely internationalized domains (e.g.
`münchen.de`) you'll see a confirm dialog showing the ASCII form
(`xn--mnchen-3ya.de`). Click OK to proceed — a yellow banner will pin
over the tab for the session as a reminder you're on an IDN. We
deliberately don't auto-trust based on TLD because a determined
phisher registers `.com` lookalikes routinely.

### "Gatekeeper keeps blocking things I downloaded through Sunny"

That's working as intended: the download manager sets
`com.apple.quarantine` on every finished file, so macOS treats them
like Safari downloads. First open prompts you to confirm the app
identity. Remove the attribute manually if you need to:

```bash
xattr -d com.apple.quarantine /path/to/file
```

For non-executable content (videos, PDFs) this mostly doesn't matter —
Gatekeeper is quiet unless the file claims to be an app. For
screenshots or scraped payloads it can surprise you.

### "I can't find the audit log / kill switch / downloads"

All three are in the Web module's **posture bar**, the thin dashed
row under the tab strip:

- The one-line posture summary lives on the left
  (`TOR · JS OFF · EPHEMERAL · …`).
- The `AUDIT` button on the right opens the filterable audit viewer.
- The kill switch is on the profile rail below the `PROFILES` header.
- Downloads + research live in the side-view tabs of the sidebar.
  Keyboard shortcut: click `DOWNLOADS` / `RESEARCH` in the sidebar.

## Build / development

### "pnpm tauri dev crashes with a Rust error"

The Rust backend may be stale after a major change (schema migration,
new deps). Clean rebuild:

```bash
cd src-tauri
cargo clean
cd ..
pnpm tauri dev
```

### "cargo check takes forever"

The first build compiles ~600 deps (~3–5 min on an M1, longer on Intel).
Incremental builds after that are ~2 s. A `cargo clean` restarts the
clock.

### "the frontend bundle is larger than 500 KB"

That's a warning, not an error. Some pages are already lazy-loaded
(see `src/pages/pages.ts`). The top candidates for further splitting
are `src/components/CommandBar/` (folder), `QuickLauncher.tsx`, and
`AgentOverlay.tsx` — moving them behind `React.lazy` would cut
first-paint size.

### "a Rust test panics only on my machine"

Tests in `memory/` use `tempfile` paths under `$TMPDIR`. If your `$TMPDIR`
is set oddly, try:

```bash
TMPDIR=/tmp cargo test --lib
```

## Data locations

If something's corrupted, these are the files to nuke:

```
~/.sunny/
├─ memory/
│  └─ memory.sqlite        — nuking loses all memory (also kills consolidator watermark)
├─ world.json              — nuking resets the "last-known state" shown on cold boot
├─ constitution.json       — nuking re-seeds with defaults on next launch
├─ settings.json           — nuking resets UI preferences
├─ scheduler.json          — nuking removes all scheduled jobs
├─ daemons.json            — nuking removes all agent daemons
└─ vault_index.json        — nuking orphans Keychain items (values remain)
```

Keychain items from the vault persist under the service name prefix
`sunny.*` — use `security find-generic-password -s sunny.<uuid>` to
inspect, or **Keychain Access** to delete them manually.

## Logs

Dev logs stream to the terminal running `pnpm tauri dev`. For a built
`.app`:

```bash
# Follow the app's console output
log stream --predicate 'process == "Sunny"' --info
```

Frontend console is in the DevTools window (`Cmd+Option+I` when the
app window is focused).

## Where to ask for help

Open an issue with:

- The output of `pnpm tauri dev` around the failure
- Your OS version (`sw_vers`)
- `~/.sunny/settings.json` (redact any API keys!)
- The contents of `~/.sunny/constitution.json` if the issue is
  policy-related
- `sqlite3 ~/.sunny/memory/memory.sqlite "SELECT * FROM meta"` if the
  issue is memory-related

## Further reading

- [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md)
- [`docs/AGENT.md`](./AGENT.md)
- [`docs/MEMORY.md`](./MEMORY.md)
- [`docs/CONSTITUTION.md`](./CONSTITUTION.md)
- [`docs/CONTRIBUTING.md`](./CONTRIBUTING.md)
