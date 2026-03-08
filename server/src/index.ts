import express from "express";
import cors from "cors";
import multer from "multer";
import {
  getConversations,
  postConversations,
  getConversationById,
  getConversationMessages,
  getConversationAttachment,
  postConversationMessage,
  postConversationMessageSync,
  deleteConversationById,
  postChat,
  getConfig,
  putConfig,
  getModels,
  getSkillsList,
  postSkillsUpload,
  deleteSkillById,
} from "./api/routes.js";

const app = express();
const port = Number(process.env.PORT) || 3001;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.get("/conversations", getConversations);
app.post("/conversations", postConversations);
app.get("/conversations/:id", getConversationById);
app.get("/conversations/:id/messages", getConversationMessages);
app.get("/conversations/:id/attachments/:filename", getConversationAttachment);
app.post("/conversations/:id/messages", postConversationMessage);
app.delete("/conversations/:id", deleteConversationById);
app.post("/conversations/:id/messages/sync", postConversationMessageSync);
app.post("/chat", postChat);
app.get("/config", getConfig);
app.put("/config", putConfig);
app.get("/models", getModels);
app.get("/skills", getSkillsList);
app.post("/skills/upload", upload.single("zip"), postSkillsUpload);
app.delete("/skills/:name", deleteSkillById);

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
