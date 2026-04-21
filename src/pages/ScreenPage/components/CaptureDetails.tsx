import type { Capture, OcrResult, OcrOptions } from '../types';
import { PSM_PRESETS } from '../constants';
import { labelSmall, valueMono, ghostBtn, actionBtn } from '../styles';
import { formatBytes, dataUrl } from '../utils';

export type CaptureDetailsProps = {
  capture: Capture | null;
  ocr: OcrResult | null;
  ocrBusy: boolean;
  ocrError: string | null;
  ocrOptions: OcrOptions;
  preserveLayout: boolean;
  onSetOcrOptions: (next: OcrOptions) => void;
  onSetPreserveLayout: (next: boolean) => void;
  onRunOcr: () => void;
  onCopyOcr: () => void;
  onDownloadOcr: () => void;
  onDownload: () => void;
  onCopyImage: () => void;
  onCopyToClipboardShell: () => void;
  onClear: () => void;
};

export function CaptureDetails({
  capture, ocr, ocrBusy, ocrError,
  ocrOptions, preserveLayout, onSetOcrOptions, onSetPreserveLayout,
  onRunOcr, onCopyOcr, onDownloadOcr, onDownload, onCopyImage, onCopyToClipboardShell, onClear,
}: CaptureDetailsProps) {
  if (!capture) {
    return (
      <div
        style={{
          border: '1px solid var(--line-soft)',
          padding: 14,
          background: 'rgba(6,14,22,0.4)',
          color: 'var(--ink-dim)',
          fontFamily: 'var(--mono)',
          fontSize: 11,
          letterSpacing: '0.1em',
        }}
      >
        NO CAPTURE YET · take one to enable OCR, download, and clipboard actions. Hotkeys: SPACE capture · ⌘R recapture · O ocr · D download · C copy.
      </div>
    );
  }

  const avgConf =
    ocr && ocr.boxes.length > 0
      ? ocr.boxes.reduce((s, b) => s + b.confidence, 0) / ocr.boxes.length
      : 0;

  const ocrText = ocr?.text ?? '';
  const trimmedOcrText = ocrText.trim();
  // Stats: count non-empty lines, words (whitespace split), chars (raw length).
  const ocrLineCount = trimmedOcrText.length === 0
    ? 0
    : ocrText.split('\n').filter(l => l.trim().length > 0).length;
  const ocrWordCount = trimmedOcrText.length === 0
    ? 0
    : trimmedOcrText.split(/\s+/).filter(Boolean).length;
  const ocrCharCount = ocrText.length;
  const activePsmLabel =
    PSM_PRESETS.find(p => p.psm === ocrOptions.psm)?.label ?? `PSM${ocrOptions.psm}`;

  return (
    <div
      style={{
        border: '1px solid var(--line-soft)',
        background: 'rgba(6,14,22,0.4)',
        display: 'grid',
        gridTemplateColumns: '220px 1fr',
        gap: 0,
      }}
    >
      {/* Thumbnail + meta */}
      <div style={{ padding: 10, borderRight: '1px solid var(--line-soft)' }}>
        <img
          src={dataUrl(capture.image)}
          alt="last capture"
          style={{
            width: '100%',
            height: 120,
            objectFit: 'cover',
            border: '1px solid var(--line-soft)',
            display: 'block',
          }}
        />
        <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '60px 1fr', gap: '2px 8px' }}>
          <span style={labelSmall}>SRC</span>
          <span style={{ ...valueMono, color: 'var(--cyan)' }}>{capture.source}</span>
          <span style={labelSmall}>DIMS</span>
          <span style={valueMono}>{capture.image.width}×{capture.image.height}</span>
          <span style={labelSmall}>SIZE</span>
          <span style={valueMono}>{formatBytes(capture.image.bytes_len)}</span>
          {capture.region && (
            <>
              <span style={labelSmall}>AT</span>
              <span style={valueMono}>
                ({capture.region.x},{capture.region.y}) · {capture.region.w}×{capture.region.h}
              </span>
            </>
          )}
          {capture.app && (
            <>
              <span style={labelSmall}>APP</span>
              <span style={{ ...valueMono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {capture.app}
              </span>
            </>
          )}
        </div>
        <div style={{ display: 'flex', gap: 4, marginTop: 10, flexWrap: 'wrap' }}>
          <button onClick={onDownload} style={{ ...ghostBtn, padding: '4px 8px', fontSize: 9.5 }}>
            DOWNLOAD
          </button>
          <button onClick={onCopyImage} style={{ ...ghostBtn, padding: '4px 8px', fontSize: 9.5 }}>
            COPY IMG
          </button>
          <button onClick={onCopyToClipboardShell} style={{ ...ghostBtn, padding: '4px 8px', fontSize: 9.5 }}>
            CLIP · SHELL
          </button>
          <button
            onClick={onClear}
            style={{ ...ghostBtn, padding: '4px 8px', fontSize: 9.5, color: 'var(--red)', borderColor: 'rgba(255,77,94,0.4)' }}
          >
            CLEAR
          </button>
        </div>
      </div>

      {/* OCR */}
      <div style={{ padding: 10, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, gap: 8 }}>
          <span
            style={{
              fontFamily: 'var(--display)',
              fontSize: 10.5,
              letterSpacing: '0.22em',
              color: 'var(--cyan)',
              fontWeight: 700,
            }}
          >
            OCR
            {ocr && (
              <span style={{ color: 'var(--ink-dim)', marginLeft: 10, fontSize: 10 }}>
                · {activePsmLabel} · {ocr.boxes.length} BOXES · {avgConf.toFixed(0)}% CONF · {ocr.engine}
              </span>
            )}
          </span>
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              onClick={onCopyOcr}
              disabled={!ocr || trimmedOcrText.length === 0}
              style={{ ...ghostBtn, padding: '4px 10px', opacity: !ocr || trimmedOcrText.length === 0 ? 0.4 : 1 }}
              title="Copy the full transcript to the clipboard"
            >
              COPY TEXT
            </button>
            <button
              onClick={onDownloadOcr}
              disabled={!ocr || trimmedOcrText.length === 0}
              style={{ ...ghostBtn, padding: '4px 10px', opacity: !ocr || trimmedOcrText.length === 0 ? 0.4 : 1 }}
              title="Download the transcript as a .txt file"
            >
              SAVE .TXT
            </button>
            <button onClick={onRunOcr} disabled={ocrBusy} style={{ ...actionBtn, padding: '4px 10px' }}>
              {ocrBusy ? 'READING…' : ocr ? 'RE-RUN OCR' : 'RUN OCR'}
            </button>
          </div>
        </div>

        {/* Tuning row: PSM preset, min-conf floor, preserve-layout toggle. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '6px 8px',
            border: '1px solid rgba(57,229,255,0.08)',
            background: 'rgba(2,6,10,0.4)',
            marginBottom: 6,
            flexWrap: 'wrap',
          }}
        >
          <span style={{ ...labelSmall, fontSize: 9.5 }}>MODE</span>
          <div style={{ display: 'flex', border: '1px solid var(--line-soft)' }}>
            {PSM_PRESETS.map(p => {
              const active = ocrOptions.psm === p.psm;
              return (
                <button
                  key={p.psm}
                  onClick={() => onSetOcrOptions({ ...ocrOptions, psm: p.psm })}
                  title={p.hint}
                  style={{
                    all: 'unset',
                    cursor: 'pointer',
                    padding: '3px 9px',
                    fontFamily: 'var(--mono)',
                    fontSize: 9.5,
                    letterSpacing: '0.12em',
                    background: active ? 'rgba(57,229,255,0.18)' : 'transparent',
                    color: active ? 'var(--cyan)' : 'var(--ink-dim)',
                    borderRight: p.psm === PSM_PRESETS[PSM_PRESETS.length - 1].psm ? 'none' : '1px solid var(--line-soft)',
                    fontWeight: active ? 700 : 500,
                  }}
                >
                  {p.label}
                </button>
              );
            })}
          </div>

          <span style={{ ...labelSmall, fontSize: 9.5, marginLeft: 6 }}>
            MIN · {Math.round(ocrOptions.minConf)}%
          </span>
          <input
            type="range"
            min={0}
            max={95}
            step={5}
            value={ocrOptions.minConf}
            onChange={e => onSetOcrOptions({ ...ocrOptions, minConf: Number(e.target.value) })}
            title="Drop words whose tesseract confidence is below this floor"
            aria-label="OCR minimum confidence"
            style={{ width: 110, accentColor: 'var(--cyan)' }}
          />

          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              cursor: 'pointer',
              fontFamily: 'var(--mono)',
              fontSize: 9.5,
              letterSpacing: '0.12em',
              color: preserveLayout ? 'var(--cyan)' : 'var(--ink-dim)',
              marginLeft: 4,
            }}
            title="Render the transcript with preserved horizontal whitespace — columns in UI text stay aligned."
          >
            <input
              type="checkbox"
              checked={preserveLayout}
              onChange={e => onSetPreserveLayout(e.target.checked)}
              style={{ accentColor: 'var(--cyan)' }}
            />
            PRESERVE LAYOUT
          </label>

          {ocr && (
            <span style={{ ...labelSmall, fontSize: 9.5, marginLeft: 'auto' }}>
              {ocrLineCount} LINE{ocrLineCount === 1 ? '' : 'S'} · {ocrWordCount} WORD{ocrWordCount === 1 ? '' : 'S'} · {ocrCharCount} CHAR{ocrCharCount === 1 ? '' : 'S'}
            </span>
          )}
        </div>

        <div
          style={{
            flex: 1,
            minHeight: 140,
            maxHeight: 260,
            overflow: 'auto',
            border: '1px solid var(--line-soft)',
            background: 'rgba(2,6,10,0.55)',
            padding: 10,
            fontFamily: 'var(--mono)',
            fontSize: 11.5,
            lineHeight: 1.55,
            color: 'var(--ink)',
            // `pre` keeps runs of spaces produced by the backend's layout
            // reconstruction. `pre-wrap` falls back to normal word-break when
            // the user opts out of layout preservation.
            whiteSpace: preserveLayout ? 'pre' : 'pre-wrap',
            wordBreak: preserveLayout ? 'normal' : 'break-word',
          }}
        >
          {ocrError ? (
            <span style={{ color: 'var(--red)' }}>{ocrError}</span>
          ) : ocr ? (
            trimmedOcrText || <span style={{ color: 'var(--ink-dim)' }}>No text detected.</span>
          ) : (
            <span style={{ color: 'var(--ink-dim)' }}>
              Tap RUN OCR to extract text from this capture. Requires `tesseract` (brew install tesseract).
              Tune MODE and MIN above for dense UI text: try SPARSE + 40% for busy desktops.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
