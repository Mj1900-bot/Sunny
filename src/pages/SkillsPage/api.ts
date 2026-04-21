import { invokeSafe } from '../../lib/tauri';

export type ProceduralSkill = {
  id: string;
  name: string;
  description: string;
  trigger_text: string;
  skill_path: string;
  uses_count: number;
  success_count: number;
  last_used_at: number | null;
  /** Synthesized recipe (if any) — typed as `unknown` because the canonical
   *  shape lives in `skillExecutor.SkillRecipe` and is validated at runtime
   *  by `validateRecipe`. Keeping it loose here avoids cross-importing the
   *  executor types into the page-level API layer. */
  recipe?: unknown;
  /** Sprint-12 η — hex-encoded ed25519 signature over the canonical manifest
   *  {name, description, trigger_text, recipe}. `null` means the row is
   *  unsigned (legacy rows, test fixtures, or synthesized skills that
   *  bypass the editor). */
  signature?: string | null;
  /** 16-char SHA-256-truncated fingerprint of the signer's public key.
   *  Pairs with `signature` — both are `null` or both are set. */
  signer_fingerprint?: string | null;
};

export async function listSkills(): Promise<ReadonlyArray<ProceduralSkill>> {
  return (await invokeSafe<ProceduralSkill[]>('memory_skill_list')) ?? [];
}

export async function deleteSkill(id: string): Promise<void> {
  await invokeSafe('memory_skill_delete', { id });
}

export async function updateSkill(
  id: string,
  patch: Partial<Pick<ProceduralSkill, 'name' | 'description' | 'trigger_text' | 'skill_path'>>,
): Promise<void> {
  await invokeSafe('memory_skill_update', {
    id,
    name: patch.name ?? null,
    description: patch.description ?? null,
    triggerText: patch.trigger_text ?? null,
    skillPath: patch.skill_path ?? null,
  });
}
