/**
 * DIAGNOSTICS — live backend health panel (sprint-12 ε).
 *
 * Surfaces the observability surface that SUNNY's backend now carries
 * but the HUD has been ignoring: session_lock depth, event_bus seq +
 * receiver_count + boot_epoch, supervisor restart counters, live
 * `osascript` process count, whisper/kokoro daemon state, memory FTS5
 * row counts + on-disk size, and constitution rule-kick counters.
 *
 * One Tauri command drives the page: `diagnostics_snapshot`. It
 * aggregates every subsystem probe server-side so the frontend stays
 * thin — polled at 2 s cadence (scaled by the MODULES · REFRESH TIER
 * setting like every other live page).
 *
 * Styling follows existing module-page conventions: `ModuleView` frame,
 * `PageGrid` / `PageCell` / `Section` primitives, monospace values,
 * cyan/amber accent colours. No new chart library — plain divs and
 * numbers throughout.
 */

import { useMemo, useState, type ReactElement } from 'react';
import { ModuleView } from '../components/ModuleView';
import {
  PageGrid, PageCell, Section, Row, Chip, StatBlock, ScrollList,
  EmptyState, PageLead, usePoll, relTime,
} from './_shared';
import { invokeSafe } from '../lib/tauri';
import type { AgentLoopDiag } from '../bindings/AgentLoopDiag';
import type { ConstitutionDiag } from '../bindings/ConstitutionDiag';
import type { DiagnosticsSnapshot } from '../bindings/DiagnosticsSnapshot';
import type { EventBusDiag } from '../bindings/EventBusDiag';
import type { MemoryDiag } from '../bindings/MemoryDiag';
import type { OsascriptDiag } from '../bindings/OsascriptDiag';
import type { SupervisorDiag } from '../bindings/SupervisorDiag';
import type { VoicePipelineDiag } from '../bindings/VoicePipelineDiag';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtNumber(n: number | null | undefined): string {
  if (n == null) return '—';
  return n.toLocaleString();
}

function fmtPid(n: number | null | undefined): string {
  if (n == null) return 'not running';
  return `pid ${n}`;
}

function fmtSpeed(speedMilli: number | null | undefined): string {
  if (speedMilli == null) return '—';
  return `${(speedMilli / 1000).toFixed(2)}×`;
}

function fmtMsAgo(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return 'never';
  const secs = Math.floor(ms / 1000);
  return `${relTime(secs)} ago`;
}

async function loadSnapshot(): Promise<DiagnosticsSnapshot | null> {
  return invokeSafe<DiagnosticsSnapshot>('diagnostics_snapshot');
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function DiagnosticsPage() {
  const { data, error, loading } = usePoll(loadSnapshot, 2000);

  const freshness = useMemo(() => {
    if (!data?.collected_at_ms) return null;
    const ageMs = Date.now() - data.collected_at_ms;
    if (ageMs < 0) return 'just now';
    if (ageMs < 1000) return `${ageMs} ms ago`;
    return `${(ageMs / 1000).toFixed(1)} s ago`;
  }, [data]);

  return (
    <ModuleView title="DIAGNOSTICS · BACKEND HEALTH">
      <PageGrid>
        <PageCell span={12}>
          <PageLead>
            Live backend observability: session locks, event bus, supervisor restarts,
            voice pipeline, memory store, constitution rule-kicks. Polled at 2 s.
            {freshness ? ` · snapshot ${freshness}` : null}
          </PageLead>
        </PageCell>

        {/* Top-line stats — the operator's first glance. */}
        <PageCell span={12}>
          <TopLineStats data={data} loading={loading} />
        </PageCell>

        {/* Agent loop + event bus — paired top row. */}
        <PageCell span={6}>
          <AgentLoopSection diag={data?.agent_loop} />
        </PageCell>
        <PageCell span={6}>
          <EventBusSection diag={data?.event_bus} />
        </PageCell>

        {/* Supervisor + osascript — operational plumbing. */}
        <PageCell span={6}>
          <SupervisorSection diag={data?.supervisor} />
        </PageCell>
        <PageCell span={6}>
          <OsascriptSection diag={data?.osascript} />
        </PageCell>

        {/* Voice pipeline. */}
        <PageCell span={6}>
          <VoiceSection diag={data?.voice} />
        </PageCell>

        {/* Memory store. */}
        <PageCell span={6}>
          <MemorySection diag={data?.memory} />
        </PageCell>

        {/* Constitution rule-kicks — wide so long rule descriptions fit. */}
        <PageCell span={12}>
          <ConstitutionSection diag={data?.constitution} />
        </PageCell>

        {/* Wave-2 latency harness trigger — dev-only, gated by
            debug_assertions on the backend. In release builds the
            backend stub returns an error which the panel surfaces. */}
        {import.meta.env.DEV && (
          <PageCell span={12}>
            <LatencyHarnessSection />
          </PageCell>
        )}

        {error && (
          <PageCell span={12}>
            <EmptyState
              title="SNAPSHOT UNAVAILABLE"
              hint={error}
            />
          </PageCell>
        )}
      </PageGrid>
    </ModuleView>
  );
}

// ---------------------------------------------------------------------------
// Wave-2 latency harness — dev-only trigger
// ---------------------------------------------------------------------------

/**
 * Shape returned by the backend `latency_run_fixture` command. Kept local
 * rather than emitted as a ts-rs binding because the harness is an
 * operator-only surface and the shape is simple enough that a drift
 * between backend + frontend would fail-fast in the JSON decode.
 */
interface RunSummary {
  run_id: string;
  fixture: string;
  total_ms: number;
  final_text: string | null;
  error: string | null;
  sink_path: string;
}

/**
 * Dev-only trigger for the Wave-2 latency harness. Loads a fixture by
 * name (relative to `~/.sunny/latency/fixtures/`) and drives it through
 * the production agent loop. The JSONL sink at `sink_path` collects
 * every stage marker for offline SLA analysis.
 */
function LatencyHarnessSection(): ReactElement {
  const [fixture, setFixture] = useState<string>('basic.json');
  const [running, setRunning] = useState(false);
  const [last, setLast] = useState<RunSummary | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const run = async (): Promise<void> => {
    setRunning(true);
    setRunError(null);
    try {
      const summary = await invokeSafe<RunSummary>('latency_run_fixture', {
        fixturePath: fixture,
      });
      if (summary == null) {
        setRunError('harness returned null (command rejected or release-build stub)');
      } else {
        setLast(summary);
      }
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Section title="LATENCY HARNESS · DEV ONLY">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <input
          type="text"
          value={fixture}
          onChange={(e) => setFixture(e.target.value)}
          placeholder="fixture path (e.g. basic.json)"
          style={{
            flex: 1,
            fontFamily: 'var(--mono)',
            fontSize: 12,
            padding: '6px 10px',
            background: 'rgba(0,0,0,0.4)',
            color: 'var(--cyan)',
            border: '1px solid rgba(0,255,255,0.25)',
            borderRadius: 4,
          }}
          disabled={running}
        />
        <button
          onClick={() => { void run(); }}
          disabled={running || fixture.trim().length === 0}
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 12,
            padding: '6px 14px',
            background: running ? 'rgba(255,193,7,0.15)' : 'rgba(0,255,255,0.15)',
            color: running ? 'var(--amber)' : 'var(--cyan)',
            border: `1px solid ${running ? 'var(--amber)' : 'var(--cyan)'}`,
            borderRadius: 4,
            cursor: running ? 'wait' : 'pointer',
          }}
        >
          {running ? 'RUNNING…' : 'RUN FIXTURE'}
        </button>
      </div>
      {runError && (
        <Chip tone="red">harness error: {runError}</Chip>
      )}
      {last && !runError && (
        <div style={{ display: 'grid', gap: 6 }}>
          <Row label="run_id"    value={<span style={{ fontFamily: 'var(--mono)' }}>{last.run_id}</span>} />
          <Row label="fixture"   value={<span style={{ fontFamily: 'var(--mono)' }}>{last.fixture}</span>} />
          <Row label="total_ms"  value={<span style={{ fontFamily: 'var(--mono)', color: last.total_ms > 2000 ? 'var(--amber)' : 'var(--green)' }}>{last.total_ms} ms</span>} />
          <Row label="sink"      value={<span style={{ fontFamily: 'var(--mono)', fontSize: 11, opacity: 0.7 }}>{last.sink_path}</span>} />
          {last.error && <Row label="error" value={<span style={{ color: 'var(--red)' }}>{last.error}</span>} />}
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Top-line stat blocks
// ---------------------------------------------------------------------------

function TopLineStats({
  data, loading,
}: {
  data: DiagnosticsSnapshot | null;
  loading: boolean;
}) {
  const osTone: 'cyan' | 'amber' | 'red' = data?.osascript.over_threshold
    ? 'red'
    : (data?.osascript.live_count ?? 0) > 20
      ? 'amber'
      : 'cyan';
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
      <StatBlock
        label="ACTIVE SESSIONS"
        value={data ? String(data.agent_loop.active_session_count) : (loading ? '…' : '—')}
        sub={data ? `${data.agent_loop.sessions.length} tracked` : 'session_lock'}
        tone="cyan"
      />
      <StatBlock
        label="EVENT SEQ"
        value={data ? fmtNumber(data.event_bus.latest_seq) : '—'}
        sub={data ? `${data.event_bus.receiver_count} receivers` : 'broadcast bus'}
        tone="violet"
      />
      <StatBlock
        label="OSASCRIPT"
        value={data?.osascript.live_count != null ? String(data.osascript.live_count) : '—'}
        sub={data?.osascript.over_threshold ? 'OVER THRESHOLD · 50' : 'live processes'}
        tone={osTone}
      />
      <StatBlock
        label="KOKORO TTS"
        value={data?.voice.kokoro_daemon_pid != null ? String(data.voice.kokoro_daemon_pid) : '—'}
        sub={data?.voice.kokoro_daemon_pid != null ? 'daemon live' : 'not running'}
        tone={data?.voice.kokoro_daemon_pid != null ? 'green' : 'amber'}
      />
      <StatBlock
        label="MEMORY FTS5"
        value={data ? fmtBytes(data.memory.db_bytes ?? null) : '—'}
        sub={data ? `${fmtNumber(data.memory.episodic_count + data.memory.semantic_count)} rows` : 'memory.sqlite'}
        tone="gold"
      />
      <StatBlock
        label="RULE KICKS"
        value={data ? fmtNumber(data.constitution.rule_kicks.reduce((n, r) => n + r.count, 0)) : '—'}
        sub={data ? `${data.constitution.prohibition_count} rules` : 'constitution'}
        tone="amber"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section: Agent loop / session locks
// ---------------------------------------------------------------------------

function AgentLoopSection({ diag }: { diag?: AgentLoopDiag }) {
  return (
    <Section
      title="AGENT LOOP · SESSION LOCKS"
      right={diag ? <Chip tone="cyan">{`${fmtNumber(diag.total_acquires)} acquires`}</Chip> : null}
    >
      {!diag || diag.sessions.length === 0 ? (
        <EmptyState title="NO SESSIONS" hint="No session_lock entries have been taken yet this process." />
      ) : (
        <ScrollList maxHeight={220}>
          {[...diag.sessions]
            .sort((a, b) => b.holders - a.holders || a.session_id.localeCompare(b.session_id))
            .map(s => (
              <Row
                key={s.session_id}
                label={s.session_id}
                value={
                  <span style={{ fontFamily: 'var(--mono)' }}>
                    {s.holders > 0 ? (
                      <span style={{ color: 'var(--amber)' }}>HELD · depth {s.holders}</span>
                    ) : (
                      <span style={{ color: 'var(--ink-dim)' }}>idle</span>
                    )}
                  </span>
                }
                tone={s.holders > 0 ? 'amber' : undefined}
              />
            ))}
        </ScrollList>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Section: Event bus
// ---------------------------------------------------------------------------

function EventBusSection({ diag }: { diag?: EventBusDiag }) {
  // Lag warns fire only when a subscriber's ring buffer overflows —
  // any non-zero count is worth flagging amber on the HUD. Dropped
  // count is informational (sum of `n` across every Lagged(n)).
  const lagged = (diag?.lag_warns ?? 0) > 0;
  return (
    <Section
      title="EVENT BUS · BROADCAST"
      right={diag ? <Chip tone="violet">{`seq ${fmtNumber(diag.latest_seq)}`}</Chip> : null}
    >
      <Row
        label="receivers"
        value={diag ? String(diag.receiver_count) : '—'}
        right="live subscribers"
      />
      <Row
        label="latest seq"
        value={diag ? fmtNumber(diag.latest_seq) : '—'}
        right="max observed"
      />
      <Row
        label="boot epoch"
        value={diag?.latest_boot_epoch ? String(diag.latest_boot_epoch) : '—'}
        right="wall-clock ms"
      />
      <Row
        label="lag warns"
        value={
          diag
            ? <span style={{ color: lagged ? 'var(--amber)' : 'var(--ink-dim)', fontFamily: 'var(--mono)' }}>
                {fmtNumber(diag.lag_warns)}
              </span>
            : '—'
        }
        right={diag ? `${fmtNumber(diag.lag_dropped)} events dropped` : 'Lagged(n) events'}
        tone={lagged ? 'amber' : undefined}
      />
      <Row
        label="throughput"
        value={
          diag && diag.latest_seq > 0
            ? <span style={{ color: 'var(--ink-dim)' }}>{`${fmtNumber(diag.latest_seq)} events since boot`}</span>
            : '—'
        }
      />
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Section: Supervisor
// ---------------------------------------------------------------------------

function SupervisorSection({ diag }: { diag?: SupervisorDiag }) {
  const totalRestarts = diag?.tasks.reduce((n, t) => n + t.restarts, 0) ?? 0;
  return (
    <Section
      title="SUPERVISOR · PANIC RESTARTS"
      right={diag ? (
        <Chip tone={totalRestarts > 0 ? 'amber' : 'green'}>
          {`${fmtNumber(totalRestarts)} total`}
        </Chip>
      ) : null}
    >
      {!diag || diag.tasks.length === 0 ? (
        <EmptyState title="NO SUPERVISED TASKS" hint="No tasks registered yet." />
      ) : (
        <ScrollList maxHeight={220}>
          {diag.tasks.map(t => (
            <Row
              key={t.name}
              label={t.name}
              value={
                <span style={{ fontFamily: 'var(--mono)' }}>
                  {t.restarts > 0 ? (
                    <span style={{ color: 'var(--amber)' }}>{`${t.restarts} restart${t.restarts === 1 ? '' : 's'}`}</span>
                  ) : (
                    <span style={{ color: 'var(--green)' }}>stable</span>
                  )}
                </span>
              }
              tone={t.restarts > 0 ? 'amber' : undefined}
            />
          ))}
        </ScrollList>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Section: osascript leak probe
// ---------------------------------------------------------------------------

function OsascriptSection({ diag }: { diag?: OsascriptDiag }) {
  const tone = diag?.over_threshold ? 'red' : 'cyan';
  return (
    <Section
      title="OSASCRIPT · LIVE PROCESSES"
      right={diag?.over_threshold
        ? <Chip tone="red">LEAK · ≥ 50</Chip>
        : (diag?.live_count != null ? <Chip tone="cyan">{`${diag.live_count}`}</Chip> : null)}
    >
      <Row
        label="live count"
        value={diag?.live_count != null ? (
          <span style={{ color: `var(--${tone})`, fontFamily: 'var(--mono)' }}>{diag.live_count}</span>
        ) : '—'}
        right="pgrep -c osascript"
        tone={diag?.over_threshold ? 'red' : undefined}
      />
      <Row
        label="threshold"
        value={<span style={{ color: 'var(--ink-dim)' }}>{'≥ 50 flags red'}</span>}
        right="static limit"
      />
      {diag?.over_threshold && (
        <div style={{
          padding: '8px 10px',
          border: '1px solid var(--red)',
          background: 'rgba(255, 70, 70, 0.08)',
          fontFamily: 'var(--mono)', fontSize: 11,
          color: 'var(--red)',
          letterSpacing: '0.04em',
        }}>
          osascript leak suspected — pgrep reports {diag.live_count} live. Expected &lt; 10
          under normal load. Inspect recent tool calls in the Audit page.
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Section: Voice pipeline
// ---------------------------------------------------------------------------

function VoiceSection({ diag }: { diag?: VoicePipelineDiag }) {
  return (
    <Section
      title="VOICE PIPELINE"
      right={diag?.kokoro_daemon_pid != null
        ? <Chip tone="green">DAEMON UP</Chip>
        : <Chip tone="amber">NO DAEMON</Chip>}
    >
      <Row
        label="whisper"
        value={
          diag?.whisper_model_path ? (
            <span style={{ fontFamily: 'var(--mono)' }}>
              {diag.whisper_model_path.split('/').pop()}
            </span>
          ) : 'not found'
        }
        right={diag?.whisper_model_size_mb != null ? `${diag.whisper_model_size_mb.toFixed(0)} MB` : undefined}
        title={diag?.whisper_model_path ?? undefined}
      />
      <Row
        label="kokoro pid"
        value={fmtPid(diag?.kokoro_daemon_pid)}
        right={diag?.kokoro_voice_id ?? undefined}
        tone={diag?.kokoro_daemon_pid != null ? 'green' : undefined}
      />
      <Row
        label="kokoro speed"
        value={fmtSpeed(diag?.kokoro_speed_milli)}
        right={diag?.kokoro_voice_id ? `voice ${diag.kokoro_voice_id}` : undefined}
      />
      <Row
        label="kokoro model"
        value={diag?.kokoro_model_present ? 'present' : 'missing'}
        tone={diag?.kokoro_model_present ? undefined : 'amber'}
        right="~/.cache/kokoros"
      />
      <Row
        label="kokoro voices"
        value={diag?.kokoro_voices_present ? 'present' : 'missing'}
        tone={diag?.kokoro_voices_present ? undefined : 'amber'}
        right="voices-v1.0.bin"
      />
      <Row
        label="last interrupt"
        value={fmtMsAgo(diag?.last_interrupt_ms)}
        right="space-bar release"
      />
      <Row
        label="vad"
        value={
          diag?.vad
            ? <span style={{ fontFamily: 'var(--mono)', color: 'var(--ink-dim)' }}>
                {`rms ${diag.vad.silence_rms.toFixed(4)} · hold ${diag.vad.hold_ms}ms · preroll ${diag.vad.preroll_ms}ms`}
              </span>
            : '—'
        }
        right={diag?.vad?.mode ?? 'mode'}
      />
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Section: Memory store
// ---------------------------------------------------------------------------

function MemorySection({ diag }: { diag?: MemoryDiag }) {
  // Pack build is the per-turn memory digest; EWMA > 400 ms means the
  // embed budget is probably pinning (500 ms outer deadline). Amber at
  // 300+ ms as early warning.
  const packSlow = (diag?.pack_ewma_ms ?? 0) >= 300;
  return (
    <Section
      title="MEMORY · SQLITE"
      right={diag ? <Chip tone="gold">{fmtBytes(diag.db_bytes)}</Chip> : null}
    >
      <Row
        label="episodic"
        value={<span style={{ fontFamily: 'var(--mono)' }}>{fmtNumber(diag?.episodic_count)}</span>}
        right="conversation turns"
      />
      <Row
        label="semantic"
        value={<span style={{ fontFamily: 'var(--mono)' }}>{fmtNumber(diag?.semantic_count)}</span>}
        right="facts"
      />
      <Row
        label="procedural"
        value={<span style={{ fontFamily: 'var(--mono)' }}>{fmtNumber(diag?.procedural_count)}</span>}
        right="skills"
      />
      <Row
        label="pack build"
        value={
          diag && diag.pack_last_ms > 0
            ? <span style={{
                color: packSlow ? 'var(--amber)' : 'var(--ink-dim)',
                fontFamily: 'var(--mono)',
              }}>{`${fmtNumber(diag.pack_last_ms)} ms`}</span>
            : <span style={{ color: 'var(--ink-dim)' }}>no build yet</span>
        }
        right={diag && diag.pack_ewma_ms > 0 ? `${fmtNumber(diag.pack_ewma_ms)} ms ewma` : 'last / ewma'}
        tone={packSlow ? 'amber' : undefined}
      />
      <Row
        label="memory db"
        value={fmtBytes(diag?.db_bytes ?? null)}
        right="~/.sunny/memory.sqlite"
      />
      <Row
        label="events db"
        value={fmtBytes(diag?.event_bus_db_bytes ?? null)}
        right="~/.sunny/events.sqlite"
      />
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Section: Constitution rule-kicks
// ---------------------------------------------------------------------------

function ConstitutionSection({ diag }: { diag?: ConstitutionDiag }) {
  const verify = diag?.last_verify ?? null;
  return (
    <Section
      title="CONSTITUTION · RULE KICKS"
      right={diag ? (
        <Chip tone={diag.rule_kicks.length > 0 ? 'amber' : 'green'}>
          {`${fmtNumber(diag.rule_kicks.length)} rules fired`}
        </Chip>
      ) : null}
    >
      <Row
        label="last verify"
        value={
          verify
            ? <span style={{
                fontFamily: 'var(--mono)',
                color: verify.passed ? 'var(--green)' : 'var(--red)',
              }}>
                {verify.passed ? 'PASS' : 'FAIL'}
                {verify.rule ? ` · ${verify.rule}` : ''}
              </span>
            : <span style={{ color: 'var(--ink-dim)' }}>never</span>
        }
        right={verify ? fmtMsAgo(verify.at_ms > 0 ? Date.now() - verify.at_ms : null) : 'verifyAnswer'}
        tone={verify && !verify.passed ? 'red' : undefined}
      />
      {!diag || diag.rule_kicks.length === 0 ? (
        <EmptyState
          title="NO BLOCKS THIS SESSION"
          hint={diag
            ? `${diag.prohibition_count} prohibition${diag.prohibition_count === 1 ? '' : 's'} configured, none triggered yet.`
            : 'waiting for snapshot'}
        />
      ) : (
        <ScrollList maxHeight={260}>
          {diag.rule_kicks.map(k => (
            <Row
              key={k.rule}
              label={<span style={{ color: 'var(--amber)' }}>{`×${k.count}`}</span>}
              value={<span style={{ fontFamily: 'var(--mono)' }}>{k.rule}</span>}
              tone="amber"
            />
          ))}
        </ScrollList>
      )}
    </Section>
  );
}
