import type { Tone } from './types';

export const LOCAL_STORAGE_KEY = 'sunny.events.v2';
export const LEGACY_STORAGE_KEYS = ['sunny.events.v1'] as const;
export const HIDDEN_CAL_KEY = 'sunny.cal.hidden.v1';

export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export const MONTH_NAMES = [
  'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
  'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER',
] as const;

export const TONES: ReadonlyArray<Tone> = ['normal', 'now', 'amber'];
