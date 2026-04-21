import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
} from 'react';
import { ModuleView } from '../../components/ModuleView';
import { CapabilitiesTab } from './CapabilitiesTab';
import { ConstitutionTab } from './ConstitutionTab';
import { GeneralTab, useGeneralBadge } from './GeneralTab';
import { ModelsTab } from './ModelsTab';
import { ModulesTab } from './ModulesTab';
import { PermissionsTab } from './PermissionsTab';
import { HotkeysTab } from './HotkeysTab';
import { AdvancedTab } from './AdvancedTab';
import { AutopilotTab } from './AutopilotTab';
import { searchSettings, type SearchEntry, type SettingsTabId } from './searchIndex';
import { useView } from '../../store/view';
import {
  SETTINGS_JUMP_EVENT,
  type SettingsJumpDetail,
} from '../../components/CommandBar/hits';

// ─────────────────────────────────────────────────────────────────
// SettingsPage — the one place all of SUNNY's knobs live.
//
//   GENERAL       — connection, theme, voice, pipeline.
//   MODELS        — provider, model, presets, sampling, keys.
//   CAPABILITIES  — tool / skill browser (live registry view).
//   CONSTITUTION  — identity / values / prohibitions editor.
//   PERMISSIONS   — macOS TCC dashboard + reset.
//   HOTKEYS       — global shortcut reference + PTT rebind.
//   MODULES       — per-module knobs (refresh, AI actions, CRM, OCR…).
//   ADVANCED      — storage, a11y, diagnostics, backup, about.
//
// There's a cross-tab search in the header too — type a few letters
// and the dropdown surfaces matching knobs from every tab along with
// a direct jump. "⌘/" focuses the search from anywhere on this page.
// ─────────────────────────────────────────────────────────────────

type Tab = SettingsTabId;

type TabDef = Readonly<{ id: Tab; label: string; hotkey: string }>;

const TABS: ReadonlyArray<TabDef> = [
  { id: 'general',      label: 'GENERAL',      hotkey: '1' },
  { id: 'models',       label: 'MODELS',       hotkey: '2' },
  { id: 'capabilities', label: 'CAPABILITIES', hotkey: '3' },
  { id: 'constitution', label: 'CONSTITUTION', hotkey: '4' },
  { id: 'permissions',  label: 'PERMISSIONS',  hotkey: '5' },
  { id: 'hotkeys',      label: 'HOTKEYS',      hotkey: '6' },
  { id: 'modules',      label: 'MODULES',      hotkey: '7' },
  { id: 'advanced',     label: 'ADVANCED',     hotkey: '8' },
  { id: 'autopilot',    label: 'AUTOPILOT',    hotkey: '9' },
];

const TAB_LABEL: Record<Tab, string> =
  Object.fromEntries(TABS.map(t => [t.id, t.label])) as Record<Tab, string>;

const tabBarStyle: CSSProperties = {
  display: 'flex',
  gap: 6,
  marginBottom: 14,
  paddingBottom: 10,
  borderBottom: '1px solid var(--line-soft)',
  flexWrap: 'wrap',
  alignItems: 'center',
};

function tabStyle(active: boolean): CSSProperties {
  return {
    all: 'unset',
    cursor: 'pointer',
    padding: '6px 14px',
    border: `1px solid ${active ? 'var(--cyan)' : 'var(--line-soft)'}`,
    background: active ? 'rgba(57, 229, 255, 0.12)' : 'rgba(6, 14, 22, 0.55)',
    color: active ? 'var(--cyan)' : 'var(--ink-dim)',
    fontFamily: 'var(--display)',
    fontSize: 11,
    letterSpacing: '0.24em',
    fontWeight: active ? 700 : 500,
  };
}

function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  if (target.isContentEditable) return true;
  return false;
}

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>('general');
  const [saveFlash, setSaveFlash] = useState(false);
  const [toolCount, setToolCount] = useState(0);
  const [skillCount, setSkillCount] = useState(0);
  const [valuesCount, setValuesCount] = useState(0);
  const [prohibitionCount, setProhibitionCount] = useState(0);
  const liveRefresh = useView(s => s.settings.liveRefresh);
  const refreshTier = useView(s => s.settings.refreshTier);
  const photoRootCount = useView(s => s.settings.photosRoots.length);

  const generalBadge = useGeneralBadge(saveFlash);

  const onCapabilitiesCounts = useCallback((tools: number, skills: number) => {
    setToolCount(tools);
    setSkillCount(skills);
  }, []);

  const onConstitutionCounts = useCallback((values: number, prohibitions: number) => {
    setValuesCount(values);
    setProhibitionCount(prohibitions);
  }, []);

  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Tab-index hotkeys: plain 1..8 while this page is open. Guarded against
  // fires while the user is typing in any form field so chat / memory /
  // model-name inputs don't get hijacked by a stray digit.
  //
  // ⌘/ and ⌘F both jump focus into the search input — ⌘/ mirrors the
  // macOS System Settings pattern, ⌘F is the universal "find in page"
  // muscle memory. ⌘S flashes the SAVED badge so the user gets explicit
  // feedback even though patchSettings already persists on every change.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // ⌘/ or ⌘F — focus search.
      if ((e.metaKey || e.ctrlKey) && (e.key === '/' || e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }
      // ⌘S — acknowledge save (settings already persist on change;
      // this just flashes the header badge for reassurance).
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        setSaveFlash(true);
        window.setTimeout(() => setSaveFlash(false), 900);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTextInput(e.target)) return;
      if (e.key >= '1' && e.key <= '9') {
        const idx = Number(e.key) - 1;
        const next = TABS[idx];
        if (next) {
          e.preventDefault();
          setTab(next.id);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ⌘K jump from QuickLauncher → switch to the requested tab.
  useEffect(() => {
    const onJump = (e: Event): void => {
      const ce = e as CustomEvent<SettingsJumpDetail>;
      const next = ce.detail?.tab;
      if (next) setTab(next);
    };
    window.addEventListener(SETTINGS_JUMP_EVENT, onJump);
    return () => window.removeEventListener(SETTINGS_JUMP_EVENT, onJump);
  }, []);

  const badge = computeBadge(
    tab,
    {
      generalBadge, toolCount, skillCount, valuesCount, prohibitionCount,
      liveRefresh, refreshTier, photoRootCount,
    },
  );

  return (
    <ModuleView title="SETTINGS" badge={badge}>
      <div style={tabBarStyle} role="tablist" aria-label="Settings tabs">
        {TABS.map(t => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            style={tabStyle(tab === t.id)}
            onClick={() => setTab(t.id)}
            title={`${t.label} · press ${t.hotkey}`}
          >
            {t.label}
            <span style={{ opacity: 0.4, marginLeft: 8, fontSize: 8 }}>{t.hotkey}</span>
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <SearchBar
          inputRef={searchInputRef}
          activeTab={tab}
          onJump={(nextTab) => setTab(nextTab)}
        />
      </div>

      <style>{TAB_REVEAL_KEYFRAMES}</style>
      <div key={tab} className="sunny-settings-tab-reveal">
        {tab === 'general'      && <GeneralTab onSaveFlash={setSaveFlash} />}
        {tab === 'models'       && <ModelsTab />}
        {tab === 'capabilities' && <CapabilitiesTab onCountsChange={onCapabilitiesCounts} />}
        {tab === 'constitution' && <ConstitutionTab onCountsChange={onConstitutionCounts} />}
        {tab === 'permissions'  && <PermissionsTab />}
        {tab === 'hotkeys'      && <HotkeysTab />}
        {tab === 'modules'      && <ModulesTab />}
        {tab === 'advanced'     && <AdvancedTab />}
        {tab === 'autopilot'    && <AutopilotTab />}
      </div>
    </ModuleView>
  );
}

// Subtle fade + 4px slide on tab change — respects `prefers-reduced-motion`
// and the app-level `body.reduced-motion` toggle from the Advanced tab.
const TAB_REVEAL_KEYFRAMES = `
@keyframes sunny-settings-tab-reveal {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}
.sunny-settings-tab-reveal {
  animation: sunny-settings-tab-reveal 180ms ease-out both;
}
body.reduced-motion .sunny-settings-tab-reveal,
@media (prefers-reduced-motion: reduce) {
  .sunny-settings-tab-reveal { animation: none; }
}
`;

// ---------------------------------------------------------------------------
// SearchBar — cross-tab filter with a keyboardable dropdown
// ---------------------------------------------------------------------------

type SearchBarProps = {
  readonly inputRef: React.RefObject<HTMLInputElement | null>;
  readonly activeTab: Tab;
  readonly onJump: (tab: Tab) => void;
};

function SearchBar({ inputRef, activeTab, onJump }: SearchBarProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const results = useMemo(() => searchSettings(query, 8), [query]);
  const trimmedQuery = query.trim();

  // Clamp the cursor whenever the result set shrinks so Enter doesn't
  // land on a ghost index. No-op when the list grows.
  useEffect(() => {
    if (cursor >= results.length) setCursor(0);
  }, [results.length, cursor]);

  // Close the dropdown when focus leaves the whole search component.
  // Track via blur on the wrapper so clicks on list items (which steal
  // focus briefly) still fire the jump handler before the list unmounts.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent): void => {
      if (!wrapperRef.current) return;
      if (!(e.target instanceof Node)) return;
      if (wrapperRef.current.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const jump = useCallback((entry: SearchEntry) => {
    onJump(entry.tab);
    setOpen(false);
    setQuery('');
    setCursor(0);
  }, [onJump]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      setOpen(true);
      return;
    }
    if (e.key === 'Escape') {
      setOpen(false);
      setQuery('');
      e.currentTarget.blur();
      return;
    }
    if (!open || results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor(c => (c + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor(c => (c - 1 + results.length) % results.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const picked = results[cursor];
      if (picked) jump(picked);
    }
  };

  return (
    <div ref={wrapperRef} style={{ position: 'relative', minWidth: 260 }}>
      <input
        ref={inputRef}
        type="text"
        placeholder="Search settings…  ⌘/"
        value={query}
        onChange={e => {
          setQuery(e.target.value);
          setOpen(true);
          setCursor(0);
        }}
        onFocus={() => { if (query.length > 0) setOpen(true); }}
        onKeyDown={onKeyDown}
        aria-label="Search settings"
        role="combobox"
        aria-expanded={open}
        aria-controls="settings-search-listbox"
        aria-activedescendant={
          open && results[cursor] ? `settings-search-item-${cursor}` : undefined
        }
        style={searchInputStyle}
      />
      {open && query.trim().length > 0 && (
        <div
          id="settings-search-listbox"
          role="listbox"
          style={dropdownStyle}
        >
          {results.length === 0 ? (
            <div style={emptyRowStyle}>No matches · try "keys", "voice", "tcc"</div>
          ) : (
            results.map((entry, i) => (
              <SearchResultRow
                key={`${entry.tab}-${entry.label}`}
                id={`settings-search-item-${i}`}
                entry={entry}
                active={i === cursor}
                query={trimmedQuery}
                onHover={() => setCursor(i)}
                onSelect={() => jump(entry)}
                sameTab={entry.tab === activeTab}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

type SearchResultRowProps = {
  readonly id: string;
  readonly entry: SearchEntry;
  readonly active: boolean;
  readonly sameTab: boolean;
  readonly query: string;
  readonly onHover: () => void;
  readonly onSelect: () => void;
};

function SearchResultRow({
  id, entry, active, sameTab, query, onHover, onSelect,
}: SearchResultRowProps): JSX.Element {
  return (
    <button
      id={id}
      type="button"
      role="option"
      aria-selected={active}
      onMouseEnter={onHover}
      onClick={onSelect}
      // MouseDown also fires before blur, which kept closing the dropdown
      // before the click registered. Prevent the input from losing focus
      // so the click-handled jump actually runs.
      onMouseDown={e => e.preventDefault()}
      style={{
        all: 'unset',
        cursor: 'pointer',
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        gap: 10,
        padding: '8px 12px',
        background: active ? 'rgba(57, 229, 255, 0.12)' : 'transparent',
        borderBottom: '1px solid rgba(120, 170, 200, 0.08)',
      }}
    >
      <div style={{ display: 'grid', gap: 2 }}>
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 12,
            color: active ? 'var(--cyan)' : 'var(--ink)',
          }}
        >
          {highlightMatch(entry.label, query)}
        </span>
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 10.5,
            color: 'var(--ink-dim)',
          }}
        >
          {highlightMatch(entry.description, query)}
        </span>
      </div>
      <span
        style={{
          alignSelf: 'center',
          fontFamily: 'var(--display)',
          fontSize: 9.5,
          letterSpacing: '0.22em',
          color: sameTab ? 'var(--cyan)' : 'var(--ink-dim)',
          padding: '2px 8px',
          border: `1px solid ${sameTab ? 'var(--cyan)' : 'var(--line-soft)'}`,
        }}
      >
        {sameTab ? '← ' : '→ '}{TAB_LABEL[entry.tab]}
      </span>
    </button>
  );
}

const searchInputStyle: CSSProperties = {
  all: 'unset',
  boxSizing: 'border-box',
  width: '100%',
  padding: '6px 10px',
  border: '1px solid var(--line-soft)',
  background: 'rgba(2, 6, 10, 0.6)',
  color: 'var(--ink)',
  fontFamily: 'var(--mono)',
  fontSize: 11.5,
};

const dropdownStyle: CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 4px)',
  right: 0,
  left: 0,
  zIndex: 40,
  background: 'rgba(4, 10, 16, 0.95)',
  border: '1px solid var(--line-soft)',
  boxShadow: '0 12px 36px rgba(0, 0, 0, 0.55)',
  display: 'grid',
  maxHeight: 360,
  overflow: 'auto',
};

const emptyRowStyle: CSSProperties = {
  padding: '10px 12px',
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--ink-dim)',
  letterSpacing: '0.14em',
};

// Substring highlighter — splits the haystack on the first case-insensitive
// occurrence of the needle and wraps each match in a cyan <mark>. Falls
// back to the plain string if the needle is empty or missing, so this is
// safe to call unconditionally.
function highlightMatch(text: string, needle: string): JSX.Element | string {
  const q = needle.trim();
  if (q.length === 0) return text;
  const lower = text.toLowerCase();
  const lowerNeedle = q.toLowerCase();
  const idx = lower.indexOf(lowerNeedle);
  if (idx < 0) return text;
  const before = text.slice(0, idx);
  const hit = text.slice(idx, idx + q.length);
  const after = text.slice(idx + q.length);
  return (
    <>
      {before}
      <mark style={highlightMarkStyle}>{hit}</mark>
      {after}
    </>
  );
}

const highlightMarkStyle: CSSProperties = {
  background: 'rgba(57, 229, 255, 0.22)',
  color: 'var(--cyan)',
  padding: '0 1px',
};

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

type BadgeArgs = Readonly<{
  generalBadge: string;
  toolCount: number;
  skillCount: number;
  valuesCount: number;
  prohibitionCount: number;
  liveRefresh: boolean;
  refreshTier: 'slow' | 'balanced' | 'fast';
  photoRootCount: number;
}>;

function computeBadge(tab: Tab, a: BadgeArgs): string {
  switch (tab) {
    case 'general':      return a.generalBadge;
    case 'models':       return 'PROVIDER + KEYS';
    case 'capabilities': return `${a.toolCount} TOOLS · ${a.skillCount} SKILLS`;
    case 'constitution': return `VALUES ${a.valuesCount} · PROHIBITIONS ${a.prohibitionCount}`;
    case 'permissions':  return 'MACOS TCC';
    case 'hotkeys':      return 'REFERENCE';
    case 'modules':      return a.liveRefresh
      ? `LIVE · ${a.refreshTier.toUpperCase()} · ${a.photoRootCount} ROOTS`
      : `POLL OFF · ${a.photoRootCount} ROOTS`;
    case 'advanced':     return 'STORAGE · DIAGNOSTICS';
    case 'autopilot':    return 'PILOT · WAKE · TRUST · VOICE';
    default:             return '';
  }
}
