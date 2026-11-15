# 参考项目复用说明

OpenLeek 复用了以下开源项目的模块和设计思路，构建了一个全新的自主框架。

## OASIS — 社交模拟运行时

- **项目**：[camel-ai/oasis](https://github.com/camel-ai/oasis)（524+ ⭐）
- **论文**：[arXiv:2411.11581](https://arxiv.org/abs/2411.11581)
- **集成方式**：`pip install camel-oasis`，通过 `OasisAdapter` 封装为 `AbstractSocialPlatform`
- **复用内容**：
    - `OasisEnv` — 模拟环境生命周期管理（reset/step/close）
    - `SocialAgent` — LLM 驱动的社交用户 Agent（子类化为 DualAgent）
    - `AgentGraph` — 社交网络图（igraph/Neo4j 后端）
    - 推荐系统 — 4 种算法（Random/HotScore/MiniLM/TwHIN-BERT）
    - SQLite trace — 全量行为追踪
    - `ManualAction` / `LLMAction` — 动作注入和 LLM 自主决策
- **不复用**：社交平台层的具体实现（Twitter/Reddit 模拟）——仅通过适配器使用

## MiroFish — 预测流水线

- **项目**：[666ghj/MiroFish](https://github.com/666ghj/MiroFish)
- **集成方式**：提取代码 + 改编 prompt 模板
- **复用内容**：
    - `OntologyGenerator` — 从文档自动提取实体类型（仅依赖 OpenAI SDK，直接提取）
    - Profile 生成 prompt — Agent 人设生成的 prompt 模板结构（改编为金融市场参与者）
    - Config 生成 prompt — 模拟参数生成（stance → bullish/bearish 映射）
    - ReACT 报告模式 — 多轮推理 + 检索的报告生成模式（抽象检索接口替代 Zep）
- **不复用**：
    - Zep Cloud 依赖（替换为 NetworkX/Neo4j）
    - Flask + Vue 前端（替换为 FastAPI）
    - OASIS 子进程 IPC（直接 import 使用 OASIS）

## YuLan-OneSim — Agent 认知架构

- **项目**：[RUC-GSAI/YuLan-OneSim](https://github.com/RUC-GSAI/YuLan-OneSim)
- **论文**：[arXiv:2505.07581](https://arxiv.org/abs/2505.07581)
- **集成方式**：提取数据结构 + 重新实现逻辑
- **复用内容**：
    - `MemoryItem` + `ListMemoryStorage` — 短期记忆数据结构（直接使用）
    - BDI prompt 模板 — Belief-Desire-Intention 规划的 prompt 结构（重新实现）
    - TOM prompt 模板 — Theory of Mind 博弈推理（重新实现）
    - COT prompt 模板 — Chain-of-Thought 逐步推理（重新实现）
- **不复用**：
    - `ModelManager` — 耦合过深，替换为直接 OpenAI SDK 调用
    - `EventBus` + gRPC 分布式 — 耦合过深，OASIS 的异步架构已够用
    - 完整框架 — 依赖链过长（Python 3.10 限制、protobuf 等）

## dyn4mik3/OrderBook — 撮合引擎

- **项目**：[dyn4mik3/OrderBook](https://github.com/dyn4mik3/OrderBook)（408+ ⭐）
- **集成方式**：`pip install orderbook`
- **复用内容**：完整的限价订单簿撮合引擎
    - `process_order()` — 下单 + 自动撮合
    - `cancel_order()` — 撤单
    - `modify_order()` — 改单
    - 价格优先/时间优先匹配
    - 限价单 + 市价单 + 部分成交
- **自建扩展**：OHLCV 生成、持仓管理、深度快照、Agent 接口桥接

## ABIDES — 设计参考

- **项目**：[jpmorganchase/abides-jpmc-public](https://github.com/jpmorganchase/abides-jpmc-public)（157+ ⭐）
- **集成方式**：仅作架构参考，不引入代码
- **参考内容**：
    - L1/L2/L3 深度快照设计
    - Agent 类型分类（NoiseAgent, ValueAgent, MomentumAgent, MarketMaker）
    - 市场微结构指标
