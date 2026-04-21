#!/usr/bin/env node --experimental-strip-types --no-warnings=ExperimentalWarning
/**
 * gen-types.ts — generate a single TypeScript file with the signature of
 * every #[tauri::command] registered in src-tauri/src/lib.rs.
 *
 * Pipeline:
 *   1. Parse lib.rs -> extract the generate_handler! list as the
 *      authoritative set of registered commands (module::fn_name).
 *   2. Walk src-tauri/src/**\/*.rs, collect every non-commented
 *      #[tauri::command] attribute with its following fn signature.
 *   3. For each registered command, look up its signature and emit
 *      TS arg + return types. Unknown Rust types pass through verbatim
 *      and are imported from ../bindings/<Name> where a sibling
 *      src/bindings/<Name>.ts exists (ts-rs already exports these).
 *   4. Output src/types/commands.generated.ts with a generated header
 *      and a typed invokeCommand<K>(cmd, args) helper.
 *
 * Design notes:
 *   - We skip Tauri runtime args (app: AppHandle, state: tauri::State<...>,
 *     window: Window). Channel<T> passes through as a user-visible arg —
 *     Tauri serialises it into a magic handle.
 *   - Commands whose return type can't be resolved (generics, opaque types)
 *     are emitted with `unknown` and listed in the UNRESOLVED_COMMANDS
 *     footer comment so reviewers can audit drift.
 *   - Tauri v2 IPC keeps arg names as-is (snake_case), so no case conversion.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(HERE);
const RUST_ROOT = join(REPO_ROOT, 'src-tauri', 'src');
const LIB_RS = join(RUST_ROOT, 'lib.rs');
const OUT_FILE = join(REPO_ROOT, 'src', 'types', 'commands.generated.ts');
const BINDINGS_DIR = join(REPO_ROOT, 'src', 'bindings');

type CommandSig = {
  name: string;
  file: string;
  args: Array<{ name: string; rustType: string }>;
  returnRust: string | null;
};

// ---------------------------------------------------------------------------
// 1. Load the handler registration list
// ---------------------------------------------------------------------------

function loadRegisteredCommands(): Array<{ module: string; name: string }> {
  const src = readFileSync(LIB_RS, 'utf8');
  const match = src.match(/generate_handler!\s*\[([\s\S]*?)\]/);
  if (!match) throw new Error('could not locate generate_handler! in lib.rs');
  const body = match[1];
  const stripped = body.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  const tokens = stripped.split(/[\s,]+/).map(t => t.trim()).filter(Boolean);
  const seen = new Set<string>();
  const out: Array<{ module: string; name: string }> = [];
  for (const t of tokens) {
    if (!/^[\w:]+$/.test(t)) continue;
    const parts = t.split('::');
    const name = parts[parts.length - 1];
    const module = parts.slice(0, -1).join('::') || 'commands';
    const key = `${module}::${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ module, name });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. Walk rust sources, extract #[tauri::command] signatures
// ---------------------------------------------------------------------------

function walkRust(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) walkRust(full, acc);
    else if (entry.endsWith('.rs')) acc.push(full);
  }
  return acc;
}

function parseFnHeader(src: string, fnStart: number): { name: string; argList: string; ret: string | null; end: number } | null {
  const headerMatch = src.slice(fnStart).match(/\bfn\s+(\w+)\s*\(/);
  if (!headerMatch) return null;
  const fnNameOffset = fnStart + headerMatch.index!;
  const name = headerMatch[1];
  const openParen = fnNameOffset + headerMatch[0].length - 1;
  let depth = 1;
  let i = openParen + 1;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    i++;
  }
  if (depth !== 0) return null;
  const argList = src.slice(openParen + 1, i - 1);
  let j = i;
  let ret: string | null = null;
  while (j < src.length && src[j] !== '{' && src[j] !== ';') j++;
  const tail = src.slice(i, j);
  const arrow = tail.indexOf('->');
  if (arrow !== -1) {
    ret = tail.slice(arrow + 2).trim().replace(/\s+/g, ' ');
    ret = ret.replace(/\s+where\s[\s\S]*$/, '').trim();
  }
  return { name, argList, ret, end: j };
}

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = '';
  for (const c of s) {
    if (c === '<' || c === '(' || c === '[' || c === '{') depth++;
    else if (c === '>' || c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
    } else {
      buf += c;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function parseArg(raw: string): { name: string; rustType: string } | null {
  let s = raw.replace(/#\[[^\]]+\]\s*/g, '').trim();
  if (s === 'self' || s.startsWith('&self') || s.startsWith('&mut self')) return null;
  s = s.replace(/^mut\s+/, '');
  const colon = s.indexOf(':');
  if (colon === -1) return null;
  const name = s.slice(0, colon).trim();
  const rustType = s.slice(colon + 1).trim();
  return { name, rustType };
}

function isTauriRuntimeArg(rustType: string): boolean {
  return /^\s*(?:tauri::)?AppHandle\b/.test(rustType)
    || /^\s*(?:tauri::)?Window\b/.test(rustType)
    || /^\s*(?:tauri::)?WebviewWindow\b/.test(rustType)
    || /^\s*(?:tauri::)?State<\s*'\w+\s*,/.test(rustType)
    || /^\s*tauri::State</.test(rustType);
}

function collectCommandSigs(): Map<string, CommandSig> {
  const files = walkRust(RUST_ROOT);
  const out = new Map<string, CommandSig>();
  const attrRE = /^[ \t]*#\[tauri::command(?:\([^)]*\))?\]/gm;
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    let m: RegExpExecArray | null;
    while ((m = attrRE.exec(src)) !== null) {
      const after = m.index + m[0].length;
      const header = parseFnHeader(src, after);
      if (!header) continue;
      const rawArgs = splitTopLevel(header.argList);
      const parsed = rawArgs
        .map(parseArg)
        .filter((a): a is { name: string; rustType: string } => a !== null)
        .filter(a => !isTauriRuntimeArg(a.rustType));
      out.set(header.name, {
        name: header.name,
        file,
        args: parsed,
        returnRust: header.ret,
      });
    }
    // Expand the page_state_cmds! macro — the 12 page-state commands are
    // generated from repeated invocations of a macro_rules! block, which
    // the static parser above can't see into. Each call is:
    //   page_state_cmds!(<getter>, <setter>, <field>, <ty>);
    // where <getter> takes no args and returns Result<$ty, String>, and
    // <setter> takes `snapshot: $ty` and returns Result<(), String>.
    const macroRE = /page_state_cmds!\s*\(\s*(\w+)\s*,\s*(\w+)\s*,\s*\w+\s*,\s*(\w+)\s*\)/g;
    let mm: RegExpExecArray | null;
    while ((mm = macroRE.exec(src)) !== null) {
      const [, getter, setter, tyName] = mm;
      out.set(getter, {
        name: getter,
        file,
        args: [],
        returnRust: `Result<${tyName}, String>`,
      });
      out.set(setter, {
        name: setter,
        file,
        args: [{ name: 'snapshot', rustType: tyName }],
        returnRust: `Result<(), String>`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. Rust -> TS type mapping
// ---------------------------------------------------------------------------

const PRIMITIVE_NUMBER = new Set([
  'u8', 'u16', 'u32', 'u64', 'u128', 'usize',
  'i8', 'i16', 'i32', 'i64', 'i128', 'isize',
  'f32', 'f64',
]);

type MapResult = {
  ts: string;
  imports: Set<string>;
  unresolved: boolean;
};

function listBindings(): Set<string> {
  try {
    return new Set(
      readdirSync(BINDINGS_DIR)
        .filter(f => f.endsWith('.ts'))
        .map(f => basename(f, '.ts')),
    );
  } catch {
    return new Set();
  }
}

const KNOWN_BINDINGS = listBindings();

function mapRust(rustRaw: string): MapResult {
  const imports = new Set<string>();
  const rust = rustRaw.trim();
  const stripped = rust.replace(/^&(?:'\w+\s+)?(?:mut\s+)?/, '').trim();

  if (stripped === '()' || stripped === '') {
    return { ts: 'void', imports, unresolved: false };
  }

  if (stripped === 'bool') return { ts: 'boolean', imports, unresolved: false };
  if (stripped === 'String' || stripped === 'str' || stripped === '&str') return { ts: 'string', imports, unresolved: false };
  if (stripped === 'char') return { ts: 'string', imports, unresolved: false };
  if (PRIMITIVE_NUMBER.has(stripped)) return { ts: 'number', imports, unresolved: false };

  const gen = stripped.match(/^([\w:]+)\s*<([\s\S]+)>$/);
  if (gen) {
    const outer = gen[1].split('::').pop()!;
    const inner = gen[2];
    const params = splitTopLevel(inner);
    if (outer === 'Option' && params.length === 1) {
      const r = mapRust(params[0]);
      r.imports.forEach(x => imports.add(x));
      return { ts: `${r.ts} | null`, imports, unresolved: r.unresolved };
    }
    if ((outer === 'Vec' || outer === 'VecDeque') && params.length === 1) {
      const r = mapRust(params[0]);
      r.imports.forEach(x => imports.add(x));
      return { ts: `Array<${r.ts}>`, imports, unresolved: r.unresolved };
    }
    if (outer === 'Result' && params.length === 2) {
      const r = mapRust(params[0]);
      r.imports.forEach(x => imports.add(x));
      return { ts: r.ts, imports, unresolved: r.unresolved };
    }
    if ((outer === 'HashMap' || outer === 'BTreeMap') && params.length === 2) {
      const k = mapRust(params[0]);
      const v = mapRust(params[1]);
      k.imports.forEach(x => imports.add(x));
      v.imports.forEach(x => imports.add(x));
      return {
        ts: `Record<${k.ts === 'number' ? 'number' : 'string'}, ${v.ts}>`,
        imports,
        unresolved: k.unresolved || v.unresolved,
      };
    }
    if (outer === 'Box' || outer === 'Arc' || outer === 'Rc' || outer === 'Cow') {
      const r = mapRust(params[0]);
      r.imports.forEach(x => imports.add(x));
      return r;
    }
    if (outer === 'Channel' && params.length === 1) {
      const r = mapRust(params[0]);
      r.imports.forEach(x => imports.add(x));
      imports.add('__channel');
      return { ts: `Channel<${r.ts}>`, imports, unresolved: r.unresolved };
    }
  }

  if (stripped === 'serde_json::Value' || stripped === 'Value' || stripped === 'JsonValue') {
    return { ts: 'unknown', imports, unresolved: false };
  }

  const idMatch = stripped.match(/^[\w:]+$/);
  if (idMatch) {
    const tail = stripped.split('::').pop()!;
    if (KNOWN_BINDINGS.has(tail)) {
      imports.add(tail);
      return { ts: tail, imports, unresolved: false };
    }
    return { ts: `unknown /* ${tail} */`, imports, unresolved: true };
  }

  return { ts: `unknown /* ${stripped} */`, imports, unresolved: true };
}

// ---------------------------------------------------------------------------
// 4. Emit
// ---------------------------------------------------------------------------

function quoteKey(k: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k);
}

function pascalCase(name: string): string {
  return name.split('_').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

function emit(registered: Array<{ module: string; name: string }>, sigs: Map<string, CommandSig>): string {
  const lines: string[] = [];
  const imports = new Set<string>();
  let wantChannel = false;

  const sorted = [...registered].sort((a, b) => a.name.localeCompare(b.name));

  const perCommand: Array<{ name: string; argsBlock: string; ret: string; unresolved: string[] }> = [];
  const unresolvedAll: string[] = [];
  let countTyped = 0;

  for (const reg of sorted) {
    const sig = sigs.get(reg.name);
    if (!sig) {
      perCommand.push({
        name: reg.name,
        argsBlock: '{}',
        ret: 'unknown',
        unresolved: [`${reg.name}: signature not found in rust sources`],
      });
      unresolvedAll.push(reg.name);
      continue;
    }
    const unresolvedHere: string[] = [];
    const argFields: string[] = [];
    for (const a of sig.args) {
      const mapped = mapRust(a.rustType);
      mapped.imports.forEach(x => {
        if (x === '__channel') { wantChannel = true; }
        else imports.add(x);
      });
      if (mapped.unresolved) unresolvedHere.push(`arg ${a.name}: ${a.rustType}`);
      argFields.push(`  ${quoteKey(a.name)}: ${mapped.ts};`);
    }
    const argsBlock = argFields.length ? `{\n${argFields.join('\n')}\n}` : '{}';

    const retMap = sig.returnRust ? mapRust(sig.returnRust) : { ts: 'void', imports: new Set<string>(), unresolved: false };
    retMap.imports.forEach(x => {
      if (x === '__channel') { wantChannel = true; }
      else imports.add(x);
    });
    if (retMap.unresolved) unresolvedHere.push(`return: ${sig.returnRust ?? '()'}`);

    perCommand.push({
      name: reg.name,
      argsBlock,
      ret: retMap.ts,
      unresolved: unresolvedHere,
    });
    if (unresolvedHere.length === 0) countTyped++;
    else unresolvedAll.push(`${reg.name} - ${unresolvedHere.join('; ')}`);
  }

  lines.push('/* eslint-disable */');
  lines.push('// ---------------------------------------------------------------------------');
  lines.push('// DO NOT EDIT - generated by scripts/gen-types.ts');
  lines.push('// Run `pnpm gen:types` after changing any #[tauri::command] signature.');
  lines.push(`// Commands registered: ${sorted.length}`);
  lines.push(`// Fully typed: ${countTyped}`);
  lines.push(`// Unresolved (opaque / missing ts-rs export): ${sorted.length - countTyped}`);
  lines.push('// ---------------------------------------------------------------------------');
  lines.push('');
  lines.push("import { invoke as __rawInvoke } from '@tauri-apps/api/core';");
  if (wantChannel) {
    lines.push("import { Channel } from '@tauri-apps/api/core';");
  }
  const sortedImports = [...imports].sort();
  for (const name of sortedImports) {
    lines.push(`import type { ${name} } from '../bindings/${name}';`);
  }
  if (wantChannel) {
    lines.push('');
    lines.push('export { Channel };');
  }
  lines.push('');
  lines.push('// ---- Per-command arg + return types --------------------------------------');
  lines.push('');

  for (const c of perCommand) {
    const pascal = pascalCase(c.name);
    lines.push(`export type ${pascal}Args = ${c.argsBlock};`);
    lines.push(`export type ${pascal}Return = ${c.ret};`);
    lines.push('');
  }

  lines.push('// ---- Aggregate command map -----------------------------------------------');
  lines.push('');
  lines.push('export interface Commands {');
  for (const c of perCommand) {
    const pascal = pascalCase(c.name);
    lines.push(`  ${quoteKey(c.name)}: { args: ${pascal}Args; returns: ${pascal}Return };`);
  }
  lines.push('}');
  lines.push('');
  lines.push('export type CommandName = keyof Commands;');
  lines.push("export type CommandArgs<K extends CommandName> = Commands[K]['args'];");
  lines.push("export type CommandReturn<K extends CommandName> = Commands[K]['returns'];");
  lines.push('');
  lines.push('/**');
  lines.push(' * Typed wrapper over @tauri-apps/api/core#invoke. The command name is');
  lines.push(' * constrained to the registered set and args/returns are inferred from');
  lines.push(' * the generated Commands map.');
  lines.push(' */');
  lines.push('export function invokeCommand<K extends CommandName>(');
  lines.push('  cmd: K,');
  lines.push('  args?: CommandArgs<K>,');
  lines.push('): Promise<CommandReturn<K>> {');
  lines.push('  return __rawInvoke<CommandReturn<K>>(cmd as string, args as Record<string, unknown> | undefined);');
  lines.push('}');
  lines.push('');

  if (unresolvedAll.length) {
    lines.push('/*');
    lines.push(' * UNRESOLVED_COMMANDS - these signatures contain types the generator could');
    lines.push(' * not map. The frontend can still call them, but args/returns fall back to');
    lines.push(' * `unknown`. Close each gap by adding #[derive(TS)] #[ts(export)] to the');
    lines.push(' * Rust struct and running scripts/regen-bindings.sh.');
    lines.push(' *');
    for (const line of unresolvedAll) lines.push(` *   - ${line}`);
    lines.push(' */');
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const registered = loadRegisteredCommands();
  const sigs = collectCommandSigs();
  const output = emit(registered, sigs);
  writeFileSync(OUT_FILE, output);
  const missing = registered.filter(r => !sigs.has(r.name)).length;
  const fullyTyped = registered.filter(r => {
    const s = sigs.get(r.name);
    if (!s) return false;
    const argsOk = s.args.every(a => !mapRust(a.rustType).unresolved);
    const retOk = !s.returnRust || !mapRust(s.returnRust).unresolved;
    return argsOk && retOk;
  }).length;
  process.stdout.write(
    `gen-types: ${registered.length} registered, ${fullyTyped} fully typed, ${missing} missing signature -> ${OUT_FILE}\n`,
  );
}

main();
