# Contributor onboarding

Short path from zero to a running app and the docs that matter for your first PR.

## 1. Run it

```bash
git clone <your-fork-url>
cd Sunny
pnpm install
pnpm tauri dev
```

First Rust build downloads and compiles a large dependency graph — expect several minutes once, then fast HMR on the React side.

**Recommended macOS tools** (voice, OCR, scan): see the [Requirements](../README.md#requirements) section in the root README. `scripts/doctor.sh` prints OK/MISS for optional binaries.

## 2. Read in this order

| Order | Doc | Why |
|------|-----|-----|
| 1 | [`README.md`](../README.md) | Product story, quickstart, privacy, feature table |
| 2 | [`docs/README.md`](./README.md) | Map of all technical docs |
| 3 | [`AGENTS.md`](../AGENTS.md) | Build commands, Rust/TS conventions, **security rules** for tools and egress |
| 4 | [`docs/CONTRIBUTING.md`](./CONTRIBUTING.md) | Day-two workflow, TCC resets, troubleshooting voice |

When you touch the agent or backend: [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md), [`docs/TOOLS.md`](./TOOLS.md), [`docs/BINDINGS.md`](./BINDINGS.md).

When you touch UI: [`docs/PAGES.md`](./PAGES.md), [`docs/SHORTCUTS.md`](./SHORTCUTS.md).

## 3. Where things live

| Area | Path |
|------|------|
| HUD module pages (lazy) | `src/pages/` + registry [`src/pages/pages.ts`](../src/pages/pages.ts) |
| Zustand + `ViewKey` | [`src/store/view.ts`](../src/store/view.ts) |
| Tauri commands | [`src-tauri/src/commands.rs`](../src-tauri/src/commands.rs), registered in [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs) |
| Agent loop + tool catalog | [`src-tauri/src/agent_loop/`](../src-tauri/src/agent_loop/) |
| Generated TS types | `src/bindings/` ([`docs/BINDINGS.md`](./BINDINGS.md)) |

## 4. Before you open a PR

- `pnpm tsc -b --noEmit`
- `cd src-tauri && cargo check` (and `cargo test` if you changed Rust)
- Match commit style in [`AGENTS.md`](../AGENTS.md#pr--commit-guidelines)

## 5. Stuck?

[`docs/TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) · permissions · Ollama · signing · voice.
