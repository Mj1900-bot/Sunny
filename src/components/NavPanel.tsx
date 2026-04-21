/**
 * Side navigation.
 *
 * Grouped into sections (CORE / LIFE / COMMS / KNOW / DO / AI·SYS) so we
 * can scale past a couple dozen modules without turning the rail into a
 * wall of identical rows. Module rows stay compact; section headers are
 * taller, tinted bands so categories stand out, with space between groups.
 * The list still fits the 528px dock-open panel with light scrolling, and
 * the entire roster in dock-closed mode (824px).
 *
 * The header of the whole panel carries a compact live security status
 * strip (always-visible traffic-light + panic button) and a module
 * filter affordance. Section headers still render inline above each
 * group, but the old jump-to-section chips have been removed in favour
 * of the security strip — navigation is just scroll + filter now.
 */

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { NAV_MODULES, type NavSection, type NavModule } from '../data/seeds';
import { NavIcon } from './NavIcons';
import { Panel } from './Panel';
import { SecurityLiveStrip } from './SecurityLiveStrip';
import { useView, type ViewKey } from '../store/view';
import { isTauri } from '../lib/tauri';

// Keep label → view-key mapping here so the seeds file stays pure data.
const LABEL_TO_VIEW: Record<string, ViewKey> = {
  OVERVIEW: 'overview', SECURITY: 'security', TODAY: 'today', TIMELINE: 'timeline',
  TASKS: 'tasks', JOURNAL: 'journal', FOCUS: 'focus', CALENDAR: 'calendar',
  INBOX: 'inbox', PEOPLE: 'people', CONTACTS: 'contacts', VOICE: 'voice', NOTIFY: 'notify',
  NOTES: 'notes', READING: 'reading', MEMORY: 'memory', PHOTOS: 'photos', FILES: 'files',
  AUTO: 'auto', SKILLS: 'skills', APPS: 'apps', WEB: 'web', CODE: 'code',
  CONSOLE: 'console', SCREEN: 'screen', SCAN: 'scan',
  WORLD: 'world', SOCIETY: 'society', BRAIN: 'brain', PERSONA: 'persona',
  INSPECTOR: 'inspector', AUDIT: 'audit', DEVICES: 'devices', DIAGNOSTICS: 'diagnostics', VAULT: 'vault',
  SETTINGS: 'settings',
};

function sectionForView(v: ViewKey): NavSection | null {
  for (const m of NAV_MODULES) {
    if (LABEL_TO_VIEW[m.label] === v) return m.section;
  }
  return null;
}

// Only items whose backend depends on macOS permissions turn amber when Tauri
// is unavailable (vite preview). Everything else is green — they render fine
// with local stores / fallback data.
const TAURI_DEPENDENT: ReadonlySet<string> = new Set([
  'FILES', 'APPS', 'CONTACTS', 'SCREEN', 'CALENDAR',
  'INBOX', 'PEOPLE', 'VOICE', 'NOTIFY', 'NOTES', 'PHOTOS',
  'CODE', 'CONSOLE', 'INSPECTOR', 'DEVICES', 'DIAGNOSTICS',
]);

const SECTION_ORDER: ReadonlyArray<NavSection> = ['CORE', 'LIFE', 'COMMS', 'KNOW', 'DO', 'AI·SYS'];

const SECTION_TONE: Record<NavSection, string> = {
  CORE:     'var(--cyan)',
  LIFE:     'var(--gold)',
  COMMS:    'var(--pink)',
  KNOW:     'var(--violet)',
  DO:       'var(--amber)',
  'AI·SYS': 'var(--green)',
};

// ---------------------------------------------------------------------------
// Styling (inline — keeps the panel self-contained and colocated with its
// markup for fast iteration).
// ---------------------------------------------------------------------------

const sectionHeaderBase: CSSProperties = {
  fontFamily: 'var(--display)',
  fontSize: 11,
  letterSpacing: '0.22em',
  fontWeight: 800,
  padding: '9px 6px 8px',
  minHeight: 34,
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  textTransform: 'uppercase',
};

/** Section rail marker — larger than per-row ticks so groups read as bands. */
const sectionTickStyle = (tone: string): CSSProperties => ({
  width: 7,
  height: 7,
  flexShrink: 0,
  borderRadius: 1,
  background: tone,
  boxShadow: `0 0 10px ${tone}`,
});

const rowStyle = (active: boolean, tone: string): CSSProperties => ({
  all: 'unset',
  cursor: 'pointer',
  display: 'flex', alignItems: 'center', gap: 6,
  padding: '1px 7px 1px 8px',
  minHeight: 19,
  position: 'relative',
  fontFamily: 'var(--display)',
  fontSize: 10,
  letterSpacing: '0.12em',
  fontWeight: 600,
  color: active ? '#fff' : 'var(--cyan)',
  background: active
    ? `linear-gradient(90deg, ${tone}55, transparent 80%)`
    : 'linear-gradient(90deg, rgba(57, 229, 255, 0.04), transparent)',
  borderLeft: active ? `2px solid ${tone}` : '2px solid transparent',
  boxShadow: active ? `inset 0 0 18px ${tone}22` : 'none',
  transition: 'background 140ms ease, color 140ms ease, border-color 140ms ease',
});

const filterInputStyle: CSSProperties = {
  all: 'unset',
  display: 'block',
  width: '100%',
  padding: '4px 8px',
  fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.06em',
  color: 'var(--ink)',
  background: 'rgba(0, 0, 0, 0.3)',
  border: '1px solid var(--line-soft)',
  boxSizing: 'border-box',
};

// ---------------------------------------------------------------------------

export function NavPanel() {
  const view = useView(s => s.view);
  const setView = useView(s => s.setView);
  const dockHidden = useView(s => s.dockHidden);
  const [query, setQuery] = useState('');
  const [openSections, setOpenSections] = useState<Record<NavSection, boolean>>(() => {
    const init = {} as Record<NavSection, boolean>;
    for (const s of SECTION_ORDER) init[s] = true;
    return init;
  });

  useEffect(() => {
    const sec = sectionForView(view);
    if (sec) setOpenSections(prev => ({ ...prev, [sec]: true }));
  }, [view]);

  // Group modules by their seed section. This preserves list order within
  // each section, so authors can still order features by importance.
  const grouped = useMemo(() => {
    const q = query.trim().toUpperCase();
    const filter = (m: NavModule) => q.length === 0 || m.label.includes(q);
    const out: Record<NavSection, Array<NavModule>> = {
      CORE: [], LIFE: [], COMMS: [], KNOW: [], DO: [], 'AI·SYS': [],
    };
    for (const m of NAV_MODULES) {
      if (filter(m)) out[m.section].push(m);
    }
    return out;
  }, [query]);

  const totalMatches = Object.values(grouped).reduce((n, arr) => n + arr.length, 0);

  return (
    <Panel
      id="p-nav"
      title="MODULES"
      right={totalMatches !== NAV_MODULES.length ? `${totalMatches}/${NAV_MODULES.length}` : String(NAV_MODULES.length)}
      bodyPad={0}
    >
      {/* Sticky header: live security strip + filter.  The strip replaces
          the old section-jump chips with an always-visible intrusion /
          permissions / egress / host monitor + panic button. */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 2,
        background: 'var(--panel-2)',
        borderBottom: '1px solid var(--line-soft)',
        padding: '6px 8px 4px',
        display: 'flex', flexDirection: 'column', gap: 5,
      }}>
        <SecurityLiveStrip />
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="filter…"
          aria-label="Filter modules"
          style={filterInputStyle}
        />
      </div>

      {/* Scrollable list body. The panel body is already overflow-y:auto,
          but we scope our scroller here so the sticky header/filter stays
          visible as the user navigates. */}
      <div
        className="sunny-scroll"
        style={{
          maxHeight: dockHidden ? 724 : 428,
          overflowY: 'auto',
          padding: '0 4px 8px',
        }}
        role="navigation"
        aria-label="Module navigation"
      >
        {SECTION_ORDER.map(section => {
          const items = grouped[section];
          if (items.length === 0) return null;
          const tone = SECTION_TONE[section];
          const open = openSections[section] !== false;
          return (
            <div
              key={section}
              data-section={section}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 0,
                marginBottom: 14,
              }}
            >
              <button
                type="button"
                className="nav-section-toggle"
                aria-expanded={open}
                aria-controls={`nav-section-${section}`}
                id={`nav-section-h-${section}`}
                onClick={() => {
                  setOpenSections(prev => ({ ...prev, [section]: !open }));
                }}
                style={{
                  ...sectionHeaderBase,
                  boxSizing: 'border-box',
                  cursor: 'pointer',
                  userSelect: 'none',
                  width: '100%',
                  border: 'none',
                  borderRadius: 3,
                  background: open
                    ? `linear-gradient(90deg, ${tone}28, transparent 72%)`
                    : `linear-gradient(90deg, ${tone}0c, transparent 90%)`,
                  borderLeft: `3px solid ${open ? tone : `${tone}55`}`,
                  boxShadow: open ? `inset 0 0 20px ${tone}14` : 'none',
                  transition: 'background 160ms ease, border-color 160ms ease, transform 90ms ease, box-shadow 160ms ease',
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.background =
                    `linear-gradient(90deg, ${tone}38, transparent 68%)`;
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.transform = 'scale(1)';
                  e.currentTarget.style.background = open
                    ? `linear-gradient(90deg, ${tone}28, transparent 72%)`
                    : `linear-gradient(90deg, ${tone}0c, transparent 90%)`;
                  e.currentTarget.style.boxShadow = open ? `inset 0 0 20px ${tone}14` : 'none';
                }}
                onMouseDown={e => {
                  e.currentTarget.style.transform = 'scale(0.98)';
                }}
                onMouseUp={e => {
                  e.currentTarget.style.transform = 'scale(1)';
                }}
              >
                <span style={sectionTickStyle(tone)} />
                <span
                  aria-hidden
                  style={{
                    fontSize: 11,
                    color: tone,
                    width: 11,
                    flexShrink: 0,
                    lineHeight: 1,
                    fontFamily: 'var(--mono)',
                    opacity: 0.95,
                  }}
                >
                  {open ? '▾' : '▸'}
                </span>
                <span
                  style={{
                    flex: 1,
                    textAlign: 'left',
                    fontSize: 11,
                    letterSpacing: '0.2em',
                    fontWeight: 800,
                    color: tone,
                    textShadow: `0 0 16px ${tone}66`,
                  }}
                >
                  {section}
                </span>
                <span style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 9,
                  fontWeight: 700,
                  color: 'var(--ink-2)',
                  letterSpacing: '0.12em',
                  opacity: 0.85,
                }}>{items.length}</span>
              </button>
              {open && (
                <div
                  id={`nav-section-${section}`}
                  role="group"
                  aria-labelledby={`nav-section-h-${section}`}
                  style={{ display: 'flex', flexDirection: 'column', gap: 0 }}
                >
                  {items.map(m => {
                    const target = LABEL_TO_VIEW[m.label] ?? 'overview';
                    const isActive = view === target;
                    const ledTone = TAURI_DEPENDENT.has(m.label) && !isTauri ? 'var(--amber)' : tone;
                    return (
                      <button
                        key={m.label}
                        aria-current={isActive ? 'page' : undefined}
                        onClick={() => setView(target)}
                        className="nav-module-btn"
                        style={rowStyle(isActive, tone)}
                        onMouseEnter={e => {
                          if (!isActive) e.currentTarget.style.background = `linear-gradient(90deg, ${tone}22, transparent 70%)`;
                        }}
                        onMouseLeave={e => {
                          if (!isActive) e.currentTarget.style.background = 'linear-gradient(90deg, rgba(57, 229, 255, 0.04), transparent)';
                        }}
                      >
                        <span style={{ width: 12, height: 12, display: 'inline-flex', color: isActive ? '#fff' : tone }}>
                          <NavIcon name={m.icon} />
                        </span>
                        <span
                          title={m.label}
                          style={{
                            flex: '1 1 auto',
                            minWidth: 0,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'clip',
                            direction: 'ltr',
                            unicodeBidi: 'isolate',
                          }}
                        >
                          {m.label}
                        </span>
                        <span
                          aria-hidden="true"
                          style={{
                            width: 4, height: 4, borderRadius: '50%',
                            background: ledTone, boxShadow: `0 0 5px ${ledTone}`,
                            flexShrink: 0,
                          }}
                        />
                        {TAURI_DEPENDENT.has(m.label) && !isTauri && (
                          <span className="sr-only"> (unavailable)</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        {totalMatches === 0 && (
          <div style={{
            padding: '18px 10px',
            fontFamily: 'var(--mono)', fontSize: 10,
            color: 'var(--ink-dim)', textAlign: 'center',
          }}>
            no matches
          </div>
        )}
      </div>
    </Panel>
  );
}
