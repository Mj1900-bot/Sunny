import { invokeSafe } from '../../lib/tauri';
import type { WorldState } from './types';

/** Pull the current world snapshot. Returns null outside Tauri. */
export async function loadWorld(): Promise<WorldState | null> {
  return invokeSafe<WorldState>('world_get');
}
