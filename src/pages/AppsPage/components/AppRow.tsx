import type { ReactElement, MouseEvent } from 'react';
import type { TileProps } from './AppTile';
import { CATEGORY_TAG } from '../constants';
import {
  catTagStyle,
  iconPlaceholderStyle,
  runningDotStyle,
  rowActionStyle,
  rowActionRedStyle,
} from '../styles';

export function AppRow({
  app, category, isFav, focused, isRunning, launchCount, icon,
  onLaunch, onToggleFav, onReveal, onQuit, onHide, onCopyPath,
}: TileProps): ReactElement {
  const stop = (ev: MouseEvent) => ev.stopPropagation();
  
  return (
    <div
      className={`app-row${focused ? ' is-focused' : ''}`}
      onClick={() => onLaunch(app.name)}
      title={`${app.name}\n${app.path}`}
      style={{
        display: 'grid',
        gridTemplateColumns: '20px 50px 1fr 110px 90px 70px 1fr',
        alignItems: 'center',
        gap: 10,
        padding: '6px 10px',
        borderBottom: '1px solid var(--line-soft)',
        cursor: 'pointer',
        background: focused ? 'rgba(57, 229, 255, 0.08)' : 'transparent',
      }}
    >
      {icon ? (
        <img src={`data:image/png;base64,${icon}`} alt="" style={{ width: 20, height: 20, objectFit: 'contain' }} />
      ) : (
        <span style={iconPlaceholderStyle} />
      )}
      <span style={catTagStyle}>{CATEGORY_TAG[category]}</span>
      <span
        style={{
          fontFamily: 'var(--label)',
          fontSize: 12,
          color: 'var(--ink)',
          fontWeight: 600,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {app.name}
      </span>
      <span
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 10,
          color: 'var(--ink-dim)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {app.path.replace('/Applications/', '').replace('/System/Applications/', '').replace('.app', '')}
      </span>
      <span
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 10,
          color: isRunning ? 'var(--green)' : 'var(--ink-dim)',
          letterSpacing: '0.14em',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        {isRunning ? <><span style={runningDotStyle} /> RUNNING</> : '—'}
      </span>
      <span
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 10,
          color: 'var(--ink-dim)',
          letterSpacing: '0.1em',
          textAlign: 'right',
        }}
      >
        {launchCount > 0 ? `×${launchCount}` : '·'}
      </span>
      <div
        onClick={stop}
        style={{
          display: 'flex',
          gap: 2,
          alignItems: 'center',
          justifyContent: 'flex-end',
          fontFamily: 'var(--mono)',
        }}
      >
        <button
          type="button"
          style={{ ...rowActionStyle, color: isFav ? 'var(--cyan)' : 'var(--ink-dim)' }}
          onClick={() => onToggleFav(app.name)}
          title={isFav ? 'Unfavorite' : 'Favorite'}
        >
          {isFav ? '★' : '☆'}
        </button>
        <span style={{ color: 'var(--ink-dim)' }}>·</span>
        <button type="button" style={rowActionStyle} onClick={() => onLaunch(app.name)}>OPEN</button>
        <span style={{ color: 'var(--ink-dim)' }}>·</span>
        <button type="button" style={rowActionStyle} onClick={() => onReveal(app.path)}>REVEAL</button>
        <span style={{ color: 'var(--ink-dim)' }}>·</span>
        <button type="button" style={rowActionStyle} onClick={() => onCopyPath(app.path)}>COPY</button>
        {isRunning && (
          <>
            <span style={{ color: 'var(--ink-dim)' }}>·</span>
            <button type="button" style={rowActionStyle} onClick={() => onHide(app.name)}>HIDE</button>
            <span style={{ color: 'var(--ink-dim)' }}>·</span>
            <button type="button" style={rowActionRedStyle} onClick={() => onQuit(app.name)}>QUIT</button>
          </>
        )}
      </div>
    </div>
  );
}
