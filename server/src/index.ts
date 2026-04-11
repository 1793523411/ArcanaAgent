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
  postAbortConversation,
  postConversationCompress,
  deleteConversationById,
  postChat,
  getConfig,
  putConfig,
  postMcpRestart,
  getModels,
  getHealth,
  getIndexStatus,
  postIndexBuild,
  getConversationIndexStatus,
  getApprovals,
  postApprovalDecision,
  getSkillsList,
  postSkillsUpload,
  deleteSkillById,
  getTemplates,
  postTemplates,
  putTemplateById,
  deleteTemplateById,
  getAgents,
  postAgents,
  getAgentById,
  putAgentById,
  deleteAgentById,
  generateAgentFromDescription,
  getTeams,
  postTeams,
  getTeamById,
  putTeamById,
  deleteTeamById,
  postShare,
  getSharedContent,
  getModelProviders,
  postModelProvider,
  putModelProvider,
  deleteModelProvider,
  postValidateModels,
  postValidateAllModels,
  getValidationResults,
  postClaudeCodeTest,
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
import {
  getGuildInfo, putGuildInfo,
  getGroups, postGroup, getGroupById, putGroupById, deleteGroupById,
  postGroupAgent, deleteGroupAgent, getGroupStream,
  getAgents as getGuildAgents, postAgent, getAgentById as getGuildAgentById,
  putAgentById as putGuildAgentById, deleteAgentById as deleteGuildAgentById,
  getAgentMemories, getAgentStats, postAgentAsset, deleteAgentAsset,
  getGroupTaskList, postGroupTask, putTask as putGuildTask, deleteTask as deleteGuildTask,
  postAssignTask, postAutoBid, getTaskExecutionLog, deleteGroupSchedulerLog,
  postReleaseAgent,
} from "./guild/routes.js";
import { guildAutonomousScheduler } from "./guild/autonomousScheduler.js";

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
app.get("/api/index-status", getIndexStatus);
app.get("/api/conversations/:id/index-status", getConversationIndexStatus);
app.post("/api/conversations/:id/index-build", postIndexBuild);
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
app.post("/api/conversations/:id/abort", postAbortConversation);
app.post("/api/conversations/:id/compress", postConversationCompress);
app.get("/api/conversations/:id/approvals", getApprovals);
app.post("/api/conversations/:id/approvals/:requestId", postApprovalDecision);
app.delete("/api/conversations/:id", deleteConversationById);
app.post("/api/conversations/:id/messages/sync", postConversationMessageSync);
app.post("/api/chat", postChat);
app.get("/api/config", getConfig);
app.put("/api/config", putConfig);
app.post("/api/mcp/restart", postMcpRestart);
app.get("/api/models", getModels);
app.get("/api/models/providers", getModelProviders);
app.post("/api/models/providers", postModelProvider);
app.put("/api/models/providers/:name", putModelProvider);
app.delete("/api/models/providers/:name", deleteModelProvider);
app.post("/api/models/validate", postValidateModels);
app.post("/api/models/validate-all", postValidateAllModels);
app.post("/api/claude-code/test", postClaudeCodeTest);
app.get("/api/models/validations", getValidationResults);
app.get("/api/skills", getSkillsList);
app.post("/api/skills/upload", upload.single("zip"), postSkillsUpload);
app.delete("/api/skills/:name", deleteSkillById);
app.get("/api/templates", getTemplates);
app.post("/api/templates", postTemplates);
app.put("/api/templates/:id", putTemplateById);
app.delete("/api/templates/:id", deleteTemplateById);

// Agent / Team 管理 API
app.get("/api/agents", getAgents);
app.post("/api/agents", postAgents);
app.post("/api/agents/generate", generateAgentFromDescription);
app.get("/api/agents/:id", getAgentById);
app.put("/api/agents/:id", putAgentById);
app.delete("/api/agents/:id", deleteAgentById);
app.get("/api/teams", getTeams);
app.post("/api/teams", postTeams);
app.get("/api/teams/:id", getTeamById);
app.put("/api/teams/:id", putTeamById);
app.delete("/api/teams/:id", deleteTeamById);

// 分享 API
app.post("/api/conversations/:id/share", postShare);
app.get("/api/shares/:shareId", getSharedContent);

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

// Guild Mode API
app.get("/api/guild", getGuildInfo);
app.put("/api/guild", putGuildInfo);
app.get("/api/guild/groups", getGroups);
app.post("/api/guild/groups", postGroup);
app.get("/api/guild/groups/:id", getGroupById);
app.put("/api/guild/groups/:id", putGroupById);
app.delete("/api/guild/groups/:id", deleteGroupById);
app.post("/api/guild/groups/:id/agents", postGroupAgent);
app.delete("/api/guild/groups/:id/agents/:agentId", deleteGroupAgent);
app.get("/api/guild/groups/:groupId/stream", getGroupStream);
app.get("/api/guild/groups/:groupId/tasks", getGroupTaskList);
app.post("/api/guild/groups/:groupId/tasks", postGroupTask);
app.post("/api/guild/groups/:groupId/assign", postAssignTask);
app.post("/api/guild/groups/:groupId/autobid", postAutoBid);
app.get("/api/guild/groups/:groupId/tasks/:taskId/logs", getTaskExecutionLog);
app.delete("/api/guild/groups/:groupId/scheduler-log", deleteGroupSchedulerLog);
app.put("/api/guild/tasks/:id", putGuildTask);
app.delete("/api/guild/tasks/:id", deleteGuildTask);
app.get("/api/guild/agents", getGuildAgents);
app.post("/api/guild/agents", postAgent);
app.get("/api/guild/agents/:id", getGuildAgentById);
app.put("/api/guild/agents/:id", putGuildAgentById);
app.delete("/api/guild/agents/:id", deleteGuildAgentById);
app.get("/api/guild/agents/:id/memories", getAgentMemories);
app.get("/api/guild/agents/:id/stats", getAgentStats);
app.post("/api/guild/agents/:id/assets", postAgentAsset);
app.delete("/api/guild/agents/:id/assets/:assetId", deleteAgentAsset);
app.post("/api/guild/agents/:agentId/release", postReleaseAgent);

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
  serverLogger.info("Starting guild autonomous scheduler...");
  guildAutonomousScheduler.start();
});
