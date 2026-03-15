import ChatInputBar, { type FileWithData } from "./ChatInputBar";
import type { ConversationMode } from "../types";

interface Props {
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  loading: boolean;
  files: FileWithData[];
  onFilesChange: (files: FileWithData[]) => void;
  models: Array<{ id: string; name: string; provider?: string; supportsImage?: boolean; contextWindow?: number }>;
  modelId: string | undefined;
  onModelChange: (modelId: string) => void;
  mode: ConversationMode;
  onModeChange: (mode: ConversationMode) => void;
}

export default function WelcomeBox({
  input,
  onInputChange,
  onSend,
  loading,
  files,
  onFilesChange,
  models,
  modelId,
  onModelChange,
  mode,
  onModeChange,
}: Props) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-6 min-h-0 overflow-auto">
      <div className="max-w-[640px] w-full flex flex-col items-center gap-6">
        <div className="text-center">
          <h1 className="m-0 mb-3 text-[28px] font-semibold text-[var(--color-accent)]">
            🚀 你好，欢迎使用！
          </h1>
          <p className="m-0 text-[15px] leading-relaxed text-[var(--color-text-muted)]">
            欢迎使用智能体对话。通过内置工具和Skills，可以帮你搜索、解析网页等，可以做任何事情。
          </p>
        </div>
        <ChatInputBar
          value={input}
          onChange={onInputChange}
          onSend={onSend}
          loading={loading}
          files={files}
          onFilesChange={onFilesChange}
          models={models}
          modelId={modelId}
          onModelChange={onModelChange}
          mode={mode}
          onModeChange={onModeChange}
          placeholder="今天我能为你做些什么？"
        />
      </div>
    </div>
  );
}
