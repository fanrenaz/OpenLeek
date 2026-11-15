# Changelog

## [1.0.1] — 2026-06-26

### Added

- 新增 Codex Sandbox Agent 默认服务路径：持久 per-Agent thread、scoped MCP、PostgreSQL phase result 与重启恢复。
- 新增真实 `sandbox_e2e_smoke` 两轮验收入口，覆盖当时的 provider、MCP 行为、下游交易/社交副作用和服务重启恢复。
- 新增 v3 service mode Docker 边界：为 Agent、Broker、Exchange、Market Maker、Orchestrator、Runtime、Social Client、Social Platform 补齐独立镜像和 compose 配置。
- 新增 v3 gRPC transport contract：引入 `openleek_v3.proto`、gRPC client/codec/transport，并将 Exchange、Broker、Market Maker、Social Platform 等业务调用收敛到强类型服务边界。
- 新增 Runtime 主导的 run resume / fork 语义：普通 resume 以 Runtime committed round 为准，fork 可从源 run 指定已提交轮次创建 lineage run。
- 新增 Runtime stream / live view recovery 能力，用于外部服务模式下恢复运行视图、进度和 domain state hydrate。
- 新增当时的 LLMRouter service 边界：AgentService 通过 OpenAI-compatible `OPENAI_BASE_URL` 连接共享 provider router。
- 新增 LLMRouter 默认模型解析：AgentService 只发送 `openleek-default` 协议 alias，真实 provider/model 由 LLMRouter 的 `OPENLEEK_LLM_ROUTER_DEFAULT_MODEL` 解析。
- 新增 DeepSeek JSON Mode 兼容降级：LLMRouter 在 DeepSeek 路由上将 Responses strict JSON Schema 输出格式降级为 `json_object`，并把 schema 约束注入 instructions。
- 新增 20 retail + 1 media + 1 market maker news-shock 场景配置，并更新报告 slides 的当前 v3 service-boundary 验证材料。

### Changed

- 默认 Compose/Orchestrator Agent 路径由旧 Python Agent 切换到 `sandbox-agent:8109`；旧 Agent 保留在显式 `legacy-agent` profile。
- `agents.brain.framework`、媒体 brain、CLI 与 retry runner 统一支持 `codex`；Codex 主路径直接访问当时的 provider。
- 重构 OpenLeek 架构到 v3 service model：保留上游 HTTP 控制面，下游业务服务走 gRPC / Redis / PostgreSQL / OTEL 边界。
- 更新 service mode 配置模板、环境变量默认值和 external compose wiring，使运行输出、SDK session、观测追踪和服务间地址在容器化模式下显式配置。
- Docker service graph 将旧 `llm-harness` 替换为正式 `llm-router`；AgentService 使用 router client key 和 `http://llm-router:8110/v1`。
- Market Maker 行为修正：补强做市账户初始化、库存/报价策略、订单行为和市场动作处理，并扩大对应测试覆盖。
- Agent OpenAI Agents brain 和 service contract 适配 v3 envelope / capability / tool policy 边界，减少跨服务隐式耦合。
- `scripts/run_with_retry.py` 支持更完整的外部服务启动、重试、resume/fork 和状态检查流程。

### Fixed

- 修复 Sandbox MCP 向 Codex 混合暴露价格 ticks 与展示价格的问题；市场、账户和执行报告统一使用展示单位，下单工具明确区分“意图已暂存”与“已成交”。
- 修复 v3 service mode 下市场动作、Broker/Exchange adapter、Social Platform hydrate、Runtime rollback/recovery 等边界行为的回归问题。
- 修复 replay amplification closure，并收紧 pressure-test 路径，避免生产 Agent 路径重新依赖旧的 `ReplayAgentBrain`。
- 修复 Docker external service mode 对 `runs/`、观测 trace 文件和 Agent SDK session 相关路径的读写边界。

### Removed

- 移除已停止生产和转发的 `initialMemory` / `InitialLongTermMemory` 契约，以及 Round 0、Agent Service、Sandbox snapshot 和持久化层中的残留接线。
- 移除 repo-local LLM pressure-test harness 文件和 `GOAL.md` 临时计划文件；压测边界不再保留已废弃的 in-repo harness artifacts。
- 移除旧的 `src/openleek/agent/replay.py` production pressure-test 路径和对应 replay tests。
- 清理过时的分布式、评估、市场、流水线和社交模块文档，避免与 v3 service-boundary 文档冲突。

### Tests

- 新增 Sandbox readiness/setup identity、Compose framework discovery、Codex 配置约束及真实两轮恢复验收覆盖。
- 新增/扩展 v3 gRPC contract、runtime streams、runtime service、resume/fork、service mode、market maker、agent concurrency、OpenAI Agents brain、persistence adapter 和 run retry 测试覆盖。

## [1.0.0] — 2026-06-16

### Added

- 新增 local-first v1 runtime skeleton，入口位于 `src/openleek/`
- 新增 Typer CLI：`validate-config`、`run`、`inspect-run`
- 新增 Pydantic v2 配置入口，并保留 dataclass domain validation
- 新增 generated / fixture 两种 Round 0 初始化路径，fixture 会记录 digest
- 新增普通 Agent 的 LangGraph AgentBrain，Media Agent 和 MarketMaker 先使用 rule-based brain
- 新增 Runtime Audit Log：`RoundEnvelope`、`DomainRequest`、idempotency key、JSONL artifacts
- 新增 Social Platform baseline：feed ranking、visibility/access filter、exposure log、round summary
- 新增 Social sentiment v1 baseline：VADER + Loughran-McDonald financial dictionary；`keyword_minimal` 仅作为显式测试/smoke analyzer
- 新增 Exchange baseline：in-memory LOB、portfolio reservation/settlement、price-time matching
- 新增 Agent self-state context：ExchangeView 提供 PortfolioView 和 LastRoundExecutionReport
- 新增 Round 0 AgentSeedSpec / HardProfile / ExchangeEndowment / InitialLongTermMemory 投影 artifacts
- 新增 Redis live view adapter、PostgreSQL JSON repository adapter、Neo4j graph store adapter
- 新增 Rust matching adapter，支持 legacy PyO3 `openleek_matching_engine` API；配置 `rust_matching` 时不允许自动降级为 in-memory
- 新增 smoke scripts：
  - `scripts/smoke_openleek.py`
  - `scripts/smoke_external_services.py`
  - `scripts/smoke_rust_matching.py`

### Changed

- 旧实现移动到 `legacy/`，作为历史实现和迁移参考保留
- Rust matching engine crate 从 `legacy/openleek-matching-engine/` 迁移到 `crates/matching-engine/`
- README / README-ENG 顶部追加 v1 架构重构状态说明，保留原项目介绍与装饰内容
- 架构文档最终收口到 `docs/architecture/ARCHITECTURE.md`

### Verified

- `PYTHONPATH=src python -m pytest tests -q`
- `python -m ruff check src tests scripts`
- `PYTHONPATH=src python scripts/smoke_openleek.py`
- `PYTHONPATH=src python scripts/smoke_external_services.py`
- `PYTHONPATH=src python scripts/smoke_rust_matching.py`

## [0.27.5] — 2026-06-01

### Fixed

- **Social network round UX**
  - Network Graph 轮次选择器不再固定为 `0..100`，改为使用 simulation `total_rounds`
  - 对已部署后端保持兼容：当 `/api/simulations/{id}` 尚未返回 `total_rounds` 时，前端回退到 social stats 的 `rounds_processed`

### Changed

- `GET /api/simulations/{id}` 的 `SimulationStatus` 响应新增 `total_rounds`，供前端社交网络和后续回放控件使用

### Tests

- 新增 Network Graph E2E 回归测试，覆盖轮次滑杆上限跟随模拟总轮数

## [0.27.4] — 2026-06-01

### Added

- **Canonical social archive**
  - 新增 `social_posts` 归档表和 Alembic revision `007`，将 OASIS runtime 帖子同步到 OpenLeek persistence
  - Social Feed 默认 `round_num=0` 查询全部轮次；指定正整数时查询单轮帖子
  - Live simulation 页面进入时会先加载 `/rounds` 历史，再合并 WebSocket 增量，避免重进页面后图表缺少历史数据

### Fixed

- `posts_count` 现在来自 OASIS runtime post delta，不再依赖交易 Agent action 中的 `post` 类型

### Docs

- 补充 OASIS runtime SQLite 与 OpenLeek canonical social archive 的边界说明
- 补充 `social_posts` PostgreSQL 迁移和 Live 页面历史补水说明

## [0.27.3] — 2026-05-31

### Fixed

- **OASIS runtime compatibility**
  - 将 OpenLeek Python 运行范围收紧为 `>=3.11,<3.12`，与 `camel-oasis 0.2.x` 的 Python 支持范围一致
  - Docker API/dev 镜像默认安装 `social` extra，避免后端缺少 OASIS/CAMEL 依赖时前端显示 `SOCIAL_ENGINE_UNAVAILABLE`
  - CI wheel、lint、test、security 和 Docker 构建统一使用 Python 3.11 / `cp311` artifacts

### Docs

- README / README_EN / 安装指南同步说明 Python 3.11 运行时要求

## [0.27.2] — 2026-05-31

### Changed

- **OASIS 社交路径校准**
  - API/local simulation 在 `social.enabled: true` 时创建 OASIS social platform，不再静默使用 `social=None`
  - `social.enabled: false` 明确保留为 no-social 消融实验
  - 移除 scheduled-news sentiment fallback；无 social 时不伪造 `sentiment_value`
  - 每个 simulation 使用独立 OASIS SQLite database path，避免并发运行互相污染
  - 模拟状态和 WebSocket round payload 暴露 `social_enabled`, `social_platform`, `social_engine_status`
  - OASIS 初始化失败归一化为 `SOCIAL_ENGINE_UNAVAILABLE`

### Docs

- README / README_EN 同步说明 OASIS local + Redis distributed 的社交引擎边界
- `docs/getting-started/configuration.md` 补充 `social.enabled`, `social.platform`, `social.rec_system`, social 模型覆盖和 no-social 消融语义
- `docs/architecture/social-engine.md` 明确 sentiment 必须来自 OASIS 帖子/评论提取，不使用新闻 fallback

### Tests

- 新增 social factory 测试，覆盖 `oasis_twitter` / `oasis_reddit` 映射、模型覆盖、disabled ablation、unsupported platform fail-fast
- 扩展 experiment/API 测试，覆盖 social 配置解析、状态返回和 unsupported platform 422

## [0.27.1] — 2026-05-31

### Added

- **模拟错误处理全链路增强**
  - LLM 凭证预验证：模拟启动时先做轻量 `max_tokens=1` 测试调用，凭证无效立即 fail-fast（不再让 100 个 agent 逐一超时）
  - 全 agent 失败早期终止：连续 2 轮所有 agent 动作均报错时自动中止模拟，避免无效空转
  - WebSocket 初始状态推送：客户端连接时立即发送当前模拟状态（`complete` / `error` / `status+progress`），解决迟连接客户端收不到历史消息的问题
  - `POST /api/config/validate-llm` — 新增 LLM 凭证批量验证端点，并发测试所有已配置模型，返回逐模型状态
  - 前端 WebSocket hook 新增 `onStatus` 回调 + `status` 消息类型处理
  - `SimulationLive` 页面：错误红色 Banner（含错误信息 + "Back to Experiments" 按钮）+ 完成绿色 Banner
  - `ExperimentDetail` 页面：`handleLaunch` 新增 `catch` 块 + 内联错误提示
  - Settings LLM 标签页："Test All Models" 按钮 + 逐模型状态指示器（绿点/红点）
  - `validateLlmCredentials()` — 前端 API client 新增方法

### Changed

- `openleek/api/routes/simulations.py` — 新增 `_validate_llm_credentials()` 和 `_check_all_agents_failed()` 辅助函数；`_run_simulation()` 增加预验证和逐轮检测逻辑
- `openleek/api/routes/websocket.py` — `simulation_ws()` 在 `accept()` 后发送初始状态
- `openleek/api/routes/config.py` — 新增 `validate-llm` 路由
- `frontend/src/api/websocket.ts` — 扩展 `UseSimWebSocketOptions` 接口，增加 `onStatus` + `status` case
- `frontend/src/api/client.ts` — 新增 `validateLlmCredentials()` 方法
- `frontend/src/pages/SimulationLive.tsx` — 新增 `simError` / `simCompleted` 状态 + `onError` / `onComplete` 回调 + Banner UI
- `frontend/src/pages/ExperimentDetail.tsx` — 新增 `launchError` 状态 + `catch` 块 + 错误 UI
- `frontend/src/pages/Settings.tsx` — 新增 LLM 验证状态 + `handleTestLlm` + 结果面板

### Tests

- 新增 `tests/unit/test_error_handling.py`（20 个测试用例）
  - `TestCheckAllAgentsFailed`：7 cases — 全失败/部分成功/空数据/边界情况
  - `TestValidateLlmCredentials`：5 cases — 成功/缺凭证/未授权/通用错误/参数验证
  - `TestWebSocketInitialState`：4 cases — 失败/完成/运行中/未知 sim
  - `TestValidateLlmEndpoint`：3 cases — 验证成功/失败/无模型配置
  - `TestSimulationEarlyTermination`：1 case — 凭证失败端到端测试

## [0.27.0] — 2026-05-30

### Added

- **可选用户管理系统**（Feature Flag: `OPENLEEK_USER_AUTH=true`）
  - 邮箱 + 密码认证（bcrypt 哈希 + JWT HS256 签发）
  - 邀请制注册：管理员创建邀请码，用户注册时必须提供有效邀请码
  - 完全数据隔离：每个用户只能访问自己创建的 simulations 和 experiments
  - 实验分级存储：`config/experiments/` 为系统预设模板（所有用户只读可见），`data/user_experiments/{user_id}/` 为用户私有实验
  - 首次启动引导：配置 `OPENLEEK_ADMIN_EMAIL` + `OPENLEEK_ADMIN_PASSWORD` 后自动创建管理员账号
  - 前端登录 / 注册页面（`/login`, `/register`）
  - `AuthGuard` 路由守卫：auth 禁用时透明通过，启用时无 token 自动跳转登录
  - 侧边栏用户头像 + 退出按钮（仅 auth 启用时显示）
  - Admin 用户管理 API：列出用户、启用/禁用、角色切换
  - 邀请码管理 API：创建、列出、过期控制
  - i18n 全覆盖（中/英 auth 相关翻译）
  - `openleek/api/user_auth.py` — 认证核心模块
  - `openleek/api/persistence_users.py` — 用户数据存储层
  - `openleek/api/routes/auth_routes.py` — Auth API 路由
  - `frontend/src/pages/Login.tsx`, `frontend/src/pages/Register.tsx`
  - `frontend/src/stores/authStore.ts`, `frontend/src/components/AuthGuard.tsx`
  - `migrations/versions/003_user_management.py` — 数据库迁移（users, invitations 表 + simulations.user_id）
- **生产环境 PostgreSQL 支持**（`OPENLEEK_PERSISTENCE_BACKEND=postgres`）
  - 持久层动态工厂：`init_persistence()` + `get_persistence()` 替代硬编码 SQLite singleton
  - `PostgresPersistence` 补齐全部缺失方法：`get_traces_by_type()`, `get_agent_type_pnl()`, `get_agent_profiles()`, `save_agent_profiles()`
  - Startup 自动选择 backend + 可选 Alembic auto-migrate（`OPENLEEK_AUTO_MIGRATE=true`）
  - Docker Compose `postgres` service（`--profile postgres`）：PostgreSQL 16 + healthcheck + named volume
  - `docker-compose.prod.yml` 默认启用 PostgreSQL
  - `.env.example` 完善持久层环境变量模板
- **生产环境 Neo4j 知识图谱支持**（`OPENLEEK_GRAPH_BACKEND=neo4j`）
  - Graph routes 动态工厂：`init_graph()` + `get_graph()` 替代硬编码 NetworkX
  - `GraphSchema` 新增具体字段（`uri`, `username`, `password`, `database`）
  - Startup 按 `OPENLEEK_GRAPH_BACKEND` 环境变量初始化图谱 backend
  - `docker-compose.prod.yml` 添加 Neo4j 环境变量配置
  - 支持外部 Neo4j 实例（Aura 等），仅需配置 URI + auth

### Changed

- `openleek/api/persistence.py` — 硬编码 SQLite singleton 重构为动态工厂模式（`init_persistence()` / `get_persistence()` / proxy `persistence_manager`）
- `openleek/api/persistence_pg.py` — trace INSERT 补齐 `agent_type` 列
- `openleek/core/persistence.py` — `save_simulation`, `list_simulations`, `get_simulation` 接口新增 `user_id` 参数
- `openleek/api/routes/simulations.py` — 注入 `require_user` dependency，按 user_id 过滤数据
- `openleek/api/routes/experiments.py` — 系统模板只读保护 + 用户实验目录隔离
- `openleek/api/server.py` — startup 事件按 `OPENLEEK_PERSISTENCE_BACKEND` 初始化 backend + `OPENLEEK_GRAPH_BACKEND` 初始化图谱 + 注册 auth 路由
- `openleek/core/config_schema.py` — `PersistenceSchema` 新增 `dsn`, `pool_min`, `pool_max`, `auto_migrate` 字段；`GraphSchema` 新增 `uri`, `username`, `password`, `database` 字段；新增 `AuthSchema`
- `openleek/api/routes/graph.py` — 硬编码 NetworkX 替换为动态工厂（`init_graph()` / `get_graph()`）
- `config/default.yaml` — persistence 段补充 PostgreSQL 注释 + graph 段补充 Neo4j 注释 + 新增 `auth:` 配置节
- `docker-compose.yml` — 新增 `postgres` service（profile: postgres）
- `docker-compose.prod.yml` — 添加 PostgreSQL + Neo4j + auth 环境变量配置
- `frontend/src/App.tsx` — 路由结构调整（公开路由 + AuthGuard 保护路由）
- `frontend/src/components/Layout.tsx` — 侧边栏底部用户信息区域
- `frontend/src/api/client.ts` — Axios interceptor 自动附加 Bearer token + 401 重定向

### Dependencies

- 新增 optional group `auth`: `pyjwt>=2.8`, `bcrypt>=4.0`, `email-validator>=2.0`
- `postgres` extra 新增 `psycopg2-binary>=2.9`（Alembic 迁移所需同步驱动）

### Fixed

- 生产部署启动顺序：`docker-compose.prod.yml` 新增 `depends_on`（postgres + neo4j healthcheck 就绪后才启动 openleek）
- CI deploy 补齐 `--profile postgres --profile graph`，确保生产环境自动拉起数据库服务
- Alembic 迁移运行时机修正为 `init_persistence()` 之前，避免 schema 验证失败
- 前端 Settings 页后端选项（persistence/graph）可被环境变量锁定，防止生产环境误切换
- 生产环境默认启用用户认证（`OPENLEEK_USER_AUTH=true`），CI deploy 自动注入 auth secrets

### 向后兼容

- 默认 `persistence.backend: "sqlite"`，不安装 postgres 依赖也不影响现有功能
- `persistence_manager` 仍可用（代理到工厂实例），现有路由代码无需改动
- 默认 `auth.enabled: false`，不安装 auth 依赖也不影响现有功能
- 现有 API Key 机制（`X-API-Key` header）保留不变
- 旧数据（`user_id = NULL`）在禁用模式下正常可见
- 所有 API 端点在 auth 禁用时行为与之前版本完全一致

## [0.26.0] — 2026-05-29

### Added

- **K 线行情页面**（`/market`）
  - ECharts 双轴图：蜡烛图（70%）+ 成交量柱状图（20%）+ DataZoom 滑动条
  - WebSocket 实时推送：运行中的模拟自动接收每轮 OHLCV 数据
  - 涨跌颜色模式切换：中国模式（红涨绿跌）/ 国际模式（绿涨红跌），localStorage 持久化
  - 十字准星 tooltip + 最新价格/总涨跌统计面板
  - 模拟选择器：支持已完成（REST API）和运行中（WebSocket）两种数据源
  - `frontend/src/pages/Market.tsx`

- **Caddy 反向代理容器**（`--profile proxy`）
  - 自动 HTTPS：Let's Encrypt 证书签发 + 自动续期
  - 开发/生产双 Caddyfile：`config/caddy/Caddyfile`（代理 Vite dev server）、`config/caddy/Caddyfile.prod`（静态文件 + SPA fallback）
  - 通过 `CADDYFILE` 环境变量切换配置文件
  - API/WebSocket 透明代理至 openleek:8000
  - gzip + zstd 压缩

- **CI/CD 自动部署**
  - GitHub Actions `deploy` job（SSH password auth via `appleboy/ssh-action`）
  - 部署流程：git pull → .env 写入 → GHCR image pull → 前端文件提取 → docker compose up
  - 从 GHCR 镜像中提取 `frontend/dist` 至宿主机（Caddy bind-mount 使用）
  - 仅 `push` to `main` 时触发

- **`docker-compose.prod.yml` 生产覆盖文件**
  - 使用 GHCR 预构建镜像替代本地 build
  - 禁用 frontend dev server（Caddy 直接服务静态文件）

- **i18n 扩展**
  - 中英文新增 `nav.market`（行情/Market）和 `market.*` 约 12 个翻译 key

### Changed

- 导航栏新增"行情"入口（📈 图标）
- Docker 部署新增 `proxy` profile，Caddy 端口 80/443

## [0.25.0] — 2026-05-28

### Added

- **Agent Types 管理系统**
  - 后端 CRUD API：`GET/POST/PUT/DELETE /api/agent-types/`
  - 10 种内置代理类型（retail_investor、value_investor、momentum_trader、contrarian、financial_analyst、financial_media、noise_trader、market_maker、institutional_investor、regulator）
  - 自定义代理类型持久化至 `config/agent_types.json`
  - 内置类型禁止修改/删除，自定义类型支持完整 CRUD
  - `openleek/api/routes/agent_types.py`：Pydantic 校验、名称正则、重名检测

- **前端 AgentTypes 页面**（`/agent-types`）
  - 卡片布局展示所有代理类型，角色描述完整显示
  - 属性说明面板：解释交易风格、风险偏好、影响力、敏感度如何影响 Agent 行为
  - 可展开详情：影响力/敏感度可视化进度条
  - 自定义类型 CRUD 表单（含字段提示、slider 控件）
  - 导航栏新增"代理类型"（⬢ 图标）

- **实验页面动态代理类型**
  - `ExperimentCreate.tsx` 和 `ExperimentDetail.tsx` 改为从 `/api/agent-types` 动态获取类型列表
  - 保留 fallback 静态列表兜底

- **设置页 Tooltip 术语说明系统**
  - 新增通用 `Tooltip` 组件（`@floating-ui/react`），hover ⓘ 图标弹出气泡解释
  - 策略 Tab：注意力门控、行为偏好、规划策略、记忆策略及所有条件参数均配有 tooltip
  - 社交引擎 Tab：Feed 算法、信息不对称度、图拓扑、平台类型等均配有 tooltip
  - Select 选项动态说明：选中某选项后下方自动显示该选项的详细解释
  - 中英文各新增 `settings.tip.*` 约 35 条术语解释

- **实验描述双语支持**
  - 实验 YAML 配置新增 `description_zh` 字段
  - 后端 API 返回双语描述
  - 前端根据当前语言环境自动选择显示对应语言描述
  - 监听 `languageChanged` 事件确保切换语言后立即更新

- **i18n 扩展**
  - 中英文新增 `agentTypes.*` 约 40 个翻译 key（含 factorDesc、formHint、styles、risk 子节点）
  - 新增 `settings.opt*` 约 20 个选项翻译 key（策略 + 社交引擎全部 Select 选项）

### Changed

- **"代理"页面重命名为"行为回放"**
  - 导航栏：代理 → 行为回放（en: Agents → Behavior Replay）
  - 页面标题和副标题同步更新
  - 明确区分：行为回放 = 模拟运行后的数据回放；代理类型 = 运行前的类型定义

- **设置页 Select 选项完全 i18n 化**
  - 策略 Tab 和社交引擎 Tab 所有 `<option>` 标签从硬编码英文改为 `t()` 调用
  - 切换语言时选项文本同步变化

- **`common.*` i18n 扩展**
  - 新增 `saving`、`edit`、`delete`、`confirm` 通用翻译 key

### Dependencies

- 新增 `@floating-ui/react`：轻量级 tooltip 定位库

## [0.24.2] — 2026-05-26

### Changed

- **前端视觉重设计 — 与 Website 品牌风格统一**
  - 从暗色科幻风格（cyan/#06d6a0 + 深色表面）迁移为现代简约浅色风格（violet/#8b5cf6 + 白色背景）
  - `tailwind.config.ts`：brand 紫色色阶（50-900）、白色 surface 色阶、柔和阴影系统（soft/card/elevated/glow）
  - `src/index.css`：全部组件类重写为浅色主题（白卡片 + border-gray-200 + shadow、渐变紫色按钮、pill badge）
  - `Layout.tsx`：毛玻璃侧边栏（`bg-white/80 backdrop-blur-lg`）、🧅 logo + 渐变品牌文字、紫色激活态导航
  - 14 个页面全部迁移：文字（gray-900/700）、背景（white/gray-50）、强调色（brand-600）、badge（pill 形状）
  - ECharts 图表全部切换为浅色主题（白色 tooltip、#e5e7eb 轴线、#f3f4f6 分割线）
  - 完全移除暗色模式（删除 `darkMode: 'class'`、dark toggle、`.light` CSS overrides）

### Added

- **Framer Motion 入场动画**
  - `src/components/FadeIn.tsx`：从 Website 移植的 whileInView 动画（支持方向/延迟/视口触发）
  - 所有页面 header 区域包裹 FadeIn，带交错延迟效果
- **ECharts 浅色主题工具**
  - `src/utils/chartTheme.ts`：统一的图表颜色调色板、轴线样式、tooltip 样式
  - `src/utils/chartConfigs.ts`：更新为浅色主题配置

### Removed

- 暗色模式切换功能（`localStorage openleek-theme`、`toggleTheme()`、`.light` CSS class）
- 所有 neon glow 效果（`shadow-glow` cyan、`card-glow`、`bg-surface-*` 深色系列）
- ECharts `theme="dark"` prop

### Dependencies

- 新增 `framer-motion` 用于页面入场动画

## [0.24.1] — 2026-05-26

### Added

- **前端 E2E 测试（Playwright）**
  - `frontend/playwright.config.ts`：双 webServer 配置（后端 DryRun + 前端 Vite），Chromium only
  - `frontend/e2e/dashboard.spec.ts`：Dashboard 页面加载 + 系统状态 + API 验证（3 tests）
  - `frontend/e2e/experiments.spec.ts`：实验列表渲染 + 卡片详情 + 导航 + API 验证（5 tests）
  - `frontend/e2e/simulation.spec.ts`：模拟创建 + WebSocket 通信 + 列表 + 轮次 API（3 tests）
  - `Makefile` 新增 `test-e2e-frontend` target

### Fixed

- **前端 API 尾部斜杠 404 问题** — `frontend/src/api/client.ts` 中 `getExperiments`、`listSimulations`、`startSimulation`、`getConfig`、`updateConfig` 请求路径缺少尾部斜杠，导致 FastAPI 路由不匹配返回 404

### Tests

- 新增 11 个前端 E2E 测试（全部通过，dry-run 模式，约 11s）
- 运行方式：`make test-e2e-frontend` 或 `cd frontend && npx playwright test`

## [0.24.0] — 2026-05-25

### Added

- **LLM Dry-Run 模式** — 无需 API 调用的 E2E 测试
  - `DryRunLLMClient`：生成随机但格式合法的 JSON 响应（交易 + 社交），无需预录 trace
  - `create_llm_client()` 工厂函数：根据环境自动选择真实/dry-run 客户端
  - 配置激活：`llm.dry_run: true` 或环境变量 `OPENLEEK_DRY_RUN=1`
  - 响应策略：buy 30% / sell 30% / hold 40%，quantity 1-10，自动检测 prompt 类型（交易 vs 社交）
  - 支持可选 seed 参数实现确定性测试
  - 与 local / cluster / distributed 三种运行模式兼容
  - 新增 22 个单元测试 + 4 个集成测试

### Changed

- `openleek/api/routes/simulations.py`：使用 `create_llm_client()` 工厂替代硬编码 `LLMClient()`
- `openleek/core/__init__.py`：导出 `DryRunLLMClient` 和 `create_llm_client`
- `openleek/core/config_schema.py`：`LLMSchema` 新增 `dry_run: bool` 字段
- `config/default.yaml`：新增 `dry_run: false` 配置项

### Tests

- 新增 `tests/unit/test_dry_run.py`（22 tests）
- 新增 `tests/integration/test_dry_run_e2e.py`（4 tests）
- 总计：530 passed

## [0.23.2] — 2026-05-25

### Added

- **CI/CD 完善**
  - `.github/workflows/ci.yml` 新增 Rust clippy/audit、Frontend typecheck/lint/build、Security audit jobs
  - `.pre-commit-config.yaml` (NEW): ruff + mypy + cargo fmt/clippy + eslint + prettier
  - `Makefile` 新增 `test-watch`, `docker-build-prod`, `docker-build-full` targets

- **OpenTelemetry 分布式追踪**
  - `openleek/observability.py` 新增 `setup_tracing()`, `get_tracer()`, `setup_fastapi_tracing()`
  - `config/tempo.yaml` (NEW): Grafana Tempo 配置
  - `docker-compose.yml` 新增 Tempo 服务 (monitoring profile)

- **数据库 Schema 规范化**
  - `migrations/versions/002_normalize_schema.py` (NEW): 新增 `trades`, `portfolios`, `agents` 三表 + 索引
  - 保持 `data_json` 向后兼容

- **Rust 引擎: `clear_trades()` + `trades_len()`** — 暴露给 Python 的交易历史清理接口，解决长时间运行内存泄漏

- **API Rate Limiting** — Token bucket per IP（可配置 `OPENLEEK_RATE_LIMIT_RPS` / `OPENLEEK_RATE_LIMIT_BURST`）

- **统一错误响应** — 全局 exception handler 返回 `{code, message, details}` 格式

- **Property-Based 测试**
  - `tests/unit/test_property_invariants.py` (NEW): Hypothesis 市场不变量测试
  - `tests/integration/test_distributed_resilience.py` (NEW): 分布式容错测试骨架

- **前端工具库**
  - `frontend/src/hooks/useAsyncData.ts` (NEW): 通用异步数据获取 Hook（loading/error/refetch/cancellation）
  - `frontend/src/utils/chartConfigs.ts` (NEW): 浅色主题 ECharts 配置生成器

### Changed

- **Rust 引擎性能** (`engine.rs`):
  - 热路径函数添加 `#[inline]` (submit_order, match_limit, match_market, add_to_book, create_trade)
  - `add_to_book()` 后添加 `debug_assert!` 验证 BTreeSet/HashMap 一致性
  - Input validation: NaN/Infinite/负数/零数量防护、self-trade prevention 改用 continue
  - 浮点比较改为整数化 (`price * 1_000_000 as i64`)

- **PyO3 绑定** (`engine-py/lib.rs`): `unwrap()` 替换为 `?` 错误传播

- **API server** (`openleek/api/server.py`):
  - 启动时初始化 OpenTelemetry tracing
  - Rate limiting middleware + global exception handler
  - WebSocket 连接管理改用 `set` 替代 `list` (O(1) 移除)

- **Agent 去重** (`openleek/agent/dual_agent.py`):
  - 提取 `_build_memory_text()` 和 `_build_profile_text()`
  - `decide()` 和 `build_prompt()` 不再重复 20+ 行代码

- **Gate/Modifier 工厂** (`openleek/distributed/factories.py` NEW):
  - `create_gate_from_config()` / `create_modifier_from_config()`
  - `shard.py` 和 `worker.py` 改为调用工厂函数

- **Pipeline 重构** (`openleek/pipeline/simulator.py`):
  - `_run_round()` 拆分为 `_gate_and_decide()` + `_execute_actions()`
  - 主方法从 190 行缩减至 ~50 行

- **SQLite 事务** (`openleek/api/persistence.py`): `save_simulation()` 添加显式 BEGIN/COMMIT/ROLLBACK

- **Dockerfile**: Rust 阶段用 venv 安装 maturin，移除 `--break-system-packages`

- **docker-compose.yml**:
  - 主服务添加 `restart: unless-stopped`
  - 前端 node_modules 改用命名卷缓存
  - 添加 `OTEL_EXPORTER_OTLP_ENDPOINT` 环境变量

- **异常处理规范化**:
  - 所有 bare `except:` → 具体异常类型 (ValueError, TimeoutError, ConnectionError)
  - TypeScript `as any` → 正确类型定义
  - Config 层添加 Pydantic schema 验证

- **pyproject.toml**:
  - `[observability]`: 新增 opentelemetry-sdk, exporter-otlp, instrumentation-fastapi
  - `[dev]`: 新增 hypothesis, pytest-watch

## [0.23.1] — 2026-05-23

### Added

- **多模型原生协议支持 (litellm Router)** — 统一接入所有主流 LLM 提供商
  - 替换 OpenAI SDK 为 litellm Router，所有 provider 走原生协议（非 OpenAI 兼容模式）
  - 支持 DashScope（通义千问）、Anthropic（Claude）、Google（Gemini）、OpenAI、DeepSeek 等
  - 每个模型可独立配置 `api_base`（中转站/代理），满足不同网络环境需求
  - 新增 `LLMClient.with_model()` 轻量视图，共享 Router 连接池，零额外资源开销
  - `AgentProfile` 新增 `model` 字段，支持 per-agent 模型路由
  - `generate_profiles()` 新增 `model_mapping` 参数，按角色分配模型
  - 配置格式升级为 `llm.models` 列表（别名机制解耦具体模型版本）
  - VLLMBatchClient 高吞吐路径保持不变（httpx 直连）
  - 向后兼容：`LLMClient(model="dashscope/qwen-plus")` 单模型用法仍有效

- **前端多模型配置 UI** — Settings 页面适配新 LLM 架构
  - Settings LLM 标签页：单 model/base_url 输入替换为动态模型列表编辑器
  - 每个模型条目支持配置：别名 (alias)、提供商/模型 (provider/model)、中转站 URL (api_base)
  - 新增「默认模型」选择字段
  - ExperimentDetail 页面显示 `llm_default_model`
  - 后端 `/api/config` 新增 `llm_default_model` 和 `llm_models` 字段
  - 中英文 i18n 完整覆盖

### Changed

- `pyproject.toml`: `openai>=1.0` → `litellm>=1.40`
- `config/default.yaml` 及所有实验配置：`llm:` 段迁移为 `models` 列表格式
- `.env.example`: 新增 `DASHSCOPE_API_KEY`、`ANTHROPIC_API_KEY`、`GEMINI_API_KEY`
- `openleek/core/llm_pool.py`: `CompletionRequest` 新增可选 `model` 字段
- `openleek/distributed/services.py`: `LLMPoolActor` 支持新 `models` 列表配置
- `openleek/distributed/worker.py`: 创建 agent 时按 profile.model 分配 LLM 视图
- `openleek/api/routes/config.py`: `_runtime_config` 和 `ConfigUpdate` 增加 `llm_default_model`、`llm_models` 字段
- `frontend/src/pages/Settings.tsx`: LLM 配置 UI 重构为多模型列表编辑器
- `frontend/src/types/index.ts`: 新增 `LLMModelEntry` 接口
- `frontend/src/i18n/{en,zh-CN}.json`: 新增多模型相关标签

## [0.23.0] — 2026-05-22

### Added

- **Barrier Pub/Sub 模式** — 事件驱动的轮次同步（替代 50ms 轮询）
  - `RoundCoordinator` 支持 `barrier_mode: "pubsub"` / `"poll"` 双模式
  - Pub/Sub 模式：Worker 完成后发布到 `ol:coord:barrier_done` channel，Coordinator 立即唤醒
  - 延迟从 25ms 平均降至 <1ms，兼容 1s 超时兜底轮询
  - 配置项: `distributed.barrier_mode`

- **Streaming RPC** — gRPC 流式接口减少连接开销
  - `GenerateFeedsStream` (server-side streaming): 按 agent 逐块返回 FeedChunk
  - `ExecuteActionsStream` (client-side streaming): 客户端流式发送 SocialActionBatch
  - `EvolveGraph` (unary): 触发一轮图演化
  - Proto 新增 3 个 RPC + 3 个消息类型 (FeedChunk, SocialActionBatch, EvolveGraphRequest)
  - `GrpcSocialClient` 对应新增 3 个方法

- **Redis Cluster 支持** — 水平扩展社交状态存储
  - `redis_factory.py` (NEW): `create_redis_client()` 工厂，支持单节点/集群模式
  - `RedisCluster.from_url()` + `read_from_replicas` 读写分离
  - `RedisPostStore` / `RedisGraphStore` 支持注入共享 client
  - Timeline 分片: `ol:timeline:{shard_idx}` (配置 `redis_timeline_shards`)

- **Feed Push 模式** — KOL 优化的 fan-out 策略
  - `RedisPostStore._fan_out_to_inboxes()`: 发帖时主动推送到粉丝 inbox
  - KOL 阈值优化 (`fan_out_threshold`): 粉丝 > N 的大 V 不 fan-out，读取时 lazy pull
  - `FeedGenerator._generate_push_mode()`: 读 inbox + 合并 KOL 帖子 + info-tier 过滤 + 排序
  - 因果隔离保证: `visible_round = current_round + 1`（当轮发帖下轮可见）
  - 配置项: `social.distributed.feed_mode: "push"` / `"pull"` (默认 pull)

- **Graph Evolution 动态图演化引擎** — 社交网络随仿真自然演化
  - `graph_evolution.py` (NEW): `GraphEvolutionEngine` + `GraphEvolutionConfig`
  - 三种演化机制:
    - **Triadic Closure**: 朋友的朋友推荐（采样 10% agent，top-k 共同好友）
    - **Weak Tie Decay**: 长期无互动关系衰减（N 轮不活跃 → 概率取关）
    - **Viral Boost**: 高互动用户自动涨粉（log(engagement) > threshold → 新增 followers）
  - 运行时机: FEEDBACK 阶段之后，每 `evolution_interval` 轮执行
  - 静态模式保留: `graph_evolution.mode: "static"` 跳过所有演化（默认）
  - 互动记录: `record_interaction()` 在 like/repost/comment 时自动累加

- **Social API 路由** — 前端访问社交数据的 REST 接口
  - `openleek/api/routes/social.py` (NEW): 6 个端点
    - `GET /simulations/{sim_id}/social/posts` — 按轮次获取帖子
    - `GET /simulations/{sim_id}/social/feed/{agent_id}` — Agent 个人 feed
    - `GET /simulations/{sim_id}/social/graph` — 社交图谱快照（节点+边）
    - `GET /simulations/{sim_id}/social/sentiment/{round_num}` — 情绪详情
    - `GET /simulations/{sim_id}/social/graph-events` — 图演化事件流
    - `GET /simulations/{sim_id}/social/stats` — 平台统计概览
  - 已注册到 FastAPI app (`/api` prefix, `social` tag)

- **前端社交可视化**
  - `frontend/src/types/social.ts` (NEW): TypeScript 类型定义
  - `frontend/src/stores/socialStore.ts` (NEW): Zustand 社交状态管理
  - `frontend/src/api/client.ts`: 新增 6 个社交 API 调用函数
  - `frontend/src/pages/SocialFeed.tsx` (NEW): 帖子时间线（按轮浏览 + 互动计数）
  - `frontend/src/pages/NetworkGraph.tsx` (NEW): Canvas 力导向图（stance 着色 + 事件流）
  - `SimulationLive.tsx`: 新增 "Social Feed" / "Network" 导航按钮
  - `App.tsx`: 新增 `/simulations/:simId/social` 和 `/simulations/:simId/network` 路由

### Changed

- `openleek/social/distributed_store.py`: Timeline 分片、inbox fan-out、KOL 优化
- `openleek/social/graph_store.py`: 支持注入共享 Redis client
- `openleek/social/feed.py`: 新增 `feed_mode` 参数，push/pull 双模式分发
- `openleek/social/clients.py`: `GrpcSocialClient` 新增 streaming + evolution 方法
- `openleek/distributed/coordination.py`: Barrier pub/sub 模式 + 向后兼容 poll
- `openleek/distributed/coordinator.py`: `barrier_mode` 参数 + 图演化调度
- `openleek/distributed/grpc_social_service.py`: 3 个新 RPC handler + evolution 集成
- `openleek/protos/social.proto`: 3 个新 RPC + 新消息类型
- `config/default.yaml`: 新增 barrier_mode、redis_cluster、feed_mode、graph_evolution 完整配置段
- `openleek/api/server.py`: 版本号 → `0.23.0`

### Design Principles

- **核心价值不妥协**: 每个 Agent 每轮真实 LLM 推理，所有优化在传输/存储层面，不减少 LLM 调用
- **因果隔离**: Push 模式下 `visible_round = current_round + 1`，当轮帖子不影响当轮决策
- **向后兼容**: `barrier_mode: "poll"` / `feed_mode: "pull"` / `graph_evolution.mode: "static"` 完全保留旧行为

---

## [0.22.0] — 2026-05-22

### BREAKING CHANGE

- **删除 Python MatchingEngine 回退** — Rust 撮合引擎现在是唯一后端，不再有 `sortedcontainers` 纯 Python 实现
- `create_engine()` 不再接受 `backend` 参数，始终返回 `RustMatchingEngine`
- `openleek-matching-engine` 从可选依赖提升为必需依赖
- 移除 `RUST_AVAILABLE` 标志和相关条件逻辑

### Added

- **Cargo Workspace 重构** — `openleek-matching-engine/` 拆分为三个 crate：
  - `engine/`：核心撮合逻辑库（BTreeSet LOB，5 个 Rust 单元测试）
  - `engine-py/`：PyO3 cdylib 包装（Python `_engine` 模块）
  - `exchange-service/`：独立 gRPC 二进制（tonic + clap CLI）

- **Rust gRPC Exchange Service** — `openleek-exchange` 二进制
  - 4 个 RPC：`GetMarketContext`, `ExecuteActions`, `AdvanceRound`, `GetState`
  - 内置 PortfolioManager + DataFeed + VirtualMarket
  - SIGTERM 优雅关闭，tracing 结构化日志

- **Dockerfile Rust 构建阶段** — `rust-builder` stage 生成 PyO3 wheel + exchange 二进制
- **Makefile Rust 目标** — `rust-build`, `rust-dev`, `rust-test`, `rust-exchange`

### Changed

- `openleek/market/engine.py`：仅保留 `MatchingEngineProtocol` + `create_engine()`
- `openleek/market/rust_engine.py`：移除 `try/except ImportError` 守卫，直接导入
- `openleek/market/adapters/virtual.py`：使用 `create_engine()`，本地跟踪 orders 字典
- `openleek/market/multi_asset.py`：使用 `MatchingEngineProtocol` 类型标注
- `docker-compose.yml`：`exchange-service` 使用 Rust 原生二进制
- `pyproject.toml`：`openleek-matching-engine>=0.1.0` 移入核心依赖，移除 `sortedcontainers`/`limit-order-book`
- `config/default.yaml`：`matching_engine: "rust"`（无回退）

### Removed

- `MatchingEngine` 类（~400 行 Python）
- `_BookEntry` dataclass
- `RUST_AVAILABLE` 变量
- `backend` 参数（`create_engine`）
- `sortedcontainers` / `limit-order-book` 依赖
- `openleek-matching-engine/src/` 旧目录（已由 workspace 取代）

---

## [0.21.2] — 2026-05-22

### Added

- **Prometheus 指标集成** — 全链路可观测性（`openleek/observability.py`）
  - LLM 层：请求延迟直方图、请求计数器（model/status）、端点健康 gauge、故障计数器
  - API 层：HTTP 请求延迟直方图、WebSocket 连接 gauge、`/metrics` 端点
  - 分布式层：模拟轮次延迟直方图（按阶段）、Worker agent 数量 gauge
  - 撮合引擎：订单计数器（side/type）、成交计数器、当前价格 gauge
  - Correlation ID 通过 `X-Request-ID` header 注入，`contextvars` 传播

- **结构化日志** — 设置 `OPENLEEK_LOG_FORMAT=json` 启用 JSON 日志输出
  - 自动注入 correlation_id、sim_id、round_num、worker_id 字段
  - 兼容传统文本格式（默认）

- **Docker 监控 Profile** — `docker compose --profile monitoring up`
  - Prometheus (v2.51) + Grafana (v10.4) 一键启动
  - 预配置 `config/prometheus.yml` 抓取 API 和 Coordinator 端点

- **优雅降级** — 未安装 `prometheus-client` 时所有指标自动退化为 no-op，零性能开销

### Changed

- `pyproject.toml`：新增 `[observability]` extras（`prometheus-client>=0.20`, `python-json-logger>=2.0`），移除未使用的 `loguru` 依赖
- `docker-compose.yml`：新增 `prometheus_data` / `grafana_data` volumes

---

## [0.21.1] — 2026-05-22

### Fixed

- **API 认证安全修复** — `auth.py` 中 `secrets.compare_digest` 自比较 bug，现已正确对所有配置 key 进行 constant-time 比较
- **移除硬编码数据库凭据** — `persistence_pg.py` 默认 DSN 不再包含用户名/密码，改为从 `OPENLEEK_PG_DSN` 环境变量读取
- **LLM API key 启动校验** — 未配置 `OPENAI_API_KEY` 时立即抛出 `ValueError`，不再使用 `sk-placeholder` 静默继续
- **分布式服务优雅关机** — coordinator、worker、gRPC Exchange/Social 四个服务全部注册 SIGTERM/SIGINT 信号处理，收到信号后完成当前操作再退出，不再数据丢失
- **Ray Actor 创建失败回退** — `DistributedSimulator.setup()` 失败时自动清理已创建的 actor（`ray.kill`），抛出 `RuntimeError` 附带上下文信息
- **单 Agent 错误隔离** — `_run_round()` 中 observe/decide 阶段使用 `return_exceptions=True`，单个 Agent LLM 调用失败不再导致整轮崩溃，自动降级为 hold
- **LLM 重试错误分类** — 区分可重试错误（连接超时/5xx/限流）与不可重试错误（认证/请求格式），后者立即失败不再浪费重试预算

### Added

- `.env.example` — 环境变量配置模板，覆盖 LLM/API/数据库/Redis/Neo4j/分布式 所有配置项
- `.gitignore` — 新增 `.env` 排除规则，防止凭据泄露

### Changed

- 更新配置文档中的环境变量表，新增 `OPENLEEK_PG_DSN`、`OPENLEEK_LOG_LEVEL`，移除过时默认值

---

## [0.21.0] — 2026-05-21

### Added

- **Dual Attention Gate 可插拔注意力门控框架** — 控制 Agent 每轮社交/交易激活
  - `openleek/core/attention_gate.py` (NEW): `AttentionGate` ABC + `GateDecision` 数据类
  - 4 种门控策略 (`openleek/agent/scheduling/`):
    - `always_active`: 每轮全参与（默认，100% 向后兼容）
    - `threshold`: 基于 activity_level / sensitivity / risk 阈值规则触发
    - `event_driven`: 仅新闻/提及/价格震荡事件后激活
    - `adaptive`: 波动率体制自适应（平静→低活跃，危机→全员激活）
  - 工厂函数 `create_gate(name, **params)` + `GATE_REGISTRY` 注册表

- **Behavior Modifier 可插拔行为偏好注入** — Prompt 后缀影响交易/社交风格
  - `openleek/core/behavior.py` (NEW): `BehaviorModifier` ABC
  - 4 种行为修正器 (`openleek/agent/behavior/`):
    - `neutral`: 无偏好（默认）
    - `momentum`: 追涨杀跌提示词注入
    - `contrarian`: 逆向操作提示词注入
    - `adaptive`: 波动率响应式（平时中性、恐慌时情绪化）
  - 工厂函数 `create_modifier(name, **params)` + `MODIFIER_REGISTRY` 注册表

- **三模式策略一致集成** — local / cluster / distributed 均支持门控
  - `openleek/pipeline/simulator.py`: `_run_round()` 集成 gate 评估，gated-out Agent 记录 hold/lurk + reason
  - `openleek/distributed/shard.py`: `decide()` 和 `social_decide()` 支持 gate 评估；新增 `notify_event()` / `advance_gate_round()`
  - `openleek/distributed/simulator.py`: 新闻注入时广播 `notify_event("news")` 到所有 shard；每轮末 `advance_gate_round()`
  - `openleek/distributed/worker.py`: `_handle_trading_phase()` 和 `_handle_social_phase()` 支持 gate 评估
  - 设计: Gate 实例在每个 Shard/Worker 内部独立创建，纯规则计算，零跨节点通信

- **前端 Settings "策略" Tab** — 可视化配置所有策略维度
  - Attention Gate 下拉选择（4 种 + adaptive/threshold 专属参数滑块）
  - Behavior Modifier 下拉选择（4 种）
  - Planning Strategy 下拉选择（COT / BDI / TOM）
  - Memory Strategy 下拉选择（tiered / sliding_window / none）
  - 中英文 i18n 完整覆盖（30+ 新翻译 key）

- **消融实验配置** — `config/experiments/ablation_attention_gate.yaml`
  - 500 Agent × 48 轮，adaptive gate vs always_active 对照
  - 评估指标: price_volatility, sentiment_causality, herding_index, social_participation_rate, attention_burst_index

- **Stylized Facts 验证模块** — Cont (2001) 金融市场经验规律自动检验
  - `stylized_facts_report()`: 验证模拟市场是否复现 6 项核心 stylized facts
  - SF1: 肥尾（超额峰度 > 0）
  - SF2: 波动率聚集（|r_t| 自相关显著，Ljung-Box 检验）
  - SF3: 收益率无自相关（弱式有效市场特征）
  - SF4: 成交量-波动率正相关
  - SF5: 收益率非正态（Jarque-Bera 检验）
  - SF6: 杠杆效应（下跌→后续高波动）
  - `StylizedFactResult` / `StylizedFactsReport` 数据类
  - `_autocorrelation()` / `_ljung_box()` 内部辅助函数
  - 集成到 `compute_all_metrics()` 作为 summary pass rate
  - 公共 API 导出: `from openleek.evaluation import stylized_facts_report`
  - 8 个单元测试覆盖每项 fact + 边界条件

### Changed

- `config/default.yaml`: 新增 `agents.strategies` 段（attention_gate / behavior_modifier / planning / memory 四维度）
- `DistributedSimulator.__init__()`: 新增 `gate_config` / `modifier_config` 参数
- `AgentShard.__init__()`: 新增 `gate_config` / `modifier_config` 参数
- `AgentShard.decide()`: 签名扩展为 `decide(market_context_data, social_context)` 以支持 gate 评估
- `AgentShard.social_decide()`: 签名扩展支持 `market_context_data` / `social_context`
- `DistributedWorker.__init__()`: 新增 `gate_config` / `modifier_config` 参数
- `RoundResult`: 新增 `lurk_count` / `gate_hold_count` 字段

### Design Decisions

| 决策 | 理由 |
|------|------|
| `always_active` 为默认 | 现有实验零影响，新框架不改变原有行为 |
| Gate 纯规则计算 | 零额外 LLM 开销，百万 Agent 无性能瓶颈 |
| market_maker / financial_media 始终激活 | 维持流动性和信息流 |
| hold = 数据点 | 不产生时间序列空洞，Granger 因果检验完整 |
| lurk = 显式记录 | 可追踪原因，支持消融对照 |
| Modifier 用 prompt suffix | 保留 LLM 自主性，不直接强制输出 |
| 各 Shard/Worker 独立创建 Gate | 无分布式状态同步，策略行为三模式一致 |
| 波动率集中注意力作为涌现信号 | 可观测 participation_rate 突增作为恐慌/贪婪指标 |

### Tests

- 新增 29 个测试 (`tests/unit/test_attention_gate.py` + `tests/unit/test_behavior_modifier.py`)
  - AlwaysActiveGate: always active ✓
  - ThresholdGate: 概率激活、事件 boost、price move 触发、market_maker 强制激活 ✓
  - EventDrivenGate: 事件后激活、过期衰减、全局计数 ✓
  - AdaptiveGate: 平静/正常/危机三体制 ✓
  - Factory: 已知策略创建、未知策略报错 ✓
  - BehaviorModifier 4 种策略: 中性/动量/逆向/自适应输出 ✓
- 总计: 484 passed

---

## [0.20.0] — 2026-05-21

### Added

- **前端现代化** — 对齐后端 v0.19.0 分布式架构
  - **Cluster 监控页** (`pages/Cluster.tsx`): Ray 连接状态、Worker/Shard 统计、vLLM 端点健康表（URL/延迟/成功率/排队/Circuit Breaker）、扩缩容事件流，5 秒自动刷新
  - **Checkpoint 管理页** (`pages/Checkpoints.tsx`): 按模拟浏览检查点列表（round/shards/agents/price/timestamp）、手动创建、一键恢复、批量清理（保留最新 N 个）
  - **Settings 页重写**: 6 个 Tab（Runtime Mode / LLM + vLLM Endpoints / Distributed 分片参数 / Persistence 后端 / Social Engine / Graph Backend），从 4 个字段扩展到 25+ 配置项
  - **ExperimentDetail 启动扩展**: 可编辑 seed + runtime mode + matching engine + persistence + agents_per_shard + streaming execute + 预估分片数显示
  - **后端 `/api/cluster/*` 路由** (`routes/cluster.py`): status、shards、vllm/endpoints、scale-events 四端点
  - **后端 `/api/config` 扩展**: 新增 20+ 配置字段（runtime_mode、persistence、distributed、scale、social 等）
  - **前端 types 扩展**: 新增 `ClusterStatus`, `ShardInfo`, `EndpointHealth`, `ScaleEvent`, `CheckpointMeta`, `AgentProfileFull`, `AgentAnovaResult` 等 11 个接口
  - **API client 扩展**: 新增 `getClusterStatus`, `getClusterShards`, `getVllmEndpoints`, `getScaleEvents`, `listCheckpoints`, `createCheckpoint`, `restoreCheckpoint`, `cleanupCheckpoints`, `getSimulationAgentAnova` 等 9 个函数
  - **i18n 双语同步**: cluster/checkpoints/settings 新增 ~60 个翻译 key（en + zh-CN）
  - **导航更新**: 新增 Cluster（⊞）和 Checkpoints（⟲）导航项

- **P2 前端功能完善** — Agent Profile / ANOVA / Dashboard 集群
  - **Dashboard 集群状态**: 新增 Runtime Mode + Workers 统计卡片（6 卡片网格布局）
  - **Agents 页完整 Profile**: 表格扩展为 9 列（Type/Style/Risk/Stance/Influence/MBTI/Trades），含彩色 Badge 组件（StyleBadge/RiskBadge/StanceBadge）
  - **AgentDetail Profile 卡片**: 12 字段展示（Name/Type/Style/Risk/Stance/MBTI/Age/Profession/Info Tier/Influence/Activity/Sensitivity）+ bio 引用块
  - **Report ANOVA 区域**: F-statistic/p-value/η² 统计卡 + 分组平均 PnL 柱状图 + Post-hoc Bonferroni 两两比较表
  - **Simulations 页增强**: 显示 experiment_name + 已完成模拟增加 Report 快捷链接
  - **后端 `GET /api/simulations/{id}/agents/profiles`**: 返回完整 AgentProfileFull 列表
  - **Persistence 扩展**: `save_agent_profiles()` / `get_agent_profiles()` — 新增 `agent_profiles` 表
  - **模拟完成时自动持久化 profiles**: `_run_simulation()` 结尾保存 profile dicts
  - **API client**: 新增 `getSimulationAgentProfiles()` 函数
  - **i18n**: 新增 `agents.*`（8 key）和 `report.*`（7 key）双语翻译

- **P3 前端完善** — 多资产 UI / WebSocket 扩展消息 / Rust 引擎指标
  - **SimulationLive 多资产支持**: 当轮次数据含多 ticker 时显示资产选择 Tab
  - **SimulationLive 分片进度**: 分布式模式下实时显示各 Shard 轮次进度条
  - **SimulationLive 事件通知**: checkpoint 保存、扩缩容事件实时通知面板
  - **WebSocket hook 扩展**: 支持 `shard_progress` / `scale_event` / `checkpoint` / `sentiment` 四种新消息类型
  - **Cluster 页 Matching Engine 状态**: 显示引擎后端类型、Rust 可用性、性能倍率、版本号、features 标签
  - **后端 `GET /api/cluster/engine`**: 返回撮合引擎状态（Rust/Python + 版本 + 功能列表）
  - **后端 WebSocket 扩展**: 新增 `broadcast_shard_progress` / `broadcast_scale_event` / `broadcast_checkpoint` / `broadcast_sentiment` 四个广播函数
  - **前端 Types**: 新增 `AssetConfig`, `AssetPrice`, `EngineStatus`, `WsShardProgress`, `WsScaleEvent`, `WsCheckpoint`, `WsSentiment` 7 个接口
  - **API client**: 新增 `getEngineStatus()` 函数
  - **i18n**: 新增 `cluster.matchingEngine` key（en + zh-CN）

### Changed

- **版本号对齐**: Layout.tsx `v0.9.0` → `v0.19.0`，server.py `0.17.0` → `0.19.0`
- **SimulationRequest 类型**: 新增 `runtime_mode`, `agents_per_shard`, `num_shards`, `matching_engine`, `streaming_execute`, `persistence_backend` 可选字段
- **docs/architecture/frontend.md**: 更新目录结构、路由表，反映 Cluster/Checkpoints/Profile/ANOVA 功能

---

- **分布式社交引擎** — 完全恢复 cluster/distributed 模式下的社交仿真能力
  - `openleek/social/models.py` (NEW): `Post`, `PostType`, `SocialActionType`, `SocialAction`, `AgentFeedSpec`, `SocialStepResult` 数据模型
  - `openleek/social/distributed_store.py` (NEW): `RedisPostStore` — Redis Hash/SortedSet/Set 实现帖子 CRUD + 时间线 + 搜索
  - `openleek/social/graph_store.py` (NEW): `RedisGraphStore` — Redis Set 实现关注图 + 三种网络拓扑种子生成（Barabási–Albert / Erdős–Rényi / Watts–Strogatz）
  - `openleek/social/feed.py` (NEW): `FeedGenerator` — 批量个性化 feed 生成 + 信息不对称过滤（info-tier）
  - `openleek/social/engine.py` (NEW): `SocialEngine` Protocol (`@runtime_checkable`)
- **SocialActor** — Ray @remote 社交引擎 Actor (`openleek/distributed/social_actor.py`)
  - 组合 RedisPostStore + RedisGraphStore + FeedGenerator + DistributedSentimentAggregator
  - 无 LLM 访问（社交 LLM 推理在 Agent Shards 中执行——方案 B）
  - `setup()`: 初始化 Redis 连接 + 种子关注图
  - `inject_news()`, `generate_feeds_for_shard()`, `execute_actions()`, `get_sentiment()`, `get_stats()`
- **独立社交 LLM Step** — 每 Agent 每轮独立社交决策（行为与 OASIS 本地模式保持一致）
  - `openleek/agent/social_prompts.py` (NEW): OASIS prompt 模板复制（Twitter/Reddit）+ JSON 输出解析
  - `DualAgent.social_decide(feed, platform)`: 独立社交 LLM 调用 → `SocialAction`
  - `DualAgent.build_social_prompt()` / `apply_social_response()`: 批量推理接口
  - `AgentShard.social_decide(feeds, platform)`: Shard 级批量社交决策 → `ShardSocialResult`
- **DistributedSentimentAggregator** — 基于关键词的分布式情绪聚合 (`openleek/social/sentiment.py`)
  - 中英文看涨/看跌关键词（frozenset，支持 vLLM 前缀缓存）
  - `aggregate(since_round, max_posts) → SentimentSignal`
- **编排集成** — 社交阶段完整集成到 `DistributedSimulator`
  - `_run_social_phase()`: 社交阶段编排（feed 生成 → shard social_decide → action 执行）
  - `_build_social_context()`: 异步方法，从 SocialActor 获取实时情绪
  - Social phase 在 `_run_round()` 和 `_run_round_streaming()` 中均完整集成
  - SocialActor 生命周期管理（setup/shutdown）
  - `social_config` 构造参数 + `social_enabled` 门控
- **三模式架构设计** — RFC 文档 (`docs/architecture/distributed-social-engine.md`)
  - local (OASIS+SQLite) → cluster (Ray+Redis) → distributed (gRPC)
  - 7 项设计决策 + 理由（独立 LLM step、方案 B、prompt 复制等）
  - 完整实现计划 + Phase 状态追踪

### Changed

- **pyproject.toml** — 版本升至 0.20.0
- **openleek/__init__.py** — `__version__` = "0.20.0"
- **openleek/distributed/simulator.py** — 新增 `social_config` 参数 + `_social_actor` + 社交阶段
- **openleek/distributed/shard.py** — 新增 `ShardSocialResult` + `social_decide()` 方法
- **openleek/agent/dual_agent.py** — 新增 `social_decide()`, `build_social_prompt()`, `apply_social_response()`; `decide()` 仅产出交易动作（移除 "post"）
- **openleek/agent/prompt_templates.py** — COT/BDI/TOM 模板移除 `{"type":"post"}` 输出模式
- **config/default.yaml** — 三模式运行时 + `social.distributed` 配置段
- **docs/architecture/ARCHITECTURE.md** — 当前 v3 服务边界架构入口
- **docs/modules/social.md** — 完整重写，覆盖双后端架构
- **docs/getting-started/configuration.md** — 新增三模式说明 + 社交引擎配置段

### New — SocialClient 统一接口

- **`openleek/social/clients.py`** (NEW): `SocialClient` Protocol (`@runtime_checkable`)
  - `RaySocialClient`: 包装 Ray SocialActor handle（cluster 模式）
  - `LocalSocialClient`: 本地模式 stub（OASIS 直接管理社交）
  - `GrpcSocialClient`: gRPC channel 包装（distributed 模式）
  - `create_social_client(mode)`: 工厂函数，按模式创建对应客户端

### New — gRPC 服务 (Phase 3.3)

- **`openleek/protos/common.proto`** (NEW): 共享消息定义 (Post, SocialAction, TradeAction, MarketContext, SentimentSignal 等)
- **`openleek/protos/social.proto`** (NEW): SocialService — 6 RPCs (Setup, InjectNews, GenerateFeeds, ExecuteActions, GetSentiment, GetStats)
- **`openleek/protos/exchange.proto`** (NEW): ExchangeService — 4 RPCs (GetMarketContext, ExecuteActions, AdvanceRound, GetState)
- **`openleek/distributed/grpc_social_service.py`** (NEW): SocialServiceServicer — 组合 RedisPostStore+GraphStore+Feed+Sentiment，端口 50052
- **`openleek/distributed/grpc_exchange_service.py`** (NEW): ExchangeServiceServicer — 包装 VirtualMarket，端口 50051
- **`openleek/market/grpc_client.py`** (NEW): `GrpcExchangeClient` — gRPC 撮合引擎客户端
- **`openleek/social/clients.py`** (MODIFY): 新增 `GrpcSocialClient` 类实现 SocialClient Protocol

### New — 分布式 Worker (Phase 6.4)

- **`openleek/distributed/coordination.py`** (NEW): `Phase` 枚举 + `PhaseSignal` + `RoundCoordinator`（发布信号+等待屏障）+ `WorkerBarrier`（监听信号+报告完成）
- **`openleek/distributed/worker.py`** (NEW): `DistributedWorker` — 独立进程管理 Agent，连接 gRPC 服务，Redis pub/sub 驱动轮次循环
  - 入口: `python -m openleek.distributed.worker --config <yaml> --worker-id <N>`
- **`openleek/distributed/coordinator.py`** (NEW): `DistributedCoordinator` — 通过 gRPC 客户端 + Redis 协调驱动模拟轮次
  - 入口: `python -m openleek.distributed.coordinator --config <yaml>`
- **docker-compose.yml** (MODIFY): 新增 `distributed` profile (redis, social-service, exchange-service, coordinator, worker)
- **Makefile** (MODIFY): 新增 `proto` target（protobuf 代码生成）
- **pyproject.toml** (MODIFY): 新增 `grpc` optional extra (`grpcio>=1.60`, `grpcio-tools>=1.60`, `protobuf>=4.25`)

### Tests

- 新增 34 个测试 (`tests/unit/test_social_distributed.py`)
  - 数据模型 (Post, SocialAction, AgentFeedSpec): 7 tests
  - SocialClient (工厂 + LocalClient): 7 tests
  - Social Prompts (模板 + 解析): 7 tests
  - Trading Decide 无 Post: 2 tests
  - Protocol 符合性: 2 tests
  - Prompt Templates 无 Post: 6 tests
- 更新现有测试适配 post 移除
- 新增 37 个测试 (`tests/unit/test_grpc_services.py`): proto 序列化、gRPC servicer、GrpcSocialClient/GrpcExchangeClient、工厂函数
- 新增 24 个测试 (`tests/unit/test_distributed_worker.py`): PhaseSignal、RoundCoordinator、WorkerBarrier、DistributedWorker、DistributedCoordinator
- 总计: 440 passed, 18 skipped

## [0.19.0] — 2026-05-21

### Added

- **ScaleTier 分级策略** — 百万级 Agent 扩容预设 (`openleek/distributed/scaling.py`)
  - `ScaleTier` 枚举: small / medium / large / mega，每级预设合理的 `max_replicas` 和步长
  - `ScalePolicy.from_tier("mega")`: 工厂方法快速创建适合目标规模的策略
  - `ScalePolicy.max_replicas` 默认值从 32 提升至 512
  - `ScalePolicy.max_concurrent_per_node`: 新增字段，用于计算 `max_concurrent_total`
  - `ScalePolicy.max_concurrent_total` 属性: `max_replicas × max_concurrent_per_node`
- **LLMPoolGroup** — 分片 LLM 池 (`openleek/distributed/services.py`)
  - 将单一 `LLMPoolActor` 拆分为 N 个独立 actor（modulo 路由）
  - 消除单 actor 消息队列瓶颈，支持 2000+ shards 并发
  - `get_pool_for_shard(shard_id)`: 按 shard 自动路由到对应 pool
  - `get_aggregate_stats()`: 跨 pool 聚合统计
- **MatchingEngineProtocol** — 撮合引擎抽象接口 (`openleek/market/engine.py`)
  - `@runtime_checkable` Protocol: `submit_order`, `cancel_order`, `get_depth`, `advance_round` 等
  - `create_engine(backend="auto"|"python"|"rust")` 工厂函数
  - `backend="auto"`: Rust 可用时使用，否则自动回退 Python（带日志提示）
- **Rust 撮合引擎** — PyO3 原生扩展 (`openleek-matching-engine/`)
  - 完整实现: 价格-时间优先连续双向拍卖、自成交防护、费率、TTL 过期
  - `BTreeSet` 订单簿: O(log n) 插入/删除，~100x Python 吞吐
  - Rust 单元测试: 基础撮合、自成交防护、价格时间优先、TTL 过期、费率计算
  - 安装: `cd openleek-matching-engine && maturin develop --release`
- **RustMatchingEngine** — Python 包装层 (`openleek/market/rust_engine.py`)
  - 透明适配 Rust 引擎返回值为 `Order` / `Trade` / `MarketDepth` 类型
  - 缺失原生扩展时抛出 `ImportError` 并提示安装方式
- **MarketActor.submit_shard_actions()** — 流式执行入口 (`openleek/distributed/services.py`)
  - 按 shard 实时撮合 + 即时返回局部 feedback（不等全局完成）
  - 与 `execute_actions()` 并存，小规模仍可用批量模式
- **Streaming Execute** — 流式执行模式 (`openleek/distributed/simulator.py`)
  - `_run_round_streaming()`: `ray.wait()` + as-completed 模式
  - Shard 完成 decide 即提交订单 → 撮合 → feedback → update_memories
  - 订单到达顺序 = shard 完成时间 → 比 batch 更贴近真实市场异步到达
- **Object Store 零拷贝广播** — `ray.put()` 优化 (`openleek/distributed/simulator.py`)
  - 观测上下文放入 Object Store，shards 通过引用获取（避免逐 shard pickle）
  - 2000 shards 广播: pickle 序列化开销从 O(N) 降至 O(1)
  - `use_object_store=True` 默认启用
- **SuperShard** — 分层扇出 (`openleek/distributed/supershard.py`)
  - 新 Ray Actor: 管理 50-100 个子 AgentShard
  - Driver → 20 SuperShards → 2000 AgentShards（两级扇出）
  - 减少 driver event loop 连接数 100x
  - `observe()` / `decide()` / `update_memories()` 批量转发
- **VLLMBatchClient.update_endpoints()** — 动态端点发现 (`openleek/core/llm_pool.py`)
  - 运行时热添加/删除 vLLM 端点（VLLMScaler 回调）
  - 保留已有端点健康状态，新端点标记为 healthy
  - 自动清理移除端点的 semaphore
- **distributed 配置段** — 全特性开关 (`config/default.yaml`)
  - `matching_engine`: "python" | "rust" | "auto"
  - `streaming_execute`: true/false
  - `use_object_store`: true/false
  - `supershard_enabled`: true/false + `supershard_size`
  - `llm_pool_shards`: LLM 池 actor 数量
  - `scale_policy.tier`: ScaleTier 预设

### Changed

- **pyproject.toml** — 版本升至 0.19.0; 新增 `[mega]` 可选依赖组; `[all]` 包含 ray+vllm
- **openleek/__init__.py** — `__version__` = 0.19.0
- **openleek/distributed/__init__.py** — 新增导出: `SuperShard`, `LLMPoolGroup`, `ScaleTier`
- **openleek/market/__init__.py** — 新增导出: `MatchingEngineProtocol`, `create_engine`
- **openleek/market/engine.py** — 新增 `logging` import, `Protocol` + `runtime_checkable`
- **DistributedSimulator** — 新增构造参数: `streaming_execute`, `llm_pool_shards`, `use_object_store`

### Tests

- 新增 19 个测试 (`tests/unit/test_scaling_infra.py`)
  - ScaleTier (7): 枚举值、tier默认值、from_tier、overrides、max_concurrent_total
  - MatchingEngineProtocol (7): 实现检查、factory各backend、protocol方法完整性
  - LLMPoolGroup (2): 路由逻辑、最小值保护
  - StreamingExecuteConfig (2): 构造参数传递、默认值
  - EnginePerformance (1): 1K orders < 5s 基准
- 总计: 376 passed, 18 skipped

## [0.18.0] — 2026-05-21

### Added

- **aiosqlite 异步持久化** — 全面替换 sqlite3，所有 DB 操作非阻塞
  - `SQLitePersistence` 使用 `aiosqlite.connect()` + `async with conn.execute()`
  - 自动 schema 迁移：`agent_type` 列 + 索引（兼容旧库）
  - 新增 `get_agent_type_pnl(sim_id)`: 按 agent_type 聚合 PnL（ANOVA 数据源）
  - 新增 `get_traces_by_type(sim_id, agent_type)`: 按类型筛选 traces
- **ANOVA Agent 类型对比** — 跨类型统计检验
  - `agent_type_anova(type_pnl)`: One-way ANOVA + Levene 齐性检验 + Welch 回退
  - `ANOVAResult`: F-stat, p-value, η², 各组均值/std, Bonferroni post-hoc 两两比较
  - 当方差不齐时自动切换 Welch's ANOVA（Satterthwaite 自由度）
- **策略对比 & 模型选择** — 非参数检验 + 信息准则
  - `strategy_comparison(strategy_metrics)`: Kruskal-Wallis H 检验 + ε² effect size
  - `model_selection_test(model_metrics, n_params)`: AIC/BIC 排名 + Akaike 权重 + 证据比
- **异步实验加载** — 非阻塞 YAML 读取
  - `load_experiment_async(path)`: `asyncio.to_thread` 包装
  - `load_all_experiments_async(config_dir)`: `asyncio.gather` 并行加载
  - API experiments 路由已切换至异步版本
- **Metrics 缓存** — 已完成模拟结果永久缓存
  - `GET /{sim_id}/report`: LRU 缓存（最多 100 条，completed 后不可变）
  - 第二次请求直接命中缓存，避免重复 Granger/bootstrap 计算
- **Agent 类型报告 API** — 新端点
  - `GET /api/simulations/{sim_id}/report/agents`: 返回 ANOVA 结果 JSON
- **TradeTrace.agent_type** — Trace 数据增强
  - `TradeTrace` 新增 `agent_type: str` 字段
  - Simulator `_run_round()` 自动从 agent profile 写入 agent_type
  - `agent_actions` dict 每条 action 附加 `agent_type` 字段

### Changed

- **pyproject.toml** — 版本升至 0.18.0; `[api]` deps 新增 `aiosqlite>=0.20`
- **persistence.py** — 从 `sqlite3` 同步连接迁移至 `aiosqlite` 异步连接
- **experiments.py routes** — `load_all_experiments` → `load_all_experiments_async`

### Tests

- 新增 13 个测试 (test_persistence +3, test_metrics +10: ANOVA, strategy, model selection)
- 总计: 357 passed, 18 skipped

## [0.17.0] — 2026-05-21

### Added

- **Statistical Rigor** — Effect sizes, power analysis, Fisher z CI
  - `MetricResult` 新增字段: `effect_size`, `std_error`, `test_statistic`, `df`, `power`
  - `sentiment_price_correlation()`: Fisher z-transform CI + `effect_size=|r|`
  - `granger_causality()`: `partial_eta_sq` = (RSS_r - RSS_u) / RSS_r
  - `emergence_detection()`: Cohen's h (arcsine transform) effect size
  - `power_analysis()`: Post-hoc power (1-β) 正态近似
  - `compute_all_metrics()`: 自动为每个 metric 附加 power 值
- **Reproducibility** — 全局 seed 管理 + 确定性保证
  - `openleek/core/seed.py`: `set_global_seed()` + `derive_seed()` 工具函数
  - `sentiment_price_correlation()` / `emergence_detection()`: 新增 `seed` 参数（替代硬编码 42）
  - `ReplayLLMClient`: 新增 `validate_prompts` 模式（prompt hash 校验）
  - `tests/integration/test_reproducibility_full.py`: 端到端确定性回归测试
- **CI/CD** — GitHub Actions 自动化
  - `.github/workflows/ci.yml`: lint (ruff) + type check (mypy) + unit tests (Python 3.11/3.12) + coverage
  - `.github/workflows/integration.yml`: integration tests with Redis service
  - `Makefile`: 新增 `ci` target 本地复合命令
- **API Security** — 认证 + 输入验证 + CORS 加固
  - `openleek/api/auth.py`: API Key 认证 (X-API-Key header)
    - `OPENLEEK_API_KEYS` env: 逗号分隔合法 key
    - `OPENLEEK_AUTH_REQUIRED` env: 生产模式强制认证
  - `PUT /api/config/`: 需认证 (`Depends(require_auth)`)
  - `SimulationRequest`: `agent_count≤100K`, `rounds≤1000`, `experiment_name` regex 校验
  - WebSocket `/ws/simulations/{id}?token=xxx`: 生产模式 token 校验
  - CORS: 从 `OPENLEEK_CORS_ORIGINS` env 读取，`allow_methods` 限定为具体方法

### Changed

- **pyproject.toml** — 版本升至 0.17.0; 新增 `[tool.coverage.run/report]` 配置
- **server.py** — API 版本升至 0.17.0; CORS 可配置

### Tests

- 新增 17 个测试 (test_metrics +4, test_api +8, test_reproducibility_full +5)
- 总计: 344 passed, 18 skipped

## [0.16.0] — 2026-05-21

### Added

- **VLLMScaler** — K8s HPA 自动扩缩 vLLM Pod (`openleek/distributed/scaling.py`)
  - ScalePolicy: 可配置阈值/冷却/步长/上下限
  - EndpointMetrics: 实时负载监控
  - Advisory 模式 (emit metrics) + Direct 模式 (K8s API)
  - 动态端点发现 → 回馈 VLLMBatchClient
- **MultiAssetEngine** — 多资产并行撮合引擎 (`openleek/market/multi_asset.py`)
  - 独立 MatchingEngine per asset
  - `submit_orders_parallel()`: asyncio 并行跨资产撮合
  - 跨资产 portfolio 验证（共享现金）
- **TieredMemoryStore** — 分级内存 RAM(热) + Redis(冷) (`openleek/agent/memory/tiered.py`)
  - Hot tier: deque(maxlen=N) 亚毫秒访问
  - Cold tier: Redis sorted set, importance-weighted 驻留
  - 自动驱逐 + 批量 flush + 透明查询合并
  - Checkpoint snapshot/restore 支持
- **SimulationPartitioner** — 模拟分片器 (`openleek/distributed/partitioner.py`)
  - round_robin / influence / community 三种策略
  - Label propagation 社区检测（无外部依赖）
  - 大社区自动拆分，小社区合并
- **CrossShardCoupler** — 跨分片信号耦合
  - 价格信号聚合（全局均价）
  - 情绪信号聚合
  - Top-K influencer 帖子跨分片传播
- **pyproject.toml [ray]** — 新增可选依赖组 (`ray[default]>=2.20`)

### Changed

- **openleek/distributed/__init__.py** — 导出 VLLMScaler, ScalePolicy, SimulationPartitioner, CrossShardCoupler

### Tests

- 新增 26 个测试（test_scaling.py）
- 总计: 327 passed, 18 skipped

## [0.15.0] — 2026-05-21

### Added

- **openleek/distributed/ 模块** — Ray 分布式执行层，支持 100K+ Agent 模拟
- **AgentShard (Ray Actor)** — 每 shard 管理 200-500 个 Agent
  - 并行 observe/decide，Semaphore 控制并发
  - `_ShardLLMClient` 代理，路由到中心化 LLMPoolActor
  - 状态序列化/恢复（支持 checkpoint）
- **DistributedSimulator** — Ray 分布式编排器
  - broadcast→gather→execute→feedback 四阶段循环
  - 自动分片（round-robin 分区 profiles）
  - 支持从 checkpoint 恢复中断的模拟
- **MarketActor (Ray Actor)** — 中心化订单簿服务
  - 单点保证价格一致性
  - `execute_actions()` 串行撮合所有 shard 的交易动作
- **LLMPoolActor (Ray Actor)** — 中心化 LLM 批处理服务
  - 全局 batching + 负载均衡
  - 支持 single / vLLM 两种模式
- **CheckpointManager** — 分布式容错
  - 周期性全状态快照（shard memories + market state）
  - 恢复/清理/列表 API
- **create_simulator("distributed")** — 工厂函数现在返回 DistributedSimulator
- **pyproject.toml [ray]** — 新增可选依赖组 (`ray[default]>=2.20`)

### Changed

- **create_simulator()** — `mode="distributed"` 不再抛出 NotImplementedError

### Tests

- 新增 12 个测试（test_distributed.py）
- 总计: 301 passed, 18 skipped

## [0.14.0] — 2026-05-21

### Added

- **AbstractLLMPool 接口** — 新增 `openleek/core/llm_pool.py`，统一 LLM 推理池抽象（complete / batch_complete / close）
- **VLLMBatchClient** — 多节点 vLLM 高吞吐批量推理客户端
  - Round-Robin 负载均衡
  - 断路器 (circuit breaker): 阈值=5 / 冷却=30s
  - Per-node 信号量并发控制
  - httpx async HTTP/2 客户端
- **SingleClientPool** — 向后兼容适配器，包装已有 `LLMClient`
- **create_llm_pool() 工厂函数** — `mode="single"` / `mode="vllm"` 切换
- **PromptTemplate 系统** — 新增 `openleek/agent/prompt_templates.py`
  - COT / BDI / TOM 预构建模板（优化 vLLM 自动前缀缓存）
  - `get_template()` 注册表查找（支持别名）
  - `group_by_system_prompt()` — 按 system prompt 分组请求
- **pyproject.toml [vllm]** — 新增可选依赖组 (`httpx>=0.27`)

### Changed

- **Simulator._run_round()** — 情绪提取与 Agent observe/decide 并行化（`asyncio.create_task`）
- **新增 `_social_step_posts_only()`** — 仅获取帖子，不阻塞情绪分析
- **新增 `_extract_sentiment()`** — 异步情绪提取（返回 float）

### Tests

- 新增 27 个测试（test_llm_pool.py, test_prompt_templates.py）
- 总计: 289 passed, 18 skipped

## [0.13.0] — 2026-05-21

### Added

- **AbstractPersistence 接口** — 新增 `openleek/core/persistence.py`，定义持久化层抽象接口
- **create_persistence() 工厂函数** — 支持 `backend="sqlite"` / `backend="postgres"` 切换
- **PostgresPersistence** — 新增 `openleek/api/persistence_pg.py`，asyncpg 连接池 + JSONB + 批量插入
- **AbstractSocialStore 接口** — 新增 `openleek/social/store.py`，社交事件存储抽象
- **MemoryQueue** — 内存有界队列实现（deque maxlen=100K）
- **RedisStream** — Redis Streams 分布式社交事件存储
- **create_social_store() 工厂函数** — `backend="memory"` / `backend="redis"`
- **SQLitePersistence.save_round()** — 流式增量写入单轮数据
- **SQLitePersistence.save_traces_batch()** — 流式批量写入 traces
- **pyproject.toml [postgres] / [distributed]** — 新增可选依赖组

### Changed

- **SQLitePersistence** — 从每次新建连接改为持久连接 + WAL + PRAGMA 优化
- **SQLite PRAGMA** — `synchronous=NORMAL`, `cache_size=64MB`, `busy_timeout=5000`
- **Batch 写入** — executemany 按 500 行分批，避免单次过大事务
- **traces 表** — 新增 `round_number` 列 + 索引（按轮查询）
- **WebSocket broadcast** — 单次 JSON 序列化发送给所有客户端（而非每客户端重新序列化）
- **WebSocket actions** — 100K actions 列表压缩为 summary（total/buy/sell/hold 计数）
- **WebSocket trades** — 超过 100 条时截断 + 返回 trades_count
- **broadcast_complete** — 添加断开客户端清理

### Tests

- 新增 24 个测试（test_persistence.py, test_social_store.py, test_websocket.py）
- 总计: 262 passed, 18 skipped

## [0.12.0] — 2026-05-22

### Added

- **并行化模拟器** — `Simulator._run_round()` 的 observe/decide 阶段通过 `asyncio.gather()` 并行执行所有 Agent，支持 5000+ Agent 并发
- **AbstractSimulator ABC** — 新增 `openleek/core/simulator.py`，定义 `setup()/run()/stop()` 抽象接口
- **create_simulator() 工厂函数** — 支持 `mode="local"` / `mode="distributed"` 运行时切换
- **DualAgent 批量推理接口** — 新增 `build_prompt()` 和 `apply_response()` 方法，支持外部批量 LLM 调用
- **Profile 批量生成** — `generate_profiles_llm()` 收集所有 prompt 后一次性 `batch_complete()`
- **MatchingEngine 堆过期** — 订单过期从 O(n) 扫描优化为 min-heap O(k log n) 弹出
- **MatchingEngine `max_trades`** — 新增参数限制最大成交记录数（默认 10,000）

### Changed

- **LLMClient max_concurrent** — 默认从 32 提升到 128
- **LLMTraceStore** — 改为环形缓冲区 `deque(maxlen=100_000)`，防止无界内存增长
- **DataFeed._current_trades** — 从 `list` 改为 `deque(maxlen=200_000)` 有界集合
- **LongTermMemory** — 淘汰策略从 O(n) 全量排序优化为 heapq O(log n)
- **Simulator** — 继承自 `AbstractSimulator`，实现标准化生命周期接口

## [0.11.0] — 2026-05-21

### Added

- **后端：模拟器 WebSocket 实时对接** (#4)
  - `POST /api/simulations/` 重构：实例化 `Simulator` 并通过 `asyncio.create_task` 后台运行
  - 每轮完成后 `broadcast_round(sim_id, round_data)` 推送数据（含 depth 快照）
  - 模拟完成/失败时分别广播 `complete` / `error` 消息
  - 进度追踪：`progress = round_n / total_rounds`
  - 新增 `broadcast_error()` WebSocket 广播函数

- **后端：SQLite 持久化层** (#9)
  - 新增 `openleek/api/persistence.py`（`PersistenceManager` 单例）
  - 表结构：`simulations`、`rounds`、`traces`，支持分页查询
  - `GET /api/simulations/:id/rounds` — 分页获取历史轮次数据
  - `GET /api/simulations/:id/report` — 计算统计指标（Granger / 相关性 / 涌现检测）
  - `GET /api/simulations/:id/agents` — 按 agent 分组获取 TradeTrace
  - 可配置 TTL 清理策略（`cleanup(max_age_days=30)`）
  - 模拟列表合并内存活跃 + 持久化历史数据

- **后端：Config API** (#7 后端)
  - 新增 `openleek/api/routes/config.py`
  - `GET /api/config` — 读取运行时配置（graph_backend, LLM 参数）
  - `PUT /api/config` — 更新运行时配置（密码字段自动掩码）

- **前端：G6 力导向知识图谱** (#1)
  - `Graph.tsx` 全面重写：G6 v5 力导向布局替换文本邻接表
  - 节点按 `entity_type` 着色（Person=cyan, Organization=blue, Event=amber）
  - 节点大小正比于度数，边带标签和方向箭头
  - 点击节点展开邻居（调用 `/api/graph/subgraph`）
  - Hover tooltip、缩放/平移控制、Minimap 插件
  - 图例颜色标识

- **前端：Agent 行为追踪页面** (#2)
  - `Agents.tsx` 重写：可排序表格（ID、类型、风格、风险、交易数）
  - Agent 行为热力图（ECharts heatmap：行=agent, 列=round, 颜色=BUY/SELL/HOLD）
  - 新增 `AgentDetail.tsx`：交易时间线、价格折线、情绪轨迹、社交发言历史
  - 路由 `/agents/:id?sim=xxx`

- **前端：订单簿深度图** (#5)
  - `SimulationLive.tsx` 新增 ECharts step-area 深度图
  - 买单（绿色）/ 卖单（红色）累积量可视化
  - 实时 Spread 指标显示
  - Zustand store 新增 `latestDepth` 状态追踪

- **前端：统计报告页** (#3)
  - 新增 `Report.tsx`（路由 `/reports/:simId`）
  - Granger 因果 / 相关性 / 涌现检测 指标卡片
  - Price vs Fundamental Value 双线图
  - 相关系数 + Bootstrap 95% CI 可视化（误差棒）
  - 全部指标详细表格（value, p-value, significance badge, CI）

- **前端：设置页** (#7)
  - 新增 `Settings.tsx`（路由 `/settings`，侧边栏导航）
  - Graph 后端切换（networkx/neo4j）+ Neo4j 连接参数配置
  - LLM 配置（model, base_url, temperature slider, max_concurrent）
  - 连接测试按钮 + 保存反馈

- **前端：i18n 国际化** (#6)
  - 集成 `i18next` + `react-i18next` + 浏览器语言检测
  - 翻译文件：`zh-CN.json`（默认）、`en.json`
  - 侧边栏语言切换按钮，偏好持久化到 localStorage

- **前端：主题切换** (#6)
  - Dark（默认）/ Light 主题切换
  - Light 模式 CSS 覆盖（白底、灰边框、调整导航颜色）
  - 偏好持久化到 localStorage

- **前端：响应式布局** (#8)
  - 侧边栏可折叠（移动端汉堡菜单 + 遮罩层）
  - `lg:translate-x-0` 桌面端常驻，`< lg` 滑出/收回
  - 图表网格 → 小屏单列堆叠
  - 触控友好（导航点击关闭侧边栏）

- **前端：API Client 扩展**
  - `getSimulationRounds()`, `getSimulationReport()`, `getSimulationAgents()`
  - `getConfig()`, `updateConfig()`

### Changed

- `openleek/api/server.py`：注册 config router（`/api/config`）
- `SimulationLive.tsx`：图表网格从 2 列扩展为 3 列（新增 depth chart）
- `Layout.tsx`：从静态布局改为响应式可折叠，新增 i18n + theme 控制
- `stores/simulation.ts`：新增 `latestDepth` 状态字段
- `App.tsx`：新增 `/agents/:id`、`/reports/:simId`、`/settings` 路由
- `index.css`：新增 `.input-field` 组件类 + light 主题 CSS 覆盖

### Technical

- 238 个后端测试全部通过（0 regression）
- 前端 TypeScript strict mode 零类型错误
- 生产构建成功（Vite build, chunk 分割正常）

## [0.10.0] — 2026-05-20

### Added

- 前端可视化仪表盘（React 18 + TypeScript + Vite 6）
  - 深色科技风主题（Tailwind CSS 自定义 design token）
  - **Dashboard**：系统概览页（实验列表、活跃模拟、图谱统计）
  - **SimulationLive**：实时 K 线图 + 情绪曲线 + 成交量柱状图（ECharts 双轴）
  - **Graph**：知识图谱搜索 + 子图可视化占位（@antv/G6 v5）
  - **Experiments**：实验配置列表 + 详情页
  - **Simulations**：模拟任务列表 + 状态管理
  - **Agents**：Agent 行为追踪页面框架
  - Zustand 全局状态管理（activeSimId, rounds[], ohlcv[]）
  - WebSocket 实时数据推送（reconnecting-websocket）
  - Vite code-splitting（echarts 独立 chunk，vendor 分离）

- API 层扩展
  - `GET /api/graph/search`：知识图谱节点搜索
  - `GET /api/graph/subgraph/{node_id}`：N-hop 子图查询
  - `GET /api/graph/stats`：图谱统计信息
  - `WebSocket /ws/simulations/{sim_id}`：模拟轮次实时推送
  - `broadcast_round()` / `broadcast_complete()`：WebSocket 广播辅助函数
  - 前端静态文件托管（FastAPI `StaticFiles` 从 `frontend/dist` 提供）
  - CORS 中间件（开发环境 localhost:3000 跨域）

- 基础设施
  - 多阶段 Dockerfile（node:20-slim 构建前端 → python:3.11-slim 运行全栈）
  - `docker-compose.yml` 新增 `frontend` 服务（dev profile，Vite 热更新）
  - `frontend/` 完整 SPA 工程目录（TypeScript strict mode，零类型错误）
  - `Makefile` 新增 `frontend-build`、`frontend-dev` 目标

- 测试
  - 256 个测试全部通过（含 API 路由、WebSocket、Graph 端点单元测试）

### Changed

- `openleek/api/server.py`：注册 graph router + websocket router，挂载 static files
- `docker-compose.yml`：openleek 服务移除 Neo4j 强依赖（depends_on 条件化）
- 架构图更新：新增 Frontend Layer

## [0.9.0] — 2026-05-20

### Added

- 知识图谱双后端架构
  - `AbstractKnowledgeGraph`：抽象基类，定义统一接口
  - `NetworkXGraph`：NetworkX 内存后端（原 `KnowledgeGraph`，保留别名向后兼容）
  - `Neo4jGraph`：Neo4j 持久化后端（Bolt 协议，MERGE 幂等写入）
  - `create_knowledge_graph(backend, **kwargs)`：工厂函数，按配置切换后端
  - 配置项 `graph.backend`：支持 `"networkx"` / `"neo4j"`
  - `neo4j>=5.0` 加入可选依赖组 `[graph]`

- 市场微观结构增强
  - `MatchingEngine` 新增 `trading_fee_rate` 参数：可配置比例交易手续费（买卖双方各收取）
  - `MatchingEngine` 新增 `order_ttl_rounds` 参数：挂单超时自动过期机制
  - `MatchingEngine.advance_round()`：推进引擎轮次，触发过期订单清理
  - `MatchingEngine.compute_fee()` / `total_fees_collected`：费用计算与累计查询
  - `PortfolioManager.deduct_fee()`：手续费扣除
  - `VirtualMarket` 传递费率/TTL 参数，结算时自动扣费，轮次结束自动过期

- 统计方法严谨性增强
  - `_newey_west_se()`：Newey-West HAC 标准误（Bartlett 核），解决残差自相关导致的 p 值偏低问题
  - `_select_lag_aic()`：AIC 信息准则最优滞后阶数选择（替代硬编码 max_lag）
  - `_benjamini_hochberg()`：Benjamini-Hochberg FDR 多重检验校正
  - `sentiment_price_correlation` 新增 Bootstrap 95% 置信区间（`ci_lower`/`ci_upper`）
  - `granger_causality` 升级：AIC 自动选择最优滞后 + HAC 稳健性标注
  - `compute_all_metrics` 自动应用 FDR 校正，`significant` 字段反映校正后结果
  - `MetricResult` 新增 `ci_lower`/`ci_upper` 字段

- 集成测试（26 个新测试）
  - `tests/integration/test_market_flow.py`：完整交易生命周期、多 Agent 并发、OHLCV 生成、订单过期、手续费累计、零流动性防崩溃、价值守恒
  - `tests/integration/test_reproducibility.py`：市场操作确定性、价格-时间优先一致性
  - `tests/integration/test_config.py`：所有 YAML 配置加载验证、必填字段检查、Agent 组成比例检查
  - `tests/integration/test_metrics_pipeline.py`：因果关系检测、Bootstrap CI、FDR 保守性、HAC 正确性、AIC 滞后选择

- 默认配置更新
  - `config/default.yaml` 新增 `trading_fee_rate: 0.001` 和 `order_ttl_rounds: 5`

### Changed

- `MatchingEngine.__init__()` 签名变更：新增 `trading_fee_rate`、`order_ttl_rounds` 可选参数（默认值保持向后兼容）
- `VirtualMarket.__init__()` 签名变更：新增 `trading_fee_rate`、`order_ttl_rounds` 可选参数
- `granger_causality()` 签名变更：`max_lag` 默认值从 3 改为 5，新增 `use_aic` 参数
- `sentiment_price_correlation()` 新增 `n_bootstrap` 参数
- `compute_all_metrics()` 新增 `fdr_alpha` 参数

## [0.6.0] — 2025-05-20

### Added

- Phase 5: 实验框架、评估指标、API
- `ExperimentConfig`：实验配置管理
  - YAML 配置加载（load_experiment / load_all_experiments）
  - news_events 解析，agent_composition 分布
  - to_simulation_config() 转换
- `evaluation/metrics.py`：统计评估指标
  - sentiment_price_correlation（Pearson + t-test）
  - granger_causality（F-test，OLS 残差比较）
  - emergence_detection（价格尖峰-情绪聚类共现）
  - compute_all_metrics 聚合
  - 内置数学工具（_ols_rss, _norm_cdf, _f_cdf），无 scipy 依赖
- `evaluation/visualization.py`：可视化
  - plot_price_sentiment 双轴图
  - plot_trades_volume 柱状图
  - plot_agent_action_heatmap 热力图
- `api/server.py`：FastAPI Web API
  - /api/health 健康检查
  - /api/experiments/ 实验配置查询
  - /api/simulations/ 模拟任务管理（CRUD + 启动）
- 实验配置文件：basic_sentiment.yaml, panic_selling.yaml
- 23 个新单元测试（含 API TestClient 集成测试）
- fastapi + httpx 作为可选依赖

## [0.5.0] — 2025-05-20

### Added

- Phase 4: 研究流水线
- `Simulator`：模拟编排器
  - 社交+市场时间同步循环（8 步骤/轮）
  - 新闻注入 → 社交讨论 → 情绪提取 → Agent 决策 → 交易执行
  - RoundResult / SimulationResult 数据结构
  - stop() 优雅停止
- `OntologyGenerator`：本体生成
  - LLM 驱动实体/关系类型提取
  - PascalCase / UPPER_SNAKE_CASE 自动规范化
  - 强制 Person + Organization 基础类型
  - 默认金融本体（Stock, Event, Sector, Policy）
- `KnowledgeGraph`：NetworkX 知识图谱
  - 节点/边 CRUD，类型过滤
  - 子串搜索，N-hop 子图提取
  - LLM 上下文渲染（to_context_text）
- `Profiler`：实体→档案生成
  - 知识图谱实体自动映射为 Agent 档案
  - 可选 LLM 增强人设
  - 不足部分用模板补齐
- `Reporter`：ReACT 报告生成
  - LLM 规划大纲 → 逐章节 ReACT 工具调用
  - 4 个内置工具（search_graph, get_price_data, get_sentiment_data, get_agent_actions）
  - 最少 2 次工具调用，最多 5 次
- networkx 移入核心依赖
- 33 个新单元测试

## [0.4.0] — 2025-05-20

### Added

- Phase 3: DualAgent 统一决策层
- `DualAgent(MarketAgent)`：社交+交易统一决策 Agent
  - 双通道观察（social_context + market_context）
  - LLM 推理 → JSON 行动解析（trade/post/hold）
  - 短期+长期记忆协作
  - 无效 JSON 容错（fallback hold）
- `ShortTermMemory(MemoryStore)`：FIFO 有界缓冲
  - 关键词子串检索
  - 文本渲染（to_text）
- `LongTermMemory(MemoryStore)`：重要性加权记忆
  - 容量超限时淘汰最低重要性
  - 关键词重叠 × 重要性评分检索
  - reflect() 返回高重要性记忆
  - 按类型过滤（get_by_type）
- 规划策略 × 3：
  - `ChainOfThought`：逐步推理（信息汇总→趋势→风险→行动）
  - `BeliefDesireIntention`：BDI 框架（信念→愿望→意图）
  - `TheoryOfMind`：心智理论（他人视角→群体预测→最优响应）
- `generate_profiles()`：8 类角色模板批量生成
  - 散户/价值/动量/逆向/分析师/自媒体/噪音/做市商
  - 可选 LLM 增强人设（generate_profiles_llm）
- 45 个新单元测试

## [0.3.0] — 2025-05-21

### Added

- Phase 2: OASIS 社交层集成
- `LLMClient`：AsyncOpenAI 封装
  - 信号量并发控制，指数退避重试
  - JSON 模式输出，批量请求
  - 兼容 vLLM / DeepSeek / Qwen / GPT
- `OasisAdapter(AbstractSocialPlatform)`：OASIS 社交仿真适配
  - 延迟 import OASIS/CAMEL 依赖
  - Agent 档案 → SocialAgent 映射
  - 新闻注入（ManualAction）、情绪查询、Agent 采访
  - SQLite 帖子查询
- `NewsInjector`：新闻事件注入器
  - 按轮次调度、格式化（利好/利空/资讯标签）
  - 注入计数与历史记录
- `SentimentExtractor`：群体情绪提取
  - LLM 评分 + 加权聚合 → SentimentSignal
  - 时间窗口过滤、变化率跟踪
  - 异常 LLM 输出容错（回退中性）
- 16 个新单元测试（test_sentiment.py + test_news_injector.py）

## [0.2.0] — 2025-05-20

### Added

- Phase 1: 市场引擎完整实现
- `MatchingEngine`：自研价格-时间优先限价订单簿（基于 sortedcontainers）
  - 限价单/市价单撮合，部分成交，撤单
  - 完整 Trade 记录生成（含买卖双方信息）
  - 深度快照聚合（L1/L2）
- `PortfolioManager`：组合管理
  - 下单前余额/持仓校验
  - 资金/持仓冻结与解冻
  - 成交结算与加权平均成本计算
  - 未实现盈亏与总资产估值
- `DataFeed`：OHLCV K 线生成
  - 从成交流按轮次聚合
  - 空 bar 自动延续上一 close
- `VirtualMarket`：统一市场适配器
  - 组合 engine + portfolio + datafeed
  - 实现完整 AbstractMarket 接口
  - 轮次管理（advance_round）
  - 订单创建辅助方法
- 43 个单元测试全部通过

## [0.1.0] — 2026-05-13

### Added

- Phase 0: 项目骨架、文档框架、核心抽象接口
- 完整文档体系（MkDocs Material）
- pyproject.toml、Makefile、Docker 配置
- Core 模块：types、ABC 接口（AbstractMarket、AbstractSocialPlatform、MarketAgent、MemoryStore、PlanningStrategy）
