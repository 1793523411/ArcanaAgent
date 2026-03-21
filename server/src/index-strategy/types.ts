export type StrategyType = "none" | "repomap" | "vector";

export interface IndexStatus {
  strategy: StrategyType;
  ready: boolean;
  fileCount: number;
  lastUpdated?: string;
  error?: string;
}

export interface SearchResult {
  file: string;
  line?: number;
  content: string;
  /** 0-1 relevance score */
  score: number;
  /** Symbol name (repomap strategy) */
  symbol?: string;
}

export interface SearchOptions {
  maxResults?: number;
  fileGlob?: string;
}

export interface IndexStrategy {
  readonly type: StrategyType;
  /** Check if runtime dependencies are available */
  checkDependencies(): Promise<{ ready: boolean; missing: string[] }>;
  /** Build or rebuild the index */
  buildIndex(workspacePath: string): Promise<void>;
  /** Search code */
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  /** Get a compact project snapshot (repo map) */
  getSnapshot(maxTokens?: number): Promise<string>;
  /** Get current index status */
  getStatus(): IndexStatus;
  /** Incremental update after file changes */
  incrementalUpdate?(changedFiles: string[]): Promise<void>;
}
