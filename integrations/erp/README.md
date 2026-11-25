# ERP integration

English | [中文](README.zh.md)

Run `pnpm web:erp` for the standard Web interface with governed ERP tools. Set `ERP_API_URL` to the ERP backend address. The default is `http://127.0.0.1:8000/`.

The Web and combined desktop launchers read `ERP_API_URL` from the Harness root `.env`. The combined desktop launcher also reads `ERP_DEV_URL` for the ERP frontend, which defaults to `http://127.0.0.1:8848/`. Set either address in the launching environment to override its file value.

For the combined desktop, start ERP Vite and FastAPI separately, then run `pnpm dev:desktop:erp`. Release packaging uses `ERP_DIST_DIR`, `ERP_API_URL` and optional `DSH_ERP_BRANDING`; see the [Desktop reference](../../apps/desktop/README.md#key-technical-decisions). ERP and Harness use the same generic desktop bridge (`window.erpDesktop`), request header (`x-erp-client-id`) and `erp-client://` link scheme. Upgrade and rebuild both sides together; previous branded identifiers are not accepted.

The public distribution has no built-in industry skill packs, customer documents or fixed deployment URL. ERP tools and tenant capability checks remain enabled. Explicit deployment composition can register business-specific `skillSources` on the ERP tool plugin; keep private templates outside this source distribution.
