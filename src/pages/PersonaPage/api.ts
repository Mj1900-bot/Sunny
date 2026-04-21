import { invokeSafe } from '../../lib/tauri';

export type Identity = {
  name: string;
  voice: string;
  operator: string;
};

export type Prohibition = {
  description: string;
  tools: ReadonlyArray<string>;
  after_local_hour: number | null;
  before_local_hour: number | null;
  match_input_contains: ReadonlyArray<string>;
};

export type Constitution = {
  schema_version: number;
  identity: Identity;
  values: ReadonlyArray<string>;
  prohibitions: ReadonlyArray<Prohibition>;
};

export async function loadConstitution(): Promise<Constitution | null> {
  return invokeSafe<Constitution>('constitution_get');
}

export async function saveConstitution(value: Constitution): Promise<void> {
  await invokeSafe('constitution_save', { value });
}
