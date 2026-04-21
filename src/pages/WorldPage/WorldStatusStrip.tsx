/**
 * Live readout: when the UI last received a snapshot (client clock) and
 * whether global module polling is paused — helps debug “stale” confusion.
 */

import { useEffect, useState } from 'react';
import { Chip } from '../_shared';

export function WorldStatusStrip({
  worldRevision,
  worldTimestampMs,
  liveRefresh,
}: {
  worldRevision: number;
  worldTimestampMs: number;
  liveRefresh: boolean;
}) {
  const [lastClientMs, setLastClientMs] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setLastClientMs(Date.now());
  }, [worldRevision, worldTimestampMs]);

  useEffect(() => {
    const h = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(h);
  }, []);

  const localAgoSec = Math.max(0, Math.floor((now - lastClientMs) / 1000));
  const localAgo =
    localAgoSec < 60 ? `${localAgoSec}s` :
    localAgoSec < 3600 ? `${Math.floor(localAgoSec / 60)}m` :
    `${Math.floor(localAgoSec / 3600)}h`;

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10,
        padding: '6px 2px 2px',
        fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)',
      }}
    >
      <span title="When this tab last received a payload from world_get (client clock)">
        UI received <span style={{ color: 'var(--cyan)' }}>{localAgo}</span> ago
      </span>
      <span style={{ opacity: 0.45 }}>·</span>
      <span title="Snapshot timestamp from the updater">server ts {new Date(worldTimestampMs).toLocaleTimeString()}</span>
      {!liveRefresh && (
        <Chip tone="amber" title="Enable in Settings → Modules to resume automatic polling">
          POLLING PAUSED
        </Chip>
      )}
    </div>
  );
}
