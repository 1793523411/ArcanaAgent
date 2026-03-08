# Novelty-Driven Planning Skill

基于《为什么伟大不能被计划》(Why Greatness Cannot Be Planned) 的创新规划技能。

## 概述

这个skill帮助你从僵化的目标导向规划转向探索驱动的创新方法。它应用了Kenneth O. Stanley和Joel Lehman的研究成果,帮助识别目标陷阱、生成新奇的探索方向(踏脚石)、追踪探索历程。

## 核心理念

1. **目标悖论**: 过于具体的长期目标可能阻碍真正的突破性发现
2. **踏脚石优于里程碑**: 重视有趣的中间发现,而非向目标的进展
3. **新奇性作为指南针**: 用有趣性和新奇性导航,而非目标距离
4. **非目标搜索**: 有时最好的前进方式是不瞄准目的地
5. **系统化的偶然性**: 通过探索有趣方向创造发现的条件

## 主要功能

### 1. 识别目标陷阱 🎯

分析你的计划或目标,识别可能限制探索的僵化思维:

- 过于具体的远期目标
- 假设线性路径的计划
- 没有发现空间的规划
- 忽视"偏离轨道"的有趣想法

### 2. 生成探索方向 🧭

基于当前状态,建议新奇有趣的探索方向(踏脚石):

- 关注从当前位置看什么是新奇有趣的
- 不用目标距离来证明踏脚石的价值
- 优先考虑学习和发现,而非成就
- 建议能开启新可能性的方向

### 3. 追踪探索历程 📝

记录探索旅程,识别模式和意外价值路径:

- 使用 `journey_tracker.py` 脚本维护结构化日志
- 或使用 `journey_template.md` 模板手动追踪
- 分析新奇性趋势和能力积累
- 识别偶然的连接和涌现的模式

### 4. 评估新奇性 📊

基于新奇性和有趣性评估选项,而非目标距离:

- **未探索领域** (0-10): 这个方向有多少未知?
- **惊喜潜力** (0-10): 意外发现的可能性?
- **开启新可能** (0-10): 扩展相邻可能空间?
- **内在兴趣** (0-10): 本身是否有趣?

## 使用场景

### 项目规划

```
用户: "我想规划一个新项目,目标是6个月内支持100万用户"

AI (使用此skill):
- 识别目标陷阱: 过于具体的远期目标,假设线性增长路径
- 生成探索方向: 
  1. 先构建最小可行原型,学习用户真实需求
  2. 探索有趣的边缘用例,可能揭示独特价值
  3. 实验不同的架构方法,发现意外优势
```

### 架构演进

```
用户: "我们需要重构这个系统,但不确定目标架构应该是什么"

AI (使用此skill):
- 分析当前架构
- 建议有趣的小步演进方向
- 关注每一步的学习,而非最终状态
- 让架构涌现,而非强加预设设计
```

### 技术决策

```
用户: "我们应该选择方案A还是方案B?"

AI (使用此skill):
- 用新奇性评估两个方案
- 推荐更新奇的选项
- 解释什么使它有趣
- 建议探索的小步骤
```

## 文件结构

```
novelty-driven-planning/
├── SKILL.md                              # 主skill文档
├── README.md                             # 本文件
├── scripts/
│   └── journey_tracker.py                # 探索历程追踪脚本
└── references/
    ├── theoretical_framework.md          # 理论框架深度解析
    ├── evaluation_criteria.md            # 详细评估标准和检查清单
    └── journey_template.md               # 手动追踪模板
```

## 快速开始

### 使用journey_tracker脚本

```bash
# 添加一个踏脚石发现
python scripts/journey_tracker.py add \
  --stone "实现了简单的缓存层" \
  --discovery "发现数据访问模式高度可预测" \
  --novelty 7 \
  --opens "可以探索预测性预取"

# 查看历程时间线
python scripts/journey_tracker.py view

# 分析历程模式
python scripts/journey_tracker.py analyze

# 设置历程名称
python scripts/journey_tracker.py meta --name "架构演进"

# 导出为markdown
python scripts/journey_tracker.py export journey.md
```

### 手动追踪

使用 `references/journey_template.md` 作为模板,在markdown文件中记录你的探索历程。

## 示例输出

### 目标陷阱分析

```markdown
## 🎯 Objective Trap Analysis

### Current Goal Structure
在6个月内构建支持100万用户的系统

### Potential Constraints
1. **过早优化**: 在理解真实需求前就设计大规模架构可能导致过度工程
2. **线性假设**: 假设用户增长是可预测和线性的,忽视了产品市场契合的探索需要
3. **忽视学习**: 专注于规模目标可能导致忽视用户行为的重要洞察

### Dismissed Opportunities
- 小规模快速实验来验证核心假设
- 探索意外的用户用例
- 发现独特的价值主张
```

### 探索方向建议

```markdown
## 🧭 Exploration Directions (Stepping Stones)

### Current Position
有一个基本原型,10个早期用户

### Interesting Directions to Explore

#### 1. 深度用户访谈与观察
**Why it's interesting**: 可能揭示意外的使用模式和需求
**What you might discover**: 用户真正的痛点可能与假设不同
**Next small step**: 与3个用户进行1小时深度访谈

#### 2. 构建"疯狂"的功能原型
**Why it's interesting**: 探索边缘想法可能发现独特价值
**What you might discover**: 看似不切实际的功能可能是杀手级应用
**Next small step**: 选择一个"疯狂"的想法,用1天构建原型

#### 3. 探索替代架构模式
**Why it's interesting**: 不同架构可能揭示问题的新视角
**What you might discover**: 意外的架构优势或简化
**Next small step**: 用不同范式(如事件驱动)重写一个小模块
```

## 理论基础

详见 `references/theoretical_framework.md`,包括:

- 目标悖论的深度解析
- 踏脚石 vs 里程碑
- 新奇性搜索算法
- 研究背景(Picbreeder, NEAT, 进化计算)
- 哲学基础(相邻可能、系统化偶然性)
- 实践启示

## 评估标准

详见 `references/evaluation_criteria.md`,包括:

- 新奇性评估量表(4个维度)
- 踏脚石识别检查清单
- 目标陷阱检测红旗
- 探索方向评估标准
- 历程分析模式
- 平衡探索与利用的建议

## 适用场景

✅ **适合使用此skill的场景**:
- 创新项目规划
- 架构演进和重构
- 技术决策评估
- 研究方向选择
- 个人成长规划
- 感觉被目标束缚时

❌ **不适合的场景**:
- 已知解决方案的常规任务
- 紧急bug修复
- 明确的短期目标
- 需要严格协调的项目

## 关键原则

在使用此skill时,始终强调:

1. **目标会欺骗**: 长期具体目标常常引导我们远离突破性发现
2. **踏脚石优于里程碑**: 重视有趣的中间步骤,而非向目标的进展
3. **新奇性作为指南针**: 用有趣性和新奇性导航,而非目标距离
4. **非目标搜索**: 有时最好的前进方式是不瞄准目的地
5. **系统化的偶然性**: 通过探索有趣方向创造发现的条件

## 进一步阅读

- "Why Greatness Cannot Be Planned" - Kenneth O. Stanley & Joel Lehman
- "Where Good Ideas Come From" - Steven Johnson
- "Range" - David Epstein
- "The Innovator's Dilemma" - Clayton Christensen

## 贡献

欢迎反馈和改进建议!这个skill本身就是一个探索历程的产物。

## 许可

基于《为什么伟大不能被计划》的理念创建,用于教育和创新目的。
