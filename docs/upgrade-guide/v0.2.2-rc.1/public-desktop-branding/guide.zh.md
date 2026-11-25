---
kind: upgrade-guide
description: "公开桌面默认使用通用品牌，不再附带私有行业技能。"
---

# 公开桌面品牌

[English](guide.md) | 中文

## 变更

公开构建使用 DeepSeek Harness 品牌，移除客户专属 Web 启动器、模板资源及桌面隐式技能注册。行业启动命令由 `web:erp` 替代，保留 `dev:desktop:erp`。ERP 环境变量、桌面桥及通信标识统一使用通用名称，不再接受旧品牌名称；既有 ERP 工具标识保持不变。

## 迁移

1. 公开启动方式见 [ERP 集成](../../../../integrations/erp/README.zh.md)。需要的业务 `skillSources` 由部署组合显式注册，私有模板保留在公开源码树之外。
2. 通过套件的 `DSH_ERP_BRANDING` 打包输入提供产品标识及公开图标，服务地址、应用 ID、签名和更新配置保留在本地。
3. ERP 与 Harness 配套更新：`ERP_DEV_URL` 指向 Vite，`ERP_API_URL` 指向 FastAPI，`ERP_DIST_DIR` 指向打包前端。网关使用 `x-erp-client-id`；自定义桥接改用 `window.erpDesktop`、`erp-desktop:*` IPC 及 `erp:*` 内嵌消息。客户端链接协议改为 `erp-client://`，重新打包并安装客户端。不需要数据库迁移或重写 Session 文件。
4. 从干净的导出源码重新构建，分别验证默认桌面及套件安装包，见[公开源码准备](../../../cookbook/preparing-open-source.zh.md)。源码清理不会修改已有安装客户端。
