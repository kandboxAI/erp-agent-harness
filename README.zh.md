# ERP Agent Harness

[English](README.md) | 中文

ERP Agent Harness 为 AI Native ERP 提供桌面助手。使用 ERP 账号登录后，可以在管理端旁打开助手对话、查询业务数据及执行有权操作的业务请求。[AI Native ERP](https://github.com/kandboxAI/ai-native-erp) · [DeepSeek Harness 上游项目](https://github.com/deepseek-ai/deepseek-harness)

<a id="run-with-erp"></a>
## 与 ERP 一起运行

1. 按发行说明准备配套的 ERP 和 Harness 版本。参照 ERP 安装指南准备 PostgreSQL 和 Redis，启动 FastAPI 后端与 ERP 管理端，并在浏览器验证登录。保持前后端运行。[ERP 安装指南](https://github.com/kandboxAI/ai-native-erp/blob/main/README.md)
2. 使用 Node.js 24.9 或更高版本，以及 `package.json` 声明的 pnpm 版本。阅读安全说明后，在另一个终端克隆 Harness。如果发行说明指定了其他标签或提交，先切换到对应版本，再在 Harness 根目录运行 pnpm 命令。[安全说明](SAFETY.zh.md)

```sh
git clone https://github.com/kandboxAI/erp-agent-harness.git
cd erp-agent-harness
```

在配套版本的源码根目录构建并启动。

```sh
pnpm install --frozen-lockfile
pnpm build:artifacts
pnpm dev:desktop:erp
```

桌面端从干净源码首次启动时需要工作区的编译产物。桌面启动器默认加载 `http://127.0.0.1:8848/` 的 ERP 管理端。如果 Vite 使用其他地址，在 Harness 终端设置 `ERP_DEV_URL`。[桌面启动与打包指南](https://github.com/kandboxAI/ai-native-erp/blob/main/plugins/core/docs/desktop-packaging.md)

在 ERP 后端的 `plugins/core/backend/.env` 配置 `LLM_GATEWAY_DEEPSEEK_API_KEY` 和模型参数，然后重启 FastAPI。在桌面端登录 ERP 后，给助手发一条简单消息，检查模型是否可用。[ERP 环境变量模板](https://github.com/kandboxAI/ai-native-erp/blob/main/plugins/core/backend/.env.core.example)

测试业务查询前，先为目标 ERP 租户同步表和接口目录。需要向量检索时，先配置向量服务再发布索引。可尝试问「列出我能查看的组织，最多 5 条」。ERP 会检查当前账号的权限和数据范围。通过受控工具执行业务写入时需要用户确认。[Harness 目录与索引同步](https://github.com/kandboxAI/ai-native-erp/blob/main/plugins/core/docs/harness-sync.md)

<a id="run"></a>

<a id="run-from-source"></a>

<a id="run-in-a-browser"></a>
## 在浏览器运行

使用上面的命令克隆、安装依赖并构建，然后在 Harness 根目录运行 `pnpm dsh web` 启动独立对话界面。开发 ERP 工具时，`pnpm web:erp` 会在标准 Web 界面加载 ERP 工具。Web 启动入口默认连接 `http://127.0.0.1:8000/`。如果 FastAPI 使用其他后端地址，设置 `ERP_API_URL`。调用工具需要为当前会话绑定已认证的 ERP 登录身份。需要直接在客户端登录 ERP 时，使用上面的组合桌面。[ERP 集成参考](integrations/erp/README.zh.md)

## 开发

DeepSeek Harness 处于开发者预览阶段，可能引入破坏兼容性的变更。上游项目使用 Cordis 实现插件架构。[Cordis](https://github.com/cordiverse/cordis) · [上游文档](https://deepseek-harness.github.io/deepseek-harness/) · [上游讨论区](https://github.com/deepseek-ai/deepseek-harness/discussions)

[开发指南](docs/development.zh.md) · [架构文档](docs/architecture.zh.md) · [贡献指南](CONTRIBUTING.zh.md) · [编码智能体规范](AGENTS.md) · [公开源码准备](docs/cookbook/preparing-open-source.zh.md)

## 引用

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## 许可证

[MIT](LICENSE)

依赖及其许可证见[第三方声明](THIRD_PARTY_NOTICES.md)。
