---
kind: upgrade-guide
description: "公开桌面默认使用通用品牌，不再附带私有行业技能。"
---

# 公开桌面品牌

[English](guide.md) | 中文

## 变更

公开构建使用 DeepSeek Harness 品牌，移除客户专属 Web 启动器、模板资源及桌面隐式技能注册。行业启动命令由 `web:erp` 替代，保留 `dev:desktop:erp`。ERP 环境变量、桌面桥及通信标识统一使用通用名称。公开 ERP 工具使用 `erp_api`、`erp_discover`、`erp_query` 和 `erp_open_page`。ERP 插件使用 `@deepseek-ai/dsh-tool-erp` 和 `@deepseek-ai/dsh-client-ui-erp-web`，其 Harness 本地接口位于 `/api/erp/` 下。

## 迁移

1. 在运行 `pnpm web:erp` 的环境中，把 `EDUCATION_ERP_API_URL` 改为 `ERP_API_URL`。重启后验证已认证的 ERP 工具请求发往配置的后端。通过部署组合注册所需的业务 `skillSources`，并将私有模板保留在公开源码树之外。[ERP 集成](../../../../integrations/erp/README.zh.md)
2. 通过套件的 `DSH_ERP_BRANDING` 打包输入提供产品标识及公开图标，服务地址、应用 ID、签名和更新配置保留在本地。
3. ERP 与 Harness 配套更新：`ERP_DEV_URL` 指向 Vite，`ERP_API_URL` 指向 FastAPI，`ERP_DIST_DIR` 指向打包前端。网关使用 `x-erp-client-id`；自定义桥接改用 `window.erpDesktop`、`erp-desktop:*` IPC 及 `erp:*` 内嵌消息。客户端链接协议改为 `erp-client://`，重新打包并安装客户端。不需要数据库迁移或重写 Session 文件。
4. 更新自定义配置、工具白名单和提示词，使用上述 ERP 标识。自定义内嵌客户端改用 `__dsh_erp_bridge` 和 Harness 本地 ERP 接口。ERP 后端升级后，已启用检索索引的租户需要重新构建索引。验证发现结果返回 `erp_*` 工具名，并可执行有权读取的查询。已有会话文件保留工具调用记录。
5. 从干净的导出源码重新构建，分别验证默认桌面及套件安装包，见[公开源码准备](../../../cookbook/preparing-open-source.zh.md)。源码清理不会修改已有安装客户端。
