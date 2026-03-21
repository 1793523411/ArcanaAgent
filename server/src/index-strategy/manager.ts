import type { IndexStrategy, IndexStatus, StrategyType } from "./types.js";
import { NoneStrategy } from "./strategies/none.js";
import type { RepomapStrategy } from "./strategies/repomap.js";
import type { VectorStrategy } from "./strategies/vector.js";
import { detectAvailableStrategies, type DetectionResult } from "./detect.js";
import { loadUserConfig } from "../config/userConfig.js";
import { serverLogger } from "../lib/logger.js";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

class IndexManager {
  private instances: Map<string, IndexStrategy> = new Map();
  /** Per-workspace override set by switchStrategy (takes priority over config) */
  private activeOverride: Map<string, StrategyType> = new Map();
  /** Track which strategies are currently building (key = workspacePath:strategyType) */
  private buildingSet: Set<string> = new Set();

  /** Cache key = workspacePath + ":" + strategyType */
  private cacheKey(workspacePath: string, type: StrategyType): string {
    return `${workspacePath}:${type}`;
  }

  /** Get or create a strategy instance for the given workspace.
   *  Always respects the latest user config. */
  async getStrategy(workspacePath: string, preferredType?: StrategyType): Promise<IndexStrategy> {
    const desiredType = preferredType ?? this.activeOverride.get(workspacePath) ?? this.getConfiguredStrategy() ?? await this.autoDetectStrategy();
    const key = this.cacheKey(workspacePath, desiredType);
    const existing = this.instances.get(key);
    if (existing) return existing;

    const strategy = await this.createStrategy(desiredType);
    // Try to restore from disk cache (avoids full rebuild after server restart)
    await this.tryRestoreFromDisk(strategy, workspacePath);
    // Cache under the actual strategy type, not the requested type
    // (createStrategy may fall back to NoneStrategy if deps are missing)
    const actualKey = this.cacheKey(workspacePath, strategy.type);
    this.instances.set(actualKey, strategy);
    // Also cache under requested key to avoid repeated failed imports
    if (actualKey !== key) {
      this.instances.set(key, strategy);
    }
    return strategy;
  }

  /** Switch strategy for a workspace */
  async switchStrategy(workspacePath: string, type: StrategyType): Promise<void> {
    this.activeOverride.set(workspacePath, type);
    const key = this.cacheKey(workspacePath, type);
    if (!this.instances.has(key)) {
      const strategy = await this.createStrategy(type);
      await this.tryRestoreFromDisk(strategy, workspacePath);
      this.instances.set(key, strategy);
    }
    serverLogger.info(`[IndexManager] Switched to ${type} strategy for ${workspacePath}`);
  }

  /** Get the build status of ALL strategies for a given workspace */
  async getAllStatuses(workspacePath: string): Promise<Record<StrategyType, IndexStatus>> {
    const results: Record<string, IndexStatus> = {};

    // none — always ready
    results["none"] = { strategy: "none", ready: true, fileCount: 0 };

    // repomap — check cached instance or probe the JSON file
    const repomapKey = this.cacheKey(workspacePath, "repomap");
    const repomapInst = this.instances.get(repomapKey);
    if (repomapInst) {
      results["repomap"] = repomapInst.getStatus();
    } else {
      results["repomap"] = this.probeRepomapStatus(workspacePath);
    }

    // vector — check cached instance or probe the LanceDB dir
    const vectorKey = this.cacheKey(workspacePath, "vector");
    const vectorInst = this.instances.get(vectorKey);
    if (vectorInst) {
      results["vector"] = vectorInst.getStatus();
    } else {
      results["vector"] = this.probeVectorStatus(workspacePath);
    }

    return results as Record<StrategyType, IndexStatus>;
  }

  /** Get recommendation for the best available strategy */
  async getRecommendation(): Promise<DetectionResult> {
    return detectAvailableStrategies();
  }

  /** Check which strategies are currently building for a workspace */
  getBuildingStrategies(workspacePath: string): StrategyType[] {
    const result: StrategyType[] = [];
    for (const type of ["repomap", "vector", "none"] as StrategyType[]) {
      if (this.buildingSet.has(this.cacheKey(workspacePath, type))) {
        result.push(type);
      }
    }
    return result;
  }

  /** Start an async build — returns immediately, build runs in background */
  async startBuild(workspacePath: string, strategy: IndexStrategy): Promise<void> {
    const key = this.cacheKey(workspacePath, strategy.type);
    if (this.buildingSet.has(key)) return; // already building
    this.buildingSet.add(key);
    try {
      await strategy.buildIndex(workspacePath);
    } finally {
      this.buildingSet.delete(key);
    }
  }

  /** Probe repomap.json without instantiating the full strategy */
  private probeRepomapStatus(workspacePath: string): IndexStatus {
    const cachePath = join(workspacePath, ".agents", "index", "repomap.json");
    if (!existsSync(cachePath)) {
      return { strategy: "repomap", ready: false, fileCount: 0 };
    }
    try {
      const data = JSON.parse(readFileSync(cachePath, "utf-8"));
      const fileCount = data.files ? Object.keys(data.files).length : 0;
      return {
        strategy: "repomap",
        ready: fileCount > 0,
        fileCount,
        lastUpdated: data.createdAt,
      };
    } catch {
      return { strategy: "repomap", ready: false, fileCount: 0, error: "Failed to read cache" };
    }
  }

  /** Probe LanceDB directory without instantiating the full strategy */
  private probeVectorStatus(workspacePath: string): IndexStatus {
    const vectorDir = join(workspacePath, ".agents", "index", "vectors");
    if (!existsSync(vectorDir)) {
      return { strategy: "vector", ready: false, fileCount: 0 };
    }
    // LanceDB dir exists — check if table data is present
    const tablePath = join(vectorDir, "chunks.lance");
    if (existsSync(tablePath)) {
      return { strategy: "vector", ready: true, fileCount: 0 };
    }
    return { strategy: "vector", ready: false, fileCount: 0 };
  }

  private getConfiguredStrategy(): StrategyType | undefined {
    try {
      const config = loadUserConfig();
      return config.codeIndexStrategy;
    } catch {
      return undefined;
    }
  }

  /** Try to restore a strategy's state from its on-disk cache. */
  private async tryRestoreFromDisk(strategy: IndexStrategy, workspacePath: string): Promise<void> {
    try {
      if (strategy.type === "repomap") {
        (strategy as RepomapStrategy).tryLoadFromDisk(workspacePath);
      } else if (strategy.type === "vector") {
        await (strategy as VectorStrategy).tryLoadFromDisk(workspacePath);
      } else if (strategy.type === "none") {
        // NoneStrategy is lightweight — just set workspacePath so getStatus().ready is true
        await strategy.buildIndex(workspacePath);
      }
    } catch {
      // Non-critical — strategy just stays in "not built" state
    }
  }

  private async autoDetectStrategy(): Promise<StrategyType> {
    try {
      const result = await detectAvailableStrategies();
      serverLogger.info(`[IndexManager] Auto-detected strategy: ${result.recommended}`);
      return result.recommended;
    } catch {
      return "none";
    }
  }

  private async createStrategy(type: StrategyType): Promise<IndexStrategy> {
    switch (type) {
      case "repomap": {
        try {
          const { RepomapStrategy } = await import("./strategies/repomap.js");
          return new RepomapStrategy();
        } catch (e) {
          serverLogger.warn(`[IndexManager] Failed to load RepomapStrategy, falling back to none: ${e}`);
          return new NoneStrategy();
        }
      }
      case "vector": {
        try {
          const { VectorStrategy } = await import("./strategies/vector.js");
          return new VectorStrategy();
        } catch (e) {
          serverLogger.warn(`[IndexManager] Failed to load VectorStrategy, falling back to none: ${e}`);
          return new NoneStrategy();
        }
      }
      case "none":
      default:
        return new NoneStrategy();
    }
  }
}

export const indexManager = new IndexManager();
