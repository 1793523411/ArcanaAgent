import { useState, useEffect } from "react";
import type { GuildAgent, AgentAsset, AssetType } from "../../types/guild";
import { listGroupAssets, addGroupAsset, removeGroupAsset, updateGroupAssetApi } from "../../api/guild";
import { ASSET_TYPE_META, ASSET_TYPES } from "../../constants/guild";

interface Props {
  groupId: string;
  agents: GuildAgent[];
  onClose: () => void;
}

const ASSET_TYPE_ICON: Record<string, string> = Object.fromEntries(
  ASSET_TYPES.map((t) => [t, ASSET_TYPE_META[t].icon])
);

const ASSET_TYPE_LABEL: Record<AssetType, string> = Object.fromEntries(
  ASSET_TYPES.map((t) => [t, ASSET_TYPE_META[t].label])
) as Record<AssetType, string>;

interface EditState {
  name: string;
  uri: string;
  description: string;
  tags: string;
}

interface AddForm {
  type: AssetType;
  name: string;
  uri: string;
  description: string;
  ownerAgentId: string;
  tags: string;
}

const emptyAdd = (): AddForm => ({
  type: "repo",
  name: "",
  uri: "",
  description: "",
  ownerAgentId: "",
  tags: "",
});

export default function GroupAssetPanel({ groupId, agents, onClose }: Props) {
  const [groupAssets, setGroupAssets] = useState<AgentAsset[]>([]);
  const [aggregated, setAggregated] = useState<AgentAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add form
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState<AddForm>(emptyAdd());
  const [adding, setAdding] = useState(false);

  // Edit state: assetId -> EditState
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EditState>({ name: "", uri: "", description: "", tags: "" });
  const [saving, setSaving] = useState(false);

  // Delete confirmation
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listGroupAssets(groupId);
      setGroupAssets(data.groupAssets);
      setAggregated(data.aggregated);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [groupId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAdd = async () => {
    if (!addForm.name.trim() || !addForm.uri.trim()) return;
    setAdding(true);
    try {
      await addGroupAsset(groupId, {
        type: addForm.type,
        name: addForm.name.trim(),
        uri: addForm.uri.trim(),
        description: addForm.description.trim() || undefined,
        ownerAgentId: addForm.ownerAgentId || undefined,
        tags: addForm.tags ? addForm.tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
      });
      setAddForm(emptyAdd());
      setShowAdd(false);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setAdding(false);
    }
  };

  const startEdit = (asset: AgentAsset) => {
    setEditingId(asset.id);
    setEditForm({
      name: asset.name,
      uri: asset.uri,
      description: asset.description ?? "",
      tags: asset.tags?.join(", ") ?? "",
    });
  };

  const handleSaveEdit = async () => {
    if (!editingId) return;
    setSaving(true);
    try {
      await updateGroupAssetApi(groupId, editingId, {
        name: editForm.name.trim(),
        uri: editForm.uri.trim(),
        description: editForm.description.trim() || undefined,
        tags: editForm.tags ? editForm.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
      });
      setEditingId(null);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (assetId: string) => {
    setDeleting(true);
    try {
      await removeGroupAsset(groupId, assetId);
      setDeletingId(null);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setDeleting(false);
    }
  };

  const agentById = (id?: string) => agents.find((a) => a.id === id);

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div
        className="relative w-full max-w-2xl rounded-xl shadow-2xl flex flex-col overflow-hidden"
        style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", maxHeight: "85vh" }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-3 border-b shrink-0"
          style={{ borderColor: "var(--color-border)" }}
        >
          <div className="flex items-center gap-2">
            <span className="text-lg">🗂️</span>
            <div>
              <h3 className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>
                小组资产管理
              </h3>
              <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                {groupAssets.length} 项小组资产 · {aggregated.length} 项聚合资产
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-[var(--color-surface-hover)]"
            style={{ color: "var(--color-text-muted)" }}
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {/* Concept explanation card */}
          <div
            className="mx-4 mt-4 px-3 py-2.5 rounded-lg text-[11px] space-y-1"
            style={{ background: "var(--color-accent-alpha)", border: "1px solid var(--color-border)", color: "var(--color-text-muted)" }}
          >
            <div>
              <span className="font-semibold" style={{ color: "var(--color-text)" }}>小组资产</span>
              {" "}是整个小组共享的资源，所有成员 Agent 都可访问。
            </div>
            <div>
              <span className="font-semibold" style={{ color: "var(--color-text)" }}>聚合资产</span>
              {" "}是只读视图，自动汇总各成员 Agent 的私有资产，无需手动添加。
            </div>
          </div>
          {loading ? (
            <div className="flex items-center justify-center h-48" style={{ color: "var(--color-text-muted)" }}>
              加载中...
            </div>
          ) : (
            <div className="p-4 space-y-6">
              {error && (
                <div
                  className="px-3 py-2 rounded-lg text-xs"
                  style={{ background: "#ef444420", color: "#ef4444", border: "1px solid #ef444440" }}
                >
                  {error}
                </div>
              )}

              {/* ── Section 1: Group Assets ── */}
              <section>
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--color-text-muted)" }}>
                    小组资产
                  </h4>
                  <button
                    onClick={() => { setShowAdd((v) => !v); setAddForm(emptyAdd()); }}
                    className="text-xs px-2.5 py-1 rounded-lg"
                    style={{ background: "var(--color-accent)", color: "white" }}
                  >
                    {showAdd ? "取消" : "+ 添加资产"}
                  </button>
                </div>

                {/* Add form */}
                {showAdd && (
                  <div
                    className="mb-3 p-4 rounded-xl space-y-3"
                    style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)" }}
                  >
                    <div className="grid grid-cols-2 gap-3">
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] font-medium uppercase" style={{ color: "var(--color-text-muted)" }}>
                          类型
                        </label>
                        <select
                          value={addForm.type}
                          onChange={(e) => setAddForm((f) => ({ ...f, type: e.target.value as AssetType }))}
                          className="text-xs px-2 py-1.5 rounded-lg"
                          style={{
                            background: "var(--color-surface)",
                            border: "1px solid var(--color-border)",
                            color: "var(--color-text)",
                          }}
                        >
                          {ASSET_TYPES.map((t) => (
                            <option key={t} value={t}>{ASSET_TYPE_ICON[t]} {ASSET_TYPE_LABEL[t]}</option>
                          ))}
                        </select>
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] font-medium uppercase" style={{ color: "var(--color-text-muted)" }}>
                          所属 Agent（可选）
                        </label>
                        <select
                          value={addForm.ownerAgentId}
                          onChange={(e) => setAddForm((f) => ({ ...f, ownerAgentId: e.target.value }))}
                          className="text-xs px-2 py-1.5 rounded-lg"
                          style={{
                            background: "var(--color-surface)",
                            border: "1px solid var(--color-border)",
                            color: "var(--color-text)",
                          }}
                        >
                          <option value="">无</option>
                          {agents.map((a) => (
                            <option key={a.id} value={a.id}>{a.icon} {a.name}</option>
                          ))}
                        </select>
                        <p className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>
                          指定主要负责此资产的 Agent，仅用于任务打分偏向，不影响其他成员访问。
                        </p>
                      </div>
                    </div>
                    <p className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>
                      {ASSET_TYPE_META[addForm.type].description}
                    </p>
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] font-medium uppercase" style={{ color: "var(--color-text-muted)" }}>
                        名称 *
                      </label>
                      <input
                        value={addForm.name}
                        onChange={(e) => setAddForm((f) => ({ ...f, name: e.target.value }))}
                        placeholder="资产名称"
                        className="text-xs px-3 py-1.5 rounded-lg"
                        style={{
                          background: "var(--color-surface)",
                          border: "1px solid var(--color-border)",
                          color: "var(--color-text)",
                        }}
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] font-medium uppercase" style={{ color: "var(--color-text-muted)" }}>
                        URI *
                      </label>
                      <input
                        value={addForm.uri}
                        onChange={(e) => setAddForm((f) => ({ ...f, uri: e.target.value }))}
                        placeholder={ASSET_TYPE_META[addForm.type].placeholder}
                        className="text-xs px-3 py-1.5 rounded-lg"
                        style={{
                          background: "var(--color-surface)",
                          border: "1px solid var(--color-border)",
                          color: "var(--color-text)",
                        }}
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] font-medium uppercase" style={{ color: "var(--color-text-muted)" }}>
                        描述（可选）
                      </label>
                      <input
                        value={addForm.description}
                        onChange={(e) => setAddForm((f) => ({ ...f, description: e.target.value }))}
                        placeholder="简短描述"
                        className="text-xs px-3 py-1.5 rounded-lg"
                        style={{
                          background: "var(--color-surface)",
                          border: "1px solid var(--color-border)",
                          color: "var(--color-text)",
                        }}
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] font-medium uppercase" style={{ color: "var(--color-text-muted)" }}>
                        标签（逗号分隔，可选）
                      </label>
                      <input
                        value={addForm.tags}
                        onChange={(e) => setAddForm((f) => ({ ...f, tags: e.target.value }))}
                        placeholder="frontend, api, v2"
                        className="text-xs px-3 py-1.5 rounded-lg"
                        style={{
                          background: "var(--color-surface)",
                          border: "1px solid var(--color-border)",
                          color: "var(--color-text)",
                        }}
                      />
                    </div>
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => setShowAdd(false)}
                        className="text-xs px-3 py-1.5 rounded-lg"
                        style={{ background: "var(--color-surface-hover)", color: "var(--color-text-muted)" }}
                      >
                        取消
                      </button>
                      <button
                        onClick={handleAdd}
                        disabled={adding || !addForm.name.trim() || !addForm.uri.trim()}
                        className="text-xs px-3 py-1.5 rounded-lg disabled:opacity-50"
                        style={{ background: "var(--color-accent)", color: "white" }}
                      >
                        {adding ? "添加中..." : "添加"}
                      </button>
                    </div>
                  </div>
                )}

                {/* Group asset list */}
                {groupAssets.length === 0 ? (
                  <div
                    className="flex flex-col items-center justify-center py-8 rounded-xl gap-2"
                    style={{ border: "1px dashed var(--color-border)", color: "var(--color-text-muted)" }}
                  >
                    <span className="text-2xl">🗂️</span>
                    <span className="text-xs">暂无小组资产</span>
                    <span className="text-[11px] text-center px-4" style={{ color: "var(--color-text-muted)" }}>
                      小组资产由所有成员共享，适合放置团队通用的知识库、API 等
                    </span>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {groupAssets.map((asset) => {
                      const isEditing = editingId === asset.id;
                      const owner = agentById(asset.ownerAgentId);
                      return (
                        <div
                          key={asset.id}
                          className="rounded-xl p-3"
                          style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)" }}
                        >
                          {isEditing ? (
                            /* Edit mode */
                            <div className="space-y-2">
                              <div className="grid grid-cols-2 gap-2">
                                <div className="flex flex-col gap-1">
                                  <label className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>名称</label>
                                  <input
                                    value={editForm.name}
                                    onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                                    className="text-xs px-2 py-1 rounded-lg"
                                    style={{
                                      background: "var(--color-surface)",
                                      border: "1px solid var(--color-border)",
                                      color: "var(--color-text)",
                                    }}
                                  />
                                </div>
                                <div className="flex flex-col gap-1">
                                  <label className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>URI</label>
                                  <input
                                    value={editForm.uri}
                                    onChange={(e) => setEditForm((f) => ({ ...f, uri: e.target.value }))}
                                    className="text-xs px-2 py-1 rounded-lg"
                                    style={{
                                      background: "var(--color-surface)",
                                      border: "1px solid var(--color-border)",
                                      color: "var(--color-text)",
                                    }}
                                  />
                                </div>
                              </div>
                              <div className="flex flex-col gap-1">
                                <label className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>描述</label>
                                <input
                                  value={editForm.description}
                                  onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))}
                                  className="text-xs px-2 py-1 rounded-lg"
                                  style={{
                                    background: "var(--color-surface)",
                                    border: "1px solid var(--color-border)",
                                    color: "var(--color-text)",
                                  }}
                                />
                              </div>
                              <div className="flex flex-col gap-1">
                                <label className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>标签（逗号分隔）</label>
                                <input
                                  value={editForm.tags}
                                  onChange={(e) => setEditForm((f) => ({ ...f, tags: e.target.value }))}
                                  className="text-xs px-2 py-1 rounded-lg"
                                  style={{
                                    background: "var(--color-surface)",
                                    border: "1px solid var(--color-border)",
                                    color: "var(--color-text)",
                                  }}
                                />
                              </div>
                              <div className="flex justify-end gap-2">
                                <button
                                  onClick={() => setEditingId(null)}
                                  className="text-xs px-2.5 py-1 rounded-lg"
                                  style={{ background: "var(--color-surface-hover)", color: "var(--color-text-muted)" }}
                                >
                                  取消
                                </button>
                                <button
                                  onClick={handleSaveEdit}
                                  disabled={saving}
                                  className="text-xs px-2.5 py-1 rounded-lg disabled:opacity-50"
                                  style={{ background: "var(--color-accent)", color: "white" }}
                                >
                                  {saving ? "保存中..." : "保存"}
                                </button>
                              </div>
                            </div>
                          ) : deletingId === asset.id ? (
                            /* Delete confirmation */
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-xs" style={{ color: "var(--color-text)" }}>
                                确定删除「{asset.name}」？
                              </span>
                              <div className="flex items-center gap-1.5 shrink-0">
                                <button
                                  onClick={() => setDeletingId(null)}
                                  className="text-xs px-2.5 py-1 rounded-lg"
                                  style={{ background: "var(--color-surface-hover)", color: "var(--color-text-muted)" }}
                                >
                                  取消
                                </button>
                                <button
                                  onClick={() => handleDelete(asset.id)}
                                  disabled={deleting}
                                  className="text-xs px-2.5 py-1 rounded-lg disabled:opacity-50"
                                  style={{ background: "#ef4444", color: "white" }}
                                >
                                  {deleting ? "删除中..." : "确认删除"}
                                </button>
                              </div>
                            </div>
                          ) : (
                            /* View mode */
                            <div className="flex items-start gap-3">
                              <span className="text-base shrink-0 mt-0.5">{ASSET_TYPE_ICON[asset.type] ?? "📎"}</span>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-medium truncate" style={{ color: "var(--color-text)" }}>
                                    {asset.name}
                                  </span>
                                  <span
                                    className="text-[9px] px-1.5 py-0.5 rounded shrink-0"
                                    style={{ background: "var(--color-surface-hover)", color: "var(--color-text-muted)" }}
                                  >
                                    {ASSET_TYPE_LABEL[asset.type] ?? asset.type}
                                  </span>
                                </div>
                                <div
                                  className="text-xs mt-0.5 truncate"
                                  style={{ color: "var(--color-text-muted)" }}
                                  title={asset.uri}
                                >
                                  {asset.uri}
                                </div>
                                {asset.description && (
                                  <div className="text-xs mt-0.5" style={{ color: "var(--color-text-muted)" }}>
                                    {asset.description}
                                  </div>
                                )}
                                <div className="flex items-center gap-2 mt-1 flex-wrap">
                                  {owner && (
                                    <span className="text-[10px] flex items-center gap-1" style={{ color: "var(--color-text-muted)" }}>
                                      <span>{owner.icon}</span>
                                      <span>{owner.name}</span>
                                    </span>
                                  )}
                                  {asset.tags?.map((tag) => (
                                    <span
                                      key={tag}
                                      className="text-[9px] px-1.5 py-0.5 rounded"
                                      style={{ background: "var(--color-surface-hover)", color: "var(--color-text-muted)" }}
                                    >
                                      {tag}
                                    </span>
                                  ))}
                                </div>
                              </div>
                              <div className="flex items-center gap-1 shrink-0">
                                <button
                                  onClick={() => startEdit(asset)}
                                  className="text-xs px-2 py-1 rounded-lg hover:bg-[var(--color-surface-hover)]"
                                  style={{ color: "var(--color-text-muted)" }}
                                  title="编辑"
                                >
                                  ✏️
                                </button>
                                <button
                                  onClick={() => setDeletingId(asset.id)}
                                  className="text-xs px-2 py-1 rounded-lg hover:bg-[var(--color-surface-hover)]"
                                  style={{ color: "var(--color-text-muted)" }}
                                  title="删除"
                                >
                                  🗑️
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              {/* ── Section 2: Aggregated Assets ── */}
              <section>
                <div className="flex items-center gap-2 mb-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--color-text-muted)" }}>
                    聚合资产
                  </h4>
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded-full"
                    style={{ background: "var(--color-surface-hover)", color: "var(--color-text-muted)" }}
                  >
                    只读 · 来自成员 Agent
                  </span>
                </div>

                {aggregated.length === 0 ? (
                  <div
                    className="flex flex-col items-center justify-center py-8 rounded-xl gap-2"
                    style={{ border: "1px dashed var(--color-border)", color: "var(--color-text-muted)" }}
                  >
                    <span className="text-2xl">🔗</span>
                    <span className="text-xs">暂无聚合资产</span>
                    <span className="text-xs">将 Agent 加入小组后，其资产会自动聚合</span>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {aggregated.map((asset) => {
                      const owner = agentById(asset.ownerAgentId);
                      return (
                        <div
                          key={asset.id}
                          className="rounded-xl p-3 flex items-start gap-3"
                          style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", opacity: 0.85 }}
                        >
                          <span className="text-base shrink-0 mt-0.5">{ASSET_TYPE_ICON[asset.type] ?? "📎"}</span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium truncate" style={{ color: "var(--color-text)" }}>
                                {asset.name}
                              </span>
                              <span
                                className="text-[9px] px-1.5 py-0.5 rounded shrink-0"
                                style={{ background: "var(--color-surface-hover)", color: "var(--color-text-muted)" }}
                              >
                                {ASSET_TYPE_LABEL[asset.type] ?? asset.type}
                              </span>
                            </div>
                            <div
                              className="text-xs mt-0.5 truncate"
                              style={{ color: "var(--color-text-muted)" }}
                              title={asset.uri}
                            >
                              {asset.uri}
                            </div>
                            {asset.description && (
                              <div className="text-xs mt-0.5" style={{ color: "var(--color-text-muted)" }}>
                                {asset.description}
                              </div>
                            )}
                            <div className="flex items-center gap-2 mt-1 flex-wrap">
                              {owner && (
                                <span
                                  className="text-[10px] flex items-center gap-1 px-1.5 py-0.5 rounded"
                                  style={{ background: "var(--color-surface-hover)", color: "var(--color-text-muted)" }}
                                >
                                  <span>{owner.icon}</span>
                                  <span>{owner.name}</span>
                                </span>
                              )}
                              {asset.tags?.map((tag) => (
                                <span
                                  key={tag}
                                  className="text-[9px] px-1.5 py-0.5 rounded"
                                  style={{ background: "var(--color-surface-hover)", color: "var(--color-text-muted)" }}
                                >
                                  {tag}
                                </span>
                              ))}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
