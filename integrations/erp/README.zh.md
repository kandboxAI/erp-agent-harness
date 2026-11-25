# ERP 集成

[English](README.md) | 中文

运行 `pnpm web:erp` 使用标准 Web 界面和受控 ERP 工具。`EDUCATION_ERP_API_URL` 配置后端，默认使用本机开发端口 8000。既有配置键及 `education_erp_*` 工具名称保持 ERP 服务端兼容。

组合桌面开发先单独启动 ERP Vite 和 FastAPI，再运行 `pnpm dev:desktop:erp`。发行打包使用 `ERP_DIST_DIR`、`ERP_API_URL` 及可选的 `DSH_ERP_BRANDING`，见 [Desktop 参考](../../apps/desktop/README.zh.md#key-technical-decisions)。ERP 与 Harness 统一使用 `window.erpDesktop`、`x-erp-client-id` 和 `erp-client://`，需配套升级并重新构建，不再接受旧品牌标识。

公开发行物不内置行业技能包、客户文档或固定部署地址。ERP 工具与租户能力检查保留；部署组合可显式在 ERP 工具插件上注册业务 `skillSources`，私有模板放在本源码发行物之外。
