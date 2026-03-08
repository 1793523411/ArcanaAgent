---
name: demo
description: 用于测试 Skill 加载与调用的示例技能。当用户说「测试 skill」「跑一下 demo」或想验证 Agent Skills 是否生效时使用。
---

# Demo Skill

本技能用于验证项目中的 Skill（SKILL.md 格式）是否被正确发现与加载。

## When to Use

- 用户明确要求「测试 skill」「跑一下 demo」「试试 demo skill」
- 需要验证 Agent 是否支持 SKILL.md 规范下的技能加载

## Instructions

1. 当用户请求测试本 skill 时，回复确认已识别到 **demo** 技能。
2. 可简要说明：本技能是一个符合 SKILL.md 规范的示例，包含 name、description 与使用说明。
3. 若项目实现了从目录加载 SKILL.md，可告知用户当前 demo 技能来自 `skills/demo/`。

## Optional Script

技能目录下可包含 `scripts/`，供 Agent 按需执行。例如本示例提供 `scripts/hello.sh`，可用于验证「技能 + 脚本」的完整流程。
