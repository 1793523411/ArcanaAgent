import type { StrategyType } from "./types.js";

export interface StrategyAvailability {
  type: StrategyType;
  ready: boolean;
  missing: string[];
}

export interface DetectionResult {
  recommended: StrategyType;
  available: StrategyAvailability[];
}

async function tryImport(moduleName: string): Promise<boolean> {
  try {
    await import(moduleName);
    return true;
  } catch {
    return false;
  }
}

export async function detectAvailableStrategies(): Promise<DetectionResult> {
  const available: StrategyAvailability[] = [];

  // NoneStrategy is always available
  available.push({ type: "none", ready: true, missing: [] });

  // Check tree-sitter availability for RepomapStrategy
  const treeSitterReady = await tryImport("web-tree-sitter");
  const treeSitterTsReady = await tryImport("tree-sitter-typescript");
  const pagerankReady = await tryImport("pagerank.js");
  const repomapMissing: string[] = [];
  if (!treeSitterReady) repomapMissing.push("web-tree-sitter");
  if (!treeSitterTsReady) repomapMissing.push("tree-sitter-typescript");
  if (!pagerankReady) repomapMissing.push("pagerank.js");
  available.push({
    type: "repomap",
    ready: repomapMissing.length === 0,
    missing: repomapMissing,
  });

  // Check LanceDB + transformers availability for VectorStrategy
  const lanceReady = await tryImport("@lancedb/lancedb");
  const transformersReady = await tryImport("@huggingface/transformers");
  const vectorMissing: string[] = [];
  if (!lanceReady) vectorMissing.push("@lancedb/lancedb");
  if (!transformersReady) vectorMissing.push("@huggingface/transformers");
  available.push({
    type: "vector",
    ready: vectorMissing.length === 0,
    missing: vectorMissing,
  });

  // Recommendation logic
  let recommended: StrategyType = "none";
  const repomapAvail = available.find(a => a.type === "repomap");
  const vectorAvail = available.find(a => a.type === "vector");

  if (repomapAvail?.ready) {
    recommended = "repomap";
  } else if (vectorAvail?.ready) {
    recommended = "vector";
  }

  return { recommended, available };
}
