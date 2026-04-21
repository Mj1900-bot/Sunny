// Skill registry for SUNNY — lets users extend the agent with drop-in tool packs.
//
// A "skill" is a bundle of tools sharing a common manifest (id, name, version,
// author). Skills live under `src/skills/*.ts`; at boot we eager-import every
// module matching that glob and register anything that `export default`s a
// SkillManifest. The file itself may also call `registerSkill(...)` directly
// as a side-effect; both styles work.
//
// Tools inside a skill are forwarded to the global `registerTool` function in
// `./tools` — the agent loop's registry is the single source of truth for
// execution. Skills are only a grouping & metadata concept on top of it.

import { registerTool, type Tool } from './tools';

export type SkillManifest = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly author?: string;
  readonly tools: ReadonlyArray<Tool>;
};

// ---------------------------------------------------------------------------
// Private registry — mutable Map, exposed through immutable-typed accessors.
// ---------------------------------------------------------------------------

const skillRegistry = new Map<string, SkillManifest>();
const warnedDuplicates = new Set<string>();

/** Register a skill manifest. Its tools are added to the global tool registry.
 *  Duplicate skill IDs are ignored (first write wins, warn once per id). */
export function registerSkill(skill: SkillManifest): void {
  if (!skill?.id || typeof skill.id !== 'string') {
    throw new Error('registerSkill: skill.id is required');
  }
  if (!Array.isArray(skill.tools)) {
    throw new Error(`registerSkill: skill "${skill.id}" tools must be an array`);
  }

  if (skillRegistry.has(skill.id)) {
    if (!warnedDuplicates.has(skill.id)) {
      warnedDuplicates.add(skill.id);
      console.warn(`registerSkill: duplicate skill id "${skill.id}" — ignoring second registration`);
    }
    return;
  }

  skillRegistry.set(skill.id, skill);
  for (const tool of skill.tools) {
    try {
      registerTool(tool);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`registerSkill[${skill.id}]: failed to register tool: ${msg}`);
    }
  }
}

/** Return a snapshot of all registered skills — safe for UI rendering. */
export function listSkills(): ReadonlyArray<SkillManifest> {
  return Array.from(skillRegistry.values());
}

// ---------------------------------------------------------------------------
// Boot-time loader. Uses Vite's `import.meta.glob` with `eager: true` so every
// skill file is bundled synchronously at build time — no dynamic fetch needed.
// ---------------------------------------------------------------------------

type SkillModule = {
  readonly default?: unknown;
};

function isManifest(value: unknown): value is SkillManifest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.description === 'string' &&
    typeof candidate.version === 'string' &&
    Array.isArray(candidate.tools)
  );
}

/** Load all built-in skills (eager-imports every file matching src/skills/*.ts).
 *  Returns the number of manifests newly registered by this call. */
export async function loadBuiltinSkills(): Promise<number> {
  const modules = import.meta.glob<SkillModule>('../skills/*.ts', { eager: true });
  const before = skillRegistry.size;

  for (const [path, mod] of Object.entries(modules)) {
    try {
      const exported = mod?.default;
      if (isManifest(exported)) {
        registerSkill(exported);
      }
      // Files that call `registerSkill(...)` as a side-effect have already run
      // by the time we get here — `eager: true` evaluates them on import.
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`loadBuiltinSkills: ${path} failed — ${msg}`);
    }
  }

  return skillRegistry.size - before;
}
