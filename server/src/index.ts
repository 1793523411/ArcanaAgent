import express from "express";
import cors from "cors";
import multer from "multer";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  getConversations,
  postConversations,
  getConversationById,
  putConversationById,
  getConversationMessages,
  getConversationAttachment,
  getConversationArtifacts,
  getConversationArtifactFile,
  getConversationExport,
  postConversationMessage,
  postConversationMessageSync,
  postConversationCompress,
  deleteConversationById,
  postChat,
  getConfig,
  putConfig,
  getModels,
  getHealth,
  getApprovals,
  postApprovalDecision,
  getSkillsList,
  postSkillsUpload,
  deleteSkillById,
  getTemplates,
  postTemplates,
  putTemplateById,
  deleteTemplateById,
} from "./api/routes.js";
import { connectToMcpServers } from "./mcp/client.js";
import { loadUserConfig } from "./config/userConfig.js";
import { serverLogger, logHTTPRequest } from "./lib/logger.js";
import {
  getTasks,
  getTask,
  createTask,
  updateTask,
  removeTask,
  toggleTask,
  executeTaskNow,
  getTaskExecutions,
  getAllExecutions,
} from "./scheduler/routes.js";
import { schedulerManager } from "./scheduler/manager.js";

const app = express();
const port = Number(process.env.PORT) || 3001;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// HTTP 请求日志中间件
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    logHTTPRequest(req.method, req.path, res.statusCode, duration);
  });
  next();
});

app.get("/api/health", getHealth);
app.get("/api/conversations", getConversations);
app.post("/api/conversations", postConversations);
app.get("/api/conversations/:id/export", getConversationExport);
app.get("/api/conversations/:id", getConversationById);
app.put("/api/conversations/:id", putConversationById);
app.get("/api/conversations/:id/messages", getConversationMessages);
app.get("/api/conversations/:id/attachments/:filename", getConversationAttachment);
app.get("/api/conversations/:id/artifacts", getConversationArtifacts);
app.get("/api/conversations/:id/artifacts/*", getConversationArtifactFile);
app.post("/api/conversations/:id/messages", postConversationMessage);
app.post("/api/conversations/:id/compress", postConversationCompress);
app.get("/api/conversations/:id/approvals", getApprovals);
app.post("/api/conversations/:id/approvals/:requestId", postApprovalDecision);
app.delete("/api/conversations/:id", deleteConversationById);
app.post("/api/conversations/:id/messages/sync", postConversationMessageSync);
app.post("/api/chat", postChat);
app.get("/api/config", getConfig);
app.put("/api/config", putConfig);
app.get("/api/models", getModels);
app.get("/api/skills", getSkillsList);
app.post("/api/skills/upload", upload.single("zip"), postSkillsUpload);
app.delete("/api/skills/:name", deleteSkillById);
app.get("/api/templates", getTemplates);
app.post("/api/templates", postTemplates);
app.put("/api/templates/:id", putTemplateById);
app.delete("/api/templates/:id", deleteTemplateById);

// 定时任务 API
app.get("/api/scheduled-tasks", getTasks);
app.get("/api/scheduled-tasks/:id", getTask);
app.post("/api/scheduled-tasks", createTask);
app.put("/api/scheduled-tasks/:id", updateTask);
app.delete("/api/scheduled-tasks/:id", removeTask);
app.post("/api/scheduled-tasks/:id/toggle", toggleTask);
app.post("/api/scheduled-tasks/:id/execute", executeTaskNow);
app.get("/api/scheduled-tasks/:id/executions", getTaskExecutions);
app.get("/api/scheduled-executions", getAllExecutions);

// 提供前端静态文件（生产环境）
const publicPath = join(__dirname, "..", "public");
app.use(express.static(publicPath));

// SPA fallback - 所有未匹配的路由返回 index.html
app.get("*", (req, res) => {
  res.sendFile(join(publicPath, "index.html"));
});

app.listen(port, async () => {
  serverLogger.info(`Server running at http://localhost:${port}`);

  const config = loadUserConfig();
  if (config.mcpServers.length > 0) {
    serverLogger.info(`Connecting to ${config.mcpServers.length} MCP server(s)...`);
    await connectToMcpServers(config.mcpServers);
  }

  // 启动定时任务调度器
  serverLogger.info("Starting scheduler...");
  await schedulerManager.start();
});
