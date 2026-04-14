# 第 7 章：Skill 技能系统

Skill 是一种可热加载的能力模块，Agent 可以在运行时根据需要加载 Skill 来扩展自己的知识和行为。每个 Skill 是一个包含 `SKILL.md` 文件的目录。

## SKILL.md 规范

每个 Skill 目录下必须有一个 `SKILL.md` 文件，使用 YAML frontmatter + Markdown 正文：

```markdown
---
name: code-reviewer
description: 代码审查专家，提供专业的 CR 意见
version: 1.0.0
---

# Code Reviewer Skill

## 角色
你是一个资深代码审查专家...

## 审查规则
1. 检查代码风格一致性
2. 检查潜在的性能问题
3. 检查安全漏洞
...

## 输出格式
- 🔴 严重问题
- 🟡 建议改进
- 🟢 良好实践
```

### Frontmatter 字段

| 字段 | 必填 | 说明 |
|:---|:---|:---|
| `name` | ✅ | Skill 唯一标识（用于 `load_skill` 工具的 `name` 参数）|
| `description` | ✅ | Skill 描述（展示在系统提示词中，帮助模型决定何时加载）|
| `version` | 否 | 版本号 |

### Markdown 正文

正文内容会在 `load_skill` 被调用时注入到对话中，成为 Agent 的临时知识。可以包含：

- 角色定义
- 操作规范
- 输出模板
- 代码示例
- 任何你想让 Agent 在特定场景下遵循的指令

---

## 配置 Skills

### 方式一：指定目录（自动扫描）

```typescript
createAgent({
  model,
  skills: {
    dirs: ["/path/to/skills"],
  },
});
```

目录结构示例：

```
/path/to/skills/
├── code-reviewer/
│   └── SKILL.md
├── test-writer/
│   ├── SKILL.md
│   └── templates/
│       └── jest.template.ts
└── doc-generator/
    └── SKILL.md
```

SDK 会扫描 `dirs` 中每个目录的直接子目录，查找 `SKILL.md` 文件。

### 方式二：直接指定单个 Skill 目录

如果目录本身就是一个 Skill（直接包含 `SKILL.md`），SDK 也能自动识别：

```typescript
skills: {
  dirs: ["/path/to/skills/code-reviewer"],  // 直接指向 Skill 目录
}
```

---

## 运行时行为

### 系统提示词注入

配置了 Skills 后，系统提示词会自动包含 Skill 目录信息：

```
## Skills
You have access to the following skills:
- code-reviewer: 代码审查专家，提供专业的 CR 意见
- test-writer: 自动生成单元测试
- doc-generator: 生成 API 文档

Use `load_skill` tool to load a skill when needed.
```

### load_skill 工具

Agent 根据用户请求判断是否需要加载 Skill：

```
用户：帮我 review 一下这段代码
Agent：（判断需要 code-reviewer skill）
  → 调用 load_skill({ name: "code-reviewer" })
  → SKILL.md 内容注入对话
  → 按照 Skill 规范进行代码审查
```

`load_skill` 工具在配置了 `skills` 时自动加入工具集，无需手动指定。

### `<SKILL_PATH>` 占位符

SKILL.md 中可以使用 `<SKILL_PATH>` 占位符，运行时会被替换为 Skill 的实际目录路径：

```markdown
---
name: template-generator
description: 使用模板文件生成代码
---

## 使用方式
1. 读取模板文件 `<SKILL_PATH>/templates/component.tsx`
2. 根据用户需求替换变量
3. 输出生成的代码
```

这使得 Skill 可以引用自己目录中的模板、脚本等资源文件。

---

## Skill 中的脚本

Skill 目录中可以包含可执行脚本，Agent 可以通过 `run_command` 工具运行它们：

```
my-skill/
├── SKILL.md
├── scripts/
│   ├── analyze.sh
│   └── generate.py
└── templates/
    └── base.tsx
```

SKILL.md 中引导 Agent 使用脚本：

```markdown
---
name: analyzer
description: 代码分析工具
---

## 使用方式
运行分析脚本：
\`\`\`bash
bash <SKILL_PATH>/scripts/analyze.sh <目标文件>
\`\`\`
```

> **权限**：Skill 目录会自动加入 workspace 白名单（`allowedDirs`），允许 Agent 读取和执行其中的文件。

---

## Skills 与 Server 对齐

SDK 的 Skill 系统与 Server 端完全对齐，包括：

1. **SKILL.md 解析**：YAML frontmatter + Markdown 正文
2. **`<SKILL_PATH>` 替换**：运行时替换为实际路径
3. **目录扫描**：支持父目录和直接 Skill 目录
4. **系统提示词格式**：Skill 列表格式与 Server 一致
5. **load_skill 工具**：完全相同的加载逻辑

---

## 完整示例

### 创建一个 Skill

```bash
mkdir -p /my/skills/sql-expert
cat > /my/skills/sql-expert/SKILL.md << 'EOF'
---
name: sql-expert
description: SQL 优化专家，帮助分析和优化 SQL 查询
---

# SQL Expert

## 角色
你是一个 PostgreSQL 优化专家。

## 分析步骤
1. 使用 `EXPLAIN ANALYZE` 分析查询计划
2. 检查索引使用情况
3. 识别全表扫描
4. 提供优化建议

## 优化模板
```sql
-- 优化前
SELECT * FROM users WHERE email LIKE '%@gmail.com';

-- 优化后
CREATE INDEX idx_users_email ON users(email);
SELECT * FROM users WHERE email LIKE '%@gmail.com';
```

## 注意事项
- 不要删除现有索引
- 大表操作建议在低峰期执行
- 始终先在测试环境验证
EOF
```

### 使用 Skill

```typescript
const agent = createAgent({
  model,
  workspacePath: "/my/project",
  skills: {
    dirs: ["/my/skills"],
  },
});

for await (const event of agent.stream("帮我优化这个 SQL 查询: SELECT * FROM orders WHERE created_at > '2024-01-01'")) {
  if (event.type === "tool_call" && event.name === "load_skill") {
    console.log(`📚 加载技能: ${event.arguments.name}`);
  }
  if (event.type === "token") {
    process.stdout.write(event.content);
  }
}
```
