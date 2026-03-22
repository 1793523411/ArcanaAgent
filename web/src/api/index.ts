import type { ConversationMeta, StoredMessage, UserConfig, ArtifactMeta, PromptTemplate, ConversationMode, AgentDef, TeamDef, ProviderInfo, ModelSpec, ModelValidationResult } from "../types";

const BASE = "/api";
function encodeArtifactPath(filePath: string): string {
  return filePath
    .split("/")
    .filter((part) => part.length > 0)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

export type { ConversationMeta, StoredMessage, UserConfig, ArtifactMeta };

export interface ListConversationsResponse {
  conversations: ConversationMeta[];
  total: number;
}

export async function listConversations(params?: { limit?: number; offset?: number }): Promise<ListConversationsResponse> {
  const sp = new URLSearchParams();
  if (params?.limit != null) sp.set("limit", String(params.limit));
  if (params?.offset != null) sp.set("offset", String(params.offset));
  const q = sp.toString();
  const r = await fetch(`${BASE}/conversations${q ? `?${q}` : ""}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function createConversation(title?: string, mode?: ConversationMode, teamId?: string): Promise<ConversationMeta> {
  const r = await fetch(`${BASE}/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(title ? { title } : {}),
      ...(mode ? { mode } : {}),
      ...(teamId ? { teamId } : {}),
    }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getConversation(id: string): Promise<ConversationMeta | null> {
  const r = await fetch(`${BASE}/conversations/${id}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function updateConversationTitle(id: string, title: string): Promise<ConversationMeta> {
  const r = await fetch(`${BASE}/conversations/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function deleteConversation(id: string): Promise<void> {
  const r = await fetch(`${BASE}/conversations/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(await r.text());
}

export async function exportConversation(id: string, format: "markdown" | "json" = "markdown"): Promise<Blob> {
  const r = await fetch(`${BASE}/conversations/${id}/export?format=${format}`);
  if (!r.ok) throw new Error(await r.text());
  return r.blob();
}

export async function getMessages(id: string): Promise<StoredMessage[]> {
  const r = await fetch(`${BASE}/conversations/${id}/messages`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export interface Attachment {
  type: "image";
  mimeType: string;
  data: string;
}

export async function sendMessageStream(
  conversationId: string,
  text: string,
  onChunk: (chunk: unknown) => void,
  onDone: () => void,
  onError: (err: string) => void,
  attachments?: Attachment[],
  mode?: ConversationMode,
  signal?: AbortSignal
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
      },
      body: JSON.stringify({
        text,
        ...(attachments?.length ? { attachments } : {}),
        ...(mode ? { mode } : {}),
      }),
      signal,
      cache: "no-store",
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") return;
    onError(String(e));
    return;
  }
  if (!res.ok) {
    onError(await res.text());
    return;
  }
  const reader = res.body?.getReader();
  if (!reader) {
    onError("No body");
    return;
  }
  const dec = new TextDecoder();
  let buf = "";
  let settled = false;
  const settle = (cb: () => void) => {
    if (settled) return;
    settled = true;
    cb();
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") {
            settle(onDone);
            return;
          }
          try {
            const parsed = JSON.parse(data);
            if (parsed?.error) settle(() => onError(parsed.error));
            else onChunk(parsed);
          } catch {
            // skip
          }
        }
      }
    }
    if (buf.startsWith("data: ")) {
      const data = buf.slice(6);
      if (data !== "[DONE]") {
        try {
          const parsed = JSON.parse(data);
          if (parsed?.error) settle(() => onError(parsed.error));
          else onChunk(parsed);
        } catch {
          // skip
        }
      }
    }
    settle(onDone);
  } catch (e) {
    if ((e as Error).name === "AbortError") return;
    settle(() => onError(String(e)));
  }
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  maxTokens: number;
  supportsImage?: boolean;
  supportsReasoning?: boolean;
}

export async function getModels(): Promise<ModelInfo[]> {
  const r = await fetch(`${BASE}/models`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getConfig(): Promise<UserConfig> {
  const r = await fetch(`${BASE}/config`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getPromptTemplates(): Promise<PromptTemplate[]> {
  const r = await fetch(`${BASE}/templates`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function createPromptTemplate(payload: {
  name: string;
  content: string;
  description?: string;
}): Promise<PromptTemplate> {
  const r = await fetch(`${BASE}/templates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function updatePromptTemplate(
  id: string,
  payload: { name: string; content: string; description?: string }
): Promise<PromptTemplate> {
  const r = await fetch(`${BASE}/templates/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function deletePromptTemplate(id: string): Promise<void> {
  const r = await fetch(`${BASE}/templates/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(await r.text());
}

export async function putConfig(config: Partial<UserConfig>): Promise<UserConfig> {
  const r = await fetch(`${BASE}/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export interface SkillMeta {
  name: string;
  description: string;
  userUploaded?: boolean;
}

export async function getSkills(): Promise<SkillMeta[]> {
  const r = await fetch(`${BASE}/skills`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function uploadSkillZip(file: File): Promise<{ name: string; description: string }> {
  const form = new FormData();
  form.append("zip", file);
  const r = await fetch(`${BASE}/skills/upload`, {
    method: "POST",
    body: form,
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(typeof err?.error === "string" ? err.error : "上传失败");
  }
  return r.json();
}

export async function deleteSkill(name: string): Promise<void> {
  const r = await fetch(`${BASE}/skills/${encodeURIComponent(name)}`, { method: "DELETE" });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(typeof err?.error === "string" ? err.error : "删除失败");
  }
}

// ─── Artifacts ─────────────────────────────────

export async function getArtifacts(conversationId: string): Promise<ArtifactMeta[]> {
  const r = await fetch(`${BASE}/conversations/${conversationId}/artifacts`);
  if (!r.ok) return [];
  return r.json();
}

export function getArtifactUrl(conversationId: string, filePath: string): string {
  return `${BASE}/conversations/${conversationId}/artifacts/${encodeArtifactPath(filePath)}`;
}

export async function getArtifactText(conversationId: string, filePath: string): Promise<string> {
  const r = await fetch(getArtifactUrl(conversationId, filePath));
  if (!r.ok) throw new Error("Failed to fetch artifact");
  return r.text();
}

// ─── 手动压缩 ─────────────────────────────────

export interface CompressResult {
  success: boolean;
  strategy: "full" | "trim" | "compress";
  totalMessages: number;
  estimatedTokens?: number;
  olderCount?: number;
  recentCount?: number;
  trimToLast?: number;
}

export async function compressConversation(conversationId: string): Promise<CompressResult> {
  const r = await fetch(`${BASE}/conversations/${conversationId}/compress`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(typeof err?.error === "string" ? err.error : "压缩失败");
  }
  return r.json();
}

// ─── Code Index Status ──────────────────────────────────

export interface IndexStatusResponse {
  configured: string | null;
  recommended: string;
  available: Array<{ type: string; ready: boolean; missing: string[] }>;
  current: { strategy: string; ready: boolean; fileCount: number; lastUpdated?: string; error?: string } | null;
}

export async function getIndexStatus(): Promise<IndexStatusResponse> {
  const r = await fetch(`${BASE}/index-status`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export interface ConversationIndexStatus {
  strategy: string;
  ready: boolean;
  fileCount: number;
  lastUpdated?: string;
  error?: string;
}

export interface ConversationIndexFullStatus {
  configured: string | null;
  recommended: string;
  active: ConversationIndexStatus;
  /** Which strategies are currently being built */
  building: string[];
  strategies: Record<string, ConversationIndexStatus & { available: boolean; missing: string[] }>;
}

export async function getConversationIndexStatus(conversationId: string): Promise<ConversationIndexFullStatus> {
  const r = await fetch(`${BASE}/conversations/${conversationId}/index-status`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function buildConversationIndex(conversationId: string, strategy?: string): Promise<ConversationIndexStatus> {
  const r = await fetch(`${BASE}/conversations/${conversationId}/index-build`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(strategy ? { strategy } : {}),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export interface ApprovalRequest {
  requestId: string;
  conversationId: string;
  subagentId: string;
  role?: string;
  operationType: string;
  operationDescription: string;
  details: Record<string, unknown>;
  createdAt: string;
  status: "pending" | "approved" | "rejected";
}

export async function getPendingApprovals(conversationId: string): Promise<ApprovalRequest[]> {
  const r = await fetch(`${BASE}/conversations/${conversationId}/approvals`);
  if (!r.ok) return [];
  return r.json();
}

export async function submitApproval(conversationId: string, requestId: string, approved: boolean): Promise<void> {
  const r = await fetch(`${BASE}/conversations/${conversationId}/approvals/${requestId}`, {
    method: "POST",
    body: JSON.stringify({ approved }),
    headers: { "Content-Type": "application/json" },
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(typeof err?.error === "string" ? err.error : "Approval submission failed");
  }
}

// ─── Agent Defs ─────────────────────────────────────────

export async function listAgentDefs(): Promise<AgentDef[]> {
  const r = await fetch(`${BASE}/agents`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function createAgentDef(payload: Omit<AgentDef, "id" | "builtIn">): Promise<AgentDef> {
  const r = await fetch(`${BASE}/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function generateAgentDef(description: string): Promise<Omit<AgentDef, "id" | "builtIn">> {
  const r = await fetch(`${BASE}/agents/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function updateAgentDef(id: string, payload: Partial<Omit<AgentDef, "id" | "builtIn">>): Promise<AgentDef> {
  const r = await fetch(`${BASE}/agents/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function deleteAgentDef(id: string): Promise<void> {
  const r = await fetch(`${BASE}/agents/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(await r.text());
}

// ─── Team Defs ──────────────────────────────────────────

export async function listTeamDefs(): Promise<TeamDef[]> {
  const r = await fetch(`${BASE}/teams`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function createTeamDef(payload: Omit<TeamDef, "id" | "builtIn">): Promise<TeamDef> {
  const r = await fetch(`${BASE}/teams`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function updateTeamDef(id: string, payload: Partial<Omit<TeamDef, "id" | "builtIn">>): Promise<TeamDef> {
  const r = await fetch(`${BASE}/teams/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function deleteTeamDef(id: string): Promise<void> {
  const r = await fetch(`${BASE}/teams/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(await r.text());
}

// ─── Share ──────────────────────────────────────────────

export interface ShareRecord {
  shareId: string;
  conversationId: string;
  conversationTitle: string;
  messageIndex: number;
  message: {
    type: string;
    content: string;
    modelId?: string;
    reasoningContent?: string;
  };
  createdAt: string;
}

export async function createShare(conversationId: string, messageIndex: number): Promise<ShareRecord> {
  const r = await fetch(`${BASE}/conversations/${conversationId}/share`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messageIndex }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getShare(shareId: string): Promise<ShareRecord> {
  const r = await fetch(`${BASE}/shares/${shareId}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ─── Model Provider CRUD ────────────────────────────────

export async function getProviders(): Promise<ProviderInfo[]> {
  const r = await fetch(`${BASE}/models/providers`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function createProvider(payload: {
  name: string;
  baseUrl: string;
  apiKey: string;
  api: string;
  models?: ModelSpec[];
}): Promise<void> {
  const r = await fetch(`${BASE}/models/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(await r.text());
}

export async function updateProvider(
  name: string,
  payload: { baseUrl?: string; apiKey?: string; api?: string; models?: ModelSpec[] }
): Promise<void> {
  const r = await fetch(`${BASE}/models/providers/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(await r.text());
}

export async function deleteProvider(name: string): Promise<void> {
  const r = await fetch(`${BASE}/models/providers/${encodeURIComponent(name)}`, { method: "DELETE" });
  if (!r.ok) throw new Error(await r.text());
}

// ─── Model Validation ───────────────────────────────────

export async function validateModels(modelIds: string[]): Promise<ModelValidationResult[]> {
  const r = await fetch(`${BASE}/models/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modelIds }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function validateAllModels(): Promise<ModelValidationResult[]> {
  const r = await fetch(`${BASE}/models/validate-all`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getCachedValidations(): Promise<Record<string, ModelValidationResult>> {
  const r = await fetch(`${BASE}/models/validations`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
