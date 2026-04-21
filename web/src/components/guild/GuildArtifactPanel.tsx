import { useState, useEffect, useMemo, useCallback } from "react";
import type { GuildTask, GuildAgent, ArtifactStrategy, ArtifactManifestEntry } from "../../types/guild";
import {
  getGroupSharedTree, getGroupSharedFile, getGroupSharedManifest,
  getAgentWorkspaceTree, getAgentWorkspaceFile,
  getAgentMemoryTree, getAgentMemoryFile,
} from "../../api/guild";
import FileTreeBrowser from "./FileTreeBrowser";

interface Props {
  tasks: GuildTask[];
  agents: GuildAgent[];
  groupId: string | null;
  artifactStrategy?: ArtifactStrategy;
  onClose: () => void;
  onSelectTask?: (id: string) => void;
}

type TabId = "shared" | "workspace" | "memory";

export default function GuildArtifactPanel({ tasks, agents, groupId, artifactStrategy, onClose }: Props) {
  const [tab, setTab] = useState<TabId>("shared");
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [manifest, setManifest] = useState<Record<string, ArtifactManifestEntry>>({});

  const strategy = artifactStrategy ?? "isolated";

  // Refresh manifest when (a) group/strategy changes, or (b) the count of
  // finished tasks changes — covers task_completed/failed SSE updates without
  // subscribing to the raw stream here.
  const completedTaskCount = useMemo(
    () => tasks.filter(t => t.status === "completed" || t.status === "failed").length,
    [tasks],
  );

  useEffect(() => {
    if (strategy === "collaborative" && groupId) {
      getGroupSharedManifest(groupId).then(setManifest).catch(() => setManifest({}));
    } else {
      setManifest({});
    }
  }, [strategy, groupId, completedTaskCount]);

  // Agents that belong to the current group (have completed tasks or are in the group)
  const groupAgentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const t of tasks) {
      if (t.assignedAgentId) ids.add(t.assignedAgentId);
    }
    return Array.from(ids);
  }, [tasks]);

  const groupAgents = useMemo(
    () => agents.filter(a => groupAgentIds.includes(a.id)),
    [agents, groupAgentIds],
  );

  // Use first agent as default if none selected
  const effectiveAgentId = selectedAgentId ?? groupAgents[0]?.id ?? null;
  const effectiveAgent = agents.find(a => a.id === effectiveAgentId);

  // Stable fetch functions — only recreated when IDs change
  const sharedTreeFetcher = useCallback(() => getGroupSharedTree(groupId!), [groupId]);
  const sharedFileFetcher = useCallback((path: string) => getGroupSharedFile(groupId!, path), [groupId]);
  const workspaceTreeFetcher = useCallback(() => getAgentWorkspaceTree(effectiveAgentId!), [effectiveAgentId]);
  const workspaceFileFetcher = useCallback((path: string) => getAgentWorkspaceFile(effectiveAgentId!, path), [effectiveAgentId]);
  const memoryTreeFetcher = useCallback(() => getAgentMemoryTree(effectiveAgentId!), [effectiveAgentId]);
  const memoryFileFetcher = useCallback((path: string) => getAgentMemoryFile(effectiveAgentId!, path), [effectiveAgentId]);

  const tabs: { id: TabId; label: string; icon: string }[] = [
    { id: "shared", label: "\u5C0F\u7EC4\u5171\u4EAB", icon: "\uD83D\uDC65" },
    { id: "workspace", label: "\u5DE5\u4F5C\u7A7A\u95F4", icon: "\uD83D\uDD27" },
    { id: "memory", label: "\u8BB0\u5FC6\u6863\u6848", icon: "\uD83E\uDDE0" },
  ];

  return (
    <div className="flex flex-col h-full" style={{ background: "var(--color-bg)" }}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b shrink-0" style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}>
        <span className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>
          {tabs.find(t => t.id === tab)?.icon} {tabs.find(t => t.id === tab)?.label}
        </span>
        <button
          onClick={onClose}
          className="text-xs px-2 py-1 rounded"
          style={{ background: "var(--color-surface-hover)", color: "var(--color-text-muted)" }}
        >
          {"\u2715"}
        </button>
      </div>

      {/* Tab bar */}
      <div className="flex items-center border-b shrink-0" style={{ borderColor: "var(--color-border)" }}>
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className="flex-1 text-xs py-2 transition-colors text-center"
            style={{
              color: tab === t.id ? "var(--color-accent)" : "var(--color-text-muted)",
              borderBottom: tab === t.id ? "2px solid var(--color-accent)" : "2px solid transparent",
              fontWeight: tab === t.id ? 600 : 400,
            }}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* Agent selector for workspace & memory tabs */}
      {(tab === "workspace" || tab === "memory") && (
        <div className="flex items-center gap-1 px-3 py-2 border-b shrink-0 overflow-x-auto" style={{ borderColor: "var(--color-border)" }}>
          {groupAgents.length === 0 ? (
            <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>{"\u6682\u65E0 Agent"}</span>
          ) : (
            groupAgents.map(a => (
              <button
                key={a.id}
                onClick={() => setSelectedAgentId(a.id)}
                className="text-[11px] px-2.5 py-1 rounded-full transition-colors shrink-0 flex items-center gap-1"
                style={{
                  background: effectiveAgentId === a.id ? "var(--color-accent)" : "transparent",
                  color: effectiveAgentId === a.id ? "white" : "var(--color-text-muted)",
                  border: effectiveAgentId === a.id ? "none" : "1px solid var(--color-border)",
                }}
              >
                <span>{a.icon}</span>
                {a.name}
              </button>
            ))
          )}
        </div>
      )}

      {/* Strategy indicator for shared tab */}
      {tab === "shared" && groupId && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b shrink-0 text-[11px]" style={{ borderColor: "var(--color-border)", color: "var(--color-text-muted)" }}>
          <span className="px-1.5 py-0.5 rounded" style={{
            background: strategy === "collaborative" ? "var(--color-accent)" : "var(--color-surface-hover)",
            color: strategy === "collaborative" ? "white" : "var(--color-text-muted)",
          }}>
            {strategy === "collaborative" ? "协作模式" : "隔离模式"}
          </span>
          <span>
            {strategy === "isolated" ? "每个任务独立产物目录" : "共享目录 · 自动追踪归属"}
          </span>
          {strategy === "collaborative" && Object.keys(manifest).length > 0 && (
            <span style={{ marginLeft: "auto" }}>
              已追踪 {Object.keys(manifest).length} 个文件
            </span>
          )}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === "shared" && groupId && (
          <FileTreeBrowser
            fetchTree={sharedTreeFetcher}
            fetchFile={sharedFileFetcher}
            refreshKey={groupId}
            emptyIcon={"\uD83D\uDC65"}
            emptyTitle={"暂无共享产物"}
            emptyDesc={"Agent 完成任务后的共享文件会出现在这里"}
          />
        )}
        {tab === "shared" && !groupId && (
          <div className="flex items-center justify-center h-full text-sm" style={{ color: "var(--color-text-muted)" }}>
            {"\u8BF7\u5148\u9009\u62E9\u4E00\u4E2A\u5C0F\u7EC4"}
          </div>
        )}
        {tab === "workspace" && effectiveAgentId && (
          <FileTreeBrowser
            fetchTree={workspaceTreeFetcher}
            fetchFile={workspaceFileFetcher}
            refreshKey={effectiveAgentId}
            emptyIcon={"\uD83D\uDD27"}
            emptyTitle={`${effectiveAgent?.name ?? "Agent"} \u7684\u5DE5\u4F5C\u7A7A\u95F4`}
            emptyDesc={"Agent \u6267\u884C\u4EFB\u52A1\u65F6\u7684\u5DE5\u4F5C\u6587\u4EF6\u4F1A\u51FA\u73B0\u5728\u8FD9\u91CC"}
          />
        )}
        {tab === "workspace" && !effectiveAgentId && (
          <div className="flex items-center justify-center h-full text-sm" style={{ color: "var(--color-text-muted)" }}>
            {"\u6682\u65E0\u53EF\u67E5\u770B\u7684 Agent"}
          </div>
        )}
        {tab === "memory" && effectiveAgentId && (
          <FileTreeBrowser
            fetchTree={memoryTreeFetcher}
            fetchFile={memoryFileFetcher}
            refreshKey={effectiveAgentId}
            emptyIcon={"\uD83E\uDDE0"}
            emptyTitle={`${effectiveAgent?.name ?? "Agent"} \u7684\u8BB0\u5FC6`}
            emptyDesc={"Agent \u4ECE\u4EFB\u52A1\u4E2D\u79EF\u7D2F\u7684\u7ECF\u9A8C\u3001\u77E5\u8BC6\u548C\u504F\u597D"}
          />
        )}
        {tab === "memory" && !effectiveAgentId && (
          <div className="flex items-center justify-center h-full text-sm" style={{ color: "var(--color-text-muted)" }}>
            {"\u6682\u65E0\u53EF\u67E5\u770B\u7684 Agent"}
          </div>
        )}
      </div>
    </div>
  );
}
