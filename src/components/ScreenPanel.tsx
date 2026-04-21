import { useEffect, useState } from 'react';
import { Panel } from './Panel';
import { useClock } from '../hooks/useClock';

export function ScreenPanel() {
  const { clock } = useClock();
  const [p1, setP1] = useState({ left: 60, top: 55 });
  const [p2, setP2] = useState({ left: 30, top: 40 });

  useEffect(() => {
    const id = window.setInterval(() => {
      setP1({ left: 20 + Math.random() * 70, top: 25 + Math.random() * 50 });
      setP2({ left: 20 + Math.random() * 70, top: 25 + Math.random() * 50 });
    }, 1800);
    return () => window.clearInterval(id);
  }, []);

  return (
    <Panel id="p-screen" title="SCREEN CAPTURE" right="2 DISPLAYS">
      <div className="screen">
        <div className="mon">
          <div className="title">DISPLAY 1 · 3456×2234</div>
          <div className="sub">{clock}</div>
          <div className="thumb">
            <div className="w"><i /><i /><i /><i /><i /></div>
            <div className="w"><i /><i /><i /><i /></div>
          </div>
          <div className="pointer" style={{ left: `${p1.left}%`, top: `${p1.top}%` }} />
          <div className="foot"><span>VSCODE · <b>index.html</b></span><span>ACTIVE</span></div>
        </div>
        <div className="mon">
          <div className="title">DISPLAY 2 · 2560×1440</div>
          <div className="sub">{clock}</div>
          <div className="thumb">
            <div className="w"><i /><i /><i /></div>
            <div className="w"><i /><i /><i /><i /></div>
          </div>
          <div className="pointer" style={{ left: `${p2.left}%`, top: `${p2.top}%` }} />
          <div className="foot"><span>CHROME · <b>12 tabs</b></span><span>IDLE 02:14</span></div>
        </div>
      </div>
    </Panel>
  );
}
