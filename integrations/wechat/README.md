---
description: "Bundled dsh-wechat 0.16.2 for Web and Desktop, including compatibility patches, login, and packaging."
---

# Bundled WeChat integration

English | [中文](README.zh.md)

## Summary

The Web application bundle depends on exactly `dsh-wechat@0.16.2` and enables it for both Web and Desktop. The [compatibility patch](patches/dsh-wechat@0.16.2.patch) preserves localized settings labels and prevents cancelled QR logins from replacing current login state or tokens. The plugin supports DSH `>=0.2.1-0 <0.3.0-0`; users do not install the plugin separately.

## Table of Contents

- [Configuration](#configuration)
- [Verification and limits](#verification-and-limits)

<a id="configuration"></a>

## Configuration

The dependency and enabled row belong to `packages/bundle/web-app`. The root `pnpm-workspace.yaml` applies the patch during source installation. Desktop packaging copies the same patch into its independent runtime installation before resolving production dependencies, and includes the patched plugin in the application payload. Login credentials are not build inputs.

The default `storageDir` is `wechat` inside the current profile directory, keeping Web and Desktop credentials separate. `workSteps: minimal` sends the final answer per turn. Profile overrides may set a different storage or working directory. Do not commit or share login files. In ERP mode, the current Desktop login supplies ERP identity and the model gateway.

Start the existing development artifacts from the repository root with `ERP_DEV_URL=http://127.0.0.1:8848/` set in the process environment:

```powershell
pnpm run start:desktop
```

Open Settings → WeChat, or the QR route `/wechat/qr` on the running application's origin: [Web at the default port](http://127.0.0.1:3080/wechat/qr) or [Desktop at the default port](http://127.0.0.1:19387/wechat/qr). Scan with the account owner's WeChat. To disable the integration, add `disabled: true` to the profile's `dsh-wechat` override and restart the application; retain login and Session data if you intend to resume.

Starting another QR login cancels the previous login's requests and polling waits. A cancelled login cannot update the QR code, save a token, or overwrite the current login status. Logout and plugin unload also cancel any pending QR login; an active login still fails after five minutes without confirmation.

<a id="verification-and-limits"></a>

## Verification and limits

Run the focused checks against the project's patched dependency:

```powershell
node --test integrations/wechat/compat.test.mjs
```

QR login and a basic text reply have been verified in the development Desktop. Media transfers, approval cards, and restart recovery still require manual verification. This integration is for one user: the plugin binds the first incoming peer and does not provide tenant or ERP-user isolation. Keep the application running and the intended ERP user signed in.

## Dev Note

The patch targets the npm package's shipped `dist` files and declarations; no new DSH runtime package is introduced. The tests require project dependencies and run explicitly rather than through the repository unit-test aggregate. Desktop's runtime-payload smoke also checks the shipped plugin version and cancellation behavior.
