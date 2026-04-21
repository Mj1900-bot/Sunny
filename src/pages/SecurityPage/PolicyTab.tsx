/**
 * POLICY tab — Phase 3 hard enforcement.
 *
 * Sections:
 *   1. Enforcement toggles — egress mode, force-confirm-all,
 *      prompt-scrubbing, sub-agent role scoping.
 *   2. Egress allowlist editor — add/remove host entries.  Suffix
 *      pattern (starts with `.`) is supported.
 *   3. Egress blocklist — universal deny list for incident
 *      response.
 *   4. Tool kill-switches — per-tool disable flags.  Disabled tools
 *      surface as `policy_denied` to the agent so the model stops
 *      retrying.
 *
 * Every change round-trips through the Rust side and emits a
 * `Notice` event so the audit log carries a record of every tweak.
 */

import { useEffect, useState } from 'react';
import {
  chipActiveStyle,
  chipBaseStyle,
  DISPLAY_FONT,
  emptyStateStyle,
  hintStyle,
  inputStyle,
  mutedBtnStyle,
  primaryBtnStyle,
  sectionStyle,
  sectionTitleStyle,
} from './styles';
import {
  fetchPolicy,
  fetchQuotaUsage,
  patchPolicy,
  policyAllowHost,
  policyBlockHost,
  policyDisableTool,
  policyEnableTool,
  policyRemoveHost,
  policyReset,
  policySetQuota,
} from './api';
import type { EgressMode, EnforcementPolicy } from './types';

const DEFAULT_POLICY: EnforcementPolicy = {
  egress_mode: 'observe',
  allowed_hosts: [],
  blocked_hosts: [],
  disabled_tools: [],
  force_confirm_all: false,
  scrub_prompts: true,
  subagent_role_scoping: true,
  tool_quotas: {},
  revision: 0,
};

const COMMON_TOOLS: ReadonlyArray<{ name: string; label: string; desc: string }> = [
  { name: 'web_fetch', label: 'web_fetch', desc: 'Agent can reach any public URL through our SSRF-guarded client.' },
  { name: 'web_search', label: 'web_search', desc: 'DuckDuckGo / Brave search via our client.' },
  { name: 'browser_open', label: 'browser_open', desc: 'Opens URL in Safari (requires Automation).' },
  { name: 'mail_send', label: 'mail_send', desc: 'Send email via Mail.app.  Always confirmed.' },
  { name: 'imessage_send', label: 'imessage_send', desc: 'Send iMessage. Always confirmed.' },
  { name: 'messaging_send_sms', label: 'messaging_send_sms', desc: 'Send SMS via Messages.app.' },
  { name: 'calendar_create_event', label: 'calendar_create_event', desc: 'Create calendar events.' },
  { name: 'notes_create', label: 'notes_create', desc: 'Create a new Apple Note.' },
  { name: 'notes_append', label: 'notes_append', desc: 'Append to an existing Apple Note.' },
  { name: 'reminders_add', label: 'reminders_add', desc: 'Create a reminder.' },
  { name: 'shortcut_run', label: 'shortcut_run', desc: 'Run a macOS Shortcut.' },
  { name: 'app_launch', label: 'app_launch', desc: 'Launch a macOS app.' },
  { name: 'py_run', label: 'py_run', desc: 'Execute Python in a sandbox.' },
  { name: 'screen_capture_full', label: 'screen_capture_full', desc: 'Capture full screen (base64 to LLM).' },
  { name: 'screen_ocr', label: 'screen_ocr', desc: 'OCR full screen; text to LLM.' },
  { name: 'clipboard_history', label: 'clipboard_history', desc: 'Read clipboard captures.' },
  { name: 'claude_code_supervise', label: 'claude_code_supervise', desc: 'Drive Claude Code autonomously.' },
  { name: 'deep_research', label: 'deep_research', desc: 'Parallel multi-worker research ReAct loop.' },
];

export function PolicyTab() {
  const [policy, setPolicy] = useState<EnforcementPolicy>(DEFAULT_POLICY);
  const [usage, setUsage] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [hostInput, setHostInput] = useState('');
  const [toolInput, setToolInput] = useState('');
  const [quotaTool, setQuotaTool] = useState('');
  const [quotaCap, setQuotaCap] = useState('');
  const [toast, setToast] = useState<string | null>(null);

  const reload = async () => {
    setBusy(true);
    const p = await fetchPolicy();
    const u = await fetchQuotaUsage();
    if (p) setPolicy(p);
    setUsage(u);
    setBusy(false);
  };

  useEffect(() => {
    void reload();
    const t = window.setInterval(() => void reload(), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const applyPatch = async (patch: Parameters<typeof patchPolicy>[0]) => {
    setBusy(true);
    const p = await patchPolicy(patch);
    if (p) setPolicy(p);
    setBusy(false);
    flashToast('policy updated');
  };

  const flashToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2500);
  };

  const onAddAllow = async () => {
    const h = hostInput.trim();
    if (!h) return;
    const p = await policyAllowHost(h);
    if (p) setPolicy(p);
    setHostInput('');
    flashToast(`allowed ${h}`);
  };

  const onAddBlock = async () => {
    const h = hostInput.trim();
    if (!h) return;
    const p = await policyBlockHost(h);
    if (p) setPolicy(p);
    setHostInput('');
    flashToast(`blocked ${h}`);
  };

  const onRemoveHost = async (host: string, list: 'allowed' | 'blocked') => {
    const p = await policyRemoveHost(host, list);
    if (p) setPolicy(p);
    flashToast(`removed ${host} from ${list}`);
  };

  const onToggleTool = async (name: string, disabled: boolean) => {
    const p = disabled ? await policyEnableTool(name) : await policyDisableTool(name);
    if (p) setPolicy(p);
    flashToast(`${disabled ? 'enabled' : 'disabled'} ${name}`);
  };

  const onDisableCustomTool = async () => {
    const t = toolInput.trim();
    if (!t) return;
    const p = await policyDisableTool(t);
    if (p) setPolicy(p);
    setToolInput('');
    flashToast(`disabled ${t}`);
  };

  const onReset = async () => {
    if (!confirm('Reset enforcement policy to defaults? This clears custom host lists + tool kill-switches.')) return;
    const p = await policyReset();
    if (p) setPolicy(p);
    flashToast('reset to defaults');
  };

  return (
    <>
      {toast && (
        <div style={{
          position: 'sticky', top: 0, zIndex: 2,
          marginBottom: 10, padding: '6px 12px',
          border: '1px solid var(--cyan)', background: 'rgba(57, 229, 255, 0.12)',
          color: 'var(--cyan)', fontFamily: 'var(--mono)', fontSize: 11,
        }}>{toast}</div>
      )}

      {/* Enforcement toggles */}
      <section style={sectionStyle}>
        <div style={sectionTitleStyle}>
          <span>ENFORCEMENT MODE</span>
          <span style={{ ...hintStyle, marginLeft: 'auto' }}>
            Phase 3 hard enforcement · policy revision #{policy.revision}
          </span>
          <button style={mutedBtnStyle} onClick={() => void onReset()} disabled={busy}>
            RESET DEFAULTS
          </button>
        </div>

        {/* Egress mode selector */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.22em', color: 'var(--ink-dim)', marginBottom: 6 }}>
            AGENT EGRESS MODE
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {(['observe', 'warn', 'block'] as EgressMode[]).map(mode => (
              <button
                key={mode}
                onClick={() => void applyPatch({ egress_mode: mode })}
                disabled={busy}
                style={{
                  ...chipBaseStyle,
                  ...(policy.egress_mode === mode ? chipActiveStyle : {}),
                  padding: '8px 14px',
                  flex: 1,
                  textAlign: 'center',
                  fontSize: 11,
                }}
                title={EGRESS_MODE_BLURB[mode]}
              >
                {mode.toUpperCase()}
              </button>
            ))}
          </div>
          <div style={{ ...hintStyle, marginTop: 6 }}>
            {EGRESS_MODE_BLURB[policy.egress_mode]}
          </div>
        </div>

        {/* Switches */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
          <ToggleCard
            label="FORCE CONFIRM ALL"
            desc="Require user approval on every tool dispatch, not just dangerous ones. Slow but maximally safe."
            value={policy.force_confirm_all}
            disabled={busy}
            onChange={v => void applyPatch({ force_confirm_all: v })}
          />
          <ToggleCard
            label="SCRUB PROMPTS"
            desc="Strip API keys / JWTs / emails from outbound LLM prompts (cloud providers only)."
            value={policy.scrub_prompts}
            disabled={busy}
            onChange={v => void applyPatch({ scrub_prompts: v })}
          />
          <ToggleCard
            label="SUB-AGENT SCOPING"
            desc="Restrict sub-agents to a role-appropriate tool subset."
            value={policy.subagent_role_scoping}
            disabled={busy}
            onChange={v => void applyPatch({ subagent_role_scoping: v })}
          />
        </div>
      </section>

      {/* Allowlist editor */}
      <section style={sectionStyle}>
        <div style={sectionTitleStyle}>
          <span>EGRESS HOSTS</span>
          <span style={{ ...hintStyle, marginLeft: 'auto' }}>
            {policy.allowed_hosts.length} allowed · {policy.blocked_hosts.length} blocked · suffix pattern = prefix with `.`
          </span>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          <input
            type="text"
            placeholder="api.example.com or .example.com (suffix)"
            value={hostInput}
            onChange={e => setHostInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void onAddAllow(); }}
            style={{ ...inputStyle, flex: 1, minWidth: 240 }}
          />
          <button style={primaryBtnStyle} onClick={() => void onAddAllow()} disabled={busy || !hostInput.trim()}>
            + ALLOW
          </button>
          <button style={{ ...mutedBtnStyle, padding: '8px 14px', borderColor: 'rgba(255, 77, 94, 0.6)', color: 'var(--red)' }}
            onClick={() => void onAddBlock()} disabled={busy || !hostInput.trim()}>
            + BLOCK
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <HostListCard
            title="ALLOWED"
            hosts={policy.allowed_hosts}
            color="var(--green)"
            onRemove={h => void onRemoveHost(h, 'allowed')}
          />
          <HostListCard
            title="BLOCKED"
            hosts={policy.blocked_hosts}
            color="var(--red)"
            onRemove={h => void onRemoveHost(h, 'blocked')}
          />
        </div>
      </section>

      {/* Tool kill-switches */}
      <section style={sectionStyle}>
        <div style={sectionTitleStyle}>
          <span>TOOL KILL-SWITCHES</span>
          <span style={{ ...hintStyle, marginLeft: 'auto' }}>
            {policy.disabled_tools.length} disabled
          </span>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input
            type="text"
            placeholder="tool_name (e.g. web_fetch)"
            value={toolInput}
            onChange={e => setToolInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void onDisableCustomTool(); }}
            style={{ ...inputStyle, flex: 1, minWidth: 220 }}
          />
          <button style={primaryBtnStyle} onClick={() => void onDisableCustomTool()} disabled={busy || !toolInput.trim()}>
            DISABLE
          </button>
        </div>

        <div style={{ display: 'grid', gap: 4 }}>
          {COMMON_TOOLS.map(t => {
            const disabled = policy.disabled_tools.includes(t.name);
            const color = disabled ? 'var(--red)' : 'var(--ink-dim)';
            return (
              <div
                key={t.name}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '180px 1fr 110px',
                  gap: 10,
                  alignItems: 'center',
                  padding: '6px 10px',
                  border: `1px solid ${disabled ? 'var(--red)' : 'var(--line-soft)'}`,
                  background: disabled ? 'rgba(255, 77, 94, 0.06)' : 'rgba(4, 10, 16, 0.45)',
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                }}
              >
                <span style={{ color: disabled ? color : 'var(--ink)' }}>{t.label}</span>
                <span style={{ color: 'var(--ink-dim)', fontSize: 10.5 }}>{t.desc}</span>
                <button
                  onClick={() => void onToggleTool(t.name, disabled)}
                  style={{
                    ...chipBaseStyle,
                    color,
                    borderColor: disabled ? color : 'var(--line-soft)',
                    padding: '4px 10px',
                    fontSize: 10,
                    letterSpacing: '0.18em',
                    textAlign: 'center',
                  }}
                  disabled={busy}
                >
                  {disabled ? '◼ DISABLED' : '◯ ENABLE'}
                </button>
              </div>
            );
          })}
          {policy.disabled_tools
            .filter(t => !COMMON_TOOLS.some(c => c.name === t))
            .map(t => (
              <div
                key={t}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '180px 1fr 110px',
                  gap: 10,
                  alignItems: 'center',
                  padding: '6px 10px',
                  border: '1px solid var(--red)',
                  background: 'rgba(255, 77, 94, 0.06)',
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                }}
              >
                <span style={{ color: 'var(--red)' }}>{t}</span>
                <span style={{ color: 'var(--ink-dim)', fontSize: 10.5 }}>custom kill-switch</span>
                <button
                  onClick={() => void onToggleTool(t, true)}
                  style={{
                    ...chipBaseStyle,
                    color: 'var(--red)',
                    borderColor: 'var(--red)',
                    padding: '4px 10px',
                    fontSize: 10,
                  }}
                  disabled={busy}
                >
                  ◼ DISABLED
                </button>
              </div>
            ))}
        </div>
      </section>

      {/* Daily tool quotas */}
      <section style={sectionStyle}>
        <div style={sectionTitleStyle}>
          <span>DAILY TOOL QUOTAS</span>
          <span style={{ ...hintStyle, marginLeft: 'auto' }}>
            Counts reset at local midnight · {Object.keys(policy.tool_quotas).length} capped
          </span>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
          <input
            type="text"
            placeholder="tool_name"
            value={quotaTool}
            onChange={e => setQuotaTool(e.target.value)}
            style={{ ...inputStyle, flex: 1, minWidth: 180 }}
          />
          <input
            type="number"
            placeholder="cap / day"
            min="1"
            value={quotaCap}
            onChange={e => setQuotaCap(e.target.value)}
            style={{ ...inputStyle, width: 120 }}
          />
          <button
            style={primaryBtnStyle}
            disabled={busy || !quotaTool.trim() || !quotaCap.trim()}
            onClick={async () => {
              const cap = Number(quotaCap);
              if (!Number.isFinite(cap) || cap < 1) return;
              const p = await policySetQuota(quotaTool.trim(), cap);
              if (p) setPolicy(p);
              setQuotaTool('');
              setQuotaCap('');
              flashToast(`set quota ${quotaTool} = ${cap}/day`);
            }}
          >
            SET
          </button>
        </div>

        {Object.keys(policy.tool_quotas).length === 0 ? (
          <div style={{ ...hintStyle }}>No quotas set — every tool can be called unlimited times per day.</div>
        ) : (
          <div style={{ display: 'grid', gap: 3 }}>
            {Object.entries(policy.tool_quotas)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([tool, cap]) => {
                const used = usage[tool] ?? 0;
                const pct = Math.min(100, Math.round((used / cap) * 100));
                const exceeded = used >= cap;
                const near = used >= cap * 0.75;
                const color = exceeded ? 'var(--red)' : near ? 'var(--amber)' : 'var(--cyan)';
                return (
                  <div
                    key={tool}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '200px 90px 1fr 90px 70px',
                      gap: 10,
                      alignItems: 'center',
                      padding: '5px 10px',
                      border: `1px solid ${exceeded ? color : 'var(--line-soft)'}`,
                      background: exceeded ? `${color}0a` : 'rgba(4, 10, 16, 0.45)',
                      fontFamily: 'var(--mono)',
                      fontSize: 11,
                    }}
                  >
                    <span style={{ color: 'var(--ink)' }}>{tool}</span>
                    <span style={{ color, textAlign: 'right' }}>
                      {used}/{cap}
                    </span>
                    <div
                      aria-hidden="true"
                      style={{
                        height: 4,
                        background: 'rgba(255,255,255,0.05)',
                        position: 'relative',
                      }}
                    >
                      <div
                        style={{
                          position: 'absolute',
                          inset: 0,
                          width: `${pct}%`,
                          background: color,
                          opacity: 0.8,
                        }}
                      />
                    </div>
                    <span style={{ color: 'var(--ink-dim)', textAlign: 'right', fontSize: 10 }}>
                      {exceeded ? 'EXCEEDED' : `${pct}%`}
                    </span>
                    <button
                      onClick={async () => {
                        const p = await policySetQuota(tool, null);
                        if (p) setPolicy(p);
                        flashToast(`cleared quota for ${tool}`);
                      }}
                      style={{
                        ...chipBaseStyle,
                        color: 'var(--ink-dim)',
                        fontSize: 9,
                        padding: '2px 6px',
                      }}
                      disabled={busy}
                    >
                      ✕ CLEAR
                    </button>
                  </div>
                );
              })}
          </div>
        )}
      </section>

      {/* Info footer */}
      <section style={{ ...sectionStyle, borderStyle: 'dashed' }}>
        <div style={sectionTitleStyle}>HOW THESE WORK</div>
        <ul style={{ ...hintStyle, margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>
          <li>
            <strong>Observe</strong> never blocks. <strong>Warn</strong> flags agent egress to
            off-allowlist hosts but still sends. <strong>Block</strong> refuses the request and
            records a <code>blocked=true</code> NetRequest event. Non-agent egress (scanner,
            provider bootstrap, weather) is never blocked.
          </li>
          <li>
            <strong>Force-confirm-all</strong> makes the ConfirmGate modal appear for every tool
            dispatch, including read-only ones. Useful when you're reviewing an unfamiliar
            automation.
          </li>
          <li>
            <strong>Scrub prompts</strong> applies the same 6-pattern secret regex used on the
            audit log to outbound chat history before it hits Anthropic / GLM / OpenRouter.
            Doesn't affect local Ollama.
          </li>
          <li>
            <strong>Sub-agent scoping</strong> restricts each role to an appropriate tool subset:
            summarizers / writers see read-only tools; researchers get web; coders add py_run +
            claude_code_supervise; browser_driver gets browser_*.
          </li>
          <li>
            Policy persists at <code>~/.sunny/security/policy.json</code> (0600) and survives
            restarts. Every change emits a <code>notice</code> event in the audit log.
          </li>
        </ul>
      </section>
    </>
  );
}

const EGRESS_MODE_BLURB: Record<EgressMode, string> = {
  observe: 'Record every request; never block. Default. Use while you build up the allowlist.',
  warn:    'Let every agent-initiated request through, but fire a Warn event when the host is not on the allowlist.',
  block:   'Refuse agent-initiated requests to hosts not on the allowlist. Non-agent egress still works.',
};

function ToggleCard({
  label,
  desc,
  value,
  disabled,
  onChange,
}: {
  label: string;
  desc: string;
  value: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  const color = value ? 'var(--cyan)' : 'var(--ink-dim)';
  return (
    <button
      onClick={() => onChange(!value)}
      disabled={disabled}
      style={{
        all: 'unset',
        cursor: disabled ? 'default' : 'pointer',
        border: `1px solid ${value ? color : 'var(--line-soft)'}`,
        background: value ? 'rgba(57, 229, 255, 0.08)' : 'rgba(4, 10, 16, 0.4)',
        padding: '10px 12px',
        display: 'grid',
        gap: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            width: 12, height: 12,
            border: `1px solid ${color}`,
            background: value ? color : 'transparent',
          }}
        />
        <span style={{ fontFamily: DISPLAY_FONT, fontSize: 10.5, letterSpacing: '0.22em', color, fontWeight: 700 }}>
          {label}
        </span>
      </div>
      <span style={{ ...hintStyle, fontSize: 10, lineHeight: 1.4 }}>{desc}</span>
    </button>
  );
}

function HostListCard({
  title,
  hosts,
  color,
  onRemove,
}: {
  title: string;
  hosts: ReadonlyArray<string>;
  color: string;
  onRemove: (h: string) => void;
}) {
  return (
    <div style={{ border: `1px solid ${color}44`, background: `${color}08`, padding: 10 }}>
      <div style={{
        fontFamily: DISPLAY_FONT, fontSize: 10, letterSpacing: '0.24em',
        color, fontWeight: 700, marginBottom: 8,
      }}>
        {title} · {hosts.length}
      </div>
      {hosts.length === 0 ? (
        <div style={{ ...emptyStateStyle, padding: '20px 10px', fontSize: 10 }}>
          (empty)
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 2, maxHeight: 320, overflowY: 'auto' }}>
          {hosts.map(h => (
            <div
              key={h}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 56px',
                gap: 8,
                padding: '3px 8px',
                fontFamily: 'var(--mono)',
                fontSize: 10.5,
                border: '1px solid var(--line-soft)',
                background: 'rgba(4, 10, 16, 0.45)',
              }}
            >
              <span style={{ color: 'var(--ink)' }}>{h}</span>
              <button
                onClick={() => onRemove(h)}
                style={{
                  all: 'unset',
                  cursor: 'pointer',
                  textAlign: 'center',
                  color: 'var(--ink-dim)',
                  fontSize: 10,
                  border: '1px solid var(--line-soft)',
                  padding: '1px 6px',
                }}
              >
                ✕ remove
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
