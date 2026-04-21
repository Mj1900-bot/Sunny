/**
 * AutopilotTab — Composes all 6 Autopilot settings sections.
 *
 * Layout (2-column grid):
 *   Col 1: Autopilot  | Col 2: Wake Word
 *   Col 1: Trust      | Col 2: Continuity
 *   Col 1: Providers  | Col 2: Voice
 *
 * Data flow: useAutopilotSettings hook → shared patch callback → sub-sections.
 */

import type { JSX } from 'react';
import { useAutopilotSettings } from './useAutopilotSettings';
import { AutopilotSection } from './AutopilotSection';
import { WakeWordSection } from './WakeWordSection';
import { TrustLevelSection } from './TrustLevelSection';
import { ContinuitySection } from './ContinuitySection';
import { ProvidersSection } from './ProvidersSection';
import { VoiceSection } from './VoiceSection';
import { twoColGrid } from './styles';

export function AutopilotTab(): JSX.Element {
  const { settings, pending, patch } = useAutopilotSettings();

  return (
    <div style={twoColGrid}>
      <AutopilotSection settings={settings} pending={pending} patch={patch} />
      <WakeWordSection  settings={settings} pending={pending} patch={patch} />
      <TrustLevelSection settings={settings} pending={pending} patch={patch} />
      <ContinuitySection settings={settings} pending={pending} patch={patch} />
      <ProvidersSection  settings={settings} pending={pending} patch={patch} />
      <VoiceSection      settings={settings} pending={pending} patch={patch} />
    </div>
  );
}
