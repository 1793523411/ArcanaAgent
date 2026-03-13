import type { ConversationMeta, StoredMessage, UserConfig, ArtifactMeta, PromptTemplate } from "../types";

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

export async function createConversation(title?: string): Promise<ConversationMeta> {
  const r = await fetch(`${BASE}/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(title ? { title } : {}),
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
