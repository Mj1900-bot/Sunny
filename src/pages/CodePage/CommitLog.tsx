/**
 * CommitLog — premium commit history with:
 *  · Timeline connector dots
 *  · Commit-type coloring (feat/fix/refactor/etc.)
 *  · Copy SHA to clipboard
 *  · Expandable detail (git show --stat)
 *  · Author initial avatar
 *  · Load-more button
 */

import { useCallback, useState, type CSSProperties } from 'react';
import { Section, ScrollList, Avatar } from '../_shared';
import { copyToClipboard } from '../../lib/clipboard';
import { commitDetail, type CommitEntry, type CommitDetail } from './api';

// ---------------------------------------------------------------------------
// Commit type classification
// ---------------------------------------------------------------------------

type CommitType = 'feat' | 'fix' | 'refactor' | 'docs' | 'test' | 'perf' | 'chore' | 'ci' | 'other';

const TYPE_TONE: Record<CommitType, string> = {
  feat: 'var(--green)',
  fix: 'var(--red)',
  refactor: 'var(--violet)',
  docs: 'var(--cyan)',
  test: 'var(--amber)',
  perf: 'var(--gold)',
  chore: 'var(--ink-dim)',
  ci: 'var(--teal)',
  other: 'var(--ink-dim)',
};

const TYPE_LABEL: Record<CommitType, string> = {
  feat: 'FEAT',
  fix: 'FIX',
  refactor: 'REFACTOR',
  docs: 'DOCS',
  test: 'TEST',
  perf: 'PERF',
  chore: 'CHORE',
  ci: 'CI',
  other: '—',
};

function classifyCommit(subject: string): CommitType {
  const lower = subject.toLowerCase();
  if (lower.startsWith('feat')) return 'feat';
  if (lower.startsWith('fix')) return 'fix';
  if (lower.startsWith('refactor')) return 'refactor';
  if (lower.startsWith('docs')) return 'docs';
  if (lower.startsWith('test')) return 'test';
  if (lower.startsWith('perf')) return 'perf';
  if (lower.startsWith('chore')) return 'chore';
  if (lower.startsWith('ci')) return 'ci';
  return 'other';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CommitLog({
  entries, loading, root, onLoadMore,
}: {
  entries: ReadonlyArray<CommitEntry>;
  loading: boolean;
  root: string;
  onLoadMore?: () => void;
}) {
  const [expandedSha, setExpandedSha] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, CommitDetail>>({});
  const [detailLoading, setDetailLoading] = useState<string | null>(null);
  const [copiedSha, setCopiedSha] = useState<string | null>(null);

  const handleExpand = useCallback(async (sha: string) => {
    if (expandedSha === sha) { setExpandedSha(null); return; }
    setExpandedSha(sha);
    if (details[sha]) return;
    setDetailLoading(sha);
    try {
      const d = await commitDetail(root, sha);
      setDetails(prev => ({ ...prev, [sha]: d }));
    } finally {
      setDetailLoading(null);
    }
  }, [expandedSha, details, root]);

  const handleCopySha = useCallback(async (sha: string) => {
    const ok = await copyToClipboard(sha);
    if (ok) {
      setCopiedSha(sha);
      window.setTimeout(() => setCopiedSha(null), 1500);
    }
  }, []);

  return (
    <Section title="COMMIT HISTORY" right={`last ${entries.length}`}>
      {loading && entries.length === 0 ? (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-dim)', padding: 8 }}>
          loading…
        </div>
      ) : entries.length === 0 ? (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-dim)', padding: 8 }}>
          no commits yet
        </div>
      ) : (
        <ScrollList maxHeight={360}>
          {entries.map((e, i) => {
            const type = classifyCommit(e.subject);
            const typeColor = TYPE_TONE[type];
            const isExpanded = expandedSha === e.sha;
            const detail = details[e.sha];
            const isLast = i === entries.length - 1;
            return (
              <div key={e.sha} style={{ position: 'relative' }}>
                {/* Timeline connector */}
                {!isLast && (
                  <div style={{
                    position: 'absolute',
                    left: 14,
                    top: 24,
                    bottom: 0,
                    width: 1,
                    background: 'var(--line-soft)',
                  }} />
                )}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '28px 1fr',
                    gap: 8,
                    padding: '6px 8px',
                    cursor: 'pointer',
                    transition: 'background 100ms ease',
                  }}
                  onClick={() => { void handleExpand(e.sha); }}
                  onMouseEnter={ev => { ev.currentTarget.style.background = 'rgba(57, 229, 255, 0.04)'; }}
                  onMouseLeave={ev => { ev.currentTarget.style.background = 'transparent'; }}
                >
                  {/* Timeline dot + avatar */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                    <div style={{
                      width: 8, height: 8, borderRadius: '50%',
                      background: typeColor,
                      boxShadow: `0 0 4px ${typeColor}`,
                      flexShrink: 0,
                      zIndex: 1,
                    }} />
                    <Avatar name={e.author} size={20} />
                  </div>

                  {/* Commit info */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                    {/* Subject row */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {type !== 'other' && (
                        <span style={{
                          fontFamily: 'var(--display)',
                          fontSize: 7,
                          letterSpacing: '0.16em',
                          fontWeight: 700,
                          color: typeColor,
                          border: `1px solid ${typeColor}`,
                          padding: '1px 5px',
                          flexShrink: 0,
                        }}>
                          {TYPE_LABEL[type]}
                        </span>
                      )}
                      <span style={{
                        fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        flex: 1,
                      }}>{e.subject}</span>
                    </div>

                    {/* Meta row */}
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)',
                      letterSpacing: '0.04em',
                    }}>
                      <button
                        type="button"
                        title="Click to copy SHA"
                        onClick={ev => { ev.stopPropagation(); void handleCopySha(e.sha); }}
                        style={{
                          all: 'unset', cursor: 'pointer',
                          fontFamily: 'var(--mono)', fontSize: 10.5,
                          color: copiedSha === e.sha ? 'var(--green)' : 'var(--violet)',
                          transition: 'color 150ms ease',
                        }}
                      >
                        {copiedSha === e.sha ? '✓ copied' : e.sha}
                      </button>
                      <span>·</span>
                      <span>{e.author}</span>
                      <span>·</span>
                      <span>{e.relDate}</span>
                      <span style={{
                        marginLeft: 'auto',
                        fontSize: 9,
                        color: 'var(--ink-dim)',
                      }}>
                        {isExpanded ? '▾' : '▸'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Expanded detail */}
                {isExpanded && (
                  <div style={{
                    marginLeft: 36, marginRight: 8,
                    padding: '6px 10px', marginBottom: 4,
                    border: '1px solid var(--line-soft)',
                    background: 'rgba(6, 14, 22, 0.5)',
                    animation: 'fadeSlideIn 150ms ease-out',
                  }}>
                    {detailLoading === e.sha ? (
                      <div style={dimText}>loading detail…</div>
                    ) : detail ? (
                      <>
                        {detail.message && (
                          <div style={{
                            fontFamily: 'var(--mono)', fontSize: 11,
                            color: 'var(--ink-2)', marginBottom: 6,
                            whiteSpace: 'pre-wrap', lineHeight: 1.5,
                          }}>
                            {detail.message}
                          </div>
                        )}
                        {detail.stats.length > 0 && (
                          <div style={{
                            borderTop: '1px dashed var(--line-soft)',
                            paddingTop: 4,
                            display: 'flex', flexDirection: 'column', gap: 1,
                          }}>
                            {detail.stats.map((s, si) => (
                              <div
                                key={si}
                                style={{
                                  fontFamily: 'var(--mono)', fontSize: 10,
                                  color: s.includes('+') && s.includes('-')
                                    ? 'var(--ink-2)'
                                    : s.includes('+') ? 'var(--green)' : s.includes('-') ? 'var(--red)' : 'var(--ink-dim)',
                                }}
                              >
                                {s}
                              </div>
                            ))}
                          </div>
                        )}
                      </>
                    ) : (
                      <div style={dimText}>no detail available</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {/* Load more */}
          {onLoadMore && (
            <div style={{ padding: '8px 0', textAlign: 'center' }}>
              <button
                type="button"
                onClick={onLoadMore}
                style={{
                  all: 'unset', cursor: 'pointer',
                  fontFamily: 'var(--display)', fontSize: 9,
                  letterSpacing: '0.2em', fontWeight: 700,
                  color: 'var(--cyan)',
                  padding: '6px 14px',
                  border: '1px solid var(--cyan)',
                  background: 'rgba(57, 229, 255, 0.06)',
                  transition: 'background 120ms ease',
                }}
              >
                LOAD MORE COMMITS
              </button>
            </div>
          )}
        </ScrollList>
      )}
    </Section>
  );
}

const dimText: CSSProperties = {
  fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)', fontStyle: 'italic',
};
