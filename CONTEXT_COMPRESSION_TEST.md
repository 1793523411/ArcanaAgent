# 上下文压缩功能测试指南

## 功能概述

系统支持两种上下文管理策略：
1. **压缩（Compress）**：将旧消息压缩成摘要，保留最近消息原文
2. **截断（Trim）**：只保留最近 N 条消息，丢弃旧消息

## 自动压缩（发送消息时触发）

### 测试场景 1: 压缩模式 - 未超过阈值
**配置：** strategy = "compress", threshold = 75%
**状态：** 当前 token 占用 < 75%

**预期行为：**
- 策略显示：`full`（全量上下文）
- 不调用模型生成摘要
- 所有消息原样保留

**测试方法：**
1. 新建对话，发送 2-3 条消息
2. 检查上下文占用 < 75%
3. 发送新消息
4. 查看服务器日志，应该没有 `[Summarizer]` 日志

---

### 测试场景 2: 压缩模式 - 超过阈值
**配置：** strategy = "compress", threshold = 75%
**状态：** 当前 token 占用 >= 75%

**预期行为：**
- 策略显示：`compress`
- **会调用模型**生成摘要
- 旧消息被压缩成系统消息 `[此前对话摘要]`
- 保留最近 20 条（compressKeepRecent）原文

**测试方法：**
1. 发送很多长消息，使 token 占用 > 75%
2. 发送新消息
3. 查看服务器日志：
   ```
   [Summarizer] Starting to summarize X messages...
   [Summarizer] Completed in XXXms, summary length: XXX chars
   ```
4. 检查历史消息，应该有一条 `[此前对话摘要]` 系统消息

---

### 测试场景 3: 截断模式 - 超过阈值
**配置：** strategy = "trim", threshold = 75%
**状态：** 当前 token 占用 >= 75%

**预期行为：**
- 策略显示：`trim`
- **不调用模型**
- 只保留最近 N 条消息（自动计算满足阈值的最大值）

**测试方法：**
1. 切换到截断模式（设置中修改）
2. 发送很多长消息，使 token 占用 > 75%
3. 发送新消息
4. 查看服务器日志，**不应该有** `[Summarizer]` 日志
5. 检查历史消息数量，应该只剩最近几条

---

## 手动压缩（点击按钮触发）

### 测试场景 4: 手动压缩 - 压缩模式
**配置：** strategy = "compress"
**状态：** 任意（即使 token < 75% 也会执行）

**预期行为：**
- 按钮显示：✅ 显示"立即压缩"按钮
- **强制调用模型**生成摘要
- 跳过阈值检查
- 如果消息 < 5 条，返回错误"消息数量太少"

**测试方法：**
1. 确保配置是 compress 模式
2. hover 上下文占用圆圈，**应该看到"立即压缩"按钮**
3. 点击按钮
4. 查看 toast 提示：
   - "正在处理上下文，请稍候..."
   - "压缩成功！已将 X 条旧消息压缩为摘要，保留 X 条最近消息"
5. 查看服务器日志：
   ```
   Manual compression requested
   [Summarizer] Starting to summarize X messages...
   [Summarizer] Completed in XXXms
   Manual compression completed (strategy: compress, olderCount: X, recentCount: X)
   ```

---

### 测试场景 5: 手动压缩 - 截断模式
**配置：** strategy = "trim"
**状态：** 任意

**预期行为：**
- 按钮显示：❌ **不显示按钮**（因为截断不需要模型调用）
- 如果通过 API 手动触发，会执行截断（保留配置的 trimToLast 条消息）

**测试方法：**
1. 切换到截断模式
2. hover 上下文占用圆圈，**应该不显示"立即压缩"按钮**
3. 通过 API 测试（可选）：
   ```bash
   curl -X POST http://localhost:3001/api/conversations/{id}/compress
   ```
4. 查看响应：
   ```json
   {
     "success": true,
     "strategy": "trim",
     "trimToLast": 20
   }
   ```

---

### 测试场景 6: 消息太少
**配置：** 任意
**状态：** 消息数 < 5

**预期行为：**
- 返回错误："消息数量太少（至少需要5条消息），不需要压缩"
- 不调用模型

**测试方法：**
1. 新建对话，只发送 2-3 条消息
2. 点击"立即压缩"
3. 查看 toast：应显示"消息数量太少，暂无需处理"

---

## 缓存机制测试

### 测试场景 7: 压缩摘要缓存
**配置：** strategy = "compress"

**预期行为：**
- 第一次压缩：调用模型生成摘要，保存缓存
- 第二次压缩（消息数量未变）：使用缓存，**不调用模型**

**测试方法：**
1. 发送 10 条消息
2. 手动压缩，查看日志（应该有 `[Summarizer]` 调用）
3. 再次手动压缩
4. 查看日志：**不应该有** `[Summarizer]` 日志（使用了缓存）

---

## 日志检查要点

### 自动压缩日志
```
User message received
Manual compression completed (if manual)
[Summarizer] Starting to summarize X messages... (if compress)
[Summarizer] Completed in XXXms (if compress)
```

### 手动压缩日志
```
Manual compression requested (messageCount: X, strategy: compress)
[Summarizer] Starting to summarize X messages...
[Summarizer] Completed in XXXms, summary length: XXX chars
Manual compression completed (strategy: compress, olderCount: X, recentCount: X, durationMs: XXX)
```

---

## 常见问题

### Q: 为什么点击"立即压缩"很快就完成了？
A: 可能是以下原因：
1. 消息太少（< 5 条），直接返回错误
2. 使用了缓存的摘要，没有调用模型
3. 只有很少的旧消息需要压缩

### Q: 为什么看不到"立即压缩"按钮？
A: 检查：
1. 配置是否为 "compress" 模式（截断模式不显示按钮）
2. 是否点击了上下文占用圆圈（不是 hover，是点击）
3. 浏览器是否缓存了旧版本（强制刷新 Cmd+Shift+R）

### Q: 手动压缩和自动压缩有什么区别？
A:
- **自动压缩**：只在 token 超过阈值（75%）时触发
- **手动压缩**：跳过阈值检查，即使 token 很低也执行

---

## 测试清单

- [ ] 自动压缩 - 压缩模式 - 未超阈值
- [ ] 自动压缩 - 压缩模式 - 超过阈值
- [ ] 自动压缩 - 截断模式 - 超过阈值
- [ ] 手动压缩 - 压缩模式 - 成功
- [ ] 手动压缩 - 压缩模式 - 消息太少
- [ ] 手动压缩 - 截断模式 - 按钮不显示
- [ ] 缓存机制 - 第二次压缩使用缓存
- [ ] UI 反馈 - toast 提示正确
- [ ] 日志 - 服务器日志完整
