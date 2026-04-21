/**
 * ModulesTab — per-module knobs for the 30+ module pages.
 *
 * Most module pages carry a few tunables (refresh cadence, fetch caps,
 * CRM thresholds, default tabs, capped OCR input). Every one of them
 * used to live as either an inline literal or a private localStorage
 * key inside that page. That scatters user-visible behaviour: a user
 * who wanted "less polling" had no single place to go.
 *
 * This tab pulls them together. The settings store owns the schema;
 * each module page reads `useView(s => s.settings.<field>)` at render
 * time. When the user lands on a page for the first time the default
 * from `DEFAULT_SETTINGS` is already in effect, so no page needs its
 * own bootstrap.
 *
 * Grouped by the same section taxonomy as the NavPanel (CORE / LIFE /
 * COMMS / KNOW / DO / AI·SYS) so a reader can map a knob back to the
 * page that consumes it without mental translation.
 */

import { type CSSProperties, type JSX } from 'react';
import { useView, type PhotoRoot, type ReadingTab, type RefreshTier } from '../../store/view';
import {
  chipBase,
  chipStyle,
  hintStyle,
  inputStyle,
  labelStyle,
  rowStyle,
  sectionStyle,
  sectionTitleStyle,
} from './styles';

const REFRESH_TIERS: ReadonlyArray<RefreshTier> = ['slow', 'balanced', 'fast'];
const PHOTO_ROOTS: ReadonlyArray<PhotoRoot> = ['Desktop', 'Screenshots', 'Downloads'];
const READING_TABS: ReadonlyArray<ReadingTab> = ['queue', 'reading', 'done'];
const FOCUS_PRESETS: ReadonlyArray<number> = [25, 45, 60, 90];

export function ModulesTab(): JSX.Element {
  const settings = useView(s => s.settings);
  const patchSettings = useView(s => s.patchSettings);

  // photosRoots is an ordered subset — clicking a chip toggles membership
  // but preserves the "first element is the default root" contract.
  const togglePhotoRoot = (root: PhotoRoot): void => {
    const current = settings.photosRoots;
    const next = current.includes(root)
      ? current.filter(r => r !== root)
      : [...current, root];
    // Reject empty selection — PhotosPage needs at least one root to
    // search, otherwise it renders an indefinite empty state.
    if (next.length === 0) return;
    patchSettings({ photosRoots: next });
  };

  return (
    <div style={gridTwoCol}>
      <section style={{ ...sectionStyle, gridColumn: '1 / -1' }}>
        <h3 style={sectionTitleStyle}>LIVE REFRESH</h3>
        <label style={checkboxRow}>
          <input
            type="checkbox"
            checked={settings.liveRefresh}
            onChange={e => patchSettings({ liveRefresh: e.target.checked })}
          />
          <span>Poll module pages in the background</span>
        </label>
        <div style={hintStyle}>
          When off, module pages only fetch once on mount and on explicit
          refresh. Saves battery + nudges Sunny's load down; trade-off is
          stale data on the TODAY / BRAIN / WORLD dashboards.
        </div>

        <label style={{ ...labelStyle, marginTop: 12 }}>REFRESH TIER</label>
        <div style={rowStyle}>
          {REFRESH_TIERS.map(t => (
            <button
              key={t}
              style={chipStyle(settings.refreshTier === t)}
              onClick={() => patchSettings({ refreshTier: t })}
              disabled={!settings.liveRefresh}
              title={tierHint(t)}
            >
              {t.toUpperCase()}
            </button>
          ))}
        </div>
        <div style={hintStyle}>
          Scales every module's default poll interval. Balanced is the
          authored cadence; slow doubles it, fast halves it. Each page
          still decides its own floor — BRAIN never polls faster than 4s
          even on FAST.
        </div>

        <label style={{ ...checkboxRow, marginTop: 12 }}>
          <input
            type="checkbox"
            checked={settings.aiModuleActions}
            onChange={e => patchSettings({ aiModuleActions: e.target.checked })}
          />
          <span>Enable "Ask Sunny" buttons on module pages</span>
        </label>
        <div style={hintStyle}>
          Gates the one-click AI affordances: INBOX triage, JOURNAL digest,
          PEOPLE briefs, NOTES expand/summarize, READING summarize,
          INSPECTOR ask. Off = the buttons hide; everything else still works.
        </div>
      </section>

      <section style={sectionStyle}>
        <h3 style={sectionTitleStyle}>CORE · TODAY / TIMELINE</h3>

        <label htmlFor="settings-timeline-cap" style={labelStyle}>TIMELINE FETCH CAP — {settings.timelineFetchCap}</label>
        <input
          id="settings-timeline-cap"
          type="range"
          min={100}
          max={2000}
          step={50}
          value={settings.timelineFetchCap}
          onChange={e => patchSettings({ timelineFetchCap: Number(e.target.value) })}
          style={{ width: '100%' }}
        />
        <div style={hintStyle}>
          Max episodic rows TIMELINE pulls per day-scrub. Higher = more
          dots on the hourly scrubber, slower first paint.
        </div>
      </section>

      <section style={sectionStyle}>
        <h3 style={sectionTitleStyle}>LIFE · FOCUS / JOURNAL</h3>

        <label style={labelStyle}>FOCUS DEFAULT — {settings.focusDefaultMinutes} min</label>
        <div style={{ ...rowStyle, marginBottom: 6 }}>
          {FOCUS_PRESETS.map(m => (
            <button
              key={m}
              style={chipStyle(settings.focusDefaultMinutes === m)}
              onClick={() => patchSettings({ focusDefaultMinutes: m })}
            >
              {m}m
            </button>
          ))}
          <input
            type="number"
            min={5}
            max={240}
            value={settings.focusDefaultMinutes}
            onChange={e => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n >= 5 && n <= 240) patchSettings({ focusDefaultMinutes: n });
            }}
            style={{ ...inputStyle, width: 70 }}
          />
        </div>
        <div style={hintStyle}>
          Quick-start length for a new focus session. 25 = pomodoro,
          90 = a deep sprint. FOCUS will still start without a duration
          set; this only seeds the timer.
        </div>

        <label htmlFor="settings-journal-cap" style={{ ...labelStyle, marginTop: 12 }}>JOURNAL FETCH CAP — {settings.journalFetchCap}</label>
        <input
          id="settings-journal-cap"
          type="range"
          min={50}
          max={1500}
          step={50}
          value={settings.journalFetchCap}
          onChange={e => patchSettings({ journalFetchCap: Number(e.target.value) })}
          style={{ width: '100%' }}
        />
        <div style={hintStyle}>
          Rows JOURNAL pulls before grouping by day. Smaller = tighter
          scroll; larger = more week-over-week context for the AI digest.
        </div>
      </section>

      <section style={sectionStyle}>
        <h3 style={sectionTitleStyle}>COMMS · PEOPLE / NOTIFY</h3>

        <label htmlFor="settings-people-warm" style={labelStyle}>PEOPLE · WARM &lt; {settings.peopleWarmDays} DAYS</label>
        <input
          id="settings-people-warm"
          type="range"
          min={1}
          max={30}
          value={settings.peopleWarmDays}
          onChange={e => {
            const n = Number(e.target.value);
            if (n < settings.peopleColdDays) patchSettings({ peopleWarmDays: n });
          }}
          style={{ width: '100%' }}
        />

        <label htmlFor="settings-people-cold" style={{ ...labelStyle, marginTop: 12 }}>PEOPLE · COLD ≥ {settings.peopleColdDays} DAYS</label>
        <input
          id="settings-people-cold"
          type="range"
          min={settings.peopleWarmDays + 1}
          max={180}
          value={settings.peopleColdDays}
          onChange={e => patchSettings({ peopleColdDays: Number(e.target.value) })}
          style={{ width: '100%' }}
        />
        <div style={hintStyle}>
          Days-since-last-message buckets that drive the warm / cooling /
          cold tabs. Anything between warm and cold is "cooling".
        </div>

        <label htmlFor="settings-notify-cap" style={{ ...labelStyle, marginTop: 12 }}>NOTIFY FEED CAP — {settings.notifyLogCap}</label>
        <input
          id="settings-notify-cap"
          type="range"
          min={25}
          max={1000}
          step={25}
          value={settings.notifyLogCap}
          onChange={e => patchSettings({ notifyLogCap: Number(e.target.value) })}
          style={{ width: '100%' }}
        />
        <div style={hintStyle}>
          Most-recent N notifications kept in the NOTIFY page log
          (localStorage). Older entries drop off the tail.
        </div>
      </section>

      <section style={sectionStyle}>
        <h3 style={sectionTitleStyle}>KNOW · PHOTOS / READING</h3>

        <label style={labelStyle}>PHOTOS ROOTS</label>
        <div style={rowStyle}>
          {PHOTO_ROOTS.map(root => (
            <button
              key={root}
              style={chipStyle(settings.photosRoots.includes(root))}
              onClick={() => togglePhotoRoot(root)}
              title={`Toggle ~/${root}`}
            >
              ~/{root}
            </button>
          ))}
        </div>
        <div style={hintStyle}>
          Which ~/ folders PHOTOS will search. First enabled root becomes
          the default view. At least one must stay on — the page's
          `fs_search` call needs a root.
        </div>

        <label style={{ ...labelStyle, marginTop: 12 }}>READING DEFAULT TAB</label>
        <div style={rowStyle}>
          {READING_TABS.map(t => (
            <button
              key={t}
              style={chipStyle(settings.readingDefaultTab === t)}
              onClick={() => patchSettings({ readingDefaultTab: t })}
            >
              {t.toUpperCase()}
            </button>
          ))}
        </div>
        <div style={hintStyle}>
          Which queue you land on when READING opens.
        </div>
      </section>

      <section style={sectionStyle}>
        <h3 style={sectionTitleStyle}>DO · CODE</h3>

        <label htmlFor="settings-code-repo" style={labelStyle}>CODE REPO ROOT</label>
        <input
          id="settings-code-repo"
          type="text"
          value={settings.codeRepoRoot}
          onChange={e => patchSettings({ codeRepoRoot: e.target.value })}
          placeholder="~/code"
          style={inputStyle}
          spellCheck={false}
        />
        <div style={hintStyle}>
          Directory CODE scans (up to depth 3) for <code>.git</code>.
          Tildes are expanded by the shell. You can override on the page
          itself — this is the default the page falls back to.
        </div>
        <div style={{ ...rowStyle, marginTop: 8 }}>
          <button style={chipBase} onClick={() => patchSettings({ codeRepoRoot: '~/code' })}>
            ~/code
          </button>
          <button style={chipBase} onClick={() => patchSettings({ codeRepoRoot: '~/src' })}>
            ~/src
          </button>
          <button style={chipBase} onClick={() => patchSettings({ codeRepoRoot: '~/projects' })}>
            ~/projects
          </button>
          <button style={chipBase} onClick={() => patchSettings({ codeRepoRoot: '~/Documents/code' })}>
            ~/Documents/code
          </button>
        </div>
      </section>

      <section style={sectionStyle}>
        <h3 style={sectionTitleStyle}>AI·SYS · INSPECTOR / AUDIT</h3>

        <label htmlFor="settings-inspector-ocr" style={labelStyle}>INSPECTOR OCR CAP — {settings.inspectorOcrMaxChars} chars</label>
        <input
          id="settings-inspector-ocr"
          type="range"
          min={500}
          max={16_000}
          step={500}
          value={settings.inspectorOcrMaxChars}
          onChange={e => patchSettings({ inspectorOcrMaxChars: Number(e.target.value) })}
          style={{ width: '100%' }}
        />
        <div style={hintStyle}>
          Hard cap on OCR'd screen text forwarded to the LLM when you
          press ASK on INSPECTOR. Larger = more context but more tokens
          and longer latency.
        </div>

        <label style={{ ...checkboxRow, marginTop: 12 }}>
          <input
            type="checkbox"
            checked={settings.auditOnlyErrors}
            onChange={e => patchSettings({ auditOnlyErrors: e.target.checked })}
          />
          <span>AUDIT — default to only-errors filter</span>
        </label>
        <div style={hintStyle}>
          When on, the AUDIT page opens with the "errors only" toggle
          pre-filled so tool failures surface immediately. Users can
          still flip it off per-visit.
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------

function tierHint(t: RefreshTier): string {
  switch (t) {
    case 'slow':     return 'Half-speed polling · battery-friendly';
    case 'balanced': return 'Authored polling · default';
    case 'fast':     return 'Double-speed polling · snappier dashboards';
  }
}

const gridTwoCol: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
  gap: 14,
};

const checkboxRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  fontFamily: 'var(--mono)',
  fontSize: 12,
  color: 'var(--ink)',
};
