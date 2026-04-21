/**
 * OcrSection — screen OCR capture with text preview, block count,
 * and AI action. Extracted from InspectorPage.
 *
 * Upgraded with:
 *  - Text length and block stats
 *  - Highlighted keyword search in OCR text
 *  - Word count estimate
 *  - Better visual preview container
 */

import { useState } from 'react';
import {
  Section, Row, Chip, EmptyState,
  Toolbar, ToolbarButton, FilterInput, useFlashMessage,
} from '../_shared';
import { copyToClipboard } from '../../lib/clipboard';
import { downloadTextFile } from '../_shared/snapshots';
import { askSunny } from '../../lib/askSunny';
import type { OcrResult } from './api';

export function OcrSection({
  ocr,
  ocring,
  ocrCap,
  onRunOcr,
}: {
  ocr: OcrResult | null;
  ocring: boolean;
  ocrCap: number;
  onRunOcr: () => void;
}) {
  const { message: copyHint, flash } = useFlashMessage();
  const [search, setSearch] = useState('');

  const wordCount = ocr?.text ? ocr.text.split(/\s+/).filter(Boolean).length : 0;
  const charCount = ocr?.text?.length ?? 0;

  return (
    <Section
      title="SCREEN OCR"
      right={
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {ocr?.text && (
            <>
              <Chip tone="cyan">{wordCount} words</Chip>
              <ToolbarButton
                tone="violet"
                title="Copy raw OCR text"
                onClick={async () => {
                  const ok = await copyToClipboard(ocr.text);
                  flash(ok ? 'OCR text copied' : 'Copy failed');
                }}
              >
                COPY TEXT
              </ToolbarButton>
              <ToolbarButton
                tone="amber"
                title="Download full OCR payload"
                onClick={() => {
                  downloadTextFile(
                    `sunny-inspector-ocr-${Date.now()}.json`,
                    JSON.stringify(ocr, null, 2),
                    'application/json',
                  );
                  flash('OCR JSON download started');
                }}
              >
                OCR JSON
              </ToolbarButton>
            </>
          )}
          <ToolbarButton
            tone="green"
            onClick={onRunOcr}
            disabled={ocring}
          >
            {ocring ? 'READING…' : '◎ RUN OCR'}
          </ToolbarButton>
          {copyHint && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--green)' }}>{copyHint}</span>
          )}
        </span>
      }
    >
      {!ocr ? (
        <EmptyState
          title="Click RUN OCR to capture what's on screen"
          hint="Uses macOS Vision to read the whole display."
        />
      ) : (
        <>
          {/* Stats row */}
          <div style={{
            display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 8,
          }}>
            <Row label="characters" value={charCount.toLocaleString()} />
            <Row label="words" value={wordCount.toLocaleString()} />
            {ocr.blocks && ocr.blocks.length > 0 && (
              <Row
                label="blocks"
                value={<Chip tone="cyan">{String(ocr.blocks.length)} regions</Chip>}
                right="Vision layout"
              />
            )}
          </div>

          {/* Search within OCR text */}
          <Toolbar style={{ marginBottom: 6 }}>
            <FilterInput
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search OCR text…"
              aria-label="Search OCR text"
              spellCheck={false}
            />
          </Toolbar>

          {/* Text preview */}
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-2)',
            lineHeight: 1.55,
            padding: '12px 14px',
            border: '1px solid var(--line-soft)',
            borderLeft: '3px solid var(--cyan)',
            background: 'rgba(0, 0, 0, 0.35)',
            whiteSpace: 'pre-wrap',
            maxHeight: 260, overflowY: 'auto',
            wordBreak: 'break-word',
          }}>
            {search.trim()
              ? highlightText(ocr.text || '(no text detected)', search.trim())
              : (ocr.text || '(no text detected)')}
          </div>

          {/* AI action */}
          <Toolbar style={{ marginTop: 8 }}>
            <ToolbarButton
              tone="violet"
              onClick={() => askSunny(
                `Here's what was on my screen:\n\n${ocr.text.slice(0, ocrCap)}\n\nWhat should I do next given this context?`,
                'inspector',
              )}
            >
              ✦ ASK SUNNY ABOUT SCREEN
            </ToolbarButton>
            <ToolbarButton
              tone="amber"
              onClick={() => askSunny(
                `Summarize the following screen text concisely:\n\n${ocr.text.slice(0, ocrCap)}`,
                'inspector',
              )}
            >
              ◎ SUMMARIZE
            </ToolbarButton>
          </Toolbar>
        </>
      )}
    </Section>
  );
}

/** Simple substring highlight — wraps matches in a styled span. */
function highlightText(text: string, term: string): React.ReactNode {
  if (!term) return text;
  const lower = text.toLowerCase();
  const searchLower = term.toLowerCase();
  const parts: React.ReactNode[] = [];
  let lastIdx = 0;

  let idx = lower.indexOf(searchLower);
  while (idx >= 0) {
    if (idx > lastIdx) {
      parts.push(text.slice(lastIdx, idx));
    }
    parts.push(
      <span key={idx} style={{
        background: 'rgba(255, 215, 0, 0.25)',
        color: 'var(--gold)',
        fontWeight: 700,
      }}>
        {text.slice(idx, idx + term.length)}
      </span>
    );
    lastIdx = idx + term.length;
    idx = lower.indexOf(searchLower, lastIdx);
  }
  if (lastIdx < text.length) {
    parts.push(text.slice(lastIdx));
  }
  return parts.length > 0 ? <>{parts}</> : text;
}
