import {
  createAgent,
  createModelAdapter,
  buildToolSet,
  listBuiltinToolIds,
  DEFAULT_HARNESS_CONFIG,
  McpManager,
  type AgentEvent,
  type AgentConfig,
  type HarnessConfig,
  type HarnessEvent,
  type HarnessAgentEvent,
  type HarnessDriverAgentEvent,
  type OuterRetryConfig,
  type McpServerConfig,
} from "./dist/index.js";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __sdkDir = path.dirname(fileURLToPath(import.meta.url));
const modelsConfig = JSON.parse(
  fs.readFileSync(path.resolve(__sdkDir, "..", "config", "models_in.json"), "utf-8"),
);
const volcProvider = modelsConfig.models.providers.volcengine;
const defaultModel = volcProvider.models[0];

const DOUBAO_MINI = {
  provider: "openai" as const,
  apiKey: volcProvider.apiKey as string,
  modelId: defaultModel.id as string,
  baseUrl: volcProvider.baseUrl as string,
};

const WORKSPACE = `${process.cwd().replace(/\/sdk$/, "")}/example`;

// ============================================================
// 示例 1: 最简用法 — 一行创建 + 流式对话
// ============================================================
async function example1_basic() {
  const agent = createAgent({
    model: DOUBAO_MINI,
    workspacePath: WORKSPACE,
  });

  for await (const event of agent.stream("帮我看看当前目录有哪些文件")) {
    switch (event.type) {
      case "token":
        process.stdout.write(event.content);
        break;
      case "tool_call":
        console.log(`\n🔧 调用工具: ${event.name}`);
        break;
      case "tool_result":
        console.log(`📋 工具结果: ${event.result.slice(0, 100)}...`);
        break;
      case "stop":
        console.log(`\n✅ 完成 (${event.reason})`);
        break;
    }
  }
}

// ============================================================
// 示例 2: 同步调用
// ============================================================
async function example2_sync() {
  const agent = createAgent({
    model: DOUBAO_MINI,
    workspacePath: WORKSPACE,
  });

  const result = await agent.run("列出当前工作区里的所有文件和文件夹");
  console.log("内容:", result.content);
  console.log("工具调用次数:", result.toolCallCount);
  console.log("停止原因:", result.stopReason);
}

// ============================================================
// 示例 3: 自定义工具 + 工具裁剪
// ============================================================
async function example3_customTools() {
  const myDatabaseTool = tool(
    async (input: { query: string }) => {
      return JSON.stringify([{ id: 1, name: "test" }]);
    },
    {
      name: "query_database",
      description: "查询数据库",
      schema: z.object({
        query: z.string().describe("SQL 查询语句"),
      }),
    },
  );

  const agent = createAgent({
    model: DOUBAO_MINI,
    workspacePath: WORKSPACE,
    tools: {
      builtinTools: ["read_file", "search_code", "get_time"],
      customTools: [myDatabaseTool as any],
    },
    systemPrompt:
      "你是一个数据库专家助手，可以帮用户查询和分析数据。用query_database工具查，有啥返回啥",
  });

  for await (const event of agent.stream("帮我查一下用户表的数据")) {
    if (event.type === "token") process.stdout.write(event.content);
    if (event.type === "stop") console.log(`\n✅ ${event.reason}`);
  }
}

// ============================================================
// 示例 4: workspace 隔离 + 文件列出
// ============================================================
async function example4_workspaceIsolation() {
  const agent = createAgent({
    model: DOUBAO_MINI,
    workspacePath: WORKSPACE,
    tools: {
      excludeTools: ["run_command"],
    },
  });

  const result = await agent.run("列出工作区中所有的文件");
  console.log(result.content);
}

// ============================================================
// 示例 5: 推理模型 — 完整事件处理
// ============================================================
async function example5_reasoning() {
  const agent = createAgent({
    model: {
      ...DOUBAO_MINI,
      reasoning: true,
    },
    workspacePath: WORKSPACE,
    tools: { builtinTools: [] },
    maxRounds: 1,
  });

  let thinkingChars = 0;
  let tokenCount = 0;
  const t0 = Date.now();
  for await (const event of agent.stream(
    "1+1等于几？简短回答",
  )) {
    switch (event.type) {
      case "reasoning_token":
        thinkingChars += event.content.length;
        console.log(`[+${Date.now() - t0}ms] reasoning: ${JSON.stringify(event.content)}`);
        break;
      case "token":
        tokenCount++;
        console.log(`[+${Date.now() - t0}ms] token#${tokenCount}: ${JSON.stringify(event.content)}`);
        break;
      case "usage":
        console.log(
          `\n📊 Token 用量: prompt=${event.promptTokens}, completion=${event.completionTokens}, total=${event.totalTokens}`,
        );
        break;
      case "stop":
        console.log(
          `\n✅ 完成 (${event.reason}), 思考 ${thinkingChars} 字符, 内容 ${tokenCount} 个token`,
        );
        break;
    }
  }
}

// ============================================================
// 示例 6: AbortSignal 中断控制
// ============================================================
async function example6_abort() {
  const controller = new AbortController();

  const agent = createAgent({
    model: DOUBAO_MINI,
    workspacePath: WORKSPACE,
    abortSignal: controller.signal,
  });

  setTimeout(() => controller.abort(), 5000);

  for await (const event of agent.stream("详细列出工作区中的所有文件并描述它们")) {
    if (event.type === "token") process.stdout.write(event.content);
    if (event.type === "stop") console.log(`\n停止: ${event.reason}`);
  }
}

// ============================================================
// 示例 7: 多轮对话 — 传入历史消息
// ============================================================
async function example7_multiTurn() {
  const agent = createAgent({
    model: DOUBAO_MINI,
    workspacePath: WORKSPACE,
  });

  const round1 = await agent.run(
    "帮我创建一个 hello.txt 文件，内容是 Hello World",
  );
  console.log("第一轮:", round1.content);

  const history = round1.messages;
  history.push(new HumanMessage("现在把文件内容改成 Hello Arcana"));

  const round2 = await agent.run(history);
  console.log("第二轮:", round2.content);

  const history2 = round2.messages;
  history2.push(new HumanMessage("读取文件确认一下内容"));

  for await (const event of agent.stream(history2)) {
    if (event.type === "token") process.stdout.write(event.content);
    if (event.type === "stop") console.log(`\n第三轮完成: ${event.reason}`);
  }
}

// ============================================================
// 示例 8: 全事件类型处理 + 错误恢复
// ============================================================
async function example8_allEvents() {
  const agent = createAgent({
    model: DOUBAO_MINI,
    workspacePath: WORKSPACE,
  });

  const stats = { tokens: 0, tools: 0, errors: 0 };

  for await (const event of agent.stream("列出工作区中的所有文件，并读取其中一个")) {
    switch (event.type) {
      case "token":
        process.stdout.write(event.content);
        stats.tokens += event.content.length;
        break;
      case "reasoning_token":
        console.log("reasoning_token", event.content);
        break;
      case "tool_call":
        console.log(
          `\n🔧 [${event.name}] args=${JSON.stringify(event.arguments)}`,
        );
        stats.tools++;
        break;
      case "tool_result":
        console.log(
          `📋 [${event.name}] ${event.result.length > 200 ? event.result.slice(0, 200) + "..." : event.result}`,
        );
        break;
      case "usage":
        console.log(
          `📊 prompt=${event.promptTokens} completion=${event.completionTokens}`,
        );
        break;
      case "error":
        console.error(
          `❌ ${event.recoverable ? "可恢复" : "不可恢复"}: ${event.message}`,
        );
        stats.errors++;
        break;
      case "stop":
        console.log(
          `\n✅ ${event.reason} | chars=${stats.tokens} tools=${stats.tools} errors=${stats.errors}`,
        );
        break;
    }
  }
}

// ============================================================
// 示例 9: 独立使用 ModelAdapter（不走 Agent）
// ============================================================
async function example9_modelAdapterStandalone() {
  const adapter = createModelAdapter(DOUBAO_MINI);

  console.log("模型:", adapter.modelId);
  console.log("支持推理流:", adapter.supportsReasoningStream());

  const llm = adapter.getLLM();
  const response = await llm.invoke([
    new HumanMessage("用一句话解释什么是 TypeScript"),
  ]);
  console.log("回复:", response.content);
}

// ============================================================
// 示例 10: 独立使用 buildToolSet + listBuiltinToolIds
// ============================================================
async function example10_toolSetStandalone() {
  console.log("所有内置工具:", listBuiltinToolIds());

  const tools = buildToolSet({
    builtinTools: ["read_file", "list_files"],
    excludeTools: [],
  });
  console.log(
    "构建的工具集:",
    tools.map((t) => t.name),
  );

  const readFileTool = tools.find((t) => t.name === "read_file");
  if (readFileTool) {
    const result = await readFileTool.invoke({
      path: WORKSPACE + "/hello.txt",
    });
    console.log("read_file 结果:", String(result).slice(0, 100));
  }
}

// ============================================================
// 示例 11: temperature / maxTokens 精细控制
// ============================================================
async function example11_modelTuning() {
  const agent = createAgent({
    model: {
      ...DOUBAO_MINI,
      temperature: 0.9,
      maxTokens: 500,
    },
    workspacePath: WORKSPACE,
    maxRounds: 5,
  });

  const result = await agent.run("给我讲一个关于程序员的冷笑话");
  console.log(result.content);
  console.log("token 用量:", result.usage);
}

// ============================================================
// 示例 12: Express SSE 端点集成 (仅展示代码结构)
// ============================================================
/*
import express from "express";

const app = express();
app.use(express.json());

app.post("/api/chat", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const agent = createAgent({
    model: DOUBAO_MINI,
    workspacePath: WORKSPACE,
    tools: {
      excludeTools: ["run_command"],
    },
  });

  for await (const event of agent.stream(req.body.message)) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
});

app.listen(3000);
*/

// ============================================================
// 示例 13: Planning 模式 — 自动规划 + 进度追踪
// ============================================================
async function example13_planning() {
  const agent = createAgent({
    model: DOUBAO_MINI,
    planningEnabled: true,
    workspacePath: WORKSPACE,
  });

  for await (const event of agent.stream(
    "帮我在工作区中创建一个简单的 Node.js 项目，包含 index.js 和 package.json",
  )) {
    switch (event.type) {
      case "plan_update":
        console.log("\n📋 执行计划:");
        event.steps.forEach((step, i) => {
          const icon =
            step.status === "completed"
              ? "✅"
              : step.status === "in_progress"
                ? "🔄"
                : "⬜";
          console.log(`  ${icon} ${i + 1}. ${step.title}`);
        });
        break;
      case "token":
        process.stdout.write(event.content);
        break;
      case "tool_call":
        console.log(`\n🔧 ${event.name}`);
        break;
      case "stop":
        console.log(`\n✅ 完成 (${event.reason})`);
        break;
    }
  }
}

// ============================================================
// 示例 14: Planning + Harness（eval/loop detection/replanning）
// ============================================================
async function example14_planningWithHarness() {
  const agent = createAgent({
    model: DOUBAO_MINI,
    planningEnabled: true,
    workspacePath: WORKSPACE,
    harnessConfig: {
      ...DEFAULT_HARNESS_CONFIG,
      evalEnabled: true,
      loopDetectionEnabled: true,
      replanEnabled: true,
      maxReplanAttempts: 2,
    },
  });

  for await (const event of agent.stream(
    "帮我在工作区里创建一个 utils.js 文件，包含一个 add 和 subtract 函数",
  )) {
    switch (event.type) {
      case "plan_update":
        const progress = event.steps.filter(
          (s) => s.status === "completed",
        ).length;
        console.log(`📋 进度: ${progress}/${event.steps.length}`);
        break;
      case "token":
        process.stdout.write(event.content);
        break;
      case "stop":
        console.log(`\n✅ ${event.reason}`);
        break;
    }
  }
}

// ============================================================
// 示例 15: Background 工具 — 长时间后台任务管理
// ============================================================
async function example15_backgroundTools() {
  const agent = createAgent({
    model: DOUBAO_MINI,
    workspacePath: WORKSPACE,
    tools: {
      builtinTools: [
        "run_command",
        "read_file",
        "write_file",
        "background_run",
        "background_check",
        "background_cancel",
      ],
    },
  });

  for await (const event of agent.stream(
    "在后台运行 'echo hello > bg_test.txt' ，然后检查它的状态",
  )) {
    switch (event.type) {
      case "tool_call":
        console.log(`🔧 ${event.name}(${JSON.stringify(event.arguments)})`);
        break;
      case "tool_result":
        console.log(`📋 ${event.name}: ${event.result.slice(0, 200)}`);
        break;
      case "token":
        process.stdout.write(event.content);
        break;
      case "stop":
        console.log(`\n✅ ${event.reason}`);
        break;
    }
  }
}

// ============================================================
// 示例 16: Skill — 从目录加载 Skills
// ============================================================
async function example16_skills() {
  const agent = createAgent({
    model: DOUBAO_MINI,
    skills: {
      dirs: [WORKSPACE],
    },
    workspacePath: WORKSPACE,
  });

  for await (const event of agent.stream(
    "列出当前可用的 Skills，然后告诉我工作区有哪些文件",
  )) {
    switch (event.type) {
      case "tool_call":
        if (event.name === "load_skill") {
          console.log(`📚 加载 Skill: ${event.arguments.name}`);
        } else {
          console.log(`🔧 ${event.name}`);
        }
        break;
      case "token":
        process.stdout.write(event.content);
        break;
      case "stop":
        console.log(`\n✅ ${event.reason}`);
        break;
    }
  }
}

// ============================================================
// 示例 17: MCP — 连接 MCP 服务器扩展工具
// ============================================================
async function example17_mcp() {
  const agent = createAgent({
    model: DOUBAO_MINI,
    workspacePath: WORKSPACE,
    mcpServers: [
      {
        name: "麦当劳",
        transport: "streamablehttp",
        url: "https://mcp.mcd.cn",
        headers: {
          Authorization: "Bearer 1lSNCxsRd8NUSAgRikQR2k76UkCJGZeZ",
        },
      }
    ],
  });

  for await (const event of agent.stream("查询麦当劳的菜单，地点是上海徐汇区漕河泾印城")) {
    switch (event.type) {
      case "tool_call":
        console.log(`🔧 ${event.name}(${JSON.stringify(event.arguments)})`);
        break;
      case "token":
        process.stdout.write(event.content);
        break;
      case "stop":
        console.log(`\n✅ ${event.reason}`);
        break;
    }
  }

  await agent.destroy();
}

// ============================================================
// 示例 18: Skill + MCP + Custom Tool 全组合
// ============================================================
async function example18_fullCombination() {
  const myDbTool = tool(
    async (input: { sql: string }) => {
      return `Query result for: ${input.sql} → [mock rows]`;
    },
    {
      name: "query_db",
      description: "Execute SQL query",
      schema: z.object({ sql: z.string() }),
    },
  );

  const agent = createAgent({
    model: DOUBAO_MINI,
    tools: {
      builtinTools: ["read_file", "write_file", "run_command"],
      customTools: [myDbTool],
    },
    skills: {
      dirs: [WORKSPACE],
    },
    mcpServers: [
      {
        name: "github",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN! },
      },
    ],
    planningEnabled: true,
    workspacePath: WORKSPACE,
  });

  for await (const event of agent.stream(
    "查询数据库中最近的错误日志，然后在 GitHub 上创建一个 issue",
  )) {
    switch (event.type) {
      case "plan_update":
        console.log(
          `📋 计划: ${event.steps.map((s) => `[${s.status}] ${s.title}`).join(" → ")}`,
        );
        break;
      case "tool_call":
        console.log(`🔧 ${event.name}`);
        break;
      case "token":
        process.stdout.write(event.content);
        break;
      case "stop":
        console.log(`\n✅ ${event.reason}`);
        break;
    }
  }

  await agent.destroy();
}

// ============================================================
// 示例 19: McpManager 独立使用（不经过 Agent）
// ============================================================
async function example19_standaloneMcp() {
  const mcp = new McpManager();
  await mcp.connect([
    {
      name: "filesystem",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    },
  ]);

  const tools = mcp.getTools();
  console.log(
    "MCP 工具列表:",
    tools.map((t) => t.name),
  );

  for (const t of tools) {
    console.log(
      `  - ${t.name}: ${(t as unknown as { description: string }).description}`,
    );
  }

  await mcp.disconnectAll();
}

// ============================================================
// 示例 20: Harness 完整体验 — 事件监听 + Prompt 增强 + 外层重试
// ============================================================
async function example20_harnessFullExperience() {
  const agent = createAgent({
    model: DOUBAO_MINI,
    planningEnabled: true,
    workspacePath: WORKSPACE,
    harnessConfig: {
      ...DEFAULT_HARNESS_CONFIG,
      evalEnabled: true,
      evalSkipReadOnly: true,
      loopDetectionEnabled: true,
      replanEnabled: true,
      autoApproveReplan: true,
      maxReplanAttempts: 2,
      loopWindowSize: 6,
      loopSimilarityThreshold: 0.7,
    },
    outerRetry: {
      maxOuterRetries: 2,
      autoApproveReplan: true,
    },
  });

  const harnessLog: { kind: string; data: unknown }[] = [];
  const driverLog: { phase: string; iteration: number }[] = [];

  for await (const event of agent.stream(
    "帮我在工作区创建一个 calculator.js 文件，包含 add、subtract、multiply 三个函数，然后读取文件确认内容正确",
  )) {
    switch (event.type) {
      case "plan_update":
        console.log("\n📋 执行计划:");
        event.steps.forEach((step, i) => {
          const icon =
            step.status === "completed"
              ? "✅"
              : step.status === "in_progress"
                ? "🔄"
                : "⬜";
          console.log(`  ${icon} ${i + 1}. ${step.title}`);
        });
        break;
      case "token":
        process.stdout.write(event.content);
        break;
      case "tool_call":
        console.log(`\n🔧 调用工具: ${event.name}`);
        break;
      case "tool_result":
        console.log(`📋 工具结果: ${event.result.slice(0, 150)}...`);
        break;
      case "harness": {
        const he = event.event;
        harnessLog.push({ kind: he.kind, data: he.data });
        switch (he.kind) {
          case "eval":
            console.log(`\n🔍 [Harness Eval] verdict=${(he.data as any).verdict}, step=${(he.data as any).stepIndex}, reason=${(he.data as any).reason ?? "n/a"}`);
            break;
          case "loop_detection":
            console.log(`\n🔁 [Harness Loop] detected=${(he.data as any).detected}, desc=${(he.data as any).description ?? "n/a"}`);
            break;
          case "replan":
            console.log(`\n🔄 [Harness Replan] shouldReplan=${(he.data as any).shouldReplan}, trigger=${(he.data as any).trigger ?? "n/a"}`);
            break;
          default:
            console.log(`\n🏷️ [Harness ${he.kind}]`, JSON.stringify(he.data).slice(0, 200));
        }
        break;
      }
      case "harness_driver":
        driverLog.push({ phase: event.phase, iteration: event.iteration });
        console.log(`\n🚗 [Driver] phase=${event.phase}, iteration=${event.iteration}/${event.maxRetries}`);
        break;
      case "usage":
        console.log(`\n📊 Token: prompt=${event.promptTokens}, completion=${event.completionTokens}`);
        break;
      case "error":
        console.error(`\n❌ ${event.recoverable ? "可恢复" : "致命"}: ${event.message}`);
        break;
      case "stop":
        console.log(`\n✅ 完成 (${event.reason})`);
        break;
    }
  }

  console.log("\n\n========== Harness 统计 ==========");
  console.log(`Harness 事件总数: ${harnessLog.length}`);
  const evalEvents = harnessLog.filter((e) => e.kind === "eval");
  const loopEvents = harnessLog.filter((e) => e.kind === "loop_detection");
  const replanEvents = harnessLog.filter((e) => e.kind === "replan");
  console.log(`  Eval 事件: ${evalEvents.length}`);
  if (evalEvents.length > 0) {
    const verdicts = evalEvents.map((e) => (e.data as any).verdict);
    console.log(`    verdicts: ${verdicts.join(", ")}`);
  }
  console.log(`  Loop Detection 事件: ${loopEvents.length}`);
  console.log(`  Replan 事件: ${replanEvents.length}`);
  console.log(`Driver 事件总数: ${driverLog.length}`);
  if (driverLog.length > 0) {
    console.log(`  phases: ${driverLog.map((d) => d.phase).join(" → ")}`);
  }
}

// ============================================================
// 运行指定示例
// ============================================================
const exampleMap: Record<string, () => Promise<void>> = {
  "1": example1_basic,
  "2": example2_sync,
  "3": example3_customTools,
  "4": example4_workspaceIsolation,
  "5": example5_reasoning,
  "6": example6_abort,
  "7": example7_multiTurn,
  "8": example8_allEvents,
  "9": example9_modelAdapterStandalone,
  "10": example10_toolSetStandalone,
  "11": example11_modelTuning,
  // 12: Express SSE 集成（仅代码展示，见源码注释，不可独立运行）
  "13": example13_planning,
  "14": example14_planningWithHarness,
  "15": example15_backgroundTools,
  "16": example16_skills,
  "17": example17_mcp,
  "18": example18_fullCombination,
  "19": example19_standaloneMcp,
  "20": example20_harnessFullExperience,
};

const target = process.argv[2];
if (target && exampleMap[target]) {
  console.log(`\n========== 运行示例 ${target} ==========\n`);
  exampleMap[target]().then(() => process.exit(0));
} else {
  console.log("用法: node examples.js <编号>");
  console.log("可用示例:", Object.keys(exampleMap).join(", "));
  process.exit(0);
}
