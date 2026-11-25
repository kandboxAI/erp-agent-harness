# ERP server assistant

The ERP FastAPI process launches this restricted `sdk-minimal` profile through the official Python SDK. Only ERP discovery, governed API calls and structured database queries are model tools. Shell tools and the ordinary DeepSeek provider are disabled. No Office, filesystem, browser or plugin-management tools mount.

`runtime.mjs` binds the current ERP access token to the authenticated request bridge and the short-lived model credential to the ERP gateway provider. Credentials arrive in process environment variables and never enter configuration files or model-visible tool arguments. Write calls use the ERP facade's permission checks and one-use grant. The approval service forwards each exact action preview to the authenticated ERP user; rejection and timeout fail closed. The profile enables persisted session resume; FastAPI supplies a private home per tenant, user and conversation and starts a new process with fresh credentials for each turn.

Build with `pnpm install --frozen-lockfile` and `pnpm build`. Deploy `pnpm-workspace.yaml` and `pnpm-lock.yaml` together; the workspace override keeps Markdown token types on one version across parser extensions. Install `python/sdk` into the ERP Python environment with `uv pip install --python <erp-python> --no-deps -e <dsh-root>/python/sdk`. Set the ERP `SERVER_ASSISTANT_DSH_ROOT` to this repository. FastAPI launches the canonical source `dsh` CLI under Node directly, with no CMD/shell parent. Do not launch it separately with customer credentials.

The ERP maintenance guide is `erp/docs/server-assistant-local-testing.md`. It documents backend settings, web/miniprogram entry points and deployment limits.

Keyless real-profile test, with the ERP Python environment:

```powershell
& '<erp-root>/backend/.venv/Scripts/python.exe' -m pytest integrations/server-assistant/test_runtime.py -q
```
