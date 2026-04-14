import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgent } from "arcana-agent-sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_WORKSPACE = path.join(PROJECT_ROOT, "example");

const modelsConfig = JSON.parse(
  fs.readFileSync(path.join(PROJECT_ROOT, "config", "models_in.json"), "utf-8"),
);
const volcProvider = modelsConfig.models.providers.volcengine;
const defaultModel = volcProvider.models[0];

const DOUBAO_MINI = {
  provider: "openai" as const,
  apiKey: volcProvider.apiKey as string,
  modelId: defaultModel.id as string,
  baseUrl: volcProvider.baseUrl as string,
};

const app = express();
app.use(express.json());

app.post("/api/chat", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const agent = createAgent({
    model: { ...DOUBAO_MINI, reasoning: true },
    workspacePath: req.body.workspacePath || DEFAULT_WORKSPACE,
    tools: {
      excludeTools: ["run_command"],
    },
  });

  try {
    for await (const event of agent.stream(req.body.message)) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    res.write("data: [DONE]\n\n");
  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: "error", content: String(err) })}\n\n`);
  }
  res.end();
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`SSE server listening on http://localhost:${PORT}`);
  console.log(`\nTest with:\n  curl -N -X POST http://localhost:${PORT}/api/chat -H "Content-Type: application/json" -d '{"message":"1+1等于几？简短回答"}'`);
});
