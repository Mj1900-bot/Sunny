import type { ReactElement, MouseEvent } from 'react';
import type { App, Category } from '../types';
import { CATEGORY_TAG } from '../constants';
import {
  tileNameStyle,
  catTagStyle,
  iconRowStyle,
  iconImgStyle,
  iconPlaceholderStyle,
  runningDotStyle,
  launchCountStyle,
  starBtnStyle,
  rowActionStyle,
  rowActionRedStyle,
} from '../styles';

export type TileProps = {
  readonly app: App;
  readonly category: Category;
  readonly isFav: boolean;
  readonly focused: boolean;
  readonly isRunning: boolean;
  readonly launchCount: number;
  readonly weeklyLaunches?: number;
  readonly icon: string | null;
  readonly onLaunch: (name: string) => void;
  readonly onToggleFav: (name: string) => void;
  readonly onReveal: (path: string) => void;
  readonly onQuit: (name: string) => void;
  readonly onHide: (name: string) => void;
  readonly onCopyPath: (path: string) => void;
};

export function AppTile({
  app, category, isFav, focused, isRunning, launchCount, weeklyLaunches, icon,
  onLaunch, onToggleFav, onReveal, onQuit, onHide, onCopyPath,
}: TileProps): ReactElement {
  const stop = (ev: MouseEvent) => ev.stopPropagation();

  return (
    <div
      className={`app-tile${focused ? ' is-focused' : ''}${isRunning ? ' is-running' : ''}`}
      title={`${app.name}\n${app.path}${isRunning ? '\n● running' : ''}${launchCount > 0 ? `\nlaunched ${launchCount}×` : ''}`}
      onClick={() => onLaunch(app.name)}
      role="button"
      tabIndex={0}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onLaunch(app.name);
        }
      }}
    >
      <div style={iconRowStyle}>
        {icon ? (
          <img src={`data:image/png;base64,${icon}`} alt="" style={iconImgStyle} draggable={false} />
        ) : (
          <span style={iconPlaceholderStyle} aria-hidden="true" />
        )}
        <span style={catTagStyle}>{CATEGORY_TAG[category]}</span>
      </div>

      <div
        style={{
          position: 'absolute',
          top: 6,
          right: 6,
          display: 'flex',
          gap: 6,
          alignItems: 'center',
        }}
      >
        {isRunning && <span style={runningDotStyle} aria-label="running" title="running" />}
        <button
          type="button"
          aria-label={isFav ? 'Unfavorite' : 'Favorite'}
          onClick={ev => { stop(ev); onToggleFav(app.name); }}
          style={{ ...starBtnStyle, position: 'static', color: isFav ? 'var(--cyan)' : 'var(--ink-dim)' }}
        >
          {isFav ? '\u2605' : '\u2606'}
        </button>
      </div>

      <span className="app-tile-name" style={tileNameStyle}>{app.name}</span>

      {launchCount > 0 && (
        <span style={launchCountStyle}>×{launchCount}</span>
      )}
      {(weeklyLaunches ?? 0) > 0 && (
        <span
          style={{
            position: 'absolute',
            bottom: 8,
            right: 10,
            fontFamily: 'var(--mono)',
            fontSize: 8,
            letterSpacing: '0.1em',
            color: 'var(--cyan)',
            opacity: 0.75,
            pointerEvents: 'none',
          }}
          title={`Launched ${weeklyLaunches}× this week`}
        >
          {weeklyLaunches}W
        </span>
      )}

      <div
        className="app-tile-actions"
        onClick={stop}
        style={{
          position: 'absolute',
          bottom: 6,
          right: 6,
          display: 'none',
          gap: 2,
          alignItems: 'center',
          background: 'rgba(4, 10, 16, 0.92)',
          border: '1px solid var(--line-soft)',
          padding: '2px 4px',
          fontFamily: 'var(--mono)',
        }}
      >
        <button type="button" style={rowActionStyle} onClick={() => onLaunch(app.name)} title="Launch / activate">
          LAUNCH
        </button>
        <span style={{ color: 'var(--ink-dim)' }}>·</span>
        <button type="button" style={rowActionStyle} onClick={() => onReveal(app.path)} title="Reveal in Finder">
          REVEAL
        </button>
        <span style={{ color: 'var(--ink-dim)' }}>·</span>
        <button type="button" style={rowActionStyle} onClick={() => onCopyPath(app.path)} title="Copy bundle path">
          COPY
        </button>
        {isRunning && (
          <>
            <span style={{ color: 'var(--ink-dim)' }}>·</span>
            <button type="button" style={rowActionStyle} onClick={() => onHide(app.name)} title="Hide windows (⌘H)">
              HIDE
            </button>
            <span style={{ color: 'var(--ink-dim)' }}>·</span>
            <button type="button" style={rowActionRedStyle} onClick={() => onQuit(app.name)} title="Quit app (⌘Q)">
              QUIT
            </button>
          </>
        )}
      </div>
    </div>
  );
}
