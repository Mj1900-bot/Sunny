import { useEffect, useState } from 'react';
import { invokeSafe } from '../lib/tauri';

const POLL_MS = 20_000;
const CONFIG_PATH = '~/.openclaw/openclaw.json';
const BRIDGE_PATH = '~/Library/Application Support/OpenClaw/bridge.sock';

type PingState = 'unknown' | 'ok' | 'down';

function toState(result: boolean | null): PingState {
  if (result === null) return 'unknown';
  return result ? 'ok' : 'down';
}

export function OpenClawStatus() {
  const [state, setState] = useState<PingState>('unknown');

  useEffect(() => {
    let alive = true;

    const ping = async () => {
      const res = await invokeSafe<boolean>('openclaw_ping');
      if (!alive) return;
      setState(toState(res));
    };

    ping();
    const id = window.setInterval(ping, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  const connected = state === 'ok';
  const color = connected ? 'var(--cyan)' : 'var(--amber)';
  const label = connected ? 'bridge.sock OK' : 'gateway not found';
  const title = `OpenClaw gateway: ${label}\nconfig: ${CONFIG_PATH}\nbridge: ${BRIDGE_PATH}`;

  return (
    <span
      title={title}
      style={{
        fontFamily: "'Orbitron', var(--display, var(--mono))",
        fontSize: 10,
        letterSpacing: '0.22em',
        color,
        fontWeight: 700,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: color,
          boxShadow: `0 0 6px ${color}`,
          display: 'inline-block',
        }}
      />
      OPENCLAW
    </span>
  );
}
