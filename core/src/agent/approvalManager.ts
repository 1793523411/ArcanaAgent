import { randomUUID } from "crypto";

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

interface PendingEntry {
  request: ApprovalRequest;
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

class ApprovalManager {
  private pending = new Map<string, PendingEntry>();

  createRequest(
    params: Omit<ApprovalRequest, "requestId" | "createdAt" | "status">
  ): { requestId: string; promise: Promise<boolean> } {
    const requestId = `apr_${randomUUID()}`;
    const request: ApprovalRequest = {
      ...params,
      requestId,
      createdAt: new Date().toISOString(),
      status: "pending",
    };

    let resolvePromise!: (approved: boolean) => void;
    const promise = new Promise<boolean>((resolve) => {
      resolvePromise = resolve;
    });

    const timer = setTimeout(() => {
      this.resolveRequest(requestId, false);
    }, APPROVAL_TIMEOUT_MS);

    this.pending.set(requestId, {
      request,
      resolve: resolvePromise,
      timer,
    });

    return { requestId, promise };
  }

  resolveRequest(requestId: string, approved: boolean): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;

    clearTimeout(entry.timer);
    entry.request.status = approved ? "approved" : "rejected";
    entry.resolve(approved);
    this.pending.delete(requestId);
    return true;
  }

  /** Cancel all pending approvals for a conversation (e.g. on SSE disconnect) */
  cancelConversation(conversationId: string): number {
    let cancelled = 0;
    for (const [requestId, entry] of this.pending) {
      if (entry.request.conversationId === conversationId) {
        clearTimeout(entry.timer);
        entry.request.status = "rejected";
        entry.resolve(false);
        this.pending.delete(requestId);
        cancelled++;
      }
    }
    return cancelled;
  }

  /** Check if a requestId belongs to a specific conversation */
  belongsToConversation(requestId: string, conversationId: string): boolean {
    const entry = this.pending.get(requestId);
    return entry?.request.conversationId === conversationId;
  }

  getPendingRequests(conversationId: string): ApprovalRequest[] {
    const result: ApprovalRequest[] = [];
    for (const entry of this.pending.values()) {
      if (entry.request.conversationId === conversationId) {
        result.push({ ...entry.request });
      }
    }
    return result;
  }

  hasPending(conversationId: string): boolean {
    for (const entry of this.pending.values()) {
      if (entry.request.conversationId === conversationId) return true;
    }
    return false;
  }
}

export const approvalManager = new ApprovalManager();
