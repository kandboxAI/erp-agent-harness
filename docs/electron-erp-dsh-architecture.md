# ERP里的DSH智能体设计


## 0. 背景技术


ERP、MES、OA、WMS、养老管理、医院管理、采购库存和财务结算等企业业务系统通常包含大量菜单、页面、表单、按钮、接口、审批流程和业务状态。用户完成一次业务操作时，需要理解菜单层级、字段含义、数据权限、审批规则、业务状态和接口约束。对于高频操作、跨模块操作或新员工使用场景，传统菜单式和表单式交互存在学习成本高、路径查找慢、重复输入多的问题。

随着大语言模型和智能助理技术的发展，业务系统开始尝试通过自然语言驱动页面打开、数据查询和业务处理。例如用户可输入“帮王大爷创建明天上午外出看诊的请假单”“给客户甲创建一张包含三号钢材的销售订单”。然而，若仅由模型根据自然语言自由推测接口地址、控件名称或数据库字段，容易产生误调用、越权调用、参数缺失、业务状态不合法、用户未确认即写入、无法审计等风险。

但是大部分友商的ERP智能体放在服务器上，本意是统一控制，不需要客户端，符合B/S (browser/server)的架构理念。但是现在明显个人智能体的发展很强大了，harness本身是以browser，sh 等为基础，不适合在服务器上跑。Meta的Muse也是过于重量级了。


## 1. 目标

将 ERP Vue 前端与 DeepSeek Harness（DSH）整合为一个 Electron 桌面客户端，同时保持 ERP 为用户进入系统后的统一业务界面。

- ERP 首页是客户端默认页面。
- ERP 保留顶部栏和左侧业务导航栏。
- ERP 菜单中的“新建会话”只展示 DSH 的聊天工作区，不展示 DSH 的左侧导航栏。
- 用户可从 ERP 进入完整 DSH，继续使用 Plugins、Workspaces、Sessions、设置等全部原生能力。
- FastAPI、PostgreSQL、Redis 均部署在内网/服务器侧，**不得打包、嵌入或运行在 Electron 客户端中**。

客户可能使用PC端，也可能使用小程序或者移动端app。移动端也需要有智能体对话能力。

## 2. 总体架构

```text
┌──────────────────────────── 用户电脑 ────────────────────────────┐
│ Electron 客户端                                                   │
│                                                                    │
│  ┌──────────────── ERP Vue 主界面 ────────────────────────────┐  │
│  │ 顶部栏                                                        │  │
│  │ 左侧 ERP 菜单                                                  │  │
│  │  ├─ 首页 / 系统管理 / 基础信息 / 其他业务菜单                 │  │
│  │  └─ 智能体助手                                                 │  │
│  │      ├─ 新建会话：DSH chat-only 嵌入页                        │  │
│  │      ├─ 会话历史：DSH 会话页面                                │  │
│  │      └─ 打开 DSH 全部功能：完整 DSH 视图                      │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  ┌──────── Electron 后台进程：完整 DSH ───────────────────────┐  │
│  │ DSH Desktop Host / 本地智能体运行时                         │  │
│  │ 插件、工作区、本地工具执行、会话、DSH WebSocket 通信         │  │
│  └───────────────────────────────────────────────────────────┘  │
└───────────────────────────────┬────────────────────────────────────┘
                                │ HTTPS / WSS
┌───────────────────────────────▼────────────────────────────────────┐
│ ERP服务器                                                                 │
│  FastAPI（认证、RBAC、ERP 业务 API）                                │
│  PostgreSQL（业务数据）                                              │
│  Redis（登录会话、Refresh Token、缓存）                             │
└───────────────────────────────────────────────────────────────────┘
```

## 3. 客户端职责边界

### 3.1 Electron 客户端

Electron 仅包含以下内容：

- 打包后的 ERP Vue 前端资源。
- DSH 的 Electron Desktop 壳、DSH Host 与其客户端资源。
- DSH 本地插件、工作区、会话和经用户授权的本地工具能力。
- 受控的 ERP API 请求和 DSH 到 ERP API 的调用能力。

Electron 不包含：

- FastAPI 进程或 Python 后端运行时。
- PostgreSQL、Redis 或任何数据库文件。
- 服务端 JWT 签名密钥、数据库密码、Redis 密码等服务端秘密。

### 3.2 服务器

服务端负责：

- FastAPI 登录、刷新、登出和当前用户接口。
- JWT 校验、RBAC、数据范围与审计。
- 所有 ERP 业务读写。
- PostgreSQL 持久化与 Redis 会话管理。

客户端不得直接连接 PostgreSQL 或 Redis。DSH 需要读取或写入 ERP 业务数据时，也必须调用受认证、授权和审计保护的 FastAPI 接口。

## 4. 界面与导航

### 默认入口

Electron 主窗口默认打开 ERP 首页。用户完成 ERP 登录后看到 ERP 顶部栏、左侧导航和首页内容，而非 DSH Welcome 或 DSH 工作区。

### 智能体助手菜单

ERP 增加/保留“智能体助手”一级菜单，并包含以下二级菜单：

| ERP 菜单 | 展示方式 | DSH 范围 |
| --- | --- | --- |
| 新建会话 | ERP 主内容区内嵌 | 仅 DSH 聊天工作区；隐藏 DSH 左侧栏和额外导航 |
| 会话历史 | ERP 主内容区内嵌 | DSH 会话历史与选中会话内容 |
| 打开 DSH 全部功能 | 独立 Electron 窗口或受控全屏内容视图 | 原生完整 DSH，包括 Plugins、Workspaces、Sessions、设置 |

“新建会话”使用 DSH 的 chat-only 嵌入模式，例如现有 `dsh_embed_chat=1` 查询参数。该模式进入后自动创建/打开新会话，页面不得叠加 DSH 左侧栏。

完整 DSH 不应被裁剪或由 Vue 复刻其插件、工作区和会话导航；应由 DSH 原生客户端完整渲染，以保证其功能、状态与插件机制保持一致。

## 5. Electron 集成方案

以现有 `deepseek-harness/apps/desktop` 为唯一 Electron 基础工程，扩展其主进程和打包配置。不要在 `frontadmin` 中新建第二个 Electron 工程。

### 主窗口

- 主窗口加载 ERP 的打包产物，作为统一应用外壳。
- ERP 内嵌 DSH 页面时，使用受控的 WebContentsView 或经过安全审查的 iframe/自定义协议页面。
- DSH 完整功能建议使用独立受控窗口；也可切换主窗口内容视图，但必须保留返回 ERP 的明确入口。
- DSH Host 的认证、HTTP 转发和 WebSocket 转发继续复用现有 DSH Desktop 机制，不把 DSH 进程 token 暴露给 ERP 页面脚本。

### 开发模式

开发时可并行运行：

- `frontadmin` Vite 开发服务器；
- DSH Web/Host 或 DSH Desktop 开发 Host；
- 内网或本机运行的 FastAPI 服务。

Electron 主进程通过明确的开发配置加载 ERP 开发地址和 DSH 开发地址。开发地址不得写入生产包。

### 生产模式

- Electron 加载随安装包发布的 ERP `dist` 静态资源。
- DSH 使用其现有 Desktop 打包的 Host、客户端与运行时资源。
- ERP API 基地址从应用配置读取，例如：

```text
ERP_API_BASE_URL=https://erp-api.intra.example.com
```

- 生产环境只允许 `https:` 的 ERP API 和 `wss:` 的实时连接；证书由企业内网 PKI 或受信任 CA 签发。

## 6. 智能体访问 ERP 的扩展架构

DSH 智能体和腾讯 WorkBuddy 智能体都不能直接调用数据库，也不能绕过 FastAPI 业务 API。采用“**统一 ERP MCP Gateway + 平台适配层 + Skill**”结构：ERP MCP Gateway 是唯一的能力与安全边界；DSH Plugin 和 WorkBuddy Connector 分别负责各自平台的连接、认证与用户体验；Skill 负责模型的业务操作说明。

```text
DSH Agent
  │ 读取 Skill：了解业务术语、操作顺序与风险提示
  │ 调用 MCP Tool：结构化参数、可记录的调用结果
  ▼
DSH 中的 ERP Connector Plugin
  │ 从 Electron 受控凭据桥获取短期 Agent Access Token
  │ 为当前 Agent/Session 配置 MCP Client
  ▼
服务器上的 ERP MCP Gateway（Streamable HTTP / HTTPS）
  │ 验证短期令牌、校验工具参数、执行工具权限策略
  ▼
FastAPI /api/{module} 业务接口
  │ JWT、RBAC、数据范围、事务、审计
  ▼
PostgreSQL / Redis
```

WorkBuddy 不通过 Electron 或 DSH Host 中转，而是从其 Connector 直接连接同一服务器端 Gateway：

```text
DSH Agent ── DSH erp-connector Plugin ──┐
                                         ├── ERP MCP Gateway ── FastAPI ── PostgreSQL / Redis
WorkBuddy Agent ── ERP MCP Connector ───┘
```

### 6.1 统一 ERP 能力契约

ERP 团队维护一份与智能体平台无关的“能力目录”，作为 FastAPI、ERP MCP Gateway、DSH Plugin 和 WorkBuddy Connector 的共同来源。能力按业务动作定义，不能按数据库表或内部 SQL 定义。

| 能力域 | MCP 工具示例 | 最小 OAuth/Agent Scope | 默认风险级别 |
| --- | --- | --- | --- |
| 老人档案 | `elder.search`、`elder.get_profile` | `erp.elder.read` | 敏感查询 |
| 护理记录 | `care_record.list`、`care_record.create_draft` | `erp.care.read`、`erp.care.draft` | 敏感查询/草稿 |
| 排班 | `schedule.list`、`schedule.propose`、`schedule.confirm` | `erp.schedule.read`、`erp.schedule.propose`、`erp.schedule.confirm` | 查询/确认写入 |
| 库存 | `inventory.get_balance`、`inventory.create_adjustment_draft` | `erp.inventory.read`、`erp.inventory.draft` | 查询/草稿 |
| 报表 | `report.generate`、`report.get_status` | `erp.report.generate` | 受控导出 |
| 系统管理 | 不对普通智能体直接开放 | 专用管理员 scope | 高风险 |

每个能力目录项必须定义：稳定工具名、版本、JSON Schema、FastAPI Pydantic 请求/响应 Schema、所需 scope、数据范围规则、是否需要用户确认、幂等要求、审计事件名、脱敏字段和最大返回条数。新增或废弃能力时先更新该目录，再同步生成/更新两个平台的工具说明与 Skill；平台不能各自发明一套相同业务的工具名。

### 6.2 DSH 与 WorkBuddy 的平台差异

| 维度 | 自封装 DSH Electron 客户端 | 腾讯 WorkBuddy 客户端 |
| --- | --- | --- |
| 平台所有权 | ERP/DSH 团队控制 Electron 主进程、DSH Host、Plugin 和打包版本 | 客户使用 WorkBuddy；ERP 团队发布 Connector，不能控制其宿主进程 |
| 连接适配层 | `erp-connector` DSH Plugin，在 Agent/Session 作用域挂载 DSH MCP Client | WorkBuddy `MCP + Skill` Connector，连接到同一远程 ERP MCP Gateway |
| 默认入口 | ERP 主界面内的“新建会话”或完整 DSH 窗口 | 客户在 WorkBuddy 安装/启用 ERP Connector 后自行创建 Agent 与任务 |
| 身份建立 | 当前 ERP 登录态由 Electron 主进程受控，签发短期 Agent Access Token | 用户在浏览器完成 FastAPI OAuth 授权；WorkBuddy 保存并刷新自己的 OAuth 凭据 |
| 会话与本地能力 | 可使用 DSH 工作区、会话、插件和经授权的本地工具 | 使用 WorkBuddy 自己的 Agent、会话、Skill 和平台能力；不依赖 ERP Electron 或 DSH 本地运行时 |
| 工具权限体验 | DSH/ERP 界面展示确认；Plugin 按当前 Agent 挂载可见工具 | Connector 安装/连接审批及 WorkBuddy 的 MCP 工具 allow/ask/deny 规则是额外一层控制 |
| 最终授权 | FastAPI/RBAC/数据范围和 ERP MCP Gateway 始终为准 | 相同；WorkBuddy 平台规则不能替代 ERP 服务端校验 |
| 发布物 | Electron 随产品发布的可信 DSH Plugin 与 ERP Skill | 独立的 WorkBuddy Connector 包，需满足其元数据、版本与审核要求 |

两个平台的**工具名、JSON Schema、scope、审计语义和 FastAPI 业务行为必须一致**。差异只存在于客户端认证和安装方式，不能造成“DSH 能做、WorkBuddy 不能做”或“WorkBuddy 绕过 ERP 权限”的分叉。

### 6.3 WorkBuddy Connector：客户自助接入

为 WorkBuddy 单独发布 `erp-mcp-connector`，采用官方推荐的远程 **MCP + Skill** 方式，而不是让客户安装可访问数据库的本地 CLI。Connector 包应包含：

```text
erp-mcp-connector/
├── connector-meta.json        # 名称、版本、唯一 source、双语说明与示例
├── mcp.json                   # 一个 HTTPS Streamable HTTP ERP MCP Gateway 地址
├── icon.svg                   # Connector 图标
└── skills/
    └── erp-operations/
        └── SKILL.md           # 工具选择、隐私与确认规则
```

`mcp.json` 只引用服务器地址，不包含任何真实 token、ERP 密码、数据库连接信息或固定管理员身份。Connector 使用标准 MCP OAuth 流程：首次连接由 Gateway 返回认证挑战，WorkBuddy 打开 FastAPI 的授权页面；用户使用其 ERP 账号登录并同意所请求的最小 scope 后，WorkBuddy 才能调用工具。

为支持该流程，服务器侧 ERP MCP Gateway 作为 OAuth Protected Resource，FastAPI/认证服务需提供或代理以下标准端点：

- `/.well-known/oauth-protected-resource`：声明受保护资源与授权服务器；
- `/.well-known/oauth-authorization-server`：声明授权、令牌和支持 scope；
- `/oauth/register`：支持 WorkBuddy 的动态公共客户端注册；
- `/oauth/authorize`：ERP 登录、用户同意、PKCE `S256` 校验和单次授权码签发；
- `/oauth/token`：授权码与 refresh token 兑换；签发 audience 为 `erp-mcp` 的用户令牌。

授权码必须一次性、短时有效；`redirect_uri` 精确匹配；OAuth access token 与 refresh token 的轮换、撤销和 Redis 会话状态由 FastAPI 维护。WorkBuddy 只得到当前 ERP 用户被授予的 scope，绝不能借用安装 Connector 的管理员账号或服务账号。

客户使用 WorkBuddy 时的实际流程为：安装 Connector → 首次连接审批 → ERP 登录与授权 → Gateway 根据用户 scope 返回可用工具 → 用户创建自己的 WorkBuddy Agent → Agent 调用工具 → Gateway 与 FastAPI 在每次调用时再次校验权限与数据范围。用户角色变更、离职、登出或管理员撤权后，服务端令牌校验必须立即生效，即使 WorkBuddy 客户端仍缓存工具列表。

Connector 的 `connector-meta.json` 必须声明唯一 `source`、Connector 版本、支持的最低 WorkBuddy 版本，以及中英文能力说明和示例；发布或更新需经过 WorkBuddy Connector 审核。`auth_mode` 采用标准 MCP OAuth，不采用用户手填长期 ERP Token 的模式。具体打包字段、OAuth 回调与版本兼容性以 [WorkBuddy Connector 官方文档](https://open.workbuddy.cn/docs/connector) 为准。

### 6.4 DSH Plugin：ERP Connector

新增一个 DSH 插件（建议命名为 `erp-connector`），并由 DSH Desktop Host 在每个需要 ERP 能力的 Agent 作用域中加载。该插件的职责是：

- 读取当前 DSH Agent/Session 的作用域信息，决定是否应挂载 ERP 工具。
- 通过 DSH 的 MCP Client 配置一个指向 ERP MCP Gateway 的 Streamable HTTP 连接。
- 管理连接生命周期、重连和当前会话与 MCP 工具可见性的绑定。
- 可选地提供 DSH 设置页，用于显示连接状态、服务器地址和用户授权状态；不得显示或导出访问令牌。

Plugin 不应直接实现 SQL、ERP 业务规则或权限判断，也不应将 ERP JWT 放入插件配置文件、DSH 会话记录、浏览器 URL 或日志。它只负责将受控的 MCP 连接挂载给正确的 DSH Agent 作用域。

### 6.5 MCP：业务工具的安全边界

在服务器端部署独立的 **ERP MCP Gateway**。它是一个 Streamable HTTP MCP 服务，而不是 Electron 内的本地服务；其唯一业务下游是 FastAPI HTTPS API。

MCP Gateway 应按业务能力而不是数据库表暴露工具。例如：

| 工具类别 | 示例 | 规则 |
| --- | --- | --- |
| 查询 | `elder.search`、`care_record.list`、`inventory.get_balance` | 强制分页、数据范围过滤、返回最小必要字段 |
| 草稿/建议 | `care_plan.create_draft`、`schedule.propose` | 只生成草稿，不直接改变业务状态 |
| 写操作 | `care_record.create`、`schedule.confirm` | 用户确认、幂等键、服务端事务、完整审计 |
| 附件/导出 | `report.generate` | 按数据权限生成，使用受控下载地址，不返回底层存储凭据 |

每个 MCP Tool 必须使用明确的 JSON Schema；Gateway 侧将其映射到 FastAPI 的 Pydantic 请求模型。Gateway 不得接受自由 SQL、任意 URL、任意表名或未经限制的筛选条件。

#### 能力对齐与“全部 ERP 能力”验收

“全部暴露”指所有**批准向智能体开放**的 ERP 业务能力均可由两个平台调用，不代表把内部管理、数据库维护或高风险操作无条件暴露给模型。能力目录中标记为“禁止智能体”的项目，在 DSH 与 WorkBuddy 中都必须不可见。

为防止两个平台逐渐不一致，Gateway 的发布流程必须包含以下契约测试：

1. 为每个能力目录项验证 FastAPI 路由、Pydantic 请求/响应 Schema、MCP Tool Schema 与 scope 映射一致。
2. 使用相同的 ERP 测试用户和 scope，分别从 DSH MCP Client 与 WorkBuddy 标准 MCP Client 执行 `tools/list`；两端应得到相同的可见工具集合、工具版本和 Schema。
3. 对每个工具执行成功、无权限、越数据范围、参数错误、令牌过期和用户取消确认的测试；两平台返回同一稳定错误码和可读信息。
4. 对写操作验证幂等键、事务回滚、真实 `operator_id`、调用来源（`dsh`、`miniapp_via_dsh` 或 `workbuddy`）、Agent/Session 标识和审计 diff 均被记录。
5. 新 ERP 能力合并前，必须同时补齐 Gateway Tool、DSH Skill、WorkBuddy Skill、授权 scope 和上述双平台回归用例；否则不得声称该能力已对智能体开放。

MCP 返回值应保持平台中性：使用结构化 JSON 及有限、脱敏的文本摘要，不返回只适用于 DSH 或 WorkBuddy 的 UI HTML。需要各平台交互式界面时，由 DSH Plugin 或 WorkBuddy Connector 在不改变业务 Tool 契约的前提下分别提供展示层。

### 6.6 Skill：指导两个平台的模型，不承担权限

ERP Skill 是平台无关的业务说明源。DSH 将其放在 DSH Skill 目录或随 Plugin 发布；WorkBuddy 将等价内容打包在 Connector 的 `skills/<skill-name>/SKILL.md` 中。两份发布物可以使用不同的目录元数据，但业务规则、工具名、参数解释、确认规则和错误处理必须从同一源内容生成或经过同一评审，用于告诉模型：

- 可用 ERP 工具及其适用业务场景；
- 老人档案、护理记录、排班、库存等领域术语；
- 查询前的确认规则和写操作前必须向用户展示的摘要；
- 对个人信息、财务、健康数据的最小化读取与脱敏要求；
- 工具失败时如何说明、重试或转人工。

Skill 只能影响模型的操作策略，不能作为安全控制。即使模型没有读取 DSH Skill 或 WorkBuddy Skill，MCP Gateway 和 FastAPI 仍必须独立完成参数校验、认证、RBAC、数据范围、事务和审计。

### 6.7 DSH 用户身份与令牌传递

ERP 用户登录成功后，客户端不直接把长期 FastAPI access token 交给 DSH renderer。推荐认证流程如下：

1. ERP 向 FastAPI 请求一个短期、一次性或可撤销的 Agent Access Token，并绑定 `user_id`、设备/客户端实例、DSH Agent/Session、允许的工具范围和过期时间。
2. Electron 主进程通过受控 IPC 将该短期令牌交给 DSH Desktop Host；普通 Vue 页面、DSH 页面和第三方插件都不能读取该令牌原文。
3. `erp-connector` Plugin 使用令牌建立到 ERP MCP Gateway 的 HTTPS 连接。
4. Gateway 验证令牌并将经验证的用户、组织、角色与数据范围作为调用上下文传递给 FastAPI。
5. FastAPI 以该可信上下文继续执行既有 JWT/RBAC/数据范围/审计流程；操作人必须记录真实 ERP 用户，而不是“DSH”或模型名称。

用户退出 ERP、令牌刷新失败、DSH Session 关闭或 Electron 应用退出时，Electron 主进程和 Gateway 都必须撤销对应的 Agent Access Token 与 MCP 连接。不同 ERP 用户、不同 DSH Session 之间不得共享 MCP 凭据或工具缓存。

### 6.8 写操作与人工确认

所有可能改变 ERP 数据的 MCP Tool 在 DSH 和 WorkBuddy 中均采用双层保护：

1. 平台侧（DSH 或 WorkBuddy）在调用前显示结构化操作摘要，并由用户确认；默认只允许查询和生成草稿。
2. FastAPI 在服务端再次校验令牌范围、用户权限、数据范围、业务状态、幂等键和事务一致性，并写入审计记录。

高风险操作（删除、批量修改、金额、排班发布、敏感档案导出、权限调整）应默认禁止模型直接执行，或要求额外的业务审批接口。

### 6.9 微信小程序远程接入 PC DSH（PC 优先通道）

小程序不运行第二套服务器端智能体，也不在手机端运行 DSH Host。客户 PC 中的 Electron + DSH Desktop Host 是**唯一的 Agent Runtime**：同一套 DSH Agent、ERP Skill、Plugin、会话和本地工具同时服务 ERP 桌面聊天与小程序聊天。

小程序无法直接连接客户 PC：客户 PC 通常位于 NAT、防火墙之后，且不能接受来自公网或小程序的入站连接。因此，PC 上的 DSH Host 必须主动向 FastAPI 建立并保持一条加密的 **WSS（WebSocket Secure）** 出站长连接；FastAPI 仅作为身份校验、消息路由和事件中继，不参与模型推理或替代 DSH 执行智能体。

```text
微信小程序
  │ 发送消息：HTTPS / 接收流：WSS
  ▼
FastAPI 消息中继与设备路由
  │ 身份校验、设备在线状态、消息路由、确认状态
  ▼ WSS（客户 PC 主动建立的长连接）
客户 PC：Electron + DSH Desktop Host
  │ 唯一 Agent Runtime：Skill、会话、插件、本地工具
  ▼
ERP MCP Gateway → FastAPI ERP API → PostgreSQL / Redis
```

#### 6.9.1 组件职责

| 组件 | 职责 | 不承担的职责 |
| --- | --- | --- |
| 微信小程序 | 展示会话、发送消息、展示流式回复与确认卡片 | 不保存 ERP/MCP 凭据；不执行模型或 ERP 工具 |
| FastAPI `agent-relay` | 小程序身份校验、PC 设备绑定、WSS 会话维护、消息路由、在线状态、确认关联和审计事件 | 不运行第二套 Agent；不访问 PC 本地文件或工具 |
| DSH `miniapp-channel` Plugin | 将远程事件映射为 DSH 会话，调用现有 Agent，回传文本/工具状态/确认请求 | 不实施 ERP 权限或直接访问数据库 |
| PC 上的 DSH Desktop Host | 唯一 Agent Runtime，执行 Skill、Plugin、会话、本地工具与 ERP MCP Client | 不信任小程序提交的用户、组织或权限字段 |
| ERP MCP Gateway / FastAPI | ERP 工具授权、业务校验、事务、数据范围、审计 | 不依赖客户端自行声明的角色或数据范围 |

#### 6.9.2 会话与消息流程

1. PC 用户登录 ERP 后，在 Electron 主进程中完成设备注册；FastAPI 记录 `tenant_id`、ERP `user_id`、`device_id`、DSH Agent 标识和设备公钥/受控连接信息。DSH Host 使用短期、可撤销的设备令牌主动连接 `wss://.../api/agent-relay/devices/{device_id}`。
2. 小程序用户完成微信登录并映射到 ERP 用户后，向 `POST /api/agent-relay/conversations/{conversation_id}/messages` 发送消息。服务端根据租户、用户与已授权设备确定目标 PC；不得由客户端任意填写其他用户的 `device_id`。
3. `agent-relay` 生成不可猜测的 `message_id`、`conversation_id` 与来源 `miniapp_via_dsh`，通过目标设备的 WSS 连接投递消息。DSH `miniapp-channel` Plugin 将其附着到对应 DSH Session，或按受控规则创建会话。
4. DSH 在 PC 上执行原有 Agent。读取 ERP 数据或写入业务数据时，仍通过 `erp-connector` 调用 ERP MCP Gateway；Gateway 与 FastAPI 按真实 ERP 用户、组织、scope 和数据范围重新授权。
5. DSH 产生的 token 流、工具进度、最终回复和错误以事件形式返回 `agent-relay`，再经小程序 WSS 推送。服务端应限制事件大小、速率、重放窗口和会话订阅权限。
6. 写操作先返回结构化确认卡片，其中包含 `confirmation_id`、操作摘要、过期时间和幂等键。用户在小程序确认后，确认事件只路由回原 `device_id` 与原 DSH Session；DSH 才调用允许写入的 MCP Tool。

#### 6.9.3 在线、离线与安全规则

- PC 未在线、设备令牌失效或 DSH Host 不可用时，不能继续使用 PC 优先通道；若该用户允许服务器端 Agent Worker，应转由 6.11 的服务器执行器处理，否则必须明确显示“PC 智能体未在线”。若后续支持排队，队列项必须加密、设置短过期时间，并在用户或设备撤权时立即删除；高风险写操作不得离线排队。
- FastAPI 必须在每次小程序消息和确认请求中校验登录态、租户、会话归属、目标设备授权与速率限制。PC 也必须校验服务端签名的路由事件，拒绝未绑定用户、过期或重复的 `message_id`。
- DSH 不得使用小程序上传的 `user_id`、角色、组织或 scope 作为授权依据；这些上下文只能由 FastAPI 签发并由 ERP MCP Gateway/FastAPI 服务端复核。
- 小程序、FastAPI 中继和 PC DSH 均不得持有数据库凭据、ERP JWT 签名密钥或长期 MCP Token。PC 仅在内存中持有绑定设备、用户和 Session 的短期 Agent Access Token。
- 聊天正文默认经服务器中继并按合规策略存储；如需让中继不可读取正文，可在小程序与 PC 间增加应用层端到端加密。无论是否加密，服务端仍需保留最小必要的设备、消息、确认和 ERP 工具审计元数据。
- 本地文件、桌面自动化等 PC 专属工具仅在 DSH 明确展示其来源为“小程序远程请求”并经本机用户授权后才能调用；默认不因小程序消息自动访问本地资源。

### 6.10 按用户计费的 LLM API Gateway

企业不得以一个共享的 LLM API Key 供所有用户、DSH 会话或小程序会话使用。每位 ERP 用户应拥有独立的模型提供方凭据和用量归属；DSH Desktop Host 是 Agent Runtime，但所有模型请求都必须通过服务器端 **LLM API Gateway**，由 Gateway 根据经过认证的 ERP 用户选择其凭据、执行预算控制并记录计费。

```text
PC DSH Agent / 小程序经 PC DSH 转发的 Agent
  │ 带用户、租户、设备、DSH Session 与请求用途的短期调用凭据
  ▼
服务器：LLM API Gateway
  │ 身份与额度校验、用户 Key 解析、模型路由、限流、用量计量、账单事件
  ▼
用户自己的模型提供方账号 / API Key
  │
  ▼
LLM Provider（如企业批准的 DeepSeek、OpenAI 或私有模型服务）
```

#### 6.10.1 账户与密钥模型

| 项目 | 规则 |
| --- | --- |
| Key 所有权 | `user_id + provider + credential_profile_id` 唯一归属一个 ERP 用户；不得以企业通用 Key 替代用户 Key。 |
| Key 录入 | 用户仅通过 ERP 的受认证“模型账户”设置页录入；页面提交后立即传至 Gateway 的秘密存储接口，客户端不保留明文。 |
| Key 存储 | Gateway 使用 KMS、Vault 或等价的操作系统/云密钥服务加密保存密文和密钥版本；数据库仅保存凭据 ID、提供方、掩码显示值、状态、创建/轮换时间，不能保存明文 Key。 |
| Key 使用 | Gateway 按请求临时解密并只在向模型提供方发起的 HTTPS 请求中使用；不得回传给 Electron、DSH Plugin、小程序、浏览器 URL、日志或会话记录。 |
| 多 Key | 同一用户可配置多个 Provider/模型档案；请求必须指定或由该用户自己的默认档案确定，不能自动借用其他用户的 Key。 |
| 撤销与轮换 | 用户删除、轮换 Key，管理员禁用模型档案，用户离职或租户关系撤销时，Gateway 必须立即拒绝新请求并清除内存缓存。 |

DSH 的 `erp-connector` 或独立 `llm-gateway` Plugin 只持有用于调用 Gateway 的短期、用户绑定令牌，不持有提供方 API Key。小程序消息虽然由 PC DSH 执行，模型用量仍归属发起小程序会话的 ERP 用户；若 PC 登录用户与小程序发起用户不同，Gateway 必须拒绝该调用，除非存在服务器端明确记录、可审计且限定 scope 的代理授权。

#### 6.10.2 Gateway 调用与计费流程

1. Electron/DSH 在建立 Agent 会话时从 FastAPI 获取短期 `llm.invoke` 调用令牌，令牌绑定 `tenant_id`、`user_id`、`device_id`、DSH Session、允许的 `credential_profile_id`、模型范围和过期时间。
2. DSH 向 Gateway 发起流式或非流式模型请求。Gateway 验证令牌、用户状态、凭据归属、模型允许列表、每分钟限额、并发数及余额/预算；不能由 DSH 指定任意用户或任意 Key。
3. Gateway 以该用户的模型档案调用模型提供方，并为每次请求生成 `llm_request_id`。流式输出可以经 Gateway 转回 DSH，再由 DSH 传回 ERP 或小程序。
4. Gateway 记录请求时间、用户、租户、Provider、模型、输入/输出/缓存 token、单价版本、实际或估算成本、状态、错误码、来源（`desktop_dsh` 或 `miniapp_via_dsh`）与 DSH Session；不得记录 API Key、完整敏感 Prompt 或完整模型回复。
5. Gateway 将用量事件写入不可变计费流水；按用户汇总日/月额度、预警阈值、欠费停用和对账报表。Provider 未返回精确 token/cost 时，必须标记为估算值及其定价版本，后续可对账修正。

#### 6.10.3 预算、隐私与失败策略

- 预算和限额至少支持每用户、每 Provider、每模型、每日/月度、单请求最大 token、并发数和速率限制；预算判断必须在调用 Provider 前执行。
- 对余额不足、Key 无效、Provider 限流或模型不可用，Gateway 返回稳定、非敏感错误码。DSH 应提示用户更新自己的模型档案或等待限额恢复，绝不能回退使用企业 Key 或其他用户 Key。
- 向外部模型发送数据前，DSH Skill 和 Gateway 必须执行与 ERP MCP 相同的最小化和脱敏原则；健康、财务、身份证等高敏字段需按模型档案的合规级别决定是否禁止发送。
- Gateway 的计费审计与 ERP 业务审计分离保存但可通过 `llm_request_id`、`conversation_id`、DSH Session 和 ERP 工具调用 ID 关联；模型用量流水不能被普通用户或模型本身修改。
- 私有化模型也通过同一 Gateway 接入，但可配置为“无外部按量费用”；它仍需记录资源用量、用户归属、配额和审计，不能绕过用户级限流。

### 6.11 DSH Server Agent Worker：共享进程、多用户上下文隔离

服务器端 `Server Agent Worker` 应复用 DSH 的无界面 Agent Core、Skill、MCP Client、会话事件和 LLM Gateway Client，但不能直接运行个人版 Electron/Desktop Host，也不能为每个用户启动一个完整 DSH 进程。

“用户 A 的 Worker”和“用户 B 的 Worker”首先是两个逻辑 Agent Context，不代表两个操作系统进程。生产环境采用固定数量的 Worker 进程池，每个进程在受控的事件循环中承载多个相互隔离的 Agent Context：

```text
FastAPI Agent Orchestrator
  │ 用户认证、权限计算、会话路由、队列与确认状态
  ▼
Redis Queue / Session Lease
  │
  ├── DSH Server Worker Process 1
  │     ├── Agent Context：用户 A / 会话 1
  │     ├── Agent Context：用户 B / 会话 2
  │     └── Agent Context：用户 C / 会话 3
  ├── DSH Server Worker Process 2
  │     ├── Agent Context：用户 D / 会话 4
  │     └── Agent Context：用户 E / 会话 5
  └── DSH Server Worker Process N
          │
          ▼
      ERP MCP Gateway → FastAPI ERP API
```

#### 6.11.1 共享代码与运行适配层

DSH 应拆成共享 Agent Core 和两个运行适配层：

```text
DSH Agent Core（共享）
├── Agent Loop / Tool Call Loop
├── Skill 加载与只读缓存
├── MCP Client 与 Tool Schema
├── Session Event Model
├── 工具确认与取消
└── LLM Gateway Client

PC DSH Desktop Adapter       Server Worker Adapter
├── Electron                  ├── 无界面运行
├── 本地工作区                ├── 多租户 Agent Context
├── 本地插件                  ├── 服务端会话恢复
└── 文件/终端/桌面能力        └── 仅 ERP MCP 工具
```

Server Worker 可以使用 DSH 的 CLI/headless 组装方式或抽出的核心包，但不能把 Electron 页面、个人 `userData`、本地 Host Cookie、个人工作区和桌面插件带入服务器进程。这样只维护一套 Agent、Skill 和 MCP 业务能力，服务器和 PC 只更换运行适配层。

#### 6.11.2 Agent Context 的隔离契约

每个 Agent Context 必须绑定服务端签发的不可变上下文，不允许从用户消息或工具参数中直接接受身份字段：

```text
tenant_id
user_id
conversation_id
agent_context_id
executor_type = server_dsh_worker
allowed_scopes
credential_profile_id
source = miniapp / web / api
```

隔离规则如下：

- 会话、消息、摘要、待确认操作和工具结果按 `tenant_id + user_id + conversation_id` 做数据范围过滤；所有读取和写入都必须再次校验会话归属。
- Worker 不使用用户级全局变量保存身份、权限、Key 或会话状态。用户上下文必须随一次 Agent turn 和每次 MCP 调用显式传递。
- Skill 内容可以在 Worker 进程内共享只读缓存，但用户变量、对话历史、工具结果、待确认操作和权限上下文不得共享。
- ERP MCP Gateway 每次调用都重新验证用户令牌、scope、数据范围和 `operator_id`；Worker 内部的 Agent Context 不是授权来源。
- LLM API Key 不进入 Agent Context，由 LLM API Gateway 根据 `credential_profile_id` 临时取得并计量。
- 同一 `conversation_id` 同时只能有一个活动写 turn；通过 Redis lease、版本号或幂等键防止并发消息互相覆盖。
- Worker 崩溃后，持久化的 Session Event 和未完成任务可以由其他 Worker 恢复；恢复时必须重新校验用户身份和权限，不能信任旧的内存状态。

#### 6.11.3 进程池与沙箱边界

普通 ERP 查询、草稿和受控写操作可以由共享 Worker 进程池执行。Worker 数量按 CPU、内存、模型并发和队列长度配置，并通过队列水平扩展；不按用户数量线性创建进程。

共享进程只允许经过审查的、无全局可变状态的 ERP MCP Plugin。以下能力默认不进入共享 Server Worker：

- 任意 Shell/Terminal 执行；
- 访问服务器或客户 PC 文件系统；
- 桌面自动化、浏览器控制和本地应用启动；
- 未审查的第三方插件或用户上传代码；
- 可以读取其他租户凭据的全局服务。

若未来必须执行不可信代码，才为该任务启动独立沙箱进程或容器，并绑定独立的临时工作目录、网络白名单、CPU/内存/时间上限和销毁策略。沙箱不能取代 ERP MCP Gateway 的业务权限校验。

PC 版 DSH 仍然是个人运行时，不需要承担多租户 RBAC。外部客户或学生的消息默认进入 Server Worker；只有同一个 ERP 用户明确绑定且在线的 PC，才允许走 6.9 的 PC 优先通道。不能把外部用户的请求投递到员工个人 DSH 后让其继承员工的本地文件、插件、LLM Key 或 ERP 权限。

#### 6.11.4 Server Worker 的插件组合

Server Worker 应使用与客户端尽量相同的 DSH profile 和插件生命周期，通过配置关闭个人桌面能力，而不是复制一套业务 Agent。`erp-worker` profile 至少包含以下受审查插件：

| 插件 | 职责 |
| --- | --- |
| `dsh-erp-gateway-bridge` | 接收 Agent Orchestrator 的会话请求并回传事件流 |
| `dsh-erp-identity` | 将服务端签发的 `agent_context_id` 绑定到当前 DSH Session；不保存长期令牌 |
| `dsh-erp-tools` | 注册 ERP MCP Tool Schema，工具调用只经 ERP MCP Gateway |
| `dsh-erp-policy` | 在 `tools/pre-execute` 执行参数、风险等级和工具可见性预检 |
| `dsh-erp-approval` | 将高风险 Tool 挂起，等待服务端审批结果后恢复 |
| `dsh-session-store` | 将 Session Event 追加到 PostgreSQL，并支持任意 Worker 回放恢复 |
| `dsh-erp-audit` | 记录工具调用、耗时、结果摘要、拒绝原因和 `llm_request_id` |

Server profile 必须禁用通用 Bash、Terminal、本地文件写入、桌面自动化和未审查第三方插件。插件可以共享代码和只读配置，但不得使用跨用户的可变单例保存身份、凭据、对话或工具结果。

#### 6.11.5 Agent Gateway、凭证代理与请求链路

FastAPI `Agent Orchestrator` 是 DSH Worker 的入口，不让客户端直接调用 Worker。它负责复用 ERP 登录态、解析 `user_id/tenant_id/roles/data_scope`、选择能力池、限流和流式转发；模型调用和 ERP 业务规则仍由 Worker、LLM Gateway 与 ERP MCP Gateway 分别负责。

一次请求的逻辑链路为：

```text
客户端消息
  → Agent Orchestrator：鉴权、租户/会话归属、限流、选择池
  → Redis：Session Lease 与 Worker 路由
  → DSH Server Worker：回放 Session Event，执行 Agent turn
  → LLM API Gateway：按用户模型档案调用模型并计量
  → ERP MCP Gateway：按用户 scope 调用 ERP API
  → PostgreSQL：追加消息、工具事件、审批和审计
  → Orchestrator：SSE/WSS 流式返回客户端
```

Worker 申请 ERP 工具令牌时只提交 `agent_context_id`、所需 scope 和工具名；凭证代理根据服务端会话映射取得短期、限定范围的委托令牌。令牌只存在工具插件内存，不进入模型上下文、Session Event 或普通日志。

#### 6.11.6 会话生命周期与高风险审批

这里的“无状态”指 Worker 进程无状态，会话本身有状态。会话状态全部追加写入 PostgreSQL，Redis 只保存短期路由、心跳、租约和锁：

```text
新建 → 活跃 → 冷却 → 已卸载 → 再次发言时任意 Worker 回放恢复
             └→ 等待审批 → 审批通过/拒绝 → 恢复或结束
```

等待审批的会话不长期占用 Worker。审批单至少保存工具名、参数快照、参数哈希、发起人、审批人、状态和过期时间；执行前重新计算哈希，确保审批通过后执行的参数与审批时一致。

工具调用遵循三层闸门：

1. **工具可见性**：根据 ERP 角色、部门/能力池和 Agent Preset 只注册允许的工具。
2. **DSH 预检**：检查参数范围、批量大小、风险级别和确认/审批要求。
3. **ERP 最终裁决**：FastAPI/ERP MCP Gateway 重新执行 JWT、RBAC、数据范围、业务状态、幂等和审计校验。

预检和 Skill 不能替代 ERP 最终裁决，也不能因为提示词要求而放宽权限。所有写工具必须带 `idempotency_key`，推荐由 `conversation_id + tool_call_id` 派生，避免重试或恢复造成重复写入。

#### 6.11.7 进程池调度、隔离分池与扩缩容

初期可以使用一个通用 ERP 池；当财务、人事、订单等业务的敏感度或峰值明显不同，再按能力域拆分独立池。分池用于故障隔离、网络隔离和独立扩缩容，不代表每个用户一个池或一个进程。

| 场景 | 调度规则 |
| --- | --- |
| 新会话 | 选择目标池内健康且活跃 Context 最少的 Worker |
| 活跃会话 | 使用 Session Lease 粘性路由，避免无意义回放 |
| Worker 满载 | 达到会话/并发上限后不再接收新 turn |
| 会话冷却 | 空闲超过配置阈值后释放内存，保留 PostgreSQL 日志 |
| Worker 失联 | 心跳超时后清理租约，下一次请求由其他 Worker 恢复 |
| 滚动升级 | 新版本先加入池，旧版本排空后停止；必须通过 Session Event 回放兼容测试 |

容量可按以下方法初估，最终以压测为准：

```text
池内 Worker 数 = ceil(峰值并发活跃会话数 / 单 Worker 并发上限) + 至少 1 个冗余
```

Worker 数量由 CPU、内存、模型并发和队列长度决定，不随注册用户数线性增长。池管理器每 30 秒采集健康、活跃会话、队列长度、首字延迟和错误率；持续高负载扩容，持续低负载先排空再缩容。

#### 6.11.8 逻辑数据模型与部署边界

Server Worker 需要以下逻辑数据（具体表结构应通过正式迁移实现，不在本设计文档中直接生成 DDL）：

| 逻辑实体 | 核心字段 | 说明 |
| --- | --- | --- |
| `agent_session` | `id`、`tenant_id`、`user_id`、`pool`、`preset`、`status`、`worker_id`、`last_active_at` | 会话归属与当前承载信息 |
| `session_event` | `session_id`、递增序号、`event_type`、结构化 payload、时间 | 只追加的消息、工具、审批和恢复日志 |
| `tool_call_audit` | `session_id`、`user_id`、工具、风险、参数哈希、结果、耗时 | 工具级审计，不存令牌原文 |
| `agent_approval` | 工具调用、发起人、审批人、状态、参数哈希、过期时间 | 高风险操作审批 |
| `agent_worker` | `worker_id`、池、版本、状态、活跃数、最后心跳 | 历史和运维记录；实时租约仍在 Redis |

部署上，Agent Orchestrator、池管理器、凭证代理和审批服务位于应用区；不同能力池可部署在独立安全区；Worker 只能出站访问 LLM Gateway、凭证/审批服务、ERP MCP Gateway、PostgreSQL 和 Redis。Worker 不得直接连接业务数据库、客户 PC 或任意公网地址。

#### 6.11.9 故障恢复、可观测性与待验证事项

- 单 Worker 崩溃：当前 turn 标记为中断；用户下次发言时由其他 Worker 从 PostgreSQL 回放，会话不会绑定在旧进程上。
- LLM 超时：按用户策略重试或切换允许的模型；超过阈值熔断，不能借用其他用户 Key。
- ERP 写接口失败：如实返回错误，默认不自动重试；依靠幂等键防止客户端重发造成重复写入。
- PostgreSQL 暂时不可用：禁止伪造成功结果；必要时只保留有界的事件缓冲，恢复后补写并标记状态。
- 审批超时：自动过期并通知发起人，不能由模型自行批准。

至少监控网关鉴权/限流、池内 Worker 数、活跃 Context、会话回放耗时、模型 token/成本、工具成功与拒绝、审批时长、Worker 崩溃和跨租户访问拒绝。上线前必须验证 DSH headless 组装方式、Session Event 完整回放、单进程并发行为、插件是否存在全局可变状态，以及新旧 DSH 版本的日志兼容性。

## 7. 认证与安全

1. ERP 登录凭据由 FastAPI 签发和验证；Electron 仅以最小必要方式保存客户端登录态，具体存储规则见下文。
2. DSH 的本地 Host token 仅用于 Electron/DSH 内部受控转发，不能当作 ERP 身份凭据，也不能通过 URL、日志或普通 renderer IPC 暴露。
3. Electron 必须启用 `contextIsolation`，禁用 `nodeIntegration`，并通过白名单 IPC 暴露最小接口。
4. 主进程限制 `will-navigate`、`setWindowOpenHandler`、外部链接和 WebContentsView 的目标来源；未知导航交由系统浏览器打开或拒绝。
5. DSH 访问 ERP 数据时携带当前 ERP 用户的受控授权上下文；FastAPI 仍须独立执行 JWT、权限、数据范围和审计校验，不能信任客户端传来的角色或用户 ID。
6. API 基地址、证书策略和允许来源需在安装包配置中显式定义；禁止把数据库和 Redis 连接配置下发到客户端。

### 7.1 Electron 登录态存储

生产版 Electron 采用“主进程持有令牌、renderer 不落盘令牌”的方式。FastAPI 当前认证体系中的 access token、refresh token 和 Redis 会话仍由服务端签发、轮换和撤销；Electron 只是受控客户端。

| 数据 | 保存位置 | 生命周期 | 说明 |
| --- | --- | --- | --- |
| Access Token（JWT） | Electron **主进程内存** | 至过期、登出或应用退出 | 不写入文件、不写入 `localStorage`、不通过普通 IPC 返回给 Vue/DSH 页面 |
| Refresh Token | Electron `userData` 下的专用凭据文件，使用 `safeStorage` 操作系统加密 | 仅在用户选择“保持登录”时跨重启保存；服务端轮换或撤销后失效 | 文件权限仅限当前系统用户；存储密文和版本，不记录明文到日志 |
| 当前用户展示信息 | 可存于 `userData` 或内存 | 可随登录态清除 | 仅包含用户 ID、昵称、头像版本、最近登录时间等非秘密数据；仍避免保存敏感档案信息 |
| ERP MCP/Agent Access Token | DSH Desktop Host/主进程内存 | 短期、绑定 Agent/Session | 不持久化；不能写入 Vue 状态、DSH 插件配置、URL、会话记录或日志 |

Electron 不保存用户密码、FastAPI JWT 签名密钥、数据库凭据、Redis 凭据或 DSH Host 的进程 token。

### 7.2 登录、请求与刷新流程

1. ERP 登录页将用户名和密码仅用于本次 HTTPS 登录请求；主进程将请求转发至 `POST /api/auth/login`，不得在 renderer 中持久化密码。
2. FastAPI 返回 access token、refresh token 与用户资料后，主进程将 access token 留在内存；若用户明确选择“保持登录”，才用 Electron `safeStorage` 加密保存 refresh token。
3. ERP Vue 的 API 层通过受限 preload API 请求主进程转发业务 API。preload 只暴露按模块白名单校验后的请求能力，不能暴露任意 Node.js、文件系统、任意 URL 请求或读取令牌的方法。
4. 主进程在 access token 临近过期时使用 refresh token 调用 FastAPI 刷新接口，并用新的 refresh token 原子替换已加密保存的旧值。刷新失败则清除本地状态并回到登录页。
5. DSH 需要 ERP 工具时，主进程依据当前登录态签发/获取短期 Agent Access Token 并只交给受信任的 DSH Host 通道；DSH renderer 与第三方插件不能读取长期 ERP token。
6. 用户登出时，主进程调用 FastAPI 登出/撤销接口，删除加密 refresh token、清空内存 access token 和 Agent Access Token，并通知 ERP 与 DSH 关闭关联连接。

### 7.3 本机加密不可用时的行为

应用启动时必须检查 Electron `safeStorage` 是否可用且实际由操作系统密钥保护。若不可用（例如某些 Linux 环境没有安全密钥存储），客户端不得把 refresh token 以明文或可逆弱加密写入磁盘：

- 默认降级为仅内存登录态，应用重启后要求重新登录；或
- 要求部署受支持的操作系统密钥存储后才允许“保持登录”。

不得使用浏览器 `localStorage`、明文 JSON、`.env`、安装包配置文件或自制固定密钥加密来保存 refresh token。

## 8. 实施阶段

### 阶段一：明确配置与窗口骨架

- 为 Electron 增加 ERP API 基地址与开发/生产前端地址配置。
- 让 Electron 主窗口默认加载 ERP 前端。
- 保持现有 FastAPI、PostgreSQL、Redis 的部署方式不变。

### 阶段二：ERP 与 DSH 视图编排

- 接入 ERP 的“新建会话”和“会话历史”菜单。
- 在聊天嵌入模式中隐藏 DSH 导航，仅保留聊天功能。
- 增加“打开 DSH 全部功能”入口并启用完整 DSH 窗口/视图。

### 阶段三：ERP Agent Connector

- 在服务器部署 ERP MCP Gateway，并仅通过 FastAPI 业务 API 访问 ERP 数据。
- 定义平台无关的 ERP 能力目录、MCP Tool Schema、scope 与双平台契约测试。
- 实现 FastAPI 签发、校验和撤销 DSH Agent Access Token 的接口与 Pydantic Schema。
- 开发 `erp-connector` DSH Plugin，按 Agent/Session 作用域挂载 MCP Client。
- 编写 DSH ERP Skill，覆盖工具选择、个人信息保护与写操作确认要求。
- 部署 LLM API Gateway，实现用户模型档案、受控密钥存储、短期 `llm.invoke` 令牌、模型路由、用量计量、预算与计费流水。

### 阶段四：DSH Server Agent Worker

- 从 DSH Desktop 运行时中抽取可复用的 Agent Core，提供无界面 Server Worker Adapter。
- 实现固定数量 Worker 进程池、Redis 队列/Session Lease、Agent Context 隔离、会话恢复和并发 turn 控制。
- 默认只加载审查后的 ERP MCP Plugin，禁用服务器端 Shell、文件系统、桌面自动化和不可信第三方插件。
- 使用同一组测试用户验证跨租户会话读取、权限越界、并发写入、Worker 崩溃恢复和 LLM credential 隔离。

### 阶段五：小程序远程 DSH Channel

- 在 FastAPI 实现 `agent-relay`：设备注册/撤销、短期设备令牌、WSS 长连接、消息路由、在线状态、确认事件和可观测审计。
- 开发 `miniapp-channel` DSH Plugin，将中继事件映射到受控 DSH Session，并回传流式回复、工具状态和确认卡片。
- 在小程序实现会话消息、WSS 订阅、PC 在线提示、确认卡片与断线恢复；PC 不在线时按用户策略切换 Server Worker，禁止静默降级到其他用户的 PC。
- 对跨租户路由、设备冒用、重放消息、重复确认、PC 断线和高风险工具本机确认进行端到端测试。

### 阶段六：WorkBuddy Connector

- 为 FastAPI/ERP MCP Gateway 实现 OAuth Protected Resource 元数据、动态公共客户端注册、OAuth 2.1 Authorization Code + PKCE 和令牌轮换/撤销。
- 制作并验证 `erp-mcp-connector` 的 `connector-meta.json`、`mcp.json`、图标与 WorkBuddy ERP Skill。
- 在 WorkBuddy 中完成首次授权、scope 变更、令牌失效、工具审批和双平台工具契约测试。
- 按 WorkBuddy Connector 审核要求发布版本，并声明最低支持的 WorkBuddy 版本。

### 阶段七：安全与交付

- 实施 Electron 导航、IPC、来源与证书白名单。
- 配置内网 API 地址和企业证书信任策略。
- 进行登录、刷新、权限、DSH 会话、插件、断网恢复和升级回归测试。

## 9. 验收标准

- 安装并启动 Electron 后，默认显示 ERP 首页及其顶部栏、左侧栏。
- ERP 用户可以正常登录既有 FastAPI 服务。
- “新建会话”只显示 DSH 聊天内容，不出现 DSH 左侧导航栏。
- “会话历史”可访问 DSH 原会话数据和功能。
- “打开 DSH 全部功能”可使用完整 DSH 的 Plugins、Workspaces、Sessions 与设置。
- Electron 客户端不包含、启动或连接 FastAPI/Python/PostgreSQL/Redis 本地进程。
- ERP 业务数据访问均经由 FastAPI，且服务端权限、数据范围和审计仍然有效。
- DSH 智能体仅通过 ERP MCP Gateway 使用明确 Schema 的 ERP 工具，不能直连数据库或执行任意 SQL。
- WorkBuddy 客户可安装 ERP Connector 并以自己的 ERP 用户身份完成 OAuth 授权；其工具可见性、数据范围和写入权限与该用户 ERP 权限一致。
- 对任何已批准开放的 ERP 能力，DSH 与 WorkBuddy 的 MCP Tool 名称、Schema、scope、业务结果和服务端审计语义一致。
- 写操作具有用户确认、幂等处理和以真实 ERP 用户为操作人的服务端审计记录。
- 小程序消息只能路由至当前 ERP 用户的 Server Worker，或经明确授权的在线 PC DSH 设备；不能路由到其他用户的个人 DSH。
- Server Worker 使用固定数量 DSH Worker 进程承载多个隔离 Agent Context，不按用户数量创建进程；用户会话、权限、Skill 状态、LLM credential 和工具结果相互隔离。
- PC 离线时，小程序按策略切换 Server Worker；本地文件、终端和桌面工具不可用，用户能看到执行模式和明确失败原因。
- 小程序远程会话的流式回复、确认事件、来源 `miniapp_via_dsh`、目标设备、DSH Session 和 ERP 工具审计可关联追踪。
- 任一模型调用均可关联到唯一 ERP 用户及其模型档案；客户端无法读取提供方 API Key，Gateway 不会回退使用企业共享 Key 或其他用户 Key。
- Gateway 可按用户、模型和 Provider 施加预算与限流，并记录可对账的 token、单价版本和成本流水。
