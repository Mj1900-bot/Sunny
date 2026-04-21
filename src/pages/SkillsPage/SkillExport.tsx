/**
 * Sprint-13 η — Share-a-skill modal.
 *
 * Renders a two-button destination picker (clipboard or native save
 * dialog) with a live preview of the export JSON.  Pure presentational;
 * all bundle-building happens in `lib/skillExport.ts` and all Tauri
 * side-effects are injected as async callbacks so the component is
 * trivially unit-testable.
 *
 * Accessibility note (sprint-12 ι carry-over): the dialog is rendered
 * as `role="dialog"` with an explicit `aria-labelledby`; ESC is bound
 * to `onClose` by the parent (`SkillsPage`'s global handler) for
 * consistency with the IMPORT / EDIT flows.
 */

import { useMemo, useState, type CSSProperties } from 'react';
import { Toolbar, ToolbarButton, Section } from '../_shared';
import {
  serializeBundle,
  shortFingerprint,
  suggestedFilename,
  type SkillBundle,
} from '../../lib/skillExport';

type Destination = 'clipboard' | 'file';

export function SkillExport({
  bundle,
  onCopy,
  onSaveFile,
  onClose,
}: {
  readonly bundle: SkillBundle;
  /** Write the serialised JSON to the clipboard.  Return `true` on success. */
  readonly onCopy: (json: string) => Promise<boolean>;
  /** Invoke a native save-dialog and write the file. Returns the final
   *  path chosen by the user, or `null` if they cancelled. */
  readonly onSaveFile: (json: string, suggestedName: string) => Promise<string | null>;
  readonly onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<
    | { readonly kind: 'idle' }
    | { readonly kind: 'ok'; readonly destination: Destination; readonly detail: string }
    | { readonly kind: 'error'; readonly reason: string }
  >({ kind: 'idle' });

  const json = useMemo(() => serializeBundle(bundle), [bundle]);
  const fpShort = shortFingerprint(bundle.signer_fingerprint);
  const filename = suggestedFilename(bundle);

  const copyNow = async () => {
    setBusy(true);
    setStatus({ kind: 'idle' });
    try {
      const ok = await onCopy(json);
      if (ok) {
        setStatus({
          kind: 'ok',
          destination: 'clipboard',
          detail: `copied · fingerprint [${fpShort}]`,
        });
      } else {
        setStatus({ kind: 'error', reason: 'Clipboard write failed.' });
      }
    } catch (e) {
      setStatus({ kind: 'error', reason: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const saveNow = async () => {
    setBusy(true);
    setStatus({ kind: 'idle' });
    try {
      const path = await onSaveFile(json, filename);
      if (path) {
        setStatus({
          kind: 'ok',
          destination: 'file',
          detail: `saved · ${path} · fingerprint [${fpShort}]`,
        });
      } else {
        setStatus({ kind: 'idle' });
      }
    } catch (e) {
      setStatus({ kind: 'error', reason: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="skill-share-title"
      style={overlayStyle}
      onClick={e => {
        // Click outside the panel closes; click inside should not bubble.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div style={panelStyle} id="skill-share-title" aria-label="Share skill">
        <Section title="SHARE SKILL" right={`FP ${fpShort}`}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={metaLineStyle}>
              <strong style={{ color: 'var(--ink)' }}>{bundle.manifest.name}</strong>
              <span style={{ color: 'var(--ink-dim)' }}>·</span>
              <span>schema: {bundle.schema}</span>
              <span style={{ color: 'var(--ink-dim)' }}>·</span>
              <span>{json.length.toLocaleString()} bytes</span>
            </div>

            <pre style={previewStyle} aria-label="Export JSON preview">
              {json}
            </pre>

            <Toolbar>
              <ToolbarButton
                tone="cyan"
                onClick={() => void copyNow()}
                disabled={busy}
                title="Copy the signed bundle to the clipboard"
              >
                COPY TO CLIPBOARD
              </ToolbarButton>
              <ToolbarButton
                tone="teal"
                onClick={() => void saveNow()}
                disabled={busy}
                title="Save the signed bundle to a .json file"
              >
                SAVE TO FILE
              </ToolbarButton>
              <span style={{ flex: 1 }} />
              <ToolbarButton onClick={onClose} disabled={busy}>
                CLOSE · ESC
              </ToolbarButton>
            </Toolbar>

            {status.kind === 'ok' && (
              <div role="status" style={okStyle}>
                {status.destination === 'clipboard' ? 'CLIPBOARD' : 'FILE'} · {status.detail}
              </div>
            )}

            {status.kind === 'error' && (
              <div role="alert" style={errorStyle}>
                {status.reason}
              </div>
            )}
          </div>
        </Section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles — kept inline so the modal is self-contained; no CSS module
// round-trip needed.
// ---------------------------------------------------------------------------

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.55)',
  backdropFilter: 'blur(3px)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 60,
  padding: 24,
};

const panelStyle: CSSProperties = {
  width: 'min(720px, 100%)',
  maxHeight: '80vh',
  overflow: 'auto',
  padding: 16,
  border: '1px solid var(--line)',
  background: 'rgba(6, 14, 22, 0.96)',
  boxShadow: '0 0 30px rgba(57, 229, 255, 0.12)',
};

const metaLineStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--ink-2)',
  letterSpacing: '0.04em',
};

const previewStyle: CSSProperties = {
  margin: 0,
  padding: 10,
  maxHeight: 260,
  overflow: 'auto',
  fontFamily: 'var(--mono)',
  fontSize: 10,
  lineHeight: 1.45,
  color: 'var(--ink-2)',
  border: '1px solid var(--line-soft)',
  background: 'rgba(0, 0, 0, 0.35)',
  whiteSpace: 'pre',
};

const okStyle: CSSProperties = {
  padding: '8px 12px',
  border: '1px solid var(--teal)',
  borderLeft: '2px solid var(--teal)',
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--ink-2)',
  background: 'rgba(0, 210, 180, 0.06)',
};

const errorStyle: CSSProperties = {
  padding: '8px 12px',
  border: '1px solid var(--red)',
  borderLeft: '2px solid var(--red)',
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--red)',
  background: 'rgba(255, 77, 94, 0.06)',
};
