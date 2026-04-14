export type RuntimeSource =
  | "unavailable"
  | "codex_shared"
  | "system_existing"
  | "app_managed";

export type SourceKind = "file" | "directory";

export type ConversionItemState =
  | "pending"
  | "converting"
  | "converted"
  | "skipped"
  | "failed";

export interface ConversionJob {
  sourceUrl: string;
  sourceKind: SourceKind;
  destinationRoot: string;
}

export interface ConversionItem {
  sourceUrl: string;
  outputUrl: string;
  state: ConversionItemState;
  errorMessage: string | null;
}

export interface ConversionProgress {
  totalCount: number;
  processedCount: number;
  convertedCount: number;
  skippedCount: number;
  failedCount: number;
  fractionCompleted: number;
  currentFile: string | null;
}

export interface ConversionSummary {
  converted: number;
  skipped: number;
  failed: number;
  durationSeconds: number;
}

export interface ConversionRunResult {
  summary: ConversionSummary;
  items: ConversionItem[];
  cancelled: boolean;
}

export interface RuntimeStatus {
  isReady: boolean;
  runtimeSource: RuntimeSource;
  executablePath: string | null;
  supportsInAppUpdate: boolean;
  installedVersion: string | null;
  latestVersion: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  hasUpdateAvailable: boolean;
}
