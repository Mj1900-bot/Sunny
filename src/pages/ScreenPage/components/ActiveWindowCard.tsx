import type { FocusedApp, WindowInfo } from '../types';
import { labelSmall, valueMono, actionBtn, ghostBtn, tinyBtn } from '../styles';
import { isTauri } from '../../../lib/tauri';

export type ActiveWindowCardProps = {
  focused: FocusedApp | null;
  title: string | null;
  windows: ReadonlyArray<WindowInfo>;
  onCaptureActive: () => void;
  onRefreshList: () => void;
  onActivateApp: (appName: string) => void;
  onCaptureApp: (appName: string) => void;
  busy: boolean;
};

export function ActiveWindowCard({
  focused, title, windows, onCaptureActive, onRefreshList, onActivateApp, onCaptureApp, busy,
}: ActiveWindowCardProps) {
  return (
    <div
      style={{
        border: '1px solid var(--line-soft)',
        background: 'rgba(6, 14, 22, 0.55)',
        minHeight: 280,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          padding: '8px 10px',
          borderBottom: '1px solid var(--line-soft)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--display)',
            fontSize: 10.5,
            letterSpacing: '0.22em',
            color: 'var(--cyan)',
            fontWeight: 700,
          }}
        >
          ACTIVE WINDOW
        </span>
        <span style={labelSmall}>{windows.length} OPEN</span>
      </div>

      {/* Focused app block */}
      <div style={{ padding: 10, display: 'grid', gridTemplateColumns: '70px 1fr', gap: '4px 12px' }}>
        <span style={labelSmall}>APP</span>
        <span style={{ ...valueMono, color: 'var(--cyan)', fontWeight: 600 }}>
          {focused?.name ?? '—'}
        </span>
        <span style={labelSmall}>BUNDLE</span>
        <span
          style={{ ...valueMono, color: 'var(--ink-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={focused?.bundle_id ?? ''}
        >
          {focused?.bundle_id ?? '—'}
        </span>
        <span style={labelSmall}>PID</span>
        <span style={valueMono}>{focused?.pid ?? '—'}</span>
        <span style={labelSmall}>TITLE</span>
        <span
          style={{ ...valueMono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={title ?? ''}
        >
          {title && title.length > 0 ? title : '—'}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 6, padding: '0 10px 10px' }}>
        <button onClick={onCaptureActive} disabled={busy || !isTauri} style={{ ...actionBtn, flex: 1 }}>
          CAPTURE WINDOW
        </button>
        <button onClick={onRefreshList} disabled={!isTauri} style={ghostBtn}>
          REFRESH LIST
        </button>
      </div>

      {/* Window list */}
      <div style={{ flex: 1, borderTop: '1px solid var(--line-soft)', overflow: 'auto', maxHeight: 240 }}>
        {windows.length === 0 ? (
          <div style={{ padding: 14, fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-dim)' }}>
            {isTauri
              ? 'No windows listed. System Events → Automation permission may be required.'
              : 'Requires Tauri runtime.'}
          </div>
        ) : (
          windows.slice(0, 60).map((w, i) => {
            const isFront = focused?.name === w.app_name;
            return (
              <div
                key={`${w.pid}-${i}`}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr auto',
                  gap: 10,
                  padding: '6px 10px',
                  borderBottom: '1px dashed rgba(57,229,255,0.08)',
                  background: isFront ? 'rgba(57,229,255,0.05)' : 'transparent',
                  alignItems: 'center',
                }}
              >
                <div style={{ overflow: 'hidden', minWidth: 0 }}>
                  <div
                    style={{
                      fontFamily: 'var(--mono)',
                      fontSize: 11,
                      color: isFront ? 'var(--cyan)' : 'var(--ink)',
                      fontWeight: isFront ? 700 : 500,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {w.app_name}
                  </div>
                  <div
                    style={{
                      fontFamily: 'var(--mono)',
                      fontSize: 10,
                      color: 'var(--ink-dim)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={w.title || '(untitled)'}
                  >
                    {w.title || '(untitled)'}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ ...labelSmall, fontSize: 9.5, minWidth: 64, textAlign: 'right' }}>
                    {w.w && w.h ? `${Math.round(w.w)}×${Math.round(w.h)}` : ''}
                  </span>
                  <button
                    onClick={() => onActivateApp(w.app_name)}
                    disabled={!isTauri}
                    style={tinyBtn}
                    title={`Focus ${w.app_name}`}
                  >
                    FOCUS
                  </button>
                  <button
                    onClick={() => onCaptureApp(w.app_name)}
                    disabled={busy || !isTauri}
                    style={{ ...tinyBtn, color: 'var(--green)', borderColor: 'rgba(125,255,154,0.4)' }}
                    title={`Activate ${w.app_name} and capture its front window`}
                  >
                    SHOT
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
