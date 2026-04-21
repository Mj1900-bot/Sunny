/**
 * VoiceSection — Section 6 of the Autopilot settings tab.
 * TTS voice dropdown (Kokoro voices), TTS speed slider 0.5–2.0x,
 * STT model dropdown (whisper-small / medium).
 */

import type { CSSProperties } from 'react';
import type { AutopilotSettings, PendingKeys } from './autopilotTypes';
import { PendingDot } from './PendingDot';
import {
  hintStyle,
  inputStyle,
  labelStyle,
  sectionStyle,
  sectionTitleStyle,
} from './styles';

/** Known Kokoro voices — updated when `list_voices` returns more. */
const TTS_VOICES: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
  { value: 'British',   label: 'George (British)' },
  { value: 'American',  label: 'Emily (American)' },
  { value: 'Australian',label: 'Isla (Australian)' },
  { value: 'Scottish',  label: 'Angus (Scottish)' },
  { value: 'Irish',     label: 'Cillian (Irish)' },
];

const STT_MODELS: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
  { value: 'whisper-small',  label: 'Whisper Small (fast)' },
  { value: 'whisper-medium', label: 'Whisper Medium (accurate)' },
];

type Props = {
  readonly settings: AutopilotSettings;
  readonly pending: PendingKeys;
  readonly patch: (diff: Partial<AutopilotSettings>) => void;
};

export function VoiceSection({ settings, pending, patch }: Props) {
  return (
    <section style={sectionStyle} aria-labelledby="sect-voice">
      <h3 id="sect-voice" style={sectionTitleStyle}>VOICE</h3>

      <div style={{ marginBottom: 12 }}>
        <label htmlFor="voice-tts-voice" style={labelStyle}>
          TTS VOICE
          <PendingDot active={pending.has('ttsVoice')} />
        </label>
        <select
          id="voice-tts-voice"
          value={settings.ttsVoice}
          onChange={e => patch({ ttsVoice: e.target.value })}
          style={selectStyle}
          aria-label="TTS Voice"
        >
          {TTS_VOICES.map(v => (
            <option key={v.value} value={v.value}>{v.label}</option>
          ))}
        </select>
      </div>

      <div style={{ marginBottom: 12 }}>
        <label htmlFor="voice-tts-speed" style={labelStyle}>
          TTS SPEED — {settings.ttsSpeed.toFixed(1)}x
          <PendingDot active={pending.has('ttsSpeed')} />
        </label>
        <input
          id="voice-tts-speed"
          type="range"
          min={0.5}
          max={2.0}
          step={0.1}
          value={settings.ttsSpeed}
          onChange={e => patch({ ttsSpeed: parseFloat(e.target.value) })}
          style={{ width: '100%' }}
          aria-valuemin={0.5}
          aria-valuemax={2.0}
          aria-valuenow={settings.ttsSpeed}
          aria-valuetext={`${settings.ttsSpeed.toFixed(1)}x`}
        />
        <div style={hintStyle}>Playback speed multiplier for Kokoro TTS output.</div>
      </div>

      <div>
        <label htmlFor="voice-stt-model" style={labelStyle}>
          STT MODEL
          <PendingDot active={pending.has('sttModel')} />
        </label>
        <select
          id="voice-stt-model"
          value={settings.sttModel}
          onChange={e => patch({ sttModel: e.target.value })}
          style={selectStyle}
          aria-label="STT model"
        >
          {STT_MODELS.map(m => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>
        <div style={hintStyle}>
          Small: ~390 MB VRAM, fastest. Medium: ~1.5 GB VRAM, better accuracy on accents.
        </div>
      </div>
    </section>
  );
}

const selectStyle: CSSProperties = {
  ...inputStyle,
  appearance: 'none',
  WebkitAppearance: 'none',
  cursor: 'pointer',
  paddingRight: 28,
  backgroundImage:
    `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%2339e5ff' opacity='0.55'/%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'right 10px center',
};
