import { useEffect, useRef, useState } from 'react';

const pad = (n: number) => String(n).padStart(2, '0');

export function useClock() {
  const [now, setNow] = useState(() => new Date());
  const start = useRef(Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const hh = pad(now.getHours());
  const mm = pad(now.getMinutes());
  const ss = pad(now.getSeconds());

  const clock = `${hh}:${mm}:${ss}`;
  const date = now.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }).toUpperCase();
  const upSecs = Math.floor((Date.now() - start.current) / 1000);
  const uptime = `${Math.floor(upSecs / 3600)}h ${pad(Math.floor(upSecs / 60) % 60)}m`;

  return { clock, date, uptime };
}
