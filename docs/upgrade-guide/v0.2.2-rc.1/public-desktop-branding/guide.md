---
kind: upgrade-guide
description: "The public desktop defaults to generic branding and no longer bundles private industry skills."
---

# Public desktop branding

English | [中文](guide.zh.md)

## Change

Public builds use DeepSeek Harness branding. The customer-specific Web launcher, template assets and implicit desktop skill registration are absent. `web:erp` replaces the industry-specific launcher; `dev:desktop:erp` remains available. ERP environment variables, desktop bridges and wire identifiers use generic names. The public ERP tools use `erp_api`, `erp_discover`, `erp_query` and `erp_open_page`. The ERP plugins use `@deepseek-ai/dsh-tool-erp` and `@deepseek-ai/dsh-client-ui-erp-web`, and their Harness-local endpoints are under `/api/erp/`.

## Migration

1. Replace `EDUCATION_ERP_API_URL` with `ERP_API_URL` in the environment used by `pnpm web:erp`. Restart the launcher and verify that an authenticated ERP tool call reaches the configured backend. Register required business `skillSources` through deployment composition and keep private templates outside the public source tree. [ERP integration](../../../../integrations/erp/README.md)
2. Supply product identity and a public icon through the suite's `DSH_ERP_BRANDING` packaging input. Configure service addresses, app ID, signing and updates locally.
3. Update ERP and Harness together. Configure `ERP_DEV_URL` for Vite, `ERP_API_URL` for FastAPI, and `ERP_DIST_DIR` for packaged frontend assets. The server must accept `x-erp-client-id`; custom bridges use `window.erpDesktop`, `erp-desktop:*` IPC and `erp:*` embedded messages. Rebuild custom links for the `erp-client://` scheme and repackage installed clients. No database migration or Session-file rewrite is required.
4. Update custom profiles, tool allowlists and prompts to use the ERP names above. Update custom iframe clients to use `__dsh_erp_bridge` and the Harness-local ERP endpoints. Rebuild any ERP discovery index after the ERP backend upgrade. Verify that discovery returns `erp_*` tool names and an authorized read succeeds. Existing Session files retain their recorded tool names.
5. Rebuild from clean exported source; verify the default desktop and suite-specific installer separately. See [public source preparation](../../../cookbook/preparing-open-source.md). Existing installed clients are not modified by source cleanup.
