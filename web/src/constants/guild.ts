import type { AssetType } from "../types/guild";

export interface AssetTypeMeta {
  label: string;
  icon: string;
  description: string;
  placeholder: string;
}

export const ASSET_TYPE_META: Record<AssetType, AssetTypeMeta> = {
  repo: {
    label: "代码库",
    icon: "📦",
    description: "代码仓库 (Git repo 或本地目录)",
    placeholder: "https://github.com/... 或 /path/to/repo",
  },
  document: {
    label: "文档",
    icon: "📄",
    description: "文档站点、文档文件、知识库",
    placeholder: "https://docs.example.com 或 /path/to/doc",
  },
  api: {
    label: "API",
    icon: "🔌",
    description: "REST / GraphQL API 端点",
    placeholder: "https://api.example.com/v1",
  },
  database: {
    label: "数据库",
    icon: "🗄️",
    description: "数据库连接字符串",
    placeholder: "postgres://host:5432/db 或 mongodb://...",
  },
  prompt: {
    label: "提示词",
    icon: "💬",
    description: "可复用的提示词模板文件",
    placeholder: "prompts/my-prompt.md",
  },
  config: {
    label: "配置",
    icon: "⚙️",
    description: "配置文件路径",
    placeholder: "~/.config/app.json",
  },
  mcp_server: {
    label: "MCP服务",
    icon: "🖥️",
    description: "Model Context Protocol 服务端点",
    placeholder: "https://mcp.example.com",
  },
  custom: {
    label: "自定义",
    icon: "📎",
    description: "其他类型资源，URI 格式自定义",
    placeholder: "任意引用路径或 URL",
  },
};

export const ASSET_TYPES: AssetType[] = [
  "repo", "document", "api", "database", "prompt", "config", "mcp_server", "custom",
];
