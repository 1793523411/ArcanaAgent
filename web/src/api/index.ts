import type { ConversationMeta, StoredMessage, UserConfig } from "../types";

const BASE = "/api";

export type { ConversationMeta, StoredMessage, UserConfig };

export async function listConversations(): Promise<ConversationMeta[]> {
  const r = await fetch(`${BASE}/conversations`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function createConversation(): Promise<ConversationMeta> {
  const r = await fetch(`${BASE}/conversations`, { method: "POST" });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getConversation(id: string): Promise<ConversationMeta | null> {
  const r = await fetch(`${BASE}/conversations/${id}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function deleteConversation(id: string): Promise<void> {
  const r = await fetch(`${BASE}/conversations/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(await r.text());
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
  attachments?: Attachment[]
): Promise<void> {
  const res = await fetch(`${BASE}/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      ...(attachments?.length ? { attachments } : {}),
    }),
  });
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
            onDone();
            return;
          }
          try {
            const parsed = JSON.parse(data);
            if (parsed?.error) onError(parsed.error);
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
          if (parsed?.error) onError(parsed.error);
          else onChunk(parsed);
        } catch {
          // skip
        }
      }
    }
    onDone();
  } catch (e) {
    onError(String(e));
  }
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  supportsImage?: boolean;
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

export async function putConfig(config: Partial<UserConfig>): Promise<UserConfig> {
  const r = await fetch(`${BASE}/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
