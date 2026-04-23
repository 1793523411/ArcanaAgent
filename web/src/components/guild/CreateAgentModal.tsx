import { useState, useEffect } from "react";
import type { GuildAgent, AgentAsset, AssetType } from "../../types/guild";
import { generateGuildAgent } from "../../api/guild";
import { getModels, type ModelInfo } from "../../api";
import Select from "./Select";
import { ASSET_TYPE_META, ASSET_TYPES } from "../../constants/guild";
import { friendlyError } from "../../lib/guildErrors";

type CreatePayload = Omit<GuildAgent, "id" | "status" | "currentTaskId" | "createdAt" | "updatedAt" | "stats">;

interface Props {
  editAgent?: import("../../types/guild").GuildAgent;
  onConfirm: (data: CreatePayload) => Promise<void>;
  onClose: () => void;
}

const ASSET_TYPE_OPTIONS: AssetType[] = ASSET_TYPES;

const ASSET_TYPE_LABEL: Record<AssetType, string> = Object.fromEntries(
  ASSET_TYPES.map((t) => [t, ASSET_TYPE_META[t].label])
) as Record<AssetType, string>;

export default function CreateAgentModal({ editAgent, onConfirm, onClose }: Props) {
  const isEdit = !!editAgent;
  const [name, setName] = useState(editAgent?.name ?? "");
  const [description, setDescription] = useState(editAgent?.description ?? "");
  const [icon, setIcon] = useState(editAgent?.icon ?? "🤖");
  const [color, setColor] = useState(editAgent?.color ?? "#6B7280");
  const [systemPrompt, setSystemPrompt] = useState(editAgent?.systemPrompt ?? "");
  const [modelId, setModelId] = useState(editAgent?.modelId ?? "");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [assets, setAssets] = useState<Omit<AgentAsset, "id" | "addedAt">[]>(
    editAgent?.assets.map(({ id: _id, addedAt: _at, ...rest }) => rest) ?? []
  );
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genPrompt, setGenPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getModels().then(setModels).catch(() => {});
  }, []);

  // Asset form
  const [assetType, setAssetType] = useState<AssetType>("repo");
  const [assetName, setAssetName] = useState("");
  const [assetUri, setAssetUri] = useState("");
  const [assetDesc, setAssetDesc] = useState("");

  const handleAddAsset = () => {
    if (!assetName.trim() || !assetUri.trim()) return;
    setAssets((prev) => [...prev, { type: assetType, name: assetName.trim(), uri: assetUri.trim(), description: assetDesc.trim() || undefined }]);
    setAssetName("");
    setAssetUri("");
    setAssetDesc("");
  };

  const handleRemoveAsset = (idx: number) => {
    setAssets((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleGenerate = async () => {
    if (!genPrompt.trim() || generating) return;
    setGenerating(true);
    setError(null);
    try {
      const result = await generateGuildAgent(genPrompt.trim());
      setName(result.name);
      setDescription(result.description);
      setIcon(result.icon);
      setColor(result.color);
      setSystemPrompt(result.systemPrompt);
    } catch (e) {
      setError(`AI 生成失败: ${e}`);
    } finally {
      setGenerating(false);
    }
  };

  const handleSubmit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await onConfirm({
        name: name.trim(),
        description: description.trim(),
        icon,
        color,
        systemPrompt,
        modelId: modelId || undefined,
        allowedTools: ["*"],
        memoryDir: "",
        assets: assets as AgentAsset[],
        skills: [],
      });
      onClose();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        className="relative w-full max-w-lg rounded-xl shadow-2xl flex flex-col overflow-hidden"
        style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", maxHeight: "90vh" }}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b shrink-0" style={{ borderColor: "var(--color-border)" }}>
          <h3 className="text-base font-semibold" style={{ color: "var(--color-text)" }}>{isEdit ? "编辑 Agent" : "创建 Guild Agent"}</h3>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-[var(--color-surface-hover)]"
            style={{ color: "var(--color-text-muted)" }}
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* AI Generation */}
          {!isEdit && (
            <div
              className="rounded-lg p-3 space-y-2"
              style={{ background: "var(--color-accent-alpha)", border: "1px solid var(--color-accent)" }}
            >
              <div className="text-xs font-semibold" style={{ color: "var(--color-accent)" }}>AI 一键生成</div>
              <div className="flex gap-2">
                <input
                  className="flex-1 px-3 py-1.5 rounded-lg text-sm"
                  style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", color: "var(--color-text)" }}
                  value={genPrompt}
                  onChange={(e) => setGenPrompt(e.target.value)}
                  placeholder="描述你想要的 Agent，如：精通 React 的前端专家"
                  disabled={generating}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing && genPrompt.trim() && !generating) {
                      e.preventDefault();
                      handleGenerate();
                    }
                  }}
                />
                <button
                  className="px-3 py-1.5 rounded-lg text-xs text-white shrink-0"
                  style={{ background: generating || !genPrompt.trim() ? "var(--color-text-muted)" : "var(--color-accent)" }}
                  disabled={generating || !genPrompt.trim()}
                  onClick={handleGenerate}
                >
                  {generating ? "生成中..." : "生成"}
                </button>
              </div>
            </div>
          )}

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-xs mb-1" style={{ color: "var(--color-text-muted)" }}>名称</label>
              <input
                className="w-full px-3 py-2 rounded-lg text-sm"
                style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", color: "var(--color-text)" }}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Agent 名称"
                autoFocus
              />
            </div>
            <div className="w-16">
              <label className="block text-xs mb-1" style={{ color: "var(--color-text-muted)" }}>图标</label>
              <input
                className="w-full px-3 py-2 rounded-lg text-sm text-center"
                style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", color: "var(--color-text)" }}
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
              />
            </div>
            <div className="w-24">
              <label className="block text-xs mb-1" style={{ color: "var(--color-text-muted)" }}>颜色</label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  className="w-8 h-8 rounded cursor-pointer border-0"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                />
                <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>{color}</span>
              </div>
            </div>
          </div>

          <div>
            <label className="block text-xs mb-1" style={{ color: "var(--color-text-muted)" }}>描述</label>
            <textarea
              className="w-full px-3 py-2 rounded-lg text-sm resize-y"
              style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", color: "var(--color-text)", minHeight: 56 }}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Agent 职责描述"
            />
          </div>

          <div>
            <label className="block text-xs mb-1" style={{ color: "var(--color-text-muted)" }}>系统提示词</label>
            <textarea
              className="w-full px-3 py-2 rounded-lg text-sm font-mono resize-y"
              style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", color: "var(--color-text)", minHeight: 100 }}
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="定义该 Agent 的角色和行为指令..."
            />
          </div>

          {/* Model selection */}
          <div>
            <label className="block text-xs mb-1" style={{ color: "var(--color-text-muted)" }}>执行模型（可选，留空使用全局默认）</label>
            <Select
              value={modelId}
              onChange={setModelId}
              widthClass="w-full"
              options={[
                { value: "", label: "默认（跟随全局设置）" },
                ...models.map((m) => ({ value: m.id, label: m.name, hint: m.provider })),
              ]}
            />
          </div>

          {/* Assets */}
          <div>
            <label className="block text-xs mb-1" style={{ color: "var(--color-text-muted)" }}>资产（可选）</label>
            <p className="text-[11px] mb-2" style={{ color: "var(--color-text-muted)" }}>
              资产是 Agent 执行任务时可访问的资源（仓库 / 文档 / API 等），系统会根据资产内容判断任务匹配度。
            </p>
            {assets.length > 0 && (
              <div className="mb-2">
                <div className="flex items-center gap-1.5 mb-1.5">
                  <span className="text-[11px] font-semibold" style={{ color: "var(--color-text-muted)" }}>已添加资产</span>
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded-full font-bold"
                    style={{ background: "var(--color-accent-alpha)", color: "var(--color-accent)" }}
                  >
                    {assets.length}
                  </span>
                </div>
                <div className="space-y-1.5">
                  {assets.map((a, i) => (
                    <div key={i} className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs" style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)" }}>
                      <span className="font-medium" style={{ color: "var(--color-accent)" }}>{ASSET_TYPE_LABEL[a.type]}</span>
                      <span className="flex-1 truncate" style={{ color: "var(--color-text)" }}>{a.name}</span>
                      <span className="truncate max-w-[120px]" style={{ color: "var(--color-text-muted)" }}>{a.uri}</span>
                      <button onClick={() => handleRemoveAsset(i)} style={{ color: "var(--color-error-text)" }} className="shrink-0">✕</button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="mb-1">
              <span className="text-[11px]" style={{ color: "var(--color-text-muted)" }}>
                {assets.length === 0 ? "添加第一个资产" : "继续添加资产"}
              </span>
            </div>
            <div className="rounded-lg p-3 space-y-2" style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)" }}>
              <div className="flex gap-2">
                <Select<AssetType>
                  value={assetType}
                  onChange={setAssetType}
                  options={ASSET_TYPE_OPTIONS.map((t) => ({ value: t, label: ASSET_TYPE_LABEL[t] }))}
                />
                <input
                  className="flex-1 px-2 py-1.5 rounded text-xs"
                  style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", color: "var(--color-text)" }}
                  value={assetName}
                  onChange={(e) => setAssetName(e.target.value)}
                  placeholder="资产名称"
                />
              </div>
              <p className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>
                {ASSET_TYPE_META[assetType].description}
              </p>
              <div className="flex gap-2">
                <input
                  className="flex-1 px-2 py-1.5 rounded text-xs"
                  style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", color: "var(--color-text)" }}
                  value={assetUri}
                  onChange={(e) => setAssetUri(e.target.value)}
                  placeholder={ASSET_TYPE_META[assetType].placeholder}
                />
                <button
                  className="px-3 py-1.5 rounded text-xs text-white"
                  style={{ background: assetName.trim() && assetUri.trim() ? "var(--color-accent)" : "var(--color-text-muted)" }}
                  onClick={handleAddAsset}
                  disabled={!assetName.trim() || !assetUri.trim()}
                >
                  添加
                </button>
              </div>
              {assets.length === 0 && (
                <p className="text-[11px]" style={{ color: "var(--color-text-muted)" }}>
                  可添加多个资产，点击"添加"后继续填写下一个
                </p>
              )}
              <input
                className="w-full px-2 py-1.5 rounded text-xs"
                style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", color: "var(--color-text)" }}
                value={assetDesc}
                onChange={(e) => setAssetDesc(e.target.value)}
                placeholder="资产描述（可选）"
              />
            </div>
          </div>

          {error && (
            <div className="text-xs" style={{ color: "var(--color-error-text)" }}>{error}</div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t shrink-0" style={{ borderColor: "var(--color-border)" }}>
          <button
            className="px-4 py-1.5 rounded-lg text-sm"
            style={{ color: "var(--color-text-muted)" }}
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="px-4 py-1.5 rounded-lg text-sm text-white"
            style={{ background: saving || !name.trim() ? "var(--color-text-muted)" : "var(--color-accent)" }}
            onClick={handleSubmit}
            disabled={saving || !name.trim()}
          >
            {saving ? (isEdit ? "保存中..." : "创建中...") : (isEdit ? "保存" : "创建 Agent")}
          </button>
        </div>
      </div>
    </div>
  );
}
