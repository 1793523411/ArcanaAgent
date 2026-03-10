import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import type { ScheduledTask, CreateTaskRequest, TaskType } from "../types/scheduler";

interface Props {
  task?: ScheduledTask;
  onSubmit: (data: CreateTaskRequest) => void;
  onClose: () => void;
  allTasks: ScheduledTask[];
}

// 辅助函数：ISO 字符串转 datetime-local 格式
const formatDateTimeLocal = (isoString: string): string => {
  if (!isoString) return "";
  const date = new Date(isoString);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
};

const formatFeishuContentInput = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return "";
    }
  }
  return "";
};

export function TaskFormModal({ task, onSubmit, onClose, allTasks }: Props) {
  const [formData, setFormData] = useState<CreateTaskRequest>({
    name: task?.name || "",
    description: task?.description || "",
    type: task?.type || "webhook",
    config: task?.config || {},
    schedule: task?.schedule || "",
    executeAt: task?.executeAt || "",
    dependsOn: task?.dependsOn || [],
    enabled: task?.enabled ?? true,
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(formData);
  };

  const updateConfig = (key: string, value: unknown) => {
    setFormData({
      ...formData,
      config: { ...formData.config, [key]: value },
    });
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 z-[100] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-[50%] top-[50%] z-[101] max-h-[90vh] w-full max-w-2xl translate-x-[-50%] translate-y-[-50%] overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]">
          <Dialog.Title className="text-lg font-semibold mb-4 text-[var(--color-text)]">
            {task ? "编辑任务" : "创建新任务"}
          </Dialog.Title>

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* 基本信息 */}
            <div>
              <label className="block text-sm font-medium text-[var(--color-text)] mb-1">任务名称 *</label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                className="w-full px-3 py-2 border border-[var(--color-border)] rounded bg-[var(--color-bg)] text-[var(--color-text)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-[var(--color-text)] mb-1">描述</label>
              <textarea
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                className="w-full px-3 py-2 border border-[var(--color-border)] rounded bg-[var(--color-bg)] text-[var(--color-text)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
                rows={2}
              />
            </div>

            {/* 任务类型 */}
            <div>
              <label className="block text-sm font-medium text-[var(--color-text)] mb-1">任务类型 *</label>
              <select
                value={formData.type}
                onChange={(e) => setFormData({ ...formData, type: e.target.value as TaskType, config: {} })}
                className="w-full px-3 py-2 border border-[var(--color-border)] rounded bg-[var(--color-bg)] text-[var(--color-text)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
              >
                <option value="webhook">🔗 Webhook (飞书群聊等)</option>
                <option value="conversation">💬 对话任务</option>
                <option value="skill">🎯 Skill 任务</option>
                <option value="system">⚙️ 系统任务</option>
              </select>
            </div>

            {/* 配置区域 */}
            {formData.type === "webhook" && (
              <WebhookConfig config={formData.config} updateConfig={updateConfig} />
            )}
            {formData.type === "conversation" && (
              <ConversationConfig config={formData.config} updateConfig={updateConfig} />
            )}

            {/* 调度配置 */}
            <div className="border-t border-[var(--color-border)] pt-4">
              <div className="mb-3">
                <label className="flex items-center gap-2 text-sm text-[var(--color-text)] cursor-pointer">
                  <input
                    type="radio"
                    checked={!formData.executeAt}
                    onChange={() => setFormData({ ...formData, executeAt: "" })}
                    className="cursor-pointer"
                  />
                  周期任务 (Cron)
                </label>
                {!formData.executeAt && (
                  <input
                    type="text"
                    value={formData.schedule}
                    onChange={(e) => setFormData({ ...formData, schedule: e.target.value })}
                    placeholder="0 8 * * * (每天8点)"
                    className="mt-2 w-full px-3 py-2 border border-[var(--color-border)] rounded bg-[var(--color-bg)] text-[var(--color-text)] font-mono text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
                  />
                )}
              </div>

              <div>
                <label className="flex items-center gap-2 text-sm text-[var(--color-text)] cursor-pointer">
                  <input
                    type="radio"
                    checked={!!formData.executeAt}
                    onChange={() => setFormData({ ...formData, executeAt: new Date().toISOString(), schedule: "" })}
                    className="cursor-pointer"
                  />
                  一次性任务
                </label>
                {formData.executeAt && (
                  <input
                    type="datetime-local"
                    value={formatDateTimeLocal(formData.executeAt)}
                    onChange={(e) => setFormData({ ...formData, executeAt: new Date(e.target.value).toISOString() })}
                    className="mt-2 w-full px-3 py-2 border border-[var(--color-border)] rounded bg-[var(--color-bg)] text-[var(--color-text)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
                  />
                )}
              </div>
            </div>

            {/* 任务依赖 */}
            <div>
              <label className="block text-sm font-medium text-[var(--color-text)] mb-1">任务依赖（可选）</label>
              <select
                multiple
                value={formData.dependsOn}
                onChange={(e) => setFormData({ ...formData, dependsOn: Array.from(e.target.selectedOptions, o => o.value) })}
                className="w-full px-3 py-2 border border-[var(--color-border)] rounded bg-[var(--color-bg)] text-[var(--color-text)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
                size={3}
              >
                {allTasks.filter(t => t.id !== task?.id).map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              {allTasks.filter(t => t.id !== task?.id).length === 0 ? (
                <p className="text-xs text-[var(--color-text-muted)] mt-1">暂无可选的依赖任务</p>
              ) : (
                <p className="text-xs text-[var(--color-text-muted)] mt-1">
                  点击选择依赖任务，按住 Ctrl/Cmd 可多选。此任务将在所有依赖任务执行成功后才运行。
                </p>
              )}
            </div>

            {/* 按钮 */}
            <div className="flex justify-end gap-2 pt-4 border-t border-[var(--color-border)]">
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="px-4 py-2 border border-[var(--color-border)] rounded text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] transition-colors"
                >
                  取消
                </button>
              </Dialog.Close>
              <button
                type="submit"
                className="px-4 py-2 bg-[var(--color-accent)] text-white rounded hover:opacity-90 transition-opacity"
              >
                {task ? "更新" : "创建"}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ─── Webhook 配置 ─────────────────────────────────────────

function WebhookConfig({ config, updateConfig }: { config: Record<string, unknown>; updateConfig: (k: string, v: unknown) => void }) {
  const useModelOutput = !!(config.useModelOutput);
  const feishuConfig = (config.feishu as Record<string, unknown>) || undefined;
  const rawMsgType = (feishuConfig?.msgType as string) || "text";
  const msgType = rawMsgType === "interactive" ? "interactive" : "text";
  const feishuContent = feishuConfig?.content;

  return (
    <div className="space-y-3 p-4 border border-[var(--color-border)] rounded-lg bg-[var(--color-bg)]">
      <div>
        <label className="block text-sm font-medium text-[var(--color-text)] mb-1">Webhook URL *</label>
        <input
          type="url"
          value={(config.url as string) || ""}
          onChange={(e) => updateConfig("url", e.target.value)}
          placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
          className="w-full px-3 py-2 border border-[var(--color-border)] rounded bg-[var(--color-surface)] text-[var(--color-text)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
          required
        />
      </div>

      {/* 飞书群聊配置（通用） */}
      <div>
        <label className="flex items-center gap-2 text-sm text-[var(--color-text)] cursor-pointer">
          <input
            type="checkbox"
            checked={!!feishuConfig}
            onChange={(e) => {
              if (e.target.checked) {
                updateConfig("feishu", { msgType: "text", content: "" });
              } else {
                updateConfig("feishu", undefined);
              }
            }}
            className="cursor-pointer"
          />
          使用飞书群聊机器人格式
        </label>
      </div>

      {feishuConfig && (
        <div className="space-y-2 pl-6 border-l-2 border-blue-500">
          <div>
            <label className="block text-sm text-[var(--color-text)] mb-1">消息类型</label>
            <select
              value={msgType}
              onChange={(e) => updateConfig("feishu", { ...feishuConfig, msgType: e.target.value })}
              className="w-full px-3 py-2 border border-[var(--color-border)] rounded bg-[var(--color-surface)] text-[var(--color-text)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
            >
              <option value="text">文本</option>
              <option value="interactive">卡片</option>
            </select>
          </div>
        </div>
      )}

      {/* 内容来源选择 */}
      <div className="border-t border-[var(--color-border)] pt-3 space-y-2">
        <label className="block text-sm font-medium text-[var(--color-text)]">内容来源</label>

        <label className="flex items-center gap-2 text-sm text-[var(--color-text)] cursor-pointer">
          <input
            type="radio"
            checked={useModelOutput}
            onChange={() => updateConfig("useModelOutput", true)}
            className="cursor-pointer"
          />
          发送模型输出（Agent 对话结果）
        </label>

        <label className="flex items-center gap-2 text-sm text-[var(--color-text)] cursor-pointer">
          <input
            type="radio"
            checked={!useModelOutput}
            onChange={() => updateConfig("useModelOutput", false)}
            className="cursor-pointer"
          />
          发送固定内容
        </label>
      </div>

      {/* 模型输出配置 */}
      {useModelOutput ? (
        <div className="space-y-3 pl-6 pt-2 border-l-2 border-[var(--color-accent)]">
          <div>
            <label className="block text-sm text-[var(--color-text)] mb-1">提示词 *</label>
            <textarea
              value={(config.prompt as string) || ""}
              onChange={(e) => updateConfig("prompt", e.target.value)}
              placeholder="例如：总结今天的新闻、生成每日报告"
              className="w-full px-3 py-2 border border-[var(--color-border)] rounded bg-[var(--color-surface)] text-[var(--color-text)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
              rows={3}
              required
            />
            <p className="text-xs text-[var(--color-text-muted)] mt-1">Agent 将根据此提示词生成内容并发送到 Webhook</p>
          </div>
          <div>
            <label className="block text-sm text-[var(--color-text)] mb-1">对话 ID（可选）</label>
            <input
              type="text"
              value={(config.conversationId as string) || ""}
              onChange={(e) => updateConfig("conversationId", e.target.value)}
              placeholder="留空则自动创建新会话"
              className="w-full px-3 py-2 border border-[var(--color-border)] rounded bg-[var(--color-surface)] text-[var(--color-text)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
            />
            <p className="text-xs text-[var(--color-text-muted)] mt-1">
              填写对话ID可在该对话的历史上下文中执行；留空则自动创建新会话，每次执行会保存完整对话记录
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-3 pl-6 pt-2 border-l-2 border-[var(--color-accent)]">
          {feishuConfig && (
            <div>
              <label className="block text-sm text-[var(--color-text)] mb-1">
                {msgType === "text" ? "消息内容 *" : "消息内容（支持 JSON 结构）*"}
              </label>
              <textarea
                value={formatFeishuContentInput(feishuContent)}
                onChange={(e) => updateConfig("feishu", { ...feishuConfig, content: e.target.value })}
                placeholder={
                  msgType === "interactive"
                    ? "{\n  \"schema\": \"2.0\",\n  \"header\": {\"title\": {\"tag\": \"plain_text\", \"content\": \"通知\"}},\n  \"body\": {\"elements\": [{\"tag\": \"markdown\", \"content\": \"内容\"}]}\n}"
                    : "定时消息内容"
                }
                className="w-full px-3 py-2 border border-[var(--color-border)] rounded bg-[var(--color-surface)] text-[var(--color-text)] text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
                rows={3}
                required
              />
              {msgType !== "text" && (
                <p className="text-xs text-[var(--color-text-muted)] mt-1">
                  可直接粘贴 JSON；如果填写纯文本，后端会自动转换为可渲染的卡片结构。
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── 对话配置 ─────────────────────────────────────────────

function ConversationConfig({ config, updateConfig }: { config: Record<string, unknown>; updateConfig: (k: string, v: unknown) => void }) {
  return (
    <div className="space-y-3 p-4 border border-[var(--color-border)] rounded-lg bg-[var(--color-bg)]">
      <div>
        <label className="block text-sm font-medium text-[var(--color-text)] mb-1">对话 ID *</label>
        <input
          type="text"
          value={(config.conversationId as string) || ""}
          onChange={(e) => updateConfig("conversationId", e.target.value)}
          placeholder="conv_xxx"
          className="w-full px-3 py-2 border border-[var(--color-border)] rounded bg-[var(--color-surface)] text-[var(--color-text)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
          required
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-[var(--color-text)] mb-1">消息内容 *</label>
        <textarea
          value={(config.message as string) || ""}
          onChange={(e) => updateConfig("message", e.target.value)}
          placeholder="定时发送的消息内容"
          className="w-full px-3 py-2 border border-[var(--color-border)] rounded bg-[var(--color-surface)] text-[var(--color-text)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
          rows={3}
          required
        />
      </div>
    </div>
  );
}
