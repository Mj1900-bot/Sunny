// ─────────────────────────────────────────────────────────────────
// VAULT — shared types (match src-tauri/src/vault.rs via Tauri bridge)
// ─────────────────────────────────────────────────────────────────

export type VaultKind = 'api_key' | 'password' | 'token' | 'ssh' | 'note';

/** Matches `vault::VaultItem` in src-tauri. Values are never sent over the bridge with the list. */
export type VaultItem = {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly service: string;
  readonly created_at: number;
  readonly last_used_at: number | null;
  readonly updated_at?: number | null;
  readonly reveal_count?: number;
};

export type KindFilter = VaultKind | 'all';

export type SortKey = 'recent' | 'used' | 'alpha' | 'oldest';

export type Toast = {
  readonly id: string;
  readonly text: string;
  readonly tone: 'info' | 'warn';
};

export type RevealState = Readonly<
  Record<string, { readonly value: string; readonly until: number }>
>;
