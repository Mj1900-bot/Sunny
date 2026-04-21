// ─────────────────────────────────────────────────────────────────
// NEW JOB — collapsible form
// ─────────────────────────────────────────────────────────────────

import { SectionHeader } from './SectionHeader';
import {
  ACTION_COLOR,
  KIND_COLOR,
  chipOutline,
  ghostBtn,
  inputStyle,
  labelStyle,
  primaryBtn,
} from './styles';
import type { Draft } from './types';

type NewJobSectionProps = {
  open: boolean;
  onToggle: () => void;
  draft: Draft;
  patch: <K extends keyof Draft>(key: K, value: Draft[K]) => void;
  valid: boolean;
  creating: boolean;
  createErr: string | null;
  onCreate: () => void;
  onReset: () => void;
};

export function NewJobSection({
  open,
  onToggle,
  draft,
  patch,
  valid,
  creating,
  createErr,
  onCreate,
  onReset,
}: NewJobSectionProps) {
  return (
    <div>
      <SectionHeader
        label="NEW JOB"
        right={
          <button
            type="button"
            onClick={onToggle}
            style={{ ...ghostBtn, fontSize: 10, padding: '4px 10px' }}
          >
            {open ? '− COLLAPSE' : '+ EXPAND'}
          </button>
        }
      />

      {open && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            padding: 14,
            border: '1px solid var(--line-soft)',
            background: 'rgba(57, 229, 255, 0.03)',
          }}
        >
          {/* Title — fix #1: htmlFor + id association */}
          <div>
            <label htmlFor="job-title" style={labelStyle}>TITLE</label>
            <input
              id="job-title"
              type="text"
              value={draft.title}
              onChange={e => patch('title', e.target.value)}
              placeholder="nightly backup"
              style={inputStyle}
            />
          </div>

          {/* Kind — fix #8: radiogroup + type="button" + aria-pressed */}
          <div>
            <div id="job-kind-label" style={labelStyle}>KIND</div>
            <div role="radiogroup" aria-labelledby="job-kind-label" style={{ display: 'flex', gap: 6 }}>
              {(['Once', 'Interval'] as const).map(k => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={draft.kind === k}
                  onClick={() => patch('kind', k)}
                  style={chipOutline(KIND_COLOR[k], draft.kind === k)}
                >
                  {k.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          {/* Time pickers — fix #1: htmlFor + id */}
          {draft.kind === 'Once' ? (
            <div>
              <label htmlFor="job-run-at" style={labelStyle}>RUN AT</label>
              <input
                id="job-run-at"
                type="datetime-local"
                value={draft.onceLocal}
                onChange={e => patch('onceLocal', e.target.value)}
                style={inputStyle}
              />
            </div>
          ) : (
            <div>
              <label htmlFor="job-interval-value" style={labelStyle}>EVERY</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  id="job-interval-value"
                  type="number"
                  min={1}
                  value={draft.intervalValue}
                  onChange={e => patch('intervalValue', e.target.value)}
                  style={{ ...inputStyle, width: 120 }}
                />
                {/* fix #8: radiogroup for interval unit */}
                <div
                  role="radiogroup"
                  aria-label="Interval unit"
                  style={{ display: 'flex', gap: 4 }}
                >
                  {(['s', 'm', 'h', 'd'] as const).map(u => (
                    <button
                      key={u}
                      type="button"
                      role="radio"
                      aria-checked={draft.intervalUnit === u}
                      onClick={() => patch('intervalUnit', u)}
                      style={chipOutline(
                        'var(--cyan)',
                        draft.intervalUnit === u,
                      )}
                    >
                      {u.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Action type — fix #8: radiogroup + type="button" + aria-checked */}
          <div>
            <div id="job-action-label" style={labelStyle}>ACTION</div>
            <div role="radiogroup" aria-labelledby="job-action-label" style={{ display: 'flex', gap: 6 }}>
              {(['Shell', 'Notify', 'Speak'] as const).map(a => (
                <button
                  key={a}
                  type="button"
                  role="radio"
                  aria-checked={draft.actionType === a}
                  onClick={() => patch('actionType', a)}
                  style={chipOutline(ACTION_COLOR[a], draft.actionType === a)}
                >
                  {a.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          {/* Per-action fields — fix #1: htmlFor + id on all inputs */}
          {draft.actionType === 'Shell' && (
            <div>
              <label htmlFor="job-shell-cmd" style={labelStyle}>SHELL COMMAND</label>
              <input
                id="job-shell-cmd"
                type="text"
                value={draft.shellCmd}
                onChange={e => patch('shellCmd', e.target.value)}
                placeholder='rsync -a ~/Documents ~/Backups/'
                style={{ ...inputStyle, fontSize: 12 }}
              />
            </div>
          )}

          {draft.actionType === 'Notify' && (
            <>
              <div>
                <label htmlFor="job-notify-title" style={labelStyle}>NOTIFY TITLE</label>
                <input
                  id="job-notify-title"
                  type="text"
                  value={draft.notifyTitle}
                  onChange={e => patch('notifyTitle', e.target.value)}
                  style={inputStyle}
                />
              </div>
              <div>
                <label htmlFor="job-notify-body" style={labelStyle}>NOTIFY BODY</label>
                <input
                  id="job-notify-body"
                  type="text"
                  value={draft.notifyBody}
                  onChange={e => patch('notifyBody', e.target.value)}
                  style={inputStyle}
                />
              </div>
            </>
          )}

          {draft.actionType === 'Speak' && (
            <>
              <div>
                <label htmlFor="job-speak-text" style={labelStyle}>SPEAK TEXT</label>
                <input
                  id="job-speak-text"
                  type="text"
                  value={draft.speakText}
                  onChange={e => patch('speakText', e.target.value)}
                  style={inputStyle}
                />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
                <div>
                  <label htmlFor="job-speak-voice" style={labelStyle}>VOICE (optional)</label>
                  <input
                    id="job-speak-voice"
                    type="text"
                    value={draft.speakVoice}
                    onChange={e => patch('speakVoice', e.target.value)}
                    placeholder="Daniel"
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label htmlFor="job-speak-rate" style={labelStyle}>RATE (optional)</label>
                  <input
                    id="job-speak-rate"
                    type="number"
                    value={draft.speakRate}
                    onChange={e => patch('speakRate', e.target.value)}
                    placeholder="180"
                    style={inputStyle}
                  />
                </div>
              </div>
            </>
          )}

          {/* fix #7: role="alert" so error is announced immediately */}
          {createErr !== null && (
            <div
              role="alert"
              aria-live="assertive"
              style={{
                color: 'var(--red)',
                fontFamily: 'var(--mono)',
                fontSize: 11,
                border: '1px solid var(--red)',
                padding: '6px 10px',
                background: 'rgba(255, 77, 94, 0.06)',
              }}
            >
              {createErr}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" onClick={onReset} style={ghostBtn}>
              RESET
            </button>
            <button
              type="button"
              onClick={onCreate}
              disabled={!valid || creating}
              aria-disabled={!valid || creating}
              style={{
                ...primaryBtn,
                cursor: !valid || creating ? 'not-allowed' : 'pointer',
                opacity: !valid || creating ? 0.4 : 1,
              }}
            >
              {creating ? 'CREATING…' : 'CREATE'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
