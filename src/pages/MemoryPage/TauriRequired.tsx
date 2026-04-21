import type { JSX } from 'react';
import { emptyStyle } from './styles';

// ---------------------------------------------------------------------------
// Fallback for non-Tauri preview (vite dev on the bare website, no backend)
// ---------------------------------------------------------------------------

export function TauriRequired(): JSX.Element {
  return (
    <div style={emptyStyle}>
      BACKEND REQUIRED · run this page inside the SUNNY desktop app to see memory contents
    </div>
  );
}
