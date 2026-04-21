/**
 * PERSONA — first-class editor for Sunny's constitution.
 *
 * Wraps the three parts of the constitution (identity, values,
 * prohibitions) in dedicated editors. Saves are atomic: we pass the
 * full object back via `constitution_save`. The page is deliberately
 * promoted out of Settings because the constitution is the most
 * important thing the user teaches Sunny.
 *
 * Upgraded with:
 *  - ConstitutionStrength progress gauge
 *  - AI quick actions (review, suggest values)
 *  - Enhanced stat blocks with sub-labels
 *  - Dirty-state glow on the save bar
 */

import { useState } from 'react';
import { ModuleView } from '../../components/ModuleView';
import {
  PageGrid, PageCell, EmptyState, ToolbarButton, StatBlock,
  PageLead, useFlashMessage, usePoll,
} from '../_shared';
import { downloadTextFile } from '../_shared/snapshots';
import { copyToClipboard } from '../../lib/clipboard';
import { askSunny } from '../../lib/askSunny';
import { IdentityCard } from './IdentityCard';
import { ValuesEditor } from './ValuesEditor';
import { Prohibitions } from './Prohibitions';
import { ConstitutionStrength } from './ConstitutionStrength';
import { PersonaPreview } from './PersonaPreview';
import { loadConstitution, saveConstitution, type Constitution } from './api';

export function PersonaPage() {
  const [value, setValue] = useState<Constitution | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: loaded, reload } = usePoll(loadConstitution, 60_000);
  const { message: copyHint, flash } = useFlashMessage();

  const source = value ?? loaded;

  if (!source) {
    return (
      <ModuleView title="PERSONA · CONSTITUTION">
        <EmptyState title="Loading constitution…" />
      </ModuleView>
    );
  }

  const dirty = value != null && JSON.stringify(value) !== JSON.stringify(loaded);

  const save = async () => {
    if (!value) return;
    setBusy(true);
    try {
      await saveConstitution(value);
      setValue(null);
      reload();
      flash('Constitution saved');
    } finally { setBusy(false); }
  };

  const revert = () => { setValue(null); reload(); };

  const constitutionText = JSON.stringify(source, null, 2);

  return (
    <ModuleView title="PERSONA · CONSTITUTION">
      <PageGrid>
        {/* Row 1: Header + Strength gauge */}
        <PageCell span={12}>
          <PageLead>
            Sunny&apos;s constitution on disk — identity, values, and prohibitions. Saves are atomic; changes apply on the next agent turn.
          </PageLead>
          <ConstitutionStrength constitution={source} />
        </PageCell>

        {/* Row 2: Stats + Actions */}
        <PageCell span={12}>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: 10, marginBottom: 8,
          }}>
            <StatBlock label="NAME" value={source.identity.name || '—'} sub="identity" tone="cyan" />
            <StatBlock label="OPERATOR" value={source.identity.operator || '—'} sub="owner" tone="violet" />
            <StatBlock label="VALUES" value={String(source.values.length)} sub="guiding principles" tone="gold" />
            <StatBlock
              label="PROHIBITIONS"
              value={String(source.prohibitions.length)}
              sub="hard red lines"
              tone={source.prohibitions.length > 0 ? 'red' : 'amber'}
            />
            <StatBlock label="SCHEMA" value={`v${source.schema_version}`} sub="version" tone="green" />
          </div>

          {/* Save/Revert bar with dirty glow */}
          <div style={{
            display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center',
            padding: dirty ? '8px 12px' : '4px 0',
            border: dirty ? '1px solid var(--green)55' : 'none',
            background: dirty ? 'rgba(0, 255, 120, 0.03)' : 'transparent',
            boxShadow: dirty ? '0 0 12px rgba(0, 255, 120, 0.08)' : 'none',
            transition: 'all 200ms ease',
          }}>
            {dirty
              ? (
                <ToolbarButton tone="green" onClick={save} disabled={busy} title="Write constitution to ~/.sunny/constitution.json">
                  {busy ? 'SAVING…' : '✦ SAVE CHANGES'}
                </ToolbarButton>
              )
              : <ToolbarButton disabled>NO UNSAVED CHANGES</ToolbarButton>}
            <ToolbarButton onClick={revert} disabled={busy || !dirty} title="Discard local edits and reload from disk">
              REVERT
            </ToolbarButton>
            <ToolbarButton
              tone="violet"
              disabled={busy}
              title="Copy full JSON to clipboard"
              onClick={async () => {
                const ok = await copyToClipboard(constitutionText);
                flash(ok ? 'Constitution JSON copied' : 'Copy failed');
              }}
            >
              COPY JSON
            </ToolbarButton>
            <ToolbarButton
              tone="cyan"
              disabled={busy}
              title="Save a backup file"
              onClick={() => {
                const safe = source.identity.name.replace(/[^\w.-]+/g, '_') || 'constitution';
                downloadTextFile(`sunny-constitution-${safe}-v${source.schema_version}.json`, constitutionText, 'application/json');
                flash('Download started');
              }}
            >
              DOWNLOAD JSON
            </ToolbarButton>
            <ToolbarButton
              tone="green"
              title="Ask Sunny to review your constitution for gaps"
              onClick={() => askSunny(
                `Here's my current Sunny constitution:\n\n${constitutionText}\n\nReview it for completeness. Are there any gaps in identity, values, or guardrails? Suggest improvements.`,
                'persona',
              )}
            >
              ◎ REVIEW CONSTITUTION
            </ToolbarButton>
            <ToolbarButton
              tone="amber"
              title="Ask Sunny to suggest new values"
              onClick={() => askSunny(
                `My current values are:\n${source.values.map((v, i) => `${i + 1}. ${v}`).join('\n')}\n\nSuggest 3-5 additional values that would make Sunny a better assistant, based on best practices for AI constitution design.`,
                'persona',
              )}
            >
              ✦ SUGGEST VALUES
            </ToolbarButton>
            {copyHint && (
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--green)' }}>{copyHint}</span>
            )}
          </div>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)', marginTop: 4,
          }}>
            ~/.sunny/constitution.json · schema v{source.schema_version}
          </div>
        </PageCell>

        {/* Row 3: Identity (6) | Values (6) */}
        <PageCell span={6}>
          <IdentityCard
            value={source.identity}
            onChange={identity => setValue({ ...source, identity })}
          />
        </PageCell>

        <PageCell span={6}>
          <ValuesEditor
            values={source.values}
            onChange={values => setValue({ ...source, values })}
          />
        </PageCell>

        {/* Row 4: Prohibitions (full width) */}
        <PageCell span={12}>
          <Prohibitions
            items={source.prohibitions}
            onChange={prohibitions => setValue({ ...source, prohibitions })}
          />
        </PageCell>

        {/* Row 5: System prompt preview */}
        <PageCell span={12}>
          <PersonaPreview constitution={source} />
        </PageCell>
      </PageGrid>
    </ModuleView>
  );
}
