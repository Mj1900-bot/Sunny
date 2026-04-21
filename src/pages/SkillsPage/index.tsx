/**
 * SKILLS — procedural memory workshop (premium edition).
 *
 * Lists every ProceduralSkill Sunny has learned, with:
 *  • Hero stat dashboard with enriched cards
 *  • Health heatmap showing skill health at a glance
 *  • View mode toggle (grid vs. list)
 *  • Bulk export to JSON
 *  • Skill insights analytics panel
 *  • Filter, sort, search, and inline edit
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ModuleView } from '../../components/ModuleView';
import {
  PageGrid, PageCell, EmptyState, StatBlock, ScrollList,
  usePoll, Toolbar, ToolbarButton, useDebounced, relTime,
  KeyHint, ProgressRing,
} from '../_shared';
import { copyToClipboard } from '../../lib/clipboard';
import { askSunny } from '../../lib/askSunny';
import { SkillCard } from './SkillCard';
import { EditDrawer } from './EditDrawer';
import { SkillEditor } from './SkillEditor';
import { SkillImport } from './SkillImport';
import { SkillExport } from './SkillExport';
import { SkillInsights } from './SkillInsights';
import { RouterLog } from './RouterLog';
import { deleteSkill, listSkills, updateSkill, type ProceduralSkill } from './api';
import {
  getOwnIdentity,
  listTrustedSigners,
  type TrustedSignerMap,
  type IdentityPubInfo,
} from '../../lib/skillSignature';
import {
  buildSkillBundle,
  serializeBundleArray,
  shortFingerprint,
  suggestedBulkFilename,
  resolvePublicKey,
  type SkillBundle,
} from '../../lib/skillExport';
import { invokeSafe, isTauri } from '../../lib/tauri';

type SortKey = 'name' | 'uses_desc' | 'recent' | 'success_desc';
type QuickFilter = 'all' | 'unused' | 'risk';
type ViewMode = 'grid' | 'list';

function compareSkills(a: ProceduralSkill, b: ProceduralSkill, sort: SortKey): number {
  switch (sort) {
    case 'name':
      return a.name.localeCompare(b.name);
    case 'uses_desc':
      return b.uses_count - a.uses_count || a.name.localeCompare(b.name);
    case 'recent': {
      const ta = a.last_used_at ?? 0;
      const tb = b.last_used_at ?? 0;
      if (tb !== ta) return tb - ta;
      return a.name.localeCompare(b.name);
    }
    case 'success_desc': {
      const ra = a.uses_count > 0 ? a.success_count / a.uses_count : -1;
      const rb = b.uses_count > 0 ? b.success_count / b.uses_count : -1;
      if (rb !== ra) return rb - ra;
      return a.name.localeCompare(b.name);
    }
    default:
      return 0;
  }
}

/** Health tone for a skill based on success rate. */
function healthTone(s: ProceduralSkill): 'green' | 'amber' | 'red' | 'cyan' {
  if (s.uses_count === 0) return 'cyan';
  const rate = (s.success_count / s.uses_count) * 100;
  if (rate >= 80) return 'green';
  if (rate >= 50) return 'amber';
  return 'red';
}

const HEALTH_COLORS: Record<string, string> = {
  green: 'var(--green)',
  amber: 'var(--amber)',
  red: 'var(--red)',
  cyan: 'var(--ink-dim)',
};

const selectStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--ink)',
  background: 'rgba(0, 0, 0, 0.35)',
  border: '1px solid var(--line-soft)',
  padding: '6px 10px',
  borderRadius: 2,
  cursor: 'pointer',
  minWidth: 140,
};

export function SkillsPage() {
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query, 200);
  const [sort, setSort] = useState<SortKey>('name');
  const [quick, setQuick] = useState<QuickFilter>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [listFlash, setListFlash] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [authoring, setAuthoring] = useState(false);
  // Sprint-12 η — toggle for the signed-manifest import panel.
  const [importing, setImporting] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [showInsights, setShowInsights] = useState(false);
  // Sprint-13 η — SHARE modal + identity/trust state for bundle building.
  // Loaded ONCE on mount (and re-fetched only on explicit reload) because
  // neither the user's identity nor their trust-store changes during a
  // session in a way that matters for export. Storing them at this level
  // keeps each SkillCard stateless w.r.t. crypto.
  const [sharing, setSharing] = useState<SkillBundle | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [ownIdentity, setOwnIdentity] = useState<IdentityPubInfo | null>(null);
  const [trustedMap, setTrustedMap] = useState<TrustedSignerMap>({ signers: {} });
  const { data: skills, loading, error, reload } = usePoll(listSkills, 30_000);

  useEffect(() => {
    if (!isTauri) return;
    // Fire-and-forget: if either call fails (backend unavailable, key not
    // yet initialised, etc.) we degrade gracefully — sharing a self-signed
    // skill will be refused with a legible "missing public key" toast.
    let cancelled = false;
    void (async () => {
      const [own, trusted] = await Promise.all([getOwnIdentity(), listTrustedSigners()]);
      if (cancelled) return;
      setOwnIdentity(own);
      setTrustedMap(trusted);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Esc closes the edit drawer, the authoring panel, or the import
  // panel — whichever is open (import > authoring > editor in priority).
  useEffect(() => {
    if (!editingId && !authoring && !importing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (importing) setImporting(false);
      else if (authoring) setAuthoring(false);
      else setEditingId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editingId, authoring, importing]);

  // ⌘F focuses search when not typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'f') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const displayed = useMemo(() => {
    let list = [...(skills ?? [])];
    if (quick === 'unused') list = list.filter(s => s.uses_count === 0);
    if (quick === 'risk') {
      list = list.filter(s => s.uses_count > 0 && s.success_count / s.uses_count < 0.5);
    }
    const q = debounced.trim().toLowerCase();
    if (q) {
      list = list.filter(s =>
        s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
      );
    }
    list.sort((a, b) => compareSkills(a, b, sort));
    return list;
  }, [skills, debounced, quick, sort]);

  const flash = useCallback((msg: string) => {
    setListFlash(msg);
    window.setTimeout(() => setListFlash(null), 2200);
  }, []);

  const copySkillList = useCallback(async () => {
    if (displayed.length === 0) {
      flash('Nothing to copy');
      return;
    }
    const lines = displayed.map(s => {
      const rate = s.uses_count > 0 ? `${((s.success_count / s.uses_count) * 100).toFixed(0)}%` : '—';
      return `• ${s.name} (${rate} · ${s.uses_count} uses)\n  ${s.description.replace(/\n/g, ' ').slice(0, 200)}`;
    });
    const header = `Skills — ${displayed.length} shown · sort ${sort} · filter ${quick}`;
    const ok = await copyToClipboard(`${header}\n\n${lines.join('\n\n')}`);
    flash(ok ? 'List copied to clipboard' : 'Copy failed');
  }, [displayed, sort, quick, flash]);

  const exportJson = useCallback(() => {
    if (!skills || skills.length === 0) {
      flash('No skills to export');
      return;
    }
    const data = JSON.stringify(skills, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sunny-skills-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    flash('Skills exported to JSON');
  }, [skills, flash]);

  // ----- Sprint-13 η — SHARE (single) and EXPORT ALL (bulk) -----------------

  /** Build a bundle for a single skill and open the share modal. */
  const openShare = useCallback((skill: ProceduralSkill) => {
    setShareError(null);
    const pk = skill.signer_fingerprint
      ? resolvePublicKey(
          skill.signer_fingerprint,
          ownIdentity?.fingerprint ?? null,
          ownIdentity?.public_key ?? null,
          trustedMap.signers,
        )
      : null;
    const { bundle, refusal } = buildSkillBundle(skill, pk);
    if (bundle) {
      setSharing(bundle);
      return;
    }
    if (refusal?.kind === 'unsigned') {
      flash(`Cannot share "${refusal.skillName}" — skill is unsigned.`);
    } else if (refusal?.kind === 'missing_pubkey') {
      flash(
        `Cannot share "${refusal.skillName}" — public key for signer ${shortFingerprint(
          refusal.fingerprint,
        )} is not in the trust store.`,
      );
    }
  }, [ownIdentity, trustedMap, flash]);

  /**
   * Bundle every SIGNED skill into a single JSON array and save it via the
   * native file dialog.  Unsigned skills are silently skipped — the bulk
   * export is explicitly for cross-device migration of provenance-bearing
   * artefacts.  A post-save toast tells the user how many were skipped so
   * the count reconciliation is visible, not magic.
   */
  const exportAllSigned = useCallback(async () => {
    if (!skills || skills.length === 0) {
      flash('No skills to export');
      return;
    }
    const bundles: SkillBundle[] = [];
    let unsigned = 0;
    let missingKey = 0;
    for (const s of skills) {
      const pk = s.signer_fingerprint
        ? resolvePublicKey(
            s.signer_fingerprint,
            ownIdentity?.fingerprint ?? null,
            ownIdentity?.public_key ?? null,
            trustedMap.signers,
          )
        : null;
      const { bundle, refusal } = buildSkillBundle(s, pk);
      if (bundle) bundles.push(bundle);
      else if (refusal?.kind === 'unsigned') unsigned += 1;
      else if (refusal?.kind === 'missing_pubkey') missingKey += 1;
    }
    if (bundles.length === 0) {
      flash(`No signed skills to export (${unsigned} unsigned, ${missingKey} no key).`);
      return;
    }
    const json = serializeBundleArray(bundles);
    const suggested = suggestedBulkFilename();
    try {
      if (isTauri) {
        const path = await invokeSafe<string | null>('skill_export_save_bulk', {
          json,
          suggestedName: suggested,
        });
        if (path) {
          flash(
            `Exported ${bundles.length} signed skill${bundles.length === 1 ? '' : 's'} → ${path}` +
              (unsigned + missingKey > 0 ? ` (${unsigned + missingKey} skipped)` : ''),
          );
        }
      } else {
        // Browser fallback (vitest / dev-server).
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = suggested;
        a.click();
        URL.revokeObjectURL(url);
        flash(`Exported ${bundles.length} signed skill${bundles.length === 1 ? '' : 's'}`);
      }
    } catch (e) {
      setShareError(e instanceof Error ? e.message : String(e));
    }
  }, [skills, ownIdentity, trustedMap, flash]);

  const editing = skills?.find(s => s.id === editingId) ?? null;

  // Aggregate stats
  const totalUses = (skills ?? []).reduce((n, s) => n + s.uses_count, 0);
  const totalSucc = (skills ?? []).reduce((n, s) => n + s.success_count, 0);
  const rate = totalUses > 0 ? (totalSucc / totalUses) * 100 : 0;

  const leastUsed: ProceduralSkill | null = useMemo(() => {
    const used = (skills ?? []).filter(s => s.uses_count > 0);
    if (used.length === 0) return null;
    return used.reduce((a, b) => a.uses_count <= b.uses_count ? a : b);
  }, [skills]);

  const stalest: ProceduralSkill | null = useMemo(() => {
    const used = (skills ?? []).filter(s => s.last_used_at !== null);
    if (used.length === 0) return null;
    return used.reduce((a, b) =>
      (a.last_used_at ?? 0) <= (b.last_used_at ?? 0) ? a : b,
    );
  }, [skills]);

  const mutate = async (op: () => Promise<void>) => {
    setMutationError(null);
    try { await op(); reload(); }
    catch (e) { setMutationError(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <ModuleView title="SKILLS · PROCEDURAL">
      <PageGrid>
        {/* Row 1 — enhanced stats with progress ring */}
        <PageCell span={12}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            animation: 'fadeSlideIn 200ms ease-out',
          }}>
            {/* Overall health ring */}
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 4,
              padding: '8px 14px',
              border: '1px solid var(--line-soft)',
              background: 'rgba(6, 14, 22, 0.5)',
            }}>
              <ProgressRing
                progress={rate / 100}
                size={56}
                tone={rate >= 70 ? 'green' : rate >= 40 ? 'amber' : 'cyan'}
              />
              <span style={{
                fontFamily: 'var(--display)',
                fontSize: 7,
                letterSpacing: '0.22em',
                color: 'var(--ink-dim)',
                fontWeight: 700,
              }}>HEALTH</span>
            </div>
            <div style={{
              flex: 1,
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
              gap: 8,
            }}>
              <StatBlock label="SKILLS" value={String((skills ?? []).length)} tone="cyan" />
              <StatBlock label="USES" value={String(totalUses)} tone="violet" />
              <StatBlock label="SUCCESS" value={`${rate.toFixed(0)}%`} tone={rate >= 70 ? 'green' : rate >= 40 ? 'amber' : 'red'} />
              <StatBlock label="UNUSED" value={String((skills ?? []).filter(s => s.uses_count === 0).length)} tone="gold" />
              <StatBlock
                label="LEAST USED"
                value={leastUsed ? String(leastUsed.uses_count) : '—'}
                sub={leastUsed ? leastUsed.name.slice(0, 14) : undefined}
                tone="amber"
              />
              <StatBlock
                label="STALEST"
                value={stalest?.last_used_at ? relTime(stalest.last_used_at) : '—'}
                sub={stalest ? stalest.name.slice(0, 14) : undefined}
                tone="red"
              />
            </div>
          </div>
        </PageCell>

        {/* Health heatmap */}
        {skills && skills.length > 0 && (
          <PageCell span={12}>
            <div style={{
              padding: '8px 12px',
              border: '1px solid var(--line-soft)',
              background: 'rgba(6, 14, 22, 0.4)',
              animation: 'fadeSlideIn 300ms ease-out',
            }}>
              <div style={{
                fontFamily: 'var(--display)',
                fontSize: 8,
                letterSpacing: '0.24em',
                color: 'var(--ink-dim)',
                fontWeight: 700,
                marginBottom: 6,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}>
                SKILL HEALTH MAP
                <span style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 9,
                  color: 'var(--ink-dim)',
                  letterSpacing: '0.06em',
                  fontWeight: 500,
                }}>
                  hover for details
                </span>
              </div>
              <div style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 3,
              }}>
                {skills.map(s => {
                  const tone = healthTone(s);
                  const color = HEALTH_COLORS[tone];
                  return (
                    <div
                      key={s.id}
                      className="heatmap-cell"
                      title={`${s.name}: ${s.uses_count > 0 ? `${((s.success_count / s.uses_count) * 100).toFixed(0)}% success` : 'unused'}`}
                      style={{
                        width: 12,
                        height: 12,
                        background: color,
                        opacity: s.uses_count === 0 ? 0.3 : 0.8,
                        boxShadow: tone !== 'cyan' ? `0 0 4px ${color}55` : 'none',
                        borderRadius: 1,
                      }}
                    />
                  );
                })}
              </div>
            </div>
          </PageCell>
        )}

        {/* Toolbar row */}
        <PageCell span={12}>
          {listFlash && (
            <div style={{
              marginBottom: 10,
              padding: '6px 12px',
              fontFamily: 'var(--mono)',
              fontSize: 11,
              color: 'var(--cyan)',
              border: '1px solid var(--cyan)',
              background: 'rgba(57, 229, 255, 0.08)',
              letterSpacing: '0.06em',
              animation: 'fadeSlideIn 150ms ease-out',
            }}>{listFlash}</div>
          )}
          <Toolbar>
            <div style={{ flex: 1, minWidth: 120 }}>
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search by name or description…"
                aria-label="Filter skills"
                autoComplete="off"
                spellCheck={false}
                style={{ width: '100%', boxSizing: 'border-box' }}
              />
            </div>
            <select
              aria-label="Sort skills"
              value={sort}
              onChange={e => setSort(e.target.value as SortKey)}
              style={selectStyle}
            >
              <option value="name">Sort · name A–Z</option>
              <option value="uses_desc">Sort · most used</option>
              <option value="recent">Sort · recently used</option>
              <option value="success_desc">Sort · success rate</option>
            </select>
            <ToolbarButton onClick={reload}>REFRESH</ToolbarButton>
            <ToolbarButton tone="gold" onClick={() => { void copySkillList(); }} disabled={displayed.length === 0}>
              COPY LIST
            </ToolbarButton>
            <ToolbarButton tone="teal" onClick={exportJson} disabled={!skills || skills.length === 0}>
              EXPORT
            </ToolbarButton>
            <ToolbarButton
              tone="cyan"
              active={authoring}
              onClick={() => {
                setAuthoring(a => !a);
                setEditingId(null);
                setImporting(false);
              }}
            >
              {authoring ? '✕ NEW SKILL' : '＋ NEW SKILL'}
            </ToolbarButton>
            <ToolbarButton
              tone="teal"
              active={importing}
              onClick={() => {
                setImporting(i => !i);
                setEditingId(null);
                setAuthoring(false);
              }}
            >
              {importing ? '✕ IMPORT' : '⇪ IMPORT'}
            </ToolbarButton>
            {/* Sprint-13 η — bulk export of SIGNED skills. Intentionally a
                peer of IMPORT: the two are symmetric, and putting EXPORT
                ALL next to it makes the cross-device migration affordance
                discoverable without crowding the primary CTAs. */}
            <ToolbarButton
              tone="teal"
              onClick={() => { void exportAllSigned(); }}
              disabled={!skills || skills.length === 0}
              title="Bundle every signed skill into a single .json for cross-device migration"
            >
              ⇗ EXPORT ALL
            </ToolbarButton>
            <ToolbarButton
              tone="violet"
              onClick={() => askSunny(
                `Look at what I've been doing recently and propose ONE new procedural skill I'd benefit from. Suggest a name, description, and the trigger text.`,
                'skills',
              )}
            >AI PROPOSE</ToolbarButton>
          </Toolbar>
          <Toolbar style={{ marginTop: 10 }}>
            <span style={{
              fontFamily: 'var(--display)',
              fontSize: 8,
              letterSpacing: '0.22em',
              color: 'var(--ink-2)',
              alignSelf: 'center',
            }}>FILTER</span>
            <ToolbarButton active={quick === 'all'} onClick={() => setQuick('all')}>ALL</ToolbarButton>
            <ToolbarButton active={quick === 'unused'} tone="gold" onClick={() => setQuick('unused')}>UNUSED</ToolbarButton>
            <ToolbarButton active={quick === 'risk'} tone="red" onClick={() => setQuick('risk')}>AT RISK</ToolbarButton>

            <span style={{ flex: 1 }} />

            {/* View mode toggle */}
            <span style={{
              fontFamily: 'var(--display)',
              fontSize: 8,
              letterSpacing: '0.22em',
              color: 'var(--ink-2)',
              alignSelf: 'center',
            }}>VIEW</span>
            <button
              className="view-toggle-btn"
              aria-pressed={viewMode === 'grid'}
              onClick={() => setViewMode('grid')}
              title="Grid view"
            >▦ GRID</button>
            <button
              className="view-toggle-btn"
              aria-pressed={viewMode === 'list'}
              onClick={() => setViewMode('list')}
              title="List view"
            >☰ LIST</button>

            {/* Insights toggle */}
            <ToolbarButton
              tone="cyan"
              active={showInsights}
              onClick={() => setShowInsights(i => !i)}
            >
              {showInsights ? '✕ INSIGHTS' : '◈ INSIGHTS'}
            </ToolbarButton>

            <span style={{
              fontFamily: 'var(--mono)',
              fontSize: 10,
              color: 'var(--ink-dim)',
              letterSpacing: '0.06em',
            }}>
              {displayed.length}{skills ? ` / ${skills.length}` : ''} shown
              <span style={{ marginLeft: 12 }}>
                <KeyHint>⌘F</KeyHint> search
              </span>
            </span>
          </Toolbar>
          {editingId && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              marginTop: 8,
              fontFamily: 'var(--mono)', fontSize: 10,
              color: 'var(--ink-dim)',
              letterSpacing: '0.06em',
            }}>
              <span style={{ fontFamily: 'var(--display)', letterSpacing: '0.14em', color: 'var(--cyan)' }}>EDITOR</span>
              <KeyHint>Esc</KeyHint>
              <span>closes the drawer when focus is outside fields · use Save to persist</span>
            </div>
          )}
        </PageCell>

        {(error || mutationError) && (
          <PageCell span={12}>
            <div role="alert" style={{
              border: '1px solid var(--red)', borderLeft: '2px solid var(--red)',
              padding: '6px 10px',
              fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--red)',
              background: 'rgba(255, 77, 94, 0.06)',
            }}>{mutationError ?? error}</div>
          </PageCell>
        )}

        {/* Insights panel (collapsible) */}
        {showInsights && skills && skills.length > 0 && (
          <PageCell span={12}>
            <SkillInsights skills={skills} />
          </PageCell>
        )}

        {/* Skill authoring panel — shown only when NEW SKILL is active. */}
        {authoring && (
          <PageCell span={12}>
            <SkillEditor
              onClose={() => setAuthoring(false)}
              onCreated={created => {
                setAuthoring(false);
                reload();
                // Select the newly created skill so it highlights when the list
                // refreshes — user immediately sees their new skill land.
                setEditingId(created.id);
                flash(`Skill "${created.name}" created`);
              }}
            />
          </PageCell>
        )}

        {/* Signed-manifest import panel — sprint-12 η. */}
        {importing && (
          <PageCell span={12}>
            <SkillImport
              onClose={() => setImporting(false)}
              onImported={created => {
                setImporting(false);
                reload();
                setEditingId(created.id);
                flash(
                  created.signature
                    ? `Skill "${created.name}" imported · signed by ${created.signer_fingerprint}`
                    : `Skill "${created.name}" imported (unsigned)`,
                );
              }}
            />
          </PageCell>
        )}

        {/* Router match log — trust surface for System-1 routing decisions. */}
        <PageCell span={12}>
          <RouterLog skills={skills ?? []} />
        </PageCell>

        {/* Skill cards */}
        <PageCell span={editing ? 8 : 12}>
          {loading && !skills ? (
            <EmptyState title="Loading skills…" />
          ) : displayed.length === 0 ? (
            <EmptyState
              title={skills && skills.length > 0 ? 'No matches' : 'No skills yet'}
              hint={skills && skills.length > 0
                ? 'Try another search term, switch filters, or clear the filter.'
                : 'Skills appear after successful runs are synthesized, or tap AI PROPOSE for ideas from Sunny.'}
            />
          ) : (
            <ScrollList maxHeight={540}>
              <div style={{
                display: viewMode === 'grid'
                  ? 'grid'
                  : 'flex',
                gridTemplateColumns: editing ? '1fr' : 'repeat(2, 1fr)',
                flexDirection: viewMode === 'list' ? 'column' : undefined,
                gap: 10,
              }}>
                {displayed.map((s: ProceduralSkill) => (
                  <SkillCard
                    key={s.id}
                    skill={s}
                    onEdit={() => setEditingId(s.id)}
                    onDelete={() => mutate(() => deleteSkill(s.id))}
                    onShare={() => openShare(s)}
                  />
                ))}
              </div>
            </ScrollList>
          )}
        </PageCell>

        {editing && (
          <PageCell span={4}>
            <EditDrawer
              key={editing.id}
              skill={editing}
              onClose={() => setEditingId(null)}
              onSave={(id, patch) => mutate(() => updateSkill(id, patch))}
            />
          </PageCell>
        )}

        {/* Sprint-13 η — SHARE error banner (bulk export surface errors here;
            single-skill refusals surface as flash toasts). */}
        {shareError && (
          <PageCell span={12}>
            <div role="alert" style={{
              border: '1px solid var(--red)', borderLeft: '2px solid var(--red)',
              padding: '6px 10px',
              fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--red)',
              background: 'rgba(255, 77, 94, 0.06)',
            }}>{shareError}</div>
          </PageCell>
        )}
      </PageGrid>

      {/* SHARE modal — rendered OUTSIDE the PageGrid so it overlays every
          other surface. The dialog manages its own clipboard / file-save
          side effects; we only pass callbacks + the pre-built bundle. */}
      {sharing && (
        <SkillExport
          bundle={sharing}
          onClose={() => setSharing(null)}
          onCopy={async (json) => {
            try {
              await navigator.clipboard.writeText(json);
              flash(`Copied — fingerprint [${shortFingerprint(sharing.signer_fingerprint)}]`);
              return true;
            } catch (e) {
              setShareError(e instanceof Error ? e.message : String(e));
              return false;
            }
          }}
          onSaveFile={async (json, suggestedName) => {
            if (!isTauri) {
              // Browser fallback for dev-server smoke: trigger a download.
              const blob = new Blob([json], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = suggestedName;
              a.click();
              URL.revokeObjectURL(url);
              flash(`Saved — ${suggestedName}`);
              return suggestedName;
            }
            const path = await invokeSafe<string | null>('skill_export_save', {
              json,
              suggestedName,
            });
            if (path) {
              flash(`Saved → ${path}`);
            }
            return path;
          }}
        />
      )}
    </ModuleView>
  );
}
