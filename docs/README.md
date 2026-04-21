# SUNNY documentation

Technical and user-facing docs for the HUD, agent stack, and macOS backend. Start with [`../README.md`](../README.md) for install, quickstart, and the high-level product story.

## Essentials

| Doc | Audience | Contents |
|-----|----------|----------|
| [`ONBOARDING.md`](./ONBOARDING.md) | New contributors | Clone → dev → which docs to read → repo map → PR checklist |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Contributors | Tauri layout, `agent_loop`, memory, world model, event bus |
| [`AGENT.md`](./AGENT.md) | Contributors | Turn routing: introspection → HTN → System-1/2 → reflection |
| [`PAGES.md`](./PAGES.md) | Everyone | **HUD module pages** — what each screen is for (Today, Security, Audit, …) |
| [`SHORTCUTS.md`](./SHORTCUTS.md) | Everyone | Per-page keyboard shortcuts ([`PAGES.md`](./PAGES.md) for UI context) |
| [`SECURITY.md`](./SECURITY.md) | Everyone + security reviewers | Threat model, `SecurityBus`, panic mode, audit log, egress/ingress hardening roadmap |
| [`TOOLS.md`](./TOOLS.md) | Contributors | Agent tool catalog, how to add tools, Rust + TS registration |
| [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) | Users + devs | Permissions, Ollama, OCR, voice, common failures |

## Product modules

| Doc | Topic |
|-----|--------|
| [`MEMORY.md`](./MEMORY.md) | Episodic / semantic / procedural stores, FTS, embeddings, consolidation |
| [`SKILLS.md`](./SKILLS.md) | Learned recipes, synthesis, manual skill packs (`src/skills/`) |
| [`AUTO.md`](./AUTO.md) | Scheduled jobs, daemon runtime, templates, AUTO page |
| [`SCAN.md`](./SCAN.md) | On-device malware scan, quarantine vault, MalwareBazaar / VT |
| [`BROWSER.md`](./BROWSER.md) | Multi-profile Web module, dispatcher, Tor/sandbox, downloads |
| [`CONSTITUTION.md`](./CONSTITUTION.md) | `~/.sunny/constitution.json`, values, gates |

## Operations & repo

| Doc | Topic |
|-----|--------|
| [`SETUP-API-KEYS.md`](./SETUP-API-KEYS.md) | Keychain-backed Anthropic / ZAI keys |
| [`BINDINGS.md`](./BINDINGS.md) | `ts-rs` generated types under `src/bindings/` |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | Dev workflow, tests, style, where state lives |
| [`CHANGELOG.md`](../CHANGELOG.md) | Release / phase history (repo root) |

## Specialized / audits

| Doc | Topic |
|-----|--------|
| [`PAGE_COVERAGE.md`](./PAGE_COVERAGE.md) | Agent-tool coverage per HUD page (R18 roadmap; developer audit) |
| [`AGI_READINESS.md`](./AGI_READINESS.md) | AGI-readiness notes |
| [`AGENTIC_AI_SCOUT.md`](./AGENTIC_AI_SCOUT.md) | Agentic AI scout notes |

## Other entry points

- **[`../AGENTS.md`](../AGENTS.md)** — instructions for coding agents (build, conventions, security notes for new tools/egress).
- **[`../src/skills/README.md`](../src/skills/README.md)** — optional TypeScript skill packs.
