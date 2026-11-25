---
description: "使用嵌入教育页面中当前登录的 ERP 用户身份调用 API，并执行按权限限定的只读查询。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-education-erp

[English](README.md) | 中文

## 概要

使用当前 ERP 账号发现业务资源、调用已批准接口、执行限定范围的只读查询，以及检索或读取已授权知识文档。后端执行权限和数据范围校验，模型不会获得 ERP 凭据。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

岗位共同记忆使用 `erp_position_memory_read` 和 `erp_position_memory_update`，只维护本人当前有效岗位的《岗位工作.md》。ERP 校验读取、贡献、成员身份和版本后自动排队发布，无需逐次确认或审核；通用知识写入仍需确认。首次取得可靠岗位职责、制度来源或共同约定时即可建立职责摘要和来源索引，不要求先有实操经验，不另建本地记忆库。 每个岗位各有一份文档，仅合并该岗位的经验。桌面 Host 在有资格的根会话每轮结束时触发一次整理，至少增加一次模型请求；已有文档没有新增职责、约定或经验时不写入，创建、提交、正常排队与解析、发布成功及跳过均静默。Host 在实时输出和记录日志前清除自动维护的回复正文，保留工具调用；工具失败或结果不可读时允许说明故障。用户主动询问状态仍正常回答。提交后由后台完成，不为汇报进度额外轮询或要求用户跟进；只有实际失败且需要用户介入时提示，用户主动询问状态除外。共同记忆上限为 12000 字符。

新建文档先用 `erp_knowledge_list_bases` 选择可管理的知识库，再用 `erp_knowledge_create_document` 保存在线 Markdown 草稿。无需已有文档或编辑令牌；确认成功后返回文档 ID 和草稿版本 ID，可继续查版本并提交审核。创建不代表发布或授予读取权限。本地 Markdown 文件不代表已入库。404 会区分路由缺失与当前租户未开通；菜单或检索为空不能证明模块未部署。新建结果未确认时先在 ERP 核对，避免自动重复创建。

使用 `erp_knowledge_update_document` 保存 ERP 草稿，`erp_knowledge_version_status` 查询版本，`erp_knowledge_submit_version` 提交审核。人工在 ERP 审核；通过后自动进入发布，索引核验成功后生效。草稿不影响已发布内容。

局部修改使用 `replacements` 提交精确的 `before` / `after` 片段，服务端保留其余完整原文；省略 `document_name` 保持标题。最多 20 处替换，片段缺失、匹配多处、重叠或版本过期时整次拒绝。`content` 仅用于用户提供完整正文的整篇替换，不能与 `replacements` 同传，也不能从截断或脱敏片段重建正文。

知识检索及正文结果中的可定位分块附带绑定来源快照的 `citation_url`，回答使用地址保持不变的编号 Markdown 引用。来源预览每次通过 `/api/knowledge/read` 复用当前 Session 的 ERP 身份，来源更新或撤权时拒绝读取；不调用 WeKnora 问答，也不绕过 ERP 正文保护。

知识库写入确认会说明操作，并按场景显示文档标题、草稿正文、修改内容或附件名称。文件送审会显示所选文档及其本地变更或附件。通用 ERP 工具对支持的知识库写入使用相同文案，其他需要确认的知识库写入请在 ERP 知识库页面办理。

新建和编辑的在线 Markdown 正文最多支持 200,000 个字符，标点、空白和 Markdown 标记计入长度。ERP 在片段替换后校验完整正文。

通过 `integrations/erp/README.md` 中的教育系统组合配置加载插件，其中提供 ERP 地址。使用工具前先登录 ERP。写入需要组合用户确认服务及回答端，`writeApprovalTimeoutMs` 默认为 300,000 毫秒；工具更新后需要更新 Electron 客户端。桌面请求通过 Electron 认证通道发送，访问令牌保留在主进程中。独立 Web 开发使用短期会话绑定，密码和刷新令牌不会发送给 Harness。

已认证宿主通过 `/api/education/knowledge-bases` 为输入框选择菜单提供候选项，经既有 `/api/harness/api` 网关和桌面认证通道调用 ERP 的 `/api/knowledge/readable-base-options`。桌面宿主在 ERP 登录完成前发布选择入口；数据提供器随当前认证能力加载，加载前无法读取。该入口要求 `knowledge:read`，无需文档管理权限，只返回 ID 和名称。最新用户消息中的 `@[名称](knowledge-base:id)` 引用决定该条消息的检索库范围，`education_erp_api` 入口同样受限；旧消息中的 `[knowledge-base:id]` 引用继续执行相同限制。ERP 在召回前将所选库、可选文档 ID 与当前读取授权取交集，并在返回结果前复核；空的指定列表不会退回全库。后续消息未携带引用时，沿用通常的检索行为。

使用 `education_erp_discover` 检索获准的 ERP 资源并加载选中的定义，使用 `education_erp_api` 调用获准的 HTTP 接口，使用 `education_erp_query` 只读查询、分组统计和执行批准的关联计划。工具均使用当前 ERP 账号，后端执行权限、字段保护和数据范围规则。不需要单独配置 ERP 账号或 Harness 查询密钥。查询工具不能执行 SQL，也不能访问任意 PostgreSQL 表。

内部制度使用 `erp_knowledge_search` 和 `erp_knowledge_read_document`：检索已授权文档、分页读取，再标注文档名称和分块序号。`erp_knowledge_update_document` 只保存 ERP 草稿，不修改 WeKnora，也不中断已发布版本。用 `erp_knowledge_version_status` 获取版本 ID 和内容哈希，再经用户确认用 `erp_knowledge_submit_version` 提交并冻结该版本；人工在 ERP 审核，通过后自动发布。上传文件（含 .md）仍只读，不支持 Wiki 编辑。所有知识工具沿用当前 ERP 身份及受控接口，Harness 不保存 WeKnora 密钥。ERP 每次读取都复核授权和来源；空授权、撤权或服务不可用时不能据此回答。这些工具不调用 WeKnora 对话接口。

技能目录按 ERP 能力包配置。提供器在列出或加载技能前会读取当前租户启用的技能标识；ERP 启停变化后，技能目录最迟在 15 秒后刷新。内置技能归属声明在 ERP 能力包的 `plugin.toml` 中，该能力包的客户技能目录也沿用相同的租户启停状态。

Desktop Host 通过 `/api/plugins/ai-capabilities` 协商 `protocol_version = 1` 及通用的 `erp.data` / `erp.navigation` 能力。插件不依赖行业包是否启用；后端按当前账号与租户过滤并授权每次资源或接口请求。导航先通过 `/api/harness/navigation` 将稳定的 `menu_key` 解析为当前授权路径，再向 ERP 窗口发送跳转；历史路径参数也必须命中授权菜单。现有 `education_erp_*` 工具名作为所有业务包共用的稳定协议标识保留。

-----

启用 `knowledgeFiles: true` 后，用 `erp_knowledge_bind_file` 明确关联 Markdown 文件，再用 `erp_knowledge_check_file` 查看本地修改。文件工具成功编辑已关联文件后自动检查；用户可选择提交审核、只保存草稿或暂不提交，同一份暂缓内容不重复提示。关联与上一份本地文本按会话和文件身份保存在宿主领域存储中；用户确认后，冻结候选仍通过 ERP 写入授权机制提交。写入结果不确定时停止自动重建，应先在 ERP 核对并关联确切文档 ID。此能力需要文件系统、用户询问回答端和领域存储，不监控无关文件，不代办知识审核；桌面 ERP 组合启用此能力。

批量送审时，先将明确选中的 1 至 10 份文件 关联到同一知识库，再调用 `erp_knowledge_submit_files`。确认卡展示 Markdown 本地差异及原件名称、大小和指纹。Word、PDF、Excel 和 PowerPoint 可与 Markdown 一同送审，原件单份最多 20 MiB，后续替换原件在 ERP 上传新版本，每份文件分别保存草稿、送审并返回结果。结果不确定时，先到 ERP 核对再重试。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>展开实现细节</summary>

资源发现请求 `/api/harness/discovery`：按问题 search，再携带 `catalog_revision` describe 选中的 ID，按定义校验和执行。后端在授权后结合精确名称、中文别名、BM25、可选 pgvector 和可选重排，先返回候选摘要，再按需返回详细定义；已审核指标使用固定的服务端查询配方。未配置 embedding 时使用词法检索，目录版本过期时需重新检索。API 工具请求 `/api/harness/api`，业务操作使用当前 ERP 权限，认证和凭证接口隔离。后端先过滤个人字段和未知文本再返回读取结果，隐藏值不代表空值或零。写入需要 `ctx.approval` 在展示准确的方法、包含查询参数的路径与请求正文后明确允许本次调用，工具取得绑定用户和具体请求的短期授权后重试一次，授权不会出现在模型结果中。拒绝、取消、超时或没有确认服务时停止写入；写操作返回状态，知识文档新建额外返回文档 ID、版本 ID 与草稿状态。查询工具请求 `/api/harness/query`，携带 `catalog_revision` 可拒绝过期定义。工具参数不包含用户身份或凭证。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [架构](../../../docs/architecture.zh.md) — 组合配置与插件职责。
- [添加工具](../../../docs/cookbook/adding-a-tool.zh.md) — 工具注册和展示。

-----

<a id="model-experience"></a>
## 模型体验

### ERP 工具参数定义

#### 模型可见内容

模型会看到标准 ERP 与岗位记忆 [工具参数定义](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-education-erp)。发现返回获准候选、选中的定义和已审核指标说明。查询的 `plan` 操作通过 ID 连接已描述的可执行关系，次数上限读取 describe 返回的 execution.max_joins，后端分别应用每张表的权限和数据范围。计划聚合在每组内对主表记录去重；聚合字段必须来自主表。`group_totals_additive` 为 false 时，各组可能重叠，不能相加当作总数。明细结果保留关联行粒度；`total` 统计输出行或分组数量。计划和分页参数放在 `plan` 内，顶层只接受 `operation`、`plan` 和必需的 `catalog_revision`。访问令牌不会进入工具参数。

#### Token 影响

挂载后，标准 ERP 与岗位记忆工具以及启用时的两个文件工具的参数定义增加固定上下文。每次发现最多返回 12 个候选，每次描述最多六个 ID，避免加载完整表和接口目录。返回数据受后端数量限制和配置的响应长度上限约束。

#### KV 缓存影响

配置不变时，工具定义前缀保持稳定。工具调用和结果追加到会话；修改工具注册或说明会改变该前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 数据库目录是后端明确登记的允许列表，不会自动公开所有表；新增资源需要审查仓库和授权规则。
- embedding 密钥、pgvector 和语义定义位于 ERP 服务端。获准定义或模型变化后独立构建元数据索引，向量索引不含业务记录。计划只允许批准的等值关系，不支持 SQL、HAVING 或混合实体聚合粒度；完整写接口参数定义仍待扩展。
- 后端现有的 `related` 数据范围在实现对应关系规则前返回空结果。
- 独立 Web 的绑定在停止续约后最多保留五分钟；桌面凭据失效时请求 ERP 登录，两种模式均需有效账号才能查询。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>展开维护信息</summary>

浏览器到 Host 的绑定按会话区分，只保存在进程内存中。不要把凭证写入会话事件、模型可见文本、工具参数或持久配置。

</details>
