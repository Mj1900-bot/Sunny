# Setting up API keys for SUNNY

SUNNY's agent loop prefers Anthropic (Claude) over the local Ollama fallback —
but only if it can see an `ANTHROPIC_API_KEY`. On macOS, a Tauri `.app`
launched from Finder or Dock inherits **only the `launchd` user
environment** — it does **not** read `~/.zshenv`, `~/.zshrc`, or any other
shell profile. That means a plain `export ANTHROPIC_API_KEY=...` in your
shell rc is invisible to Sunny.app and you silently get the Ollama path.

SUNNY solves this by reading the key from the **macOS Keychain** at startup.
There are two installation paths — pick one.

---

## Path A (recommended): Keychain only

Zero shell configuration. Works for Finder, Dock, Spotlight, and
`cargo tauri dev`.

```sh
scripts/install-anthropic-key.sh sk-ant-your-key-here
```

That stores the key under Keychain service `sunny-anthropic-api-key`. The
Rust side (`src-tauri/src/secrets.rs`) reads it at startup via
`/usr/bin/security find-generic-password`.

### Verify

```sh
security find-generic-password -s sunny-anthropic-api-key -w
```

Should print your key. First run may prompt for your login password — click
**Always Allow** if you don't want to be prompted on every Sunny launch.

### Remove

```sh
security delete-generic-password -s sunny-anthropic-api-key
```

---

## Path B (optional): Keychain + LaunchAgent

Use this if you want **other** apps (not just Sunny) to see
`ANTHROPIC_API_KEY` in their env — e.g. iTerm spawned from Dock,
third-party Claude clients, etc.

```sh
scripts/install-anthropic-key.sh sk-ant-your-key-here
cp scripts/ai.kinglystudio.sunny.env.plist.template \
   ~/Library/LaunchAgents/ai.kinglystudio.sunny.env.plist
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/ai.kinglystudio.sunny.env.plist
```

At login, the LaunchAgent reads the Keychain entry and calls
`launchctl setenv ANTHROPIC_API_KEY <value>`. Every GUI app launched
thereafter inherits it.

### Verify

Log out and back in, then:

```sh
launchctl getenv ANTHROPIC_API_KEY
```

### Remove

```sh
launchctl bootout gui/$UID/ai.kinglystudio.sunny.env
rm ~/Library/LaunchAgents/ai.kinglystudio.sunny.env.plist
launchctl unsetenv ANTHROPIC_API_KEY
```

---

## Common pitfalls

- **`cargo tauri dev` sees the key but Sunny.app doesn't.** You set the key
  in your shell rc. Dev mode runs under your shell; Finder launches don't.
  Fix: use Path A.
- **Keychain prompts every launch.** The first time `/usr/bin/security`
  reads the entry from a new binary signature, macOS asks for your login
  password. Click **Always Allow** to stop the prompts. After a rebuild
  with a changed signature, the prompt may return once.
- **Key looks wrong / request rejected.** `install-anthropic-key.sh`
  sanity-checks the `sk-` prefix. If you pasted extra whitespace, re-run
  the script — it deletes the old entry first.
- **Rotating the key.** Just re-run `scripts/install-anthropic-key.sh`
  with the new value. The `-U` flag updates in place.
