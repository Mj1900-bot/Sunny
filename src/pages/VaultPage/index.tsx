/**
 * VAULT — Main orchestrator for the local Keychain secrets storage.
 *
 * Upgraded to Cyber-Premium V4:
 *  - Uses PageGrid / PageCell / Section layout standards
 *  - Extracted Sidebar logic to VaultSidebar
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ModuleView } from '../../components/ModuleView';
import { invoke, isTauri } from '../../lib/tauri';
import {
  BLUR_SEAL_STORAGE_KEY, CLIPBOARD_CLEAR_SECONDS, IDLE_AUTOSEAL_SECONDS,
  KIND_LABELS, PIN_STORAGE_KEY, QUICK_COPY_VISIBLE_MS, REVEAL_SECONDS, SORT_STORAGE_KEY,
} from './constants';
import { FallbackNotice } from './FallbackNotice';
import { NewItemForm } from './NewItemForm';
import { SealedView } from './SealedView';
import { SecretCard } from './SecretCard';
import { VaultSidebar } from './VaultSidebar';
import { VaultHelpOverlay } from './VaultHelpOverlay';
import type { KindFilter, RevealState, SortKey, Toast, VaultItem, VaultKind } from './types';
import { kindOf, makeLocalId, parseRetryAfter, readPinSet, secondsUntil, writePinSet } from './utils';
import { PageGrid, PageCell, Section, Toolbar, ToolbarButton, FilterInput, EmptyState } from '../_shared';

type SealReason = 'manual' | 'idle' | 'initial' | 'blur' | 'panic';

export function VaultPage() {
  const [items, setItems] = useState<ReadonlyArray<VaultItem>>([]);
  const [listErr, setListErr] = useState<string | null>(null);
  const [sealed, setSealed] = useState<boolean>(true);
  const [sealReason, setSealReason] = useState<SealReason>('initial');
  const [reveals, setReveals] = useState<RevealState>({});
  const [now, setNow] = useState<number>(() => Date.now());
  const [filter, setFilter] = useState<KindFilter>('all');
  const [showNewForm, setShowNewForm] = useState<boolean>(false);
  const [toasts, setToasts] = useState<ReadonlyArray<Toast>>([]);
  const [addBusy, setAddBusy] = useState<boolean>(false);
  const [revealBusyId, setRevealBusyId] = useState<string | null>(null);
  const [query, setQuery] = useState<string>('');
  const [sort, setSort] = useState<SortKey>(() => {
    try {
      const raw = localStorage.getItem(SORT_STORAGE_KEY);
      if (raw === 'recent' || raw === 'used' || raw === 'alpha' || raw === 'oldest') return raw as SortKey;
    } catch { /* ignore */ }
    return 'recent';
  });
  const [pins, setPins] = useState<ReadonlySet<string>>(() => readPinSet(PIN_STORAGE_KEY));
  const [lastActivity, setLastActivity] = useState<number>(() => Date.now());
  const [blurSeal, setBlurSeal] = useState<boolean>(() => {
    try { return localStorage.getItem(BLUR_SEAL_STORAGE_KEY) === '1'; }
    catch { return false; }
  });
  const [sessionReveals, setSessionReveals] = useState<number>(0);
  const [cooldownUntil, setCooldownUntil] = useState<number>(0);
  const [showHelp, setShowHelp] = useState<boolean>(false);

  const clipboardTimerRef = useRef<number | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const quickCopyTimerRef = useRef<number | null>(null);

  const pushToast = useCallback((text: string, tone: 'info' | 'warn' = 'info') => {
    const t: Toast = { id: makeLocalId(), text, tone };
    setToasts(prev => [...prev, t]);
    window.setTimeout(() => setToasts(prev => prev.filter(p => p.id !== t.id)), 2800);
  }, []);

  const refreshList = useCallback(async () => {
    if (!isTauri) return setItems([]);
    try {
      setItems(await invoke<ReadonlyArray<VaultItem>>('vault_list'));
      setListErr(null);
    } catch (e) {
      setListErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void refreshList(); }, [refreshList]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    return () => {
      if (clipboardTimerRef.current !== null) window.clearTimeout(clipboardTimerRef.current);
      if (quickCopyTimerRef.current !== null) window.clearTimeout(quickCopyTimerRef.current);
    };
  }, []);

  useEffect(() => { try { localStorage.setItem(SORT_STORAGE_KEY, sort); } catch {} }, [sort]);
  useEffect(() => { try { localStorage.setItem(BLUR_SEAL_STORAGE_KEY, blurSeal ? '1' : '0'); } catch {} }, [blurSeal]);

  // Purge expired reveals from state
  useEffect(() => {
    setReveals(prev => {
      const entries = Object.entries(prev).filter(([, r]) => r.until > now);
      if (entries.length === Object.keys(prev).length) return prev;
      return Object.fromEntries(entries);
    });
  }, [now]);

  // Real idle auto-seal logic. Any keyboard/mouse activity resets the clock.
  useEffect(() => {
    if (sealed) return;
    const bump = () => setLastActivity(Date.now());
    window.addEventListener('mousemove', bump);
    window.addEventListener('keydown', bump);
    window.addEventListener('click', bump);
    window.addEventListener('scroll', bump, true);
    return () => {
      window.removeEventListener('mousemove', bump);
      window.removeEventListener('keydown', bump);
      window.removeEventListener('click', bump);
      window.removeEventListener('scroll', bump, true);
    };
  }, [sealed]);

  const sealNow = useCallback((reason: SealReason) => {
    setSealed(true);
    setSealReason(reason);
    setReveals({});
    setShowNewForm(false);
    setFilter('all');
    setQuery('');
    if (clipboardTimerRef.current !== null) {
      window.clearTimeout(clipboardTimerRef.current);
      clipboardTimerRef.current = null;
    }
    if (quickCopyTimerRef.current !== null) {
      window.clearTimeout(quickCopyTimerRef.current);
      quickCopyTimerRef.current = null;
    }
  }, []);

  // Auto-seal on window blur
  useEffect(() => {
    if (sealed || !blurSeal) return;
    function onBlur() { sealNow('blur'); }
    function onVisibility() { if (document.visibilityState === 'hidden') sealNow('blur'); }
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [sealed, blurSeal, sealNow]);

  const idleSecondsLeft = useMemo(() => (sealed ? 0 : secondsUntil(lastActivity + IDLE_AUTOSEAL_SECONDS * 1000, now)), [sealed, lastActivity, now]);

  useEffect(() => {
    if (!sealed && idleSecondsLeft === 0) sealNow('idle');
  }, [sealed, idleSecondsLeft, sealNow]);

  const activeReveals = useMemo(() => Object.values(reveals).filter(r => r.until > now).length, [reveals, now]);

  const counts = useMemo<Readonly<Record<KindFilter, number>>>(() => {
    const base: Record<KindFilter, number> = { all: items.length, api_key: 0, password: 0, token: 0, ssh: 0, note: 0 };
    for (const it of items) base[kindOf(it)]++;
    return base;
  }, [items]);

  const visibleItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    let out = items.filter(i => filter === 'all' ? true : kindOf(i) === filter);
    if (q.length > 0) out = out.filter(i => i.label.toLowerCase().includes(q) || kindOf(i).includes(q));
    
    return [...out].sort((a, b) => {
      const pa = pins.has(a.id) ? 1 : 0;
      const pb = pins.has(b.id) ? 1 : 0;
      if (pa !== pb) return pb - pa;
      switch (sort) {
        case 'alpha': return a.label.localeCompare(b.label);
        case 'oldest': return a.created_at - b.created_at;
        case 'used': return (b.last_used_at ?? 0) - (a.last_used_at ?? 0);
        case 'recent': default: return (b.updated_at ?? b.created_at) - (a.updated_at ?? a.created_at);
      }
    });
  }, [items, filter, query, sort, pins]);

  const cooldownLeft = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));

  function handleUnseal() {
    setSealed(false);
    setSealReason('manual');
    setLastActivity(Date.now());
    setSessionReveals(0);
  }

  function handleRevealError(msg: string) {
    const retry = parseRetryAfter(msg);
    if (retry !== null) {
      setCooldownUntil(Date.now() + retry * 1000);
      pushToast(`RATE LIMITED · retry in ${retry}s`, 'warn');
    } else pushToast(`Reveal denied: ${msg}`, 'warn');
  }

  async function fetchValue(id: string): Promise<string | null> {
    if (!isTauri) { pushToast('Keychain unavailable outside Tauri', 'warn'); return null; }
    if (cooldownLeft > 0) { pushToast(`RATE LIMITED · retry in ${cooldownLeft}s`, 'warn'); return null; }
    try {
      const value = await invoke<string>('vault_reveal', { id });
      setSessionReveals(c => c + 1);
      void refreshList();
      return value;
    } catch (e) {
      handleRevealError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  async function handleReveal(id: string) {
    setRevealBusyId(id);
    try {
      const value = await fetchValue(id);
      if (value === null) return;
      const until = Date.now() + REVEAL_SECONDS * 1000;
      setReveals(prev => ({ ...prev, [id]: { value, until } }));
    } finally {
      setRevealBusyId(prev => (prev === id ? null : prev));
    }
  }

  function handleHide(id: string) {
    setReveals(prev => { const next = { ...prev }; delete next[id]; return next; });
  }

  async function handleDelete(id: string) {
    if (!isTauri) return;
    try {
      await invoke<void>('vault_delete', { id });
      setReveals(prev => { const next = { ...prev }; delete next[id]; return next; });
      setPins(prev => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev); next.delete(id); writePinSet(PIN_STORAGE_KEY, next); return next;
      });
      await refreshList();
      pushToast('DELETED from Keychain');
    } catch (e) { pushToast(`Delete failed`, 'warn'); }
  }

  async function handleAdd(kind: VaultKind, label: string, value: string) {
    if (!isTauri) return;
    setAddBusy(true);
    try {
      await invoke<VaultItem>('vault_add', { kind, label, value });
      await refreshList();
      setShowNewForm(false);
      pushToast('SAVED to Keychain');
    } catch (e) { pushToast(`Add failed`, 'warn'); } 
    finally { setAddBusy(false); }
  }

  async function handleRename(id: string, label: string) {
    if (!isTauri) return;
    try {
      await invoke<VaultItem>('vault_rename', { id, label });
      await refreshList(); pushToast('RENAMED');
    } catch (e) { pushToast(`Rename failed`, 'warn'); }
  }

  async function handleRotate(id: string, value: string) {
    if (!isTauri) return;
    try {
      await invoke<VaultItem>('vault_update_value', { id, value });
      handleHide(id);
      await refreshList(); pushToast('ROTATED in Keychain');
    } catch (e) { pushToast(`Rotate failed`, 'warn'); }
  }

  function handleTogglePin(id: string) {
    setPins(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      writePinSet(PIN_STORAGE_KEY, next); return next;
    });
  }

  function writeClipboard(value: string, item: VaultItem) {
    if (!navigator.clipboard) return pushToast('Clipboard unavailable', 'warn');
    navigator.clipboard.writeText(value).then(() => {
      pushToast(`COPIED "${item.label}"`);
      if (clipboardTimerRef.current !== null) window.clearTimeout(clipboardTimerRef.current);
      clipboardTimerRef.current = window.setTimeout(() => {
        navigator.clipboard.writeText('').catch(() => {});
        clipboardTimerRef.current = null;
      }, CLIPBOARD_CLEAR_SECONDS * 1000);
    });
  }

  function handleCopy(item: VaultItem) {
    const current = reveals[item.id];
    if (!current || current.until <= now) return pushToast('Reveal first, then copy', 'warn');
    writeClipboard(current.value, item);
  }

  async function handleQuickCopy(item: VaultItem) {
    const value = await fetchValue(item.id);
    if (value === null) return;
    const until = Date.now() + QUICK_COPY_VISIBLE_MS;
    setReveals(prev => ({ ...prev, [item.id]: { value, until } }));
    writeClipboard(value, item);
    if (quickCopyTimerRef.current !== null) window.clearTimeout(quickCopyTimerRef.current);
    quickCopyTimerRef.current = window.setTimeout(() => {
      handleHide(item.id); quickCopyTimerRef.current = null;
    }, QUICK_COPY_VISIBLE_MS);
  }

  // Keyboard shortcuts inside the open vault.
  useEffect(() => {
    if (sealed) return;
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'l') { e.preventDefault(); sealNow('panic'); return; }
      const inField = ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName);
      if (e.key === '/' && !inField) { e.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); return; }
      if (e.key === '?' && !inField) { e.preventDefault(); setShowHelp(v => !v); return; }
      if (e.key.toLowerCase() === 'n' && !inField && !e.metaKey && !e.ctrlKey) { e.preventDefault(); setShowNewForm(v => !v); return; }
      if (e.key === 'Escape') {
        if (showHelp) setShowHelp(false);
        else if (showNewForm) setShowNewForm(false);
        else if (query.length > 0) setQuery('');
        else if (!inField) sealNow('manual');
      }
    }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [sealed, showNewForm, query, showHelp, sealNow]);

  const badge = sealed ? 'SEALED' : `${items.length} · ${activeReveals} REVEALED`;

  if (!isTauri) return <ModuleView title="VAULT" badge="PREVIEW"><FallbackNotice /></ModuleView>;

  return (
    <ModuleView title="VAULT" badge={badge}>
      {listErr && (
        <div style={{
          color: 'var(--red)', border: '1px solid var(--red)', padding: '8px 12px',
          marginBottom: 10, fontFamily: 'var(--mono)', fontSize: 11, background: 'rgba(255, 0, 0, 0.05)',
        }}>
          Index error: {listErr}
        </div>
      )}

      {cooldownLeft > 0 && !sealed && (
        <div style={{
          color: 'var(--amber)', border: '1px solid var(--amber)', padding: '8px 12px',
          marginBottom: 10, fontFamily: 'var(--mono)', fontSize: 11, background: 'rgba(255, 179, 71, 0.05)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center'
        }}>
          <span>⚠ RATE LIMITED — repeat requests denied. Pause for <b>{cooldownLeft}s</b>.</span>
          <span style={{ color: 'var(--ink-dim)' }}>5 reveals / 60s max</span>
        </div>
      )}

      {sealed ? (
        <SealedView onUnseal={handleUnseal} itemCount={items.length} autoSealedReason={sealReason} />
      ) : (
        <PageGrid>
          <PageCell span={3}>
            <VaultSidebar
              filter={filter} setFilter={setFilter} counts={counts}
              sort={sort} setSort={setSort} itemsLength={items.length}
              activeReveals={activeReveals} sessionReveals={sessionReveals}
              visibleItemsLength={visibleItems.length} pinsSize={pins.size}
              idleSecondsLeft={idleSecondsLeft} blurSeal={blurSeal}
              setBlurSeal={setBlurSeal} onSeal={() => sealNow('manual')}
            />
          </PageCell>
          
          <PageCell span={9}>
            <Section title={filter === 'all' ? 'ALL SECRETS' : KIND_LABELS[filter]} right={
              <ToolbarButton tone="cyan" onClick={() => setShowNewForm(v => !v)}>
                {showNewForm ? '× CLOSE' : '+ NEW SECRET'}
              </ToolbarButton>
            }>
              <Toolbar style={{ marginBottom: 12 }}>
                <FilterInput
                  ref={searchRef} value={query} onChange={e => setQuery(e.target.value)}
                  placeholder="search labels…   ( / )   Enter = copy if unique"
                  onKeyDown={e => {
                    if (e.key === 'Enter' && visibleItems.length === 1) {
                      e.preventDefault(); void handleQuickCopy(visibleItems[0]);
                    }
                  }}
                />
              </Toolbar>

              {showNewForm && (
                <NewItemForm
                  onAdd={handleAdd} onCancel={() => setShowNewForm(false)}
                  busy={addBusy} existingLabels={items.map(i => i.label)}
                />
              )}

              {/* Items List */}
              {items.length === 0 ? (
                <EmptyState title="EMPTY VAULT" hint="Nothing in the Keychain yet. Add your first secret." />
              ) : visibleItems.length === 0 ? (
                <EmptyState title="No match" hint={query ? `Nothing for "${query}"` : 'No secrets in this category'} />
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 10 }}>
                  {visibleItems.map(item => (
                    <SecretCard
                      key={item.id} item={item} reveal={reveals[item.id]} now={now}
                      busy={revealBusyId === item.id} pinned={pins.has(item.id)}
                      onReveal={handleReveal} onHide={handleHide} onCopy={handleCopy}
                      onQuickCopy={handleQuickCopy} onDelete={handleDelete}
                      onRename={handleRename} onRotate={handleRotate} onTogglePin={handleTogglePin}
                    />
                  ))}
                </div>
              )}
            </Section>
            
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)', marginTop: 16 }}>
              Reveals hide after {REVEAL_SECONDS}s. Clipboard clears {CLIPBOARD_CLEAR_SECONDS}s. COPY makes a 600ms flash reveal if hidden.
            </div>
          </PageCell>
        </PageGrid>
      )}

      {showHelp && !sealed && <VaultHelpOverlay onClose={() => setShowHelp(false)} />}
      
      {/* Toasts */}
      {toasts.length > 0 && (
        <div style={{ position: 'absolute', right: 16, bottom: 16, display: 'flex', flexDirection: 'column', gap: 6, zIndex: 100 }}>
          {toasts.map(t => (
            <div key={t.id} style={{
              fontFamily: 'var(--mono)', fontSize: 10.5, letterSpacing: '0.18em', padding: '8px 14px',
              border: `1px solid ${t.tone === 'warn' ? 'var(--amber)' : 'var(--cyan)'}`,
              color: t.tone === 'warn' ? 'var(--amber)' : 'var(--cyan)',
              background: 'rgba(4, 10, 16, 0.9)', boxShadow: `0 0 12px ${t.tone === 'warn' ? 'rgba(255, 179, 71, 0.25)' : 'rgba(57, 229, 255, 0.25)'}`
            }}>
              {t.text}
            </div>
          ))}
        </div>
      )}
    </ModuleView>
  );
}
