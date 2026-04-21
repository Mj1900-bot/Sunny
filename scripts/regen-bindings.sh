#!/usr/bin/env bash
# Regenerate the ts-rs TypeScript bindings in src/bindings/ from the Rust
# structs that carry #[derive(TS)] #[ts(export)] in src-tauri/src/.
#
# Running the `export_bindings_*` unit tests is what actually writes the .ts
# files — ts-rs plumbs the emission through a per-type test function. We
# pin --test-threads=1 so concurrent writers can't collide on the output
# directory (TS_RS_EXPORT_DIR is set to ../src/bindings via
# src-tauri/.cargo/config.toml).
set -euo pipefail
cd "$(dirname "$0")/../src-tauri"
cargo test --lib export_bindings_ -- --test-threads=1 2>&1 | tail -20
echo "✓ Bindings regenerated to src/bindings/"
