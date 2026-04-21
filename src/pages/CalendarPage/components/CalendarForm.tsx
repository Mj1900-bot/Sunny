import type { FormEvent } from 'react';
import type { Tone } from '../types';
import { TONES } from '../constants';
import { calendarColor, toneColor } from '../utils';
import { navBtnStyle } from '../styles';

type Props = {
  draftDay: string;
  setDraftDay: (val: string) => void;
  draftTime: string;
  setDraftTime: (val: string) => void;
  draftDuration: string;
  setDraftDuration: (val: string) => void;
  draftTitle: string;
  setDraftTitle: (val: string) => void;
  draftSub: string;
  setDraftSub: (val: string) => void;
  draftTarget: string;
  setDraftTarget: (val: string) => void;
  draftTone: Tone;
  setDraftTone: (val: Tone) => void;
  calendars: ReadonlyArray<string>;
  onSave: (ev: FormEvent<HTMLFormElement>) => Promise<void>;
  onCancel: () => void;
};

export function CalendarForm({
  draftDay, setDraftDay, draftTime, setDraftTime,
  draftDuration, setDraftDuration, draftTitle, setDraftTitle,
  draftSub, setDraftSub, draftTarget, setDraftTarget,
  draftTone, setDraftTone, calendars, onSave, onCancel
}: Props) {
  return (
    <form onSubmit={onSave} style={{
      display: 'grid', gap: 8, marginBottom: 10,
      padding: 10, border: '1px solid var(--line-soft)',
      background: 'rgba(4, 10, 16, 0.45)',
    }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 80px', gap: 8 }}>
        <label style={{ display: 'grid', gap: 3 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-2)', letterSpacing: '0.15em' }}>DATE</span>
          <input type="text" value={draftDay} onChange={e => setDraftDay(e.target.value)} placeholder="YYYY-MM-DD" required />
        </label>
        <label style={{ display: 'grid', gap: 3 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-2)', letterSpacing: '0.15em' }}>TIME</span>
          <input type="text" value={draftTime} onChange={e => setDraftTime(e.target.value)} placeholder="14:30" required />
        </label>
        {draftTarget !== 'LOCAL' && (
          <label style={{ display: 'grid', gap: 3 }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-2)', letterSpacing: '0.15em' }}>DUR (min)</span>
            <input type="text" value={draftDuration} onChange={e => setDraftDuration(e.target.value)} placeholder="60" />
          </label>
        )}
      </div>
      <label style={{ display: 'grid', gap: 3 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-2)', letterSpacing: '0.15em' }}>TITLE</span>
        <input type="text" value={draftTitle} onChange={e => setDraftTitle(e.target.value)} placeholder="Meeting title" required />
      </label>
      <label style={{ display: 'grid', gap: 3 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-2)', letterSpacing: '0.15em' }}>
          {draftTarget === 'LOCAL' ? 'SUB' : 'LOCATION'}
        </span>
        <input
          type="text"
          value={draftSub}
          onChange={e => setDraftSub(e.target.value)}
          placeholder={draftTarget === 'LOCAL' ? 'Location · duration' : 'Conference room A'}
        />
      </label>

      <div style={{ display: 'grid', gap: 3 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-2)', letterSpacing: '0.15em' }}>TARGET</span>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => setDraftTarget('LOCAL')}
            style={{
              ...navBtnStyle, padding: '4px 8px',
              borderColor: draftTarget === 'LOCAL' ? 'var(--cyan)' : 'var(--line-soft)',
              background: draftTarget === 'LOCAL' ? 'rgba(57, 229, 255, 0.1)' : 'transparent',
              color: draftTarget === 'LOCAL' ? 'var(--cyan)' : 'var(--ink-2)',
            }}
          >
            LOCAL
          </button>
          {calendars.map(name => {
            const active = draftTarget === name;
            const color = calendarColor(name);
            return (
              <button
                key={name}
                type="button"
                onClick={() => setDraftTarget(name)}
                style={{
                  ...navBtnStyle, padding: '4px 8px',
                  borderColor: active ? color : 'var(--line-soft)',
                  background: active ? 'rgba(57, 229, 255, 0.08)' : 'transparent',
                  color: active ? color : 'var(--ink-2)',
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                }}
              >
                <span style={{ width: 6, height: 6, borderRadius: 1, background: color }} />
                {name.toUpperCase()}
              </button>
            );
          })}
        </div>
      </div>

      {draftTarget === 'LOCAL' && (
        <div style={{ display: 'grid', gap: 3 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-2)', letterSpacing: '0.15em' }}>TONE</span>
          <div style={{ display: 'flex', gap: 4 }}>
            {TONES.map(t => {
              const active = draftTone === t;
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => setDraftTone(t)}
                  style={{
                    ...navBtnStyle, flex: 1, padding: '4px 6px',
                    borderColor: active ? toneColor(t) : 'var(--line-soft)',
                    background: active ? 'rgba(57, 229, 255, 0.08)' : 'transparent',
                    color: active ? toneColor(t) : 'var(--ink-2)',
                    textTransform: 'uppercase',
                  }}
                >
                  {t}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" className="primary" style={{ flex: 1 }}>SAVE</button>
        <button type="button" onClick={onCancel} style={{ ...navBtnStyle, flex: 1, padding: '6px 8px' }}>CANCEL</button>
      </div>
    </form>
  );
}
