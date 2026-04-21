import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Capture, AutoCadence, DragRect, OcrResult, OcrBox } from '../types';
import { labelSmall, actionBtn, toggleOnBtn, ghostBtn, tinyBtn } from '../styles';
import { formatAge, formatBytes, normalizeDrag, dragIsMeaningful, dataUrl, clamp01 } from '../utils';
import { OcrBoxOverlay } from './OcrBoxOverlay';
import { isTauri } from '../../../lib/tauri';

export type LivePreviewProps = {
  capture: Capture | null;
  busy: boolean;
  error: string | null;
  cadence: AutoCadence;
  onCadenceChange: (c: AutoCadence) => void;
  onRefresh: () => void;
  onOpenInViewer: () => void;
  now: number;

  // Select mode (drag to capture a region on the current preview)
  selectMode: boolean;
  onToggleSelect: () => void;
  onCaptureSelection: (rect: DragRect) => void;

  // OCR overlay
  showBoxes: boolean;
  onToggleBoxes: () => void;
  ocr: OcrResult | null;
  boxesClickable: boolean;
  onBoxClick: (box: OcrBox) => void;
  searchTerm: string;
  onSearchTerm: (s: string) => void;

  // When true the Screen Recording TCC grant is confirmed missing. Renders an
  // actionable empty-state block in place of the "PRESS CAPTURE TO BEGIN"
  // copy so the user knows a capture will fail until they open Settings.
  screenRecordingMissing?: boolean;
  onOpenScreenRecordingSettings?: () => void;
};

export function LivePreview({
  capture, busy, error, cadence, onCadenceChange, onRefresh, onOpenInViewer, now,
  selectMode, onToggleSelect, onCaptureSelection,
  showBoxes, onToggleBoxes, ocr, boxesClickable, onBoxClick,
  searchTerm, onSearchTerm,
  screenRecordingMissing = false, onOpenScreenRecordingSettings,
}: LivePreviewProps) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [drag, setDrag] = useState<DragRect | null>(null);
  const draggingRef = useRef(false);

  const age = capture ? now - capture.capturedAt : null;
  const cadences: ReadonlyArray<AutoCadence> = ['OFF', '5s', '15s', '60s'];

  // Reset any pending drag when leaving select mode or changing capture.
  useEffect(() => {
    if (!selectMode) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDrag(null);
      draggingRef.current = false;
    }
  }, [selectMode, capture?.id]);

  const uvFromEvent = useCallback((e: ReactPointerEvent<HTMLDivElement>): { u: number; v: number } | null => {
    const img = imgRef.current;
    if (!img) return null;
    const rect = img.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const u = clamp01((e.clientX - rect.left) / rect.width);
    const v = clamp01((e.clientY - rect.top) / rect.height);
    return { u, v };
  }, []);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!selectMode || !capture) return;
    const uv = uvFromEvent(e);
    if (!uv) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = true;
    setDrag({ u0: uv.u, v0: uv.v, u1: uv.u, v1: uv.v });
  }, [selectMode, capture, uvFromEvent]);

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const uv = uvFromEvent(e);
    if (!uv) return;
    setDrag(prev => (prev ? { ...prev, u1: uv.u, v1: uv.v } : prev));
  }, [uvFromEvent]);

  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* noop */ }
  }, []);

  const normDrag = drag ? normalizeDrag(drag) : null;
  const canCommitDrag = !!normDrag && dragIsMeaningful(normDrag);

  // Case-insensitive match for OCR search.
  const lowerSearch = searchTerm.trim().toLowerCase();
  const matchedCount = useMemo(() => {
    if (!ocr || lowerSearch.length === 0) return 0;
    return ocr.boxes.reduce((acc, b) => (b.text.toLowerCase().includes(lowerSearch) ? acc + 1 : acc), 0);
  }, [ocr, lowerSearch]);

  return (
    <div
      style={{
        position: 'relative',
        border: '1px solid var(--line-soft)',
        background: 'rgba(6, 14, 22, 0.55)',
        minHeight: 280,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '8px 10px',
          borderBottom: '1px solid var(--line-soft)',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--display)',
            fontSize: 10.5,
            letterSpacing: '0.22em',
            color: 'var(--cyan)',
            fontWeight: 700,
          }}
        >
          LIVE PREVIEW
          {capture && (
            <span style={{ color: 'var(--ink-dim)', marginLeft: 10 }}>
              · {capture.source} · {capture.image.width}×{capture.image.height} · {formatBytes(capture.image.bytes_len)}
            </span>
          )}
        </span>
        <span style={labelSmall}>
          {age === null ? 'NO CAPTURE' : formatAge(age).toUpperCase()}
        </span>
      </div>

      {/* Image area */}
      <div
        style={{
          flex: 1,
          position: 'relative',
          minHeight: 200,
          background:
            'repeating-linear-gradient(90deg, rgba(57,229,255,0.04) 0 1px, transparent 1px 48px),' +
            'repeating-linear-gradient(0deg, rgba(57,229,255,0.04) 0 1px, transparent 1px 48px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          userSelect: 'none',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {capture ? (
          <div
            style={{
              position: 'relative',
              maxWidth: '100%',
              maxHeight: 380,
              display: 'inline-block',
            }}
          >
            <img
              ref={imgRef}
              src={dataUrl(capture.image)}
              alt="screen capture"
              onClick={() => {
                // Only open the modal when not actively selecting/OCR-clicking.
                if (!selectMode && !(showBoxes && boxesClickable)) onOpenInViewer();
              }}
              style={{
                display: 'block',
                maxWidth: '100%',
                maxHeight: 380,
                objectFit: 'contain',
                filter: 'drop-shadow(0 0 14px rgba(57,229,255,0.25))',
                cursor: selectMode ? 'crosshair' : (showBoxes && boxesClickable) ? 'default' : 'zoom-in',
                pointerEvents: selectMode ? 'none' : 'auto', // let wrapper capture drag
              }}
              draggable={false}
            />

            {/* OCR overlay. Disabled for pointer events while selecting a region. */}
            {showBoxes && ocr && (
              <OcrBoxOverlay
                ocr={ocr}
                clickable={boxesClickable}
                searchTerm={lowerSearch}
                onBoxClick={onBoxClick}
                interactive={!selectMode}
              />
            )}

            {/* Drag selection overlay */}
            {selectMode && normDrag && (normDrag.u1 > normDrag.u0 || normDrag.v1 > normDrag.v0) && (
              <div
                style={{
                  position: 'absolute',
                  left: `${normDrag.u0 * 100}%`,
                  top: `${normDrag.v0 * 100}%`,
                  width: `${(normDrag.u1 - normDrag.u0) * 100}%`,
                  height: `${(normDrag.v1 - normDrag.v0) * 100}%`,
                  border: '1px solid var(--cyan)',
                  background: 'rgba(57,229,255,0.12)',
                  boxShadow: '0 0 0 9999px rgba(2,6,10,0.45)',
                  pointerEvents: 'none',
                }}
              />
            )}

            {/* Selection commit toolbar */}
            {selectMode && canCommitDrag && normDrag && (
              <div
                style={{
                  position: 'absolute',
                  left: `${normDrag.u0 * 100}%`,
                  top: `calc(${normDrag.v1 * 100}% + 6px)`,
                  display: 'flex',
                  gap: 4,
                  background: 'rgba(2,6,10,0.9)',
                  border: '1px solid var(--line)',
                  padding: 3,
                  zIndex: 4,
                }}
              >
                <button
                  onClick={() => onCaptureSelection(normDrag)}
                  style={{ ...tinyBtn, padding: '4px 9px' }}
                >
                  CAPTURE SELECTION
                </button>
                <button
                  onClick={() => setDrag(null)}
                  style={{ ...tinyBtn, padding: '4px 9px', color: 'var(--ink-dim)' }}
                >
                  CLEAR
                </button>
              </div>
            )}
          </div>
        ) : screenRecordingMissing && !busy && isTauri ? (
          // Dedicated empty-state when TCC reports Screen Recording is not
          // granted. We surface this BEFORE the first capture attempt so the
          // user never has to trigger a failure to learn what's wrong.
          <div style={{ textAlign: 'center', padding: 30, maxWidth: 460 }}>
            <div
              style={{
                fontFamily: 'var(--display)',
                fontSize: 12,
                letterSpacing: '0.24em',
                color: 'var(--red)',
                fontWeight: 700,
              }}
            >
              SCREEN RECORDING · NOT GRANTED
            </div>
            <div
              style={{
                marginTop: 10,
                fontFamily: 'var(--mono)',
                fontSize: 10.5,
                color: 'var(--ink-2)',
                letterSpacing: '0.05em',
                lineHeight: 1.6,
              }}
            >
              macOS blocks `screencapture` until Sunny is enabled under
              System Settings → Privacy & Security → Screen Recording.
              After granting, relaunch Sunny so the new TCC state takes effect.
            </div>
            {onOpenScreenRecordingSettings && (
              <button
                onClick={onOpenScreenRecordingSettings}
                style={{ ...actionBtn, marginTop: 14, color: 'var(--red)', borderColor: 'rgba(255,77,94,0.5)' }}
              >
                OPEN SETTINGS
              </button>
            )}
          </div>
        ) : (
          <div style={{ textAlign: 'center', padding: 30 }}>
            <div
              style={{
                fontFamily: 'var(--display)',
                fontSize: 12,
                letterSpacing: '0.24em',
                color: 'var(--ink-dim)',
                fontWeight: 700,
              }}
            >
              {busy ? 'CAPTURING…' : isTauri ? 'PRESS CAPTURE · OR TAP SPACE' : 'SCREEN · TAURI RUNTIME REQUIRED'}
            </div>
            {error && (
              <div
                style={{
                  marginTop: 12,
                  fontFamily: 'var(--mono)',
                  fontSize: 10.5,
                  color: 'var(--red)',
                  letterSpacing: '0.08em',
                  maxWidth: 420,
                  lineHeight: 1.6,
                }}
              >
                {error}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Controls */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 10px',
          borderTop: '1px solid var(--line-soft)',
          flexWrap: 'wrap',
        }}
      >
        <button onClick={onRefresh} disabled={busy || !isTauri} style={{ ...actionBtn, opacity: !isTauri ? 0.4 : 1 }}>
          {busy ? 'WORKING…' : 'CAPTURE NOW'}
        </button>
        <button
          onClick={onToggleSelect}
          disabled={!isTauri || !capture}
          style={selectMode ? toggleOnBtn : { ...actionBtn, color: 'var(--cyan-2)' }}
          title="Drag a rectangle on the preview to capture just that region"
        >
          {selectMode ? 'SELECT · ON' : 'SELECT REGION'}
        </button>
        <button
          onClick={onToggleBoxes}
          disabled={!capture}
          style={showBoxes ? toggleOnBtn : ghostBtn}
          title={boxesClickable ? 'Show OCR boxes — click a word to click it on the real screen' : 'Show OCR boxes — click to copy word'}
        >
          {showBoxes ? 'BOXES · ON' : 'SHOW BOXES'}
        </button>

        {showBoxes && ocr && (
          <input
            value={searchTerm}
            onChange={e => onSearchTerm(e.target.value)}
            placeholder={`search ${ocr.boxes.length} words…`}
            style={{
              all: 'unset',
              padding: '5px 10px',
              minWidth: 140,
              border: '1px solid var(--line-soft)',
              background: 'rgba(2,6,10,0.55)',
              color: 'var(--ink)',
              fontFamily: 'var(--mono)',
              fontSize: 11,
            }}
          />
        )}
        {showBoxes && ocr && lowerSearch.length > 0 && (
          <span style={labelSmall}>{matchedCount} MATCH{matchedCount === 1 ? '' : 'ES'}</span>
        )}

        <span style={{ ...labelSmall, marginLeft: 'auto' }}>AUTO</span>
        <div style={{ display: 'flex', border: '1px solid var(--line-soft)' }}>
          {cadences.map(c => (
            <button
              key={c}
              onClick={() => onCadenceChange(c)}
              style={{
                all: 'unset',
                cursor: 'pointer',
                padding: '4px 10px',
                fontFamily: 'var(--mono)',
                fontSize: 10,
                letterSpacing: '0.12em',
                background: cadence === c ? 'rgba(57,229,255,0.18)' : 'transparent',
                color: cadence === c ? 'var(--cyan)' : 'var(--ink-dim)',
                borderRight: c === '60s' ? 'none' : '1px solid var(--line-soft)',
                fontWeight: cadence === c ? 700 : 400,
              }}
            >
              {c}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
