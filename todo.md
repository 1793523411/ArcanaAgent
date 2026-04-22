产物区域，对齐普通模式其他类型预览：（已完成 PDF base64 iframe 渲染 + HTML sandbox 预览/源码双模式）

agent 产物感知：（初版已接入）执行前将 workspace 私有产物 + group-shared 按 owner 分组列入 system prompt，附"未声明直接覆盖视为错误"的硬约束；后续可在 handoff 解析阶段校验 inputsConsumed / summary 是否显式声明了覆盖。

页面 loading 巡检剩余：（已补齐 TaskBoard 指派 Agent、GroupList 添加/移除成员/设置 Lead 的 busy 反馈；DetailPanel 释放/删除、GroupAssetPanel、创建 Agent/Group 表单此前已具备 loading）

经验检索：（已优化）索引加 mtime 缓存避免重复磁盘读取/解析；token 化区分 Latin 单词与 CJK bigram；字段加权打分（title 3x / tag 2.5x / summary 1.5x / content 1x 上限），新增 token 覆盖度奖励


------

我觉得小组也可以用AI创建，并且需要的agent也一并创建，不然都不知道咋组件agent，流水线模板也支持AI创建，根据已已有的agent，当然也能创建新的的agent如果当前已有的agent不满足，甚至可以fork并修改agent