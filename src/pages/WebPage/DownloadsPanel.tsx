import type { ReactElement } from 'react';
import { useEffect, useState, type CSSProperties } from 'react';
import { invoke, invokeSafe, isTauri, listen } from '../../lib/tauri';
import { MediaWorkbench } from './MediaWorkbench';
import { useTabs } from './tabStore';
import type { DownloadJob, ProbeResult } from './types';

const wrap: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--ink)',
  padding: 10,
};

const rowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'auto 1fr auto',
  gap: 10,
  alignItems: 'center',
  padding: 8,
  border: '1px solid var(--line-soft)',
  background: 'rgba(4, 10, 16, 0.5)',
};

const btn: CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  padding: '2px 8px',
  border: '1px solid var(--line-soft)',
  fontSize: 10,
  color: 'var(--cyan)',
  letterSpacing: '0.14em',
};

export function DownloadsPanel(): ReactElement {
  const downloads = useTabs(s => s.downloads);
  const upsertDownload = useTabs(s => s.upsertDownload);
  const refreshDownloads = useTabs(s => s.refreshDownloads);
  const profiles = useTabs(s => s.profiles);
  const tabs = useTabs(s => s.tabs);
  const activeTabId = useTabs(s => s.activeTabId);

  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [url, setUrl] = useState('');
  const [workbenchId, setWorkbenchId] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri) return;
    void refreshDownloads();
    void invokeSafe<ProbeResult>('browser_downloads_probe').then(p => setProbe(p ?? null));
    const unlistenP = listen<DownloadJob>('browser:download:update', job => {
      upsertDownload(job);
    });
    return () => {
      void unlistenP.then(fn => fn());
    };
  }, [refreshDownloads, upsertDownload]);

  const activeTab = tabs.find(t => t.id === activeTabId);
  const currentUrl = activeTab?.url ?? '';
  const currentProfileId = activeTab?.profileId ?? profiles[0]?.id ?? 'default';

  const enqueue = async (target: string) => {
    if (!target.trim()) return;
    try {
      await invoke<DownloadJob>('browser_downloads_enqueue', {
        profileId: currentProfileId,
        url: target.trim(),
      });
      setUrl('');
      await refreshDownloads();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      alert(`Download failed: ${msg}`);
    }
  };

  return (
    <div style={wrap}>
      <div style={{ letterSpacing: '0.18em', color: 'var(--cyan)' }}>// DOWNLOADS</div>
      <div style={{ color: 'var(--ink-dim)', fontSize: 10, lineHeight: 1.6 }}>
        {probe === null
          ? 'probing local tools…'
          : probe.has_yt_dlp
            ? `yt-dlp ${probe.yt_dlp_version ?? 'present'} — 1000+ sites supported`
            : probe.has_ffmpeg
              ? 'yt-dlp missing; ffmpeg fallback will handle direct media URLs only'
              : 'yt-dlp and ffmpeg not on PATH — run `brew install yt-dlp ffmpeg`'}
      </div>

      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="text"
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder={currentUrl || 'paste URL to download…'}
          style={{
            all: 'unset',
            flex: 1,
            padding: '0 8px',
            height: 26,
            border: '1px solid var(--line-soft)',
            fontFamily: 'var(--mono)',
            fontSize: 11,
            color: 'var(--ink)',
            background: 'rgba(4, 10, 16, 0.5)',
          }}
        />
        <button
          type="button"
          onClick={() => void enqueue(url.length > 0 ? url : currentUrl)}
          style={btn}
        >
          DOWNLOAD
        </button>
      </div>

      {downloads.length === 0 ? (
        <div style={{ color: 'var(--ink-dim)', fontSize: 10, padding: '8px 0' }}>
          {'// no jobs yet'}
        </div>
      ) : (
        downloads.map(job => (
          <DownloadRow
            key={job.id}
            job={job}
            onAnalyze={() => setWorkbenchId(job.id)}
          />
        ))
      )}

      {workbenchId !== null && (
        <MediaWorkbench
          job={downloads.find(j => j.id === workbenchId) ?? downloads[0]}
          onClose={() => setWorkbenchId(null)}
        />
      )}
    </div>
  );
}

function DownloadRow({
  job,
  onAnalyze,
}: {
  job: DownloadJob;
  onAnalyze: () => void;
}): ReactElement {
  const pct = Math.round(job.progress * 100);
  const stateColor =
    job.state === 'done'
      ? '#8ae68a'
      : job.state === 'failed'
        ? '#ff6b6b'
        : job.state === 'cancelled'
          ? 'var(--ink-dim)'
          : 'var(--cyan)';

  return (
    <div style={rowStyle}>
      <span
        style={{
          fontSize: 9,
          padding: '2px 6px',
          border: `1px solid ${stateColor}`,
          color: stateColor,
          letterSpacing: '0.14em',
        }}
      >
        {job.state.toUpperCase()}
      </span>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={job.source_url}
        >
          {job.title ?? job.source_url}
        </div>
        <div
          style={{
            marginTop: 4,
            height: 4,
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid var(--line-soft)',
            position: 'relative',
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              width: `${pct}%`,
              background: stateColor,
              opacity: 0.7,
            }}
          />
        </div>
        {job.error ? (
          <div style={{ color: '#ff9b9b', fontSize: 9, marginTop: 3 }}>{job.error}</div>
        ) : (
          <div style={{ color: 'var(--ink-dim)', fontSize: 9, marginTop: 3 }}>
            {job.state === 'downloading' ? `${pct}%` : job.file_path ?? job.profile_id}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {job.state === 'done' && job.file_path ? (
          <>
            <button
              type="button"
              onClick={() => void invokeSafe('browser_downloads_reveal', { id: job.id })}
              style={{ ...btn, fontSize: 9, padding: '1px 6px' }}
              title="Reveal in Finder"
            >
              REVEAL
            </button>
            <button
              type="button"
              onClick={onAnalyze}
              style={{ ...btn, fontSize: 9, padding: '1px 6px' }}
              title="AI analyze this video"
            >
              ANALYZE
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => void invokeSafe('browser_downloads_cancel', { id: job.id })}
            disabled={job.state === 'failed' || job.state === 'cancelled'}
            style={{
              ...btn,
              color: 'var(--ink-dim)',
              borderColor: 'var(--line-soft)',
              opacity: job.state === 'failed' ? 0.4 : 1,
            }}
          >
            X
          </button>
        )}
      </div>
    </div>
  );
}
