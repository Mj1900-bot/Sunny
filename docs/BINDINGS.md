# TypeScript Bindings — Rust ↔ TS contract

SUNNY generates its TypeScript wire types straight from the Rust structs that
`#[tauri::command]` functions return. The canonical source is Rust; the frontend
imports generated `.ts` files under `src/bindings/`. This eliminates a whole
class of silent-drift bugs where a Rust rename (e.g. `#[serde(rename = "exit_code")]`)
left hand-written TS types pointing at a ghost field.

The emitter is [`ts-rs`](https://github.com/Aleph-Alpha/ts-rs) (pinned at
`10.1.0` in `src-tauri/Cargo.toml`).

## Migrated types (37)

Every type below is declared with `#[derive(TS)] #[ts(export)]` in Rust and
round-trips through `src/bindings/<Name>.ts` verbatim. Any shape drift fails
CI — the generated file is diffed against the committed copy on every
`cargo test --lib export_bindings_` run.

| Domain | Types |
|---|---|
| Shell / apps | `ShellResult` |
| Scheduler / daemons | `Job`, `JobKind`, `JobAction`, `Daemon`, `DaemonSpec` |
| Scanner | `ScanOptions`, `ScanPhase`, `ScanProgress`, `ScanRecord`, `Signal`, `SignalKind`, `Finding`, `Verdict`, `VaultItem` |
| Metrics | `SystemMetrics`, `NetStats`, `ProcessRow`, `BatteryInfo` |
| Telemetry | `TelemetryEvent`, `LlmStats`, `UsageRecord` |
| Contacts / messages | `MessageContact`, `ChatSummary`, `ConversationMessage`, `ContactBookEntry` |
| World / forecast | `Weather`, `DayForecast`, `Forecast`, `StockQuote` |
| Calendar / reminders / mail / notes / clipboard | `CalendarEvent`, `Reminder`, `MailMessage`, `Note`, `ClipboardEntry` |
| World state | `WorldState`, `Activity`, `FocusSnapshot`, `AppSwitch` |
| Secrets | `SecretsStatus`, `VerifyResult` |

## Regenerating after a schema change

One-liner:

```bash
./scripts/regen-bindings.sh
```

That runs `cargo test --lib export_bindings_ -- --test-threads=1` from inside
`src-tauri/`. ts-rs plumbs the `.ts` file emission through a per-type
`#[test]` function (`export_bindings_<lowercase-name>`), so running the tests
is what actually writes the files.

Output path is controlled by `src-tauri/.cargo/config.toml`:

```toml
[env]
TS_RS_EXPORT_DIR = { value = "../src/bindings", relative = true }
```

Without that env var ts-rs defaults to `src-tauri/bindings/`, which Vite can't
import.

## Adding a new type

1. Pick the Rust struct returned by a `#[tauri::command]` (or emitted on a
   Tauri event channel).
2. Add three things to the derive + attrs:
   ```rust
   use ts_rs::TS;

   #[derive(Serialize, Deserialize, Clone, Debug, TS)]
   #[ts(export)]
   pub struct MyThing {
       pub id: String,
       #[ts(type = "number")]
       pub big_id: u64,  // see "bigint trap" below
   }
   ```
3. Run `./scripts/regen-bindings.sh`. A new `src/bindings/MyThing.ts` appears.
4. Import it on the frontend:
   ```ts
   import type { MyThing } from '../../bindings/MyThing';
   ```
5. Delete the old hand-written TS type (and any duplicate copies across
   `pages/*/api.ts`, `lib/*`, or component files — `grep -r 'type MyThing'`
   to find them).
6. Commit the Rust change AND the generated `.ts` file in the same commit so
   reviewers see both halves of the contract.

## Gotchas

### Bigint trap (`#[ts(type = "number")]`)

ts-rs' default mapping for `i64` / `u64` / `usize` is `bigint`, because JS
numbers lose precision past 2^53. In practice every caller in SUNNY already
treats these as plain numbers (`Date.now()` arithmetic, row counts that will
never hit 2^53), and receiving a `bigint` instead of `number` breaks
comparisons, JSON round-tripping, and React key props silently.

The rule: on any `i64` / `u64` / `usize` field that fits comfortably in a
double, force the wire type with `#[ts(type = "number")]`. Example from
`messaging::ChatSummary`:

```rust
#[ts(type = "number")]
pub last_message_ts: i64,
```

If a value genuinely can exceed 2^53 (row ids from a >9-quadrillion row
table), leave the default and teach the frontend to use `bigint`.

### `#[serde(rename)]` for non-snake_case wire fields

When the wire field name doesn't match the Rust field, you MUST also add the
equivalent `#[ts(rename = "...")]` so the generated TS matches what serde
actually emits. The canonical example lives in `control::ShellResult`:

```rust
#[serde(rename = "exit_code")]
#[ts(rename = "exit_code")]
pub code: i32,
```

If you forget the `#[ts(rename)]`, the generated file will name the field
`code` but the wire payload will carry `exit_code`, and every frontend read
will silently produce `undefined`. This is the exact drift bug that
triggered the R16-E audit and motivated the bulk migration.

Preserve existing `#[serde(rename)]`, `#[serde(default)]`, and
`#[serde(skip_serializing_if = "...")]` attributes — the TS derive inspects
serde attrs directly for `rename`, but `default` / `skip_serializing_if`
affect runtime shape only and require manually making the field optional in
TS where appropriate (`field: T | null` or `field?: T`).

### `Option<&'static str>` on returned structs

ts-rs happily accepts a `&'static str` field (maps to `string`) but **not**
`Option<&'static str>` without help. If you need an optional static category
label on a returned type, either switch to `Option<String>` or force
`#[ts(type = "string | null")]`.

### Enum discriminated unions

Rust enums with data-carrying variants round-trip as TS discriminated unions.
ts-rs picks the shape from the serde attrs on the enum:

- `#[serde(tag = "type")]` → `{ "type": "Once" } | { "type": "Interval" }`
  (see `JobKind.ts`)
- `#[serde(tag = "type", content = "data")]` → nested object
- Plain enums with `#[serde(rename_all = "snake_case")]` → string literal
  union (see `Activity.ts`: `"unknown" | "coding" | ...`).

The TS file is always usable as-is — no post-processing.

### One type, one file

ts-rs emits one `.ts` file per type and imports transitive dependencies.
`WorldState.ts` imports `Activity`, `AppSwitch`, `FocusSnapshot`, and
`CalendarEvent` — you do not need to import them yourself, and the
bindings folder stays browsable.
