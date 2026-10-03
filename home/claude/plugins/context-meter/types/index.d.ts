// The live window as the status line reads it; null until a reply reports it.
export type Reading = { tokens: number | null; window: number; percent: number | null };

// The last compaction's sizes, kept until the next reply reports a fill.
export type Compacted = { before: number | null; after: number | null };

declare module "claude-code" {
  interface PluginState {
    "context-meter": {
      reading: Reading | null;
      compacted: Compacted | null;
      isCompacting: boolean;
    };
  }
}
