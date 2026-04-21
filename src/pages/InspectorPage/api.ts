import { invokeSafe } from '../../lib/tauri';

export type FocusedApp = { name: string; bundle_id: string | null; pid: number };

export type WindowInfo = {
  app_name: string;
  title: string;
  pid: number;
  window_id: number | null;
  x: number | null;
  y: number | null;
  w: number | null;
  h: number | null;
};

export type OcrResult = {
  text: string;
  blocks?: ReadonlyArray<{ text: string; x: number; y: number; w: number; h: number }>;
};

export async function focusedApp(): Promise<FocusedApp | null> {
  return invokeSafe<FocusedApp>('window_focused_app');
}

export async function activeTitle(): Promise<string | null> {
  return invokeSafe<string>('window_active_title');
}

export async function listWindows(): Promise<ReadonlyArray<WindowInfo>> {
  return (await invokeSafe<WindowInfo[]>('window_list')) ?? [];
}

export async function screenSize(): Promise<{ width: number; height: number } | null> {
  const r = await invokeSafe<[number, number]>('screen_size');
  return r ? { width: r[0], height: r[1] } : null;
}

export async function ocrFullScreen(): Promise<OcrResult | null> {
  return invokeSafe<OcrResult>('ocr_full_screen', { display: null, options: null });
}

export async function cursorPosition(): Promise<{ x: number; y: number } | null> {
  const r = await invokeSafe<[number, number]>('cursor_position');
  return r ? { x: r[0], y: r[1] } : null;
}
