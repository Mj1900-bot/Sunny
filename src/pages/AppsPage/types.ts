export type App = { name: string; path: string };
export type WindowInfo = { app_name: string; title: string; pid: number };

export type Category =
  | 'FAVORITES'
  | 'SYSTEM'
  | 'DEVELOPER'
  | 'DESIGN'
  | 'PRODUCTIVITY'
  | 'MEDIA'
  | 'GAMES'
  | 'UTILITIES'
  | 'OTHER';

export type ChipKey = 'ALL' | 'RUNNING' | Category;
export type ViewMode = 'grid' | 'list';
export type SortKey = 'name' | 'recent' | 'launches';
