import express from "express";
import cors from "cors";
import {
  getConversations,
  postConversations,
  getConversationById,
  getConversationMessages,
  postConversationMessage,
  postConversationMessageSync,
  deleteConversationById,
  postChat,
  getConfig,
  putConfig,
  getModels,
} from "./routes.js";

const app = express();
const port = Number(process.env.PORT) || 3001;

app.use(cors());
app.use(express.json());

app.get("/conversations", getConversations);
app.post("/conversations", postConversations);
app.get("/conversations/:id", getConversationById);
app.get("/conversations/:id/messages", getConversationMessages);
app.post("/conversations/:id/messages", postConversationMessage);
app.delete("/conversations/:id", deleteConversationById);
app.post("/conversations/:id/messages/sync", postConversationMessageSync);
app.post("/chat", postChat);
app.get("/config", getConfig);
app.put("/config", putConfig);
app.get("/models", getModels);

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
