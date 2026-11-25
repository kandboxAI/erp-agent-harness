# ERP Agent Harness

English | [中文](README.zh.md)

ERP Agent Harness provides a desktop assistant for AI Native ERP. Sign in with your ERP account to chat, look up business data, and run authorized operations alongside the ERP management interface. [AI Native ERP](https://github.com/kandboxAI/ai-native-erp) · [DeepSeek Harness upstream](https://github.com/deepseek-ai/deepseek-harness)

## Run with ERP

1. Prepare the matching ERP and Harness versions listed in the release notes. Follow the ERP setup guide to prepare PostgreSQL and Redis, start FastAPI and the ERP management frontend, and verify browser login. Keep both services running. [ERP setup guide](https://github.com/kandboxAI/ai-native-erp/blob/main/README.md)
2. Use Node.js 24.9 or later and the pnpm version declared in `package.json`. Review the safety notice, then clone Harness in a separate terminal. If the release notes specify a different tag or commit, check it out before running the pnpm commands from the Harness root. [Safety notice](SAFETY.md)

```sh
git clone https://github.com/kandboxAI/erp-agent-harness.git
cd erp-agent-harness
```

Build and launch the matching checkout from its root.

```sh
pnpm install --frozen-lockfile
pnpm build:artifacts
pnpm dev:desktop:erp
```

The first desktop launch from a clean checkout needs the compiled workspace packages. The desktop launcher loads the ERP frontend at `http://127.0.0.1:8848/` by default. Set `ERP_DEV_URL` in the Harness terminal if Vite uses a different address. [Desktop launch and packaging guide](https://github.com/kandboxAI/ai-native-erp/blob/main/plugins/core/docs/desktop-packaging.md)

Configure `LLM_GATEWAY_DEEPSEEK_API_KEY` and the model settings in the ERP backend's `plugins/core/backend/.env`, then restart FastAPI. Sign in to ERP in the desktop app and send a short message to the assistant to check model access. [ERP environment template](https://github.com/kandboxAI/ai-native-erp/blob/main/plugins/core/backend/.env.core.example)

Sync the table and API catalogs for the target ERP tenant before testing business queries. If you use vector retrieval, configure the embedding service before publishing the index. Try asking “List up to five organizations I can access.” ERP checks the account's permissions and data scope. Governed business writes require user confirmation. [Harness catalog and index synchronization](https://github.com/kandboxAI/ai-native-erp/blob/main/plugins/core/docs/harness-sync.md)

<a id="run"></a>

<a id="run-from-source"></a>
## Run in a browser

Use the clone, install and build commands above to prepare a checkout for standalone chat. Start the Web UI with `pnpm dsh web` from the Harness root. For ERP tool development, `pnpm web:erp` adds the ERP tools to the standard Web UI. The Web launcher uses `http://127.0.0.1:8000/` by default. Set `EDUCATION_ERP_API_URL` if FastAPI uses a different backend address. ERP tool calls require an authenticated ERP session binding. Use the combined desktop above for the integrated ERP sign-in flow. [ERP integration reference](integrations/erp/README.md)

## Development

DeepSeek Harness is in developer preview and may introduce breaking changes. The upstream project builds its plugin architecture on Cordis. [Cordis](https://github.com/cordiverse/cordis) · [Upstream documentation](https://deepseek-harness.github.io/deepseek-harness/) · [Upstream discussions](https://github.com/deepseek-ai/deepseek-harness/discussions)

[Development guide](docs/development.md) · [Architecture](docs/architecture.md) · [Contribution guide](CONTRIBUTING.md) · [Coding agent instructions](AGENTS.md) · [Public source preparation](docs/cookbook/preparing-open-source.md)

## Citation

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## License

[MIT](LICENSE)

See [third-party notices](THIRD_PARTY_NOTICES.md) for dependency licenses.
