/** Ordered from most positive to most negative — dominantMoodGlyph picks the first match. */
export type MoodOption = {
  id: string;
  glyph: string;
  label: string;
  tone: 'green' | 'cyan' | 'amber' | 'gold' | 'red' | 'violet' | 'teal' | 'pink';
};

export const MOOD_OPTIONS: ReadonlyArray<MoodOption> = [
  { id: 'elated',   glyph: '✦',  label: 'ELATED',   tone: 'green' },
  { id: 'good',     glyph: '◉',  label: 'GOOD',     tone: 'cyan' },
  { id: 'focused',  glyph: '⊙',  label: 'FOCUSED',  tone: 'teal' },
  { id: 'calm',     glyph: '○',  label: 'CALM',     tone: 'violet' },
  { id: 'meh',      glyph: '◌',  label: 'MEH',      tone: 'gold' },
  { id: 'stressed', glyph: '◈',  label: 'STRESSED', tone: 'amber' },
  { id: 'drained',  glyph: '◇',  label: 'DRAINED',  tone: 'pink' },
  { id: 'low',      glyph: '▽',  label: 'LOW',      tone: 'red' },
];
