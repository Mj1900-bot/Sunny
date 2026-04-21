# SUNNY Skills

Skills are drop-in tool packs. For the full picture (SQLite procedural store,
auto-synthesis, and HUD **Skills** page), see [`docs/SKILLS.md`](../../docs/SKILLS.md).

Create one file in `src/skills/`, export a
`SkillManifest` as the default export, and SUNNY will register its tools at
boot.

## Adding a skill

1. Copy `example-weather.ts` to `src/skills/<your-skill>.ts`.
2. Update the manifest fields: unique `id` (e.g. `skill.calendar`), `name`,
   `description`, `version`, optional `author`.
3. Define one or more `Tool` objects (see `src/lib/tools.ts` for the `Tool`
   type — each needs a `schema`, a `dangerous` flag, and an async `run`).
4. List the tools in the manifest and `export default` it.

At startup, `loadBuiltinSkills()` in `src/lib/skills.ts` imports every file
matching `../skills/*.ts` via Vite's `import.meta.glob({ eager: true })`, then
registers whichever default export looks like a manifest. Tools inside a
registered skill are forwarded to the shared registry in `lib/tools.ts`, so the
agent loop picks them up automatically.

## Tool schema contract

A `Tool` is:

```ts
type Tool = {
  readonly schema: {
    readonly name: string;                       // unique tool id
    readonly description: string;
    readonly input_schema: Record<string, unknown>; // JSON Schema for input
  };
  readonly dangerous: boolean;
  readonly run: (input: unknown, signal: AbortSignal) => Promise<ToolResult>;
};
```

Namespace your tool names (e.g. `skill.weather.current`) so they don't collide
with built-ins. Validate `input` defensively — treat it as `unknown`. Honour
`signal.aborted` both before and after any async work so long-running calls
can be cancelled.

## The `dangerous` flag and ConfirmGate

Set `dangerous: true` for any tool that performs a side effect a user might
want to veto (shell execution, deletions, sending messages, UI automation).
The pending ConfirmGate in the agent loop will intercept those calls and
prompt the user before they run. Read-only tools (lookups, fetches,
introspection) should set `dangerous: false`.

## Testing a skill locally

- `pnpm tsc --noEmit` to confirm the manifest and tools typecheck.
- Run the app (`pnpm tauri dev`); your skill should appear in the skills list
  emitted by `listSkills()` on boot.
- To smoke-test a tool in isolation, import it from the file and call
  `tool.run(input, new AbortController().signal)` from a scratch test.

## Duplicate IDs

If two files register the same `skill.id`, only the first wins — SUNNY will
log one warning per duplicate and otherwise ignore the collision.
