---
description: "Web 和 Desktop 内置的 dsh-wechat 0.16.2，包含兼容补丁、登录和打包说明。"
---

# 内置微信接入

[English](README.md) | 中文

## 摘要

Web 应用 bundle 固定依赖 `dsh-wechat@0.16.2`，并在 Web 和 Desktop 中默认启用。[兼容补丁](patches/dsh-wechat@0.16.2.patch)保留设置入口的语言适配，并防止已取消的扫码流程覆盖当前登录状态或令牌。插件支持 DSH `>=0.2.1-0 <0.3.0-0`，用户无需单独安装插件。

## 目录

- [配置](#configuration)
- [验证与限制](#verification-and-limits)

<a id="configuration"></a>

## 配置

依赖和默认启用项归 `packages/bundle/web-app` 所有。根目录的 `pnpm-workspace.yaml` 在源码安装时应用补丁。Desktop 打包在解析生产依赖前，将同一补丁复制到独立运行时安装目录，并把修正后的插件放入应用产物。登录凭据不属于构建输入。

默认 `storageDir` 为当前配置档案（profile）目录下的 `wechat`，Web 和 Desktop 的凭据分别保存。`workSteps: minimal` 表示每轮发送最终回答。配置档案覆盖项可设置其他存储目录或工作目录。不要提交或分享登录文件。ERP 模式沿用当前 Desktop 登录人的 ERP 身份和模型网关。

在进程环境中设置 `ERP_DEV_URL=http://127.0.0.1:8848/` 后，从仓库根目录启动已有开发产物：

```powershell
pnpm run start:desktop
```

打开设置 → 微信，或访问运行中应用地址下的 `/wechat/qr`：[默认端口的 Web](http://127.0.0.1:3080/wechat/qr) 或[默认端口的 Desktop](http://127.0.0.1:19387/wechat/qr)。请使用账号本人的微信扫码。停用时，在配置档案的 `dsh-wechat` 覆盖项添加 `disabled: true`，然后重启应用；若准备继续使用，请保留登录数据和会话记录。

发起新一轮扫码会取消上一轮登录的请求和轮询等待。已取消的登录不能更新二维码、保存令牌或覆盖当前登录状态。退出登录和插件卸载也会取消尚未完成的扫码；当前有效的扫码流程若五分钟内未获确认，仍会报超时。

<a id="verification-and-limits"></a>

## 验证与限制

针对项目已应用补丁的依赖执行聚焦检查：

```powershell
node --test integrations/wechat/compat.test.mjs
```

已在开发版 Desktop 验证扫码登录与基础文本回复。媒体传输、审批卡和重启恢复仍需人工验证。当前接入仅供单用户使用：插件绑定首个发来消息的用户，不提供租户或 ERP 用户隔离。使用时需保持应用运行，并由目标 ERP 用户保持登录。

## 开发说明

补丁修改 npm 包交付的 `dist` 文件及声明，不增加 DSH 运行时包。测试依赖项目安装，需要显式执行，不纳入仓库单元测试聚合命令。Desktop 的运行时产物冒烟检查也会验证交付的插件版本和取消行为。
