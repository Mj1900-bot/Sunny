export type ScreenImage = {
  readonly width: number;
  readonly height: number;
  readonly format: string;
  readonly bytes_len: number;
  readonly base64: string;
};

export type FocusedApp = {
  readonly name: string;
  readonly bundle_id: string | null;
  readonly pid: number;
};

export type WindowInfo = {
  readonly app_name: string;
  readonly title: string;
  readonly pid: number;
  readonly window_id: number | null;
  readonly x: number | null;
  readonly y: number | null;
  readonly w: number | null;
  readonly h: number | null;
};

export type OcrBox = {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly confidence: number;
};

export type OcrResult = {
  readonly text: string;
  readonly boxes: ReadonlyArray<OcrBox>;
  readonly engine: string;
  readonly width: number;
  readonly height: number;
  readonly psm: number;
  readonly avg_confidence: number;
};

/** User-tunable OCR knobs that get serialized straight to Rust. */
export type OcrOptions = {
  readonly psm: number;
  readonly minConf: number;
};

/** Tesseract PSM presets, surfaced in the UI as a small selector. */
export type PsmPreset = {
  readonly psm: number;
  readonly label: string;
  readonly hint: string;
};

export type ActivityKind = 'SNAP' | 'WIN' | 'OCR' | 'FOCUS' | 'IDLE' | 'ERR' | 'SYS' | 'CLICK';

export type Activity = {
  readonly id: string;
  readonly kind: ActivityKind;
  readonly time: string;
  readonly text: string;
};

export type CaptureSource = 'FULL' | 'ACTIVE WINDOW' | 'REGION';

export type Capture = {
  readonly id: string;
  readonly image: ScreenImage;
  readonly source: CaptureSource;
  readonly capturedAt: number;
  readonly region?: { x: number; y: number; w: number; h: number };
  readonly app?: string;
  readonly title?: string;
};

export type AutoCadence = 'OFF' | '5s' | '15s' | '60s';

export type ScreenSize = { readonly w: number; readonly h: number };

/** Drag rectangle in normalized [0..1] image coordinates. */
export type DragRect = { readonly u0: number; readonly v0: number; readonly u1: number; readonly v1: number };

export type ScreenPrefs = {
  cadence: AutoCadence;
  showBoxes: boolean;
  /** OCR page-segmentation mode. */
  ocrPsm: number;
  /** Minimum confidence floor used when calling OCR (0–100). */
  ocrMinConf: number;
  /** Render the OCR transcript with preserved horizontal whitespace. */
  ocrPreserveLayout: boolean;
};

export type PermissionStatus = 'unknown' | 'checking' | 'granted' | 'missing';

export type PermissionState = {
  readonly status: PermissionStatus;
  /** The real error string from the backend when `status === 'missing'`. */
  readonly message?: string;
};

export type PermissionProbe = {
  readonly screenRecording: PermissionState;
  readonly automation: PermissionState;
  readonly accessibility: PermissionState;
  readonly tesseract: PermissionState;
  readonly checkedAt: number;
};

export type PaneKey = 'screenRecording' | 'automation' | 'accessibility';

export type ScreenCache = {
  capture: Capture | null;
  ocr: OcrResult | null;
  history: ReadonlyArray<Capture>;
  activity: ReadonlyArray<Activity>;
  probe: PermissionProbe;
};

export type RegionInput = { x: string; y: string; w: string; h: string };
