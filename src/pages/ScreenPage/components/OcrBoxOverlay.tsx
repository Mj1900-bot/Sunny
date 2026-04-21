import type { OcrResult, OcrBox } from '../types';

export type OcrBoxOverlayProps = {
  ocr: OcrResult;
  clickable: boolean;
  searchTerm: string;
  onBoxClick: (b: OcrBox) => void;
  interactive: boolean;
};

export function OcrBoxOverlay({ ocr, clickable, searchTerm, onBoxClick, interactive }: OcrBoxOverlayProps) {
  if (ocr.width === 0 || ocr.height === 0) return null;
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
      }}
    >
      {ocr.boxes.map((b, i) => {
        const text = b.text.trim();
        if (!text) return null;
        const highlighted = searchTerm.length > 0 && text.toLowerCase().includes(searchTerm);
        const dimmed = searchTerm.length > 0 && !highlighted;
        const left = (b.x / ocr.width) * 100;
        const top = (b.y / ocr.height) * 100;
        const width = (b.w / ocr.width) * 100;
        const height = (b.h / ocr.height) * 100;
        const borderColor = highlighted ? 'var(--amber)' : 'rgba(57,229,255,0.55)';
        const bg = highlighted ? 'rgba(255,179,71,0.18)' : 'rgba(57,229,255,0.06)';
        return (
          <button
            key={`${i}-${b.x}-${b.y}`}
            type="button"
            onClick={e => {
              e.stopPropagation();
              onBoxClick(b);
            }}
            title={`${text} · conf ${b.confidence.toFixed(0)}${clickable ? ' · click to click on screen' : ' · click to copy'}`}
            style={{
              all: 'unset',
              position: 'absolute',
              left: `${left}%`,
              top: `${top}%`,
              width: `${width}%`,
              height: `${height}%`,
              border: `1px solid ${borderColor}`,
              background: bg,
              cursor: interactive ? 'pointer' : 'default',
              pointerEvents: interactive ? 'auto' : 'none',
              opacity: dimmed ? 0.25 : 1,
              boxSizing: 'border-box',
            }}
          />
        );
      })}
    </div>
  );
}
