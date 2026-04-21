import type { CSSProperties, ReactElement } from 'react';
import { profileColor, routeTag } from './profiles';
import { useTabs } from './tabStore';
import type { TabRecord } from './types';

const strip: CSSProperties = {
  display: 'flex',
  gap: 4,
  alignItems: 'stretch',
  flexShrink: 0,
  borderBottom: '1px solid var(--line-soft)',
  overflowX: 'auto',
  paddingBottom: 2,
};

const tabBase: CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  padding: '4px 10px',
  minWidth: 140,
  maxWidth: 240,
  height: 28,
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  border: '1px solid var(--line-soft)',
  borderBottom: 'none',
  fontFamily: 'var(--mono)',
  fontSize: 11,
  boxSizing: 'border-box',
};

const addBtn: CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  padding: '0 10px',
  height: 28,
  lineHeight: '28px',
  border: '1px dashed var(--line-soft)',
  color: 'var(--cyan)',
  fontFamily: 'var(--mono)',
  fontSize: 14,
  flexShrink: 0,
};

export function TabStrip(): ReactElement {
  const tabs = useTabs(s => s.tabs);
  const profiles = useTabs(s => s.profiles);
  const activeTabId = useTabs(s => s.activeTabId);
  const selectTab = useTabs(s => s.selectTab);
  const closeTab = useTabs(s => s.closeTab);
  const openTab = useTabs(s => s.openTab);

  const activeProfileId =
    tabs.find(t => t.id === activeTabId)?.profileId ?? profiles[0]?.id ?? 'default';

  return (
    <div style={strip}>
      <style>{`@keyframes sunny-tab-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      {tabs.map(t => (
        <TabPill
          key={t.id}
          tab={t}
          active={t.id === activeTabId}
          policy={profiles.find(p => p.id === t.profileId) ?? profiles[0]}
          onSelect={() => selectTab(t.id)}
          onClose={() => closeTab(t.id)}
        />
      ))}
      <button
        type="button"
        onClick={() => openTab(activeProfileId)}
        title="New tab in current profile"
        style={addBtn}
      >
        +
      </button>
    </div>
  );
}

function faviconUrl(tab: TabRecord): string | null {
  // Prefer the favicon the reader extractor surfaced — it's the canonical
  // one advertised by the page itself. Fall back to Google's favicon proxy
  // for any tab that has a URL but no extracted favicon yet. The proxy is
  // fetched through the standard img loader, which honors the tab's
  // render-mode transport for the reader case.
  if (tab.load.kind === 'ready') {
    const f = tab.load.result.extract.favicon_url;
    if (f && f.length > 0) return f;
  }
  if (tab.url.length === 0) return null;
  try {
    const host = new URL(tab.url).hostname;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`;
  } catch {
    return null;
  }
}

function TabPill({
  tab,
  active,
  policy,
  onSelect,
  onClose,
}: {
  tab: TabRecord;
  active: boolean;
  policy: import('./types').ProfilePolicy;
  onSelect: () => void;
  onClose: () => void;
}): ReactElement {
  const color = profileColor(policy);
  const tag = routeTag(policy);
  const label = tab.title.length > 0 ? tab.title : (tab.url.length > 0 ? tab.url : 'New tab');
  const loading = tab.load.kind === 'loading';
  const favicon = faviconUrl(tab);
  return (
    <div
      role="button"
      onClick={onSelect}
      onKeyDown={e => {
        if (e.key === 'Enter') onSelect();
      }}
      tabIndex={0}
      style={{
        ...tabBase,
        background: active ? 'rgba(0, 220, 255, 0.08)' : 'rgba(4, 10, 16, 0.5)',
        borderColor: active ? color : 'var(--line-soft)',
        color: active ? 'var(--ink)' : 'var(--ink-dim)',
        outline: 'none',
        position: 'relative',
      }}
    >
      <span
        style={{
          fontSize: 8,
          letterSpacing: '0.2em',
          padding: '1px 4px',
          border: `1px solid ${color}`,
          color,
        }}
      >
        {tag}
      </span>
      {loading ? (
        <span
          style={{
            width: 10,
            height: 10,
            border: '1.5px solid var(--line-soft)',
            borderTopColor: 'var(--cyan)',
            borderRadius: '50%',
            animation: 'sunny-tab-spin 0.9s linear infinite',
            flexShrink: 0,
          }}
          aria-hidden
        />
      ) : favicon ? (
        <img
          src={favicon}
          alt=""
          width={12}
          height={12}
          style={{
            width: 12,
            height: 12,
            objectFit: 'contain',
            flexShrink: 0,
            opacity: 0.85,
          }}
          onError={e => {
            (e.currentTarget as HTMLImageElement).style.display = 'none';
          }}
        />
      ) : null}
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flex: 1,
        }}
      >
        {label}
      </span>
      <button
        type="button"
        onClick={e => {
          e.stopPropagation();
          onClose();
        }}
        aria-label="Close tab"
        style={{
          all: 'unset',
          cursor: 'pointer',
          padding: '0 2px',
          color: 'var(--ink-dim)',
          fontFamily: 'var(--mono)',
          fontSize: 10,
        }}
      >
        {'\u00d7'}
      </button>
    </div>
  );
}
