# ERP 集成

[English](README.md) | 中文

运行 `pnpm web:erp` 使用标准 Web 界面和受控 ERP 工具。通过 `ERP_API_URL` 设置 ERP 后端地址，默认值为 `http://127.0.0.1:8000/`。

Web 和组合桌面启动器均从 Harness 根目录的 `.env` 读取 `ERP_API_URL`。组合桌面还读取前端地址 `ERP_DEV_URL`，默认值为 `http://127.0.0.1:8848/`。启动终端设置的同名地址优先于文件中的值。

组合桌面开发先单独启动 ERP Vite 和 FastAPI，再运行 `pnpm dev:desktop:erp`。发行打包使用 `ERP_DIST_DIR`、`ERP_API_URL` 及可选的 `DSH_ERP_BRANDING`，见 [Desktop 参考](../../apps/desktop/README.zh.md#key-technical-decisions)。ERP 与 Harness 统一使用 `window.erpDesktop`、`x-erp-client-id` 和 `erp-client://`，需配套升级并重新构建，不再接受旧品牌标识。

公开发行物不内置行业技能包、客户文档或固定部署地址。ERP 工具与租户能力检查保留；部署组合可显式在 ERP 工具插件上注册业务 `skillSources`，私有模板放在本源码发行物之外。
