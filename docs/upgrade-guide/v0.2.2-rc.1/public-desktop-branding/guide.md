---
kind: upgrade-guide
description: "The public desktop defaults to generic branding and no longer bundles private industry skills."
---

# Public desktop branding

English | [中文](guide.zh.md)

## Change

Public builds use DeepSeek Harness branding. The customer-specific Web launcher, template assets and implicit desktop skill registration are absent. `web:erp` replaces the industry-specific launcher; `dev:desktop:erp` remains available. ERP environment variables, desktop bridges and wire identifiers use generic names. The previous branded names are no longer accepted; the existing ERP tool names remain unchanged.

## Migration

1. Use the [ERP integration](../../../../integrations/erp/README.md) for the public launcher. Register required business `skillSources` explicitly through deployment composition; keep private templates outside the public source tree.
2. Supply product identity and a public icon through the suite's `DSH_ERP_BRANDING` packaging input. Configure service addresses, app ID, signing and updates locally.
3. Update ERP and Harness together. Configure `ERP_DEV_URL` for Vite, `ERP_API_URL` for FastAPI, and `ERP_DIST_DIR` for packaged frontend assets. The server must accept `x-erp-client-id`; custom bridges use `window.erpDesktop`, `erp-desktop:*` IPC and `erp:*` embedded messages. Rebuild custom links for the `erp-client://` scheme and repackage installed clients. No database migration or Session-file rewrite is required.
4. Rebuild from clean exported source; verify the default desktop and suite-specific installer separately. See [public source preparation](../../../cookbook/preparing-open-source.md). Existing installed clients are not modified by source cleanup.
