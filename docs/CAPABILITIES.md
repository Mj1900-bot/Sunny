# Capabilities

SUNNY enforces a per-initiator capability grant system that controls which tools
each caller — the main agent, sub-agents, the scheduler, and daemons — is
allowed to invoke. The policy lives in `~/.sunny/grants.json` and is loaded by
`src-tauri/src/capability.rs` with a mtime-driven in-process cache so UI edits
take effect without an app restart.

## `grants.json` schema

```json
{
  "initiators": {
    "agent:scheduler": ["network.read", "web:fetch", "memory.read"],
    "agent:daemon:security-sweep": [
      "network.read",
      "memory.read",
      "scan:read",
      "macos.files.read"
    ]
  },
  "default_for_sub_agents": ["memory.read", "compute.run"]
}
```

### Fields

| Field | Type | Description |
|---|---|---|
| `initiators` | `Record<string, string[]>` | Explicit per-initiator allowlists. Keys are the initiator strings the dispatcher receives. |
| `default_for_sub_agents` | `string[]` | Fallback grant set for any `agent:sub:*` / `agent:daemon:*` / `agent:scheduler` initiator NOT listed in `initiators`. |

### Initiator key patterns

| Pattern | Who it covers |
|---|---|
| `agent:main` | The primary user-facing chat agent. Always unscoped (default-allow) — not affected by this file. |
| `agent:scheduler` | Jobs fired by the Rust scheduler (`scheduler.rs`). |
| `agent:daemon:<name>` | A named persistent daemon from the AUTO → AGENTS tab. |
| `agent:sub:<uuid>` | An ad-hoc sub-agent spawned by `spawn_subagent`. |

### Capability string taxonomy

Capability strings follow dotted or colon-namespaced conventions matching what
`agent_loop::tools::*` modules declare on their `ToolSpec::required_capabilities`:

| String | Covers |
|---|---|
| `memory.read` | `memory_recall`, `memory_list`, `memory_search` |
| `network.read` | Read-only web fetches (`web_search`, `web_fetch_readable`) |
| `web:fetch` | `browser_fetch_readable`, `browser_research_run` |
| `macos.calendar.read` | `calendar_list_events`, `calendar_list_calendars` |
| `scan:read` | `scan_start`, `scan_findings`, `scan_vault_list` |
| `compute.run` | `run_shell` (dangerous; requires explicit grant) |
| `app:launch` | `open_app` |

See `src-tauri/src/capability.rs:60-82` for the authoritative `GrantsFile`
struct and the baked-in default initiator maps.

## Runtime behaviour

- **Denial logging**: every denied call appends a JSONL row to
  `~/.sunny/capability_denials.log` for post-hoc audit.
- **Unknown sub-agents**: any initiator not in `initiators` falls back to
  `default_for_sub_agents`. This is intentionally conservative — unknown
  callers get read-only memory access and basic compute, not the full tool set.
- **`agent:main` bypass**: the primary agent never consults `grants.json`;
  the normal constitution + ConfirmGate path is the user-level control surface
  for restricting the main agent.

## Denial audit log

Every denied call appends a structured JSONL row to
`~/.sunny/capability_denials.log` for post-hoc audit:

```json
{"at":"2026-04-19T10:00:00Z","initiator":"agent:sub:abc123","tool":"run_shell","missing":["compute.run"],"reason":"…"}
```

Rows are deduplicated per `(initiator, tool, capability)` triple so a
runaway loop does not produce duplicate lines.

The Tauri command `capability_tail_denials` returns the most recent N rows
from the log. This is what the **GRANTS** tab in `SecurityPage` calls to
populate its denial audit panel (hotkey `0` on the Security page).

## Editing grants

Edit `~/.sunny/grants.json` directly (it is created with sensible defaults on
first launch). Changes are picked up within the mtime check interval without
restarting SUNNY.

The **GRANTS** tab in the Security page (`SecurityPage/GrantsTab.tsx`) shows
the current policy and recent denials without requiring a shell. The tab is
read-only — edit the JSON file to change grants.

Compare the default initiator map in `src-tauri/src/capability.rs` (function
`default_initiator_map`) when troubleshooting unexpected denials.

## Further reading

- [`docs/CONSTITUTION.md`](./CONSTITUTION.md) — the complementary declarative
  prohibition system that gates tool calls for the main agent.
- [`docs/SECURITY.md`](./SECURITY.md) — runtime security monitoring and panic mode.
- [`docs/AGENT.md`](./AGENT.md) — how the agent loop integrates with dispatch.
