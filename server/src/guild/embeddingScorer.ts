/**
 * Embedding-based semantic scorer for Guild bidding.
 *
 * Uses the same Xenova/multilingual-e5-small model as the project vector index.
 * Embeddings are pre-computed asynchronously and cached so the synchronous
 * bidding path can look up cosine similarities without blocking.
 *
 * Flow:
 *   1. Scheduler calls `warmBiddingEmbeddings(agents, task)` before the bid loop
 *   2. `calculateConfidenceBreakdown` calls `getCachedSemanticScore(agentId, taskId)`
 *   3. If cached → returns cosine similarity [0,1]; if not → returns null (token fallback)
 */

import type { GuildAgent, GuildTask } from "./types.js";
import { serverLogger } from "../lib/logger.js";

// ─── Dynamic imports (same pattern as vector.ts) ─────────────────

interface EmbeddingPipeline {
  (texts: string[], options?: { pooling: string; normalize: boolean }): Promise<{
    tolist(): number[][];
  }>;
}

let embedder: EmbeddingPipeline | null = null;
let loadFailed = false;
/** Promise-based lock: all concurrent callers await the same in-flight load. */
let loadPromise: Promise<EmbeddingPipeline | null> | null = null;

const MODEL_ID = "Xenova/multilingual-e5-small";

async function ensureEmbedder(): Promise<EmbeddingPipeline | null> {
  if (embedder) return embedder;
  if (loadFailed) return null;
  // If a load is already in flight, all callers share the same promise.
  if (loadPromise) return loadPromise;

  loadPromise = doLoadEmbedder();
  return loadPromise;
}

async function doLoadEmbedder(): Promise<EmbeddingPipeline | null> {
  try {
    const transformers = await import("@huggingface/transformers");
    const pipelineFn = (transformers as Record<string, unknown>).pipeline as
      ((task: string, model?: string) => Promise<EmbeddingPipeline>) | undefined;
    if (!pipelineFn) {
      loadFailed = true;
      return null;
    }
    embedder = await pipelineFn("feature-extraction", MODEL_ID);
    serverLogger.info("[embeddingScorer] model loaded", { model: MODEL_ID });
    return embedder;
  } catch (e) {
    loadFailed = true;
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("Cannot find")) {
      serverLogger.warn("[embeddingScorer] @huggingface/transformers not available, falling back to token matching");
    } else {
      serverLogger.warn("[embeddingScorer] model load failed, falling back to token matching", { error: msg });
    }
    return null;
  } finally {
    loadPromise = null;
  }
}

// ─── Embedding caches ────────────────────────────────────────────

/** Agent profile embeddings — keyed by agentId, invalidated on profile change. */
const agentEmbeddingCache = new Map<string, { vector: number[]; hash: string }>();

/** Task text embeddings — short-lived, cleared after bidding round. */
const taskEmbeddingCache = new Map<string, number[]>();

/** Pre-computed cosine similarities — keyed by "agentId::taskId". */
const semanticScoreCache = new Map<string, number>();

// ─── Helpers ─────────────────────────────────────────────────────

/** Returns cosine similarity in [0,1], or null if vectors are incompatible
 *  (dim mismatch) so the caller can skip writing a spurious 0 into the cache.
 */
function cosine(a: number[], b: number[]): number | null {
  if (a.length !== b.length) {
    serverLogger.warn("[embeddingScorer] cosine dim mismatch", { a: a.length, b: b.length });
    return null;
  }
  // Vectors are already L2-normalized by the pipeline, so dot product = cosine sim.
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return Math.max(0, Math.min(1, dot));
}

/** Build the text blob that represents an agent's profile for embedding. */
function agentProfileText(agent: GuildAgent): string {
  const parts = [agent.name, agent.description, agent.systemPrompt];
  for (const skill of agent.skills) parts.push(skill);
  for (const asset of agent.assets) {
    parts.push(asset.name);
    if (asset.description) parts.push(asset.description);
    if (asset.tags) parts.push(asset.tags.join(" "));
  }
  // Cap at 1500 chars (≈ hundreds of tokens) to stay well under E5's 512-token window.
  return parts.join(" ").slice(0, 1500);
}

/** Simple hash to detect agent profile changes. */
function agentProfileHash(agent: GuildAgent): string {
  const text = agentProfileText(agent);
  // Fast FNV-1a-like hash — not cryptographic, just for cache invalidation.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(36);
}

function taskSearchText(task: GuildTask): string {
  return `${task.title} ${task.description}`.slice(0, 1500);
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Pre-compute embeddings for a set of agents and a task, populating the
 * semantic score cache. Call this before the synchronous bidding loop.
 *
 * Gracefully no-ops if the embedding model isn't available.
 */
export async function warmBiddingEmbeddings(
  agents: GuildAgent[],
  task: GuildTask,
): Promise<boolean> {
  const emb = await ensureEmbedder();
  if (!emb) return false;

  try {
    // 1. Compute task embedding (with "query:" prefix per E5 convention)
    let taskVec = taskEmbeddingCache.get(task.id);
    if (!taskVec) {
      const output = await emb([`query: ${taskSearchText(task)}`], {
        pooling: "mean",
        normalize: true,
      });
      taskVec = output.tolist()[0];
      taskEmbeddingCache.set(task.id, taskVec);
    }

    // 2. Compute agent embeddings (with "passage:" prefix), using cache
    const agentsNeedingEmbedding: { agent: GuildAgent; index: number }[] = [];
    const agentVectors: (number[] | null)[] = [];

    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i];
      const hash = agentProfileHash(agent);
      const cached = agentEmbeddingCache.get(agent.id);
      if (cached && cached.hash === hash) {
        agentVectors.push(cached.vector);
      } else {
        agentVectors.push(null);
        agentsNeedingEmbedding.push({ agent, index: i });
      }
    }

    // Batch-embed agents that aren't cached
    if (agentsNeedingEmbedding.length > 0) {
      const texts = agentsNeedingEmbedding.map(
        ({ agent }) => `passage: ${agentProfileText(agent)}`,
      );
      const output = await emb(texts, { pooling: "mean", normalize: true });
      const vectors = output.tolist();
      for (let j = 0; j < agentsNeedingEmbedding.length; j++) {
        const { agent, index } = agentsNeedingEmbedding[j];
        const vec = vectors[j];
        agentVectors[index] = vec;
        const hash = agentProfileHash(agent);
        agentEmbeddingCache.set(agent.id, { vector: vec, hash });
      }
    }

    // 3. Compute cosine similarities and cache
    for (let i = 0; i < agents.length; i++) {
      const agentVec = agentVectors[i];
      if (!agentVec) continue;
      const score = cosine(agentVec, taskVec);
      if (score === null) continue; // skip — dim mismatch shouldn't pollute cache
      semanticScoreCache.set(`${agents[i].id}::${task.id}`, score);
    }

    return true;
  } catch (e) {
    serverLogger.warn("[embeddingScorer] warmBiddingEmbeddings failed", {
      taskId: task.id,
      error: String(e),
    });
    return false;
  }
}

/**
 * Pre-compute embeddings for multiple tasks at once. Batches all task texts
 * into a single `emb([...])` call to avoid the per-task pipeline overhead
 * that Promise.all over `warmBiddingEmbeddings` incurs (the HF pipeline
 * serializes on the same instance).
 */
export async function warmBiddingEmbeddingsBatch(
  agents: GuildAgent[],
  tasks: GuildTask[],
): Promise<boolean> {
  if (tasks.length === 0) return true;
  const emb = await ensureEmbedder();
  if (!emb) return false;

  // Transformer pipelines have bounded batch budgets; chunk to keep memory
  // predictable when a scheduler round has many eligible tasks/agents.
  const EMBED_BATCH_SIZE = 32;
  const embedChunked = async (inputs: string[]): Promise<number[][]> => {
    const all: number[][] = [];
    for (let i = 0; i < inputs.length; i += EMBED_BATCH_SIZE) {
      const slice = inputs.slice(i, i + EMBED_BATCH_SIZE);
      const out = await emb(slice, { pooling: "mean", normalize: true });
      for (const v of out.tolist()) all.push(v);
    }
    return all;
  };

  try {
    // 1. Task embeddings — batched for uncached tasks.
    const uncachedTasks = tasks.filter((t) => !taskEmbeddingCache.has(t.id));
    if (uncachedTasks.length > 0) {
      const vectors = await embedChunked(uncachedTasks.map((t) => `query: ${taskSearchText(t)}`));
      for (let i = 0; i < uncachedTasks.length; i++) {
        taskEmbeddingCache.set(uncachedTasks[i].id, vectors[i]);
      }
    }

    // 2. Agent embeddings — batched for uncached/stale agents.
    const agentsNeedingEmbedding: { agent: GuildAgent; hash: string }[] = [];
    for (const agent of agents) {
      const hash = agentProfileHash(agent);
      const cached = agentEmbeddingCache.get(agent.id);
      if (!cached || cached.hash !== hash) {
        agentsNeedingEmbedding.push({ agent, hash });
      }
    }
    if (agentsNeedingEmbedding.length > 0) {
      const vectors = await embedChunked(
        agentsNeedingEmbedding.map(({ agent }) => `passage: ${agentProfileText(agent)}`),
      );
      for (let i = 0; i < agentsNeedingEmbedding.length; i++) {
        const { agent, hash } = agentsNeedingEmbedding[i];
        agentEmbeddingCache.set(agent.id, { vector: vectors[i], hash });
      }
    }

    // 3. Cosine similarities for every (agent, task) pair.
    for (const task of tasks) {
      const taskVec = taskEmbeddingCache.get(task.id);
      if (!taskVec) continue;
      for (const agent of agents) {
        const entry = agentEmbeddingCache.get(agent.id);
        if (!entry) continue;
        const score = cosine(entry.vector, taskVec);
        if (score === null) continue; // dim mismatch — don't poison cache with 0
        semanticScoreCache.set(`${agent.id}::${task.id}`, score);
      }
    }

    return true;
  } catch (e) {
    serverLogger.warn("[embeddingScorer] warmBiddingEmbeddingsBatch failed", {
      taskCount: tasks.length,
      error: String(e),
    });
    return false;
  }
}

/**
 * Synchronous lookup of a pre-computed semantic score.
 * Returns null if embeddings weren't warmed for this agent+task pair.
 */
export function getCachedSemanticScore(agentId: string, taskId: string): number | null {
  return semanticScoreCache.get(`${agentId}::${taskId}`) ?? null;
}

/**
 * Clean up task-specific caches after a bidding round completes.
 */
export function clearTaskEmbeddingCache(taskId: string): void {
  taskEmbeddingCache.delete(taskId);
  // Collect matching keys first, then delete (avoids mutation during iteration).
  const suffix = `::${taskId}`;
  const toDelete = [...semanticScoreCache.keys()].filter((k) => k.endsWith(suffix));
  for (const k of toDelete) semanticScoreCache.delete(k);
}

/**
 * Invalidate a specific agent's cached embedding (e.g. after profile update).
 */
export function invalidateAgentEmbedding(agentId: string): void {
  agentEmbeddingCache.delete(agentId);
}

/**
 * Check if the embedding model is available without loading it.
 */
export function isEmbeddingAvailable(): boolean {
  return embedder !== null && !loadFailed;
}

/**
 * Start loading the embedding model in the background.
 * Call at server startup so the model is ready when the first bidding round needs it.
 */
export function preloadEmbeddingModel(): void {
  ensureEmbedder().catch(() => {
    // Swallow — loadFailed flag is already set inside ensureEmbedder.
  });
}

/** Reset all state — used for testing. */
export function _resetForTest(): void {
  agentEmbeddingCache.clear();
  taskEmbeddingCache.clear();
  semanticScoreCache.clear();
  embedder = null;
  loadFailed = false;
  loadPromise = null;
}
