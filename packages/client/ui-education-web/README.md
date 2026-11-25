---
description: "Embed the ERP Web application as an opt-in DeepSeek Harness main panel."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-education-web

## Summary

This local Client plugin registers the ERP management application as a full-height Harness main panel and adds a matching entry to the left sidebar. Its Host half injects a validated HTTP(S) URL, exposes an SSE navigation channel, and registers the `education_erp_open_page` tool. Its browser half renders the application in a sandboxed iframe and relays validated navigation commands through `postMessage`.

## Use this package

Mount this package explicitly in a composition whose resolver declares the package dependency. The default application address is `http://127.0.0.1:8848/`; set `url` in the plugin configuration to override it. `openOnStartup` selects the panel when the browser plugin loads. The [public ERP launcher](../../../integrations/erp/README.md) registers governed tools without this iframe panel.

The embedded frame permits scripts, forms, same-origin storage, popups, and downloads. It sends no referrer and cannot access the Harness origin when the education application remains on its own origin. A per-frame random token binds the `postMessage` exchange to the iframe instance. The parent verifies the configured education origin and iframe window. Navigation accepts every absolute route inside the education SPA, including dynamically registered `/system/*` pages, while rejecting external-shaped URLs, query strings embedded in paths, fragments, control characters, and malformed encoding.

The same token-bound bridge reports router-derived page context (`path`, `fullPath`, optional route entity, params, and query) and forwards `Ctrl/Cmd+K` from the focused iframe. After login or token refresh, it sends only the current ERP access token to the verified parent. The parent binds that token to the selected Harness Session through the authenticated Host API; passwords and refresh tokens never cross the frame. The bridge never reads ERP DOM content or form values.

## Personal instructions

ERP Desktop mounts this package with `settingsOnly: true` from `apps/desktop-host/erp-llm.patch.yml`. This mode contributes personal settings without adding the legacy iframe panel, quick assistant, or iframe navigation tool. Explicit iframe compositions retain those features.

ERP Desktop adds **Personal instructions** to Harness settings. The page reads the current ERP account's identity, active role template names and effective prompt, and edits only personal response preferences (up to 2,000 characters). Saved preferences share ERP storage and apply to the next conversation turn. Role templates remain administrator-managed; preferences cannot change identity or permissions. The page appears only when Desktop Host publishes its fixed personal-settings endpoint. Sign in to ERP before loading it; failed reads or saves show an error, and failed saves retain the draft. Reload reads the latest saved ERP value.

## Quick assistant

Press `Ctrl+K` on Windows/Linux or `Command+K` on macOS anywhere in the Harness application, or use the global **Ask AI** launcher. The assistant is registered in the root `shell.overlay`, so it remains available from the Conversation, the education ERP, and other Harness main panels. The shortcut first opens a centered command-style dialog for fast intent capture. After submission it changes to a right-side drawer that has room for streamed output, tool status, errors, and follow-up turns. Text prompts are submitted through the currently selected Harness Session, so the drawer and the full Conversation share history, tool calls, and execution state.

When the education panel is currently visible, each quick prompt carries a compact education-page context envelope after the user's text. This lets references such as “this student” resolve from Vue Router params without scraping the page. Prompts sent from any other Harness panel remain ordinary context-free Session prompts. The drawer accepts one task at a time; when the selected Session is already running another request it asks the user to wait rather than misattributing the other request's streamed response. **Open full conversation** returns to the ordinary Harness Conversation without changing Sessions.

`navigationTimeoutMs` defaults to 15 seconds. A tool call fails clearly when no Harness browser page is connected, when the iframe does not acknowledge in time, when login redirects the requested page, or when Vue Router rejects navigation.

## Model Experience

The package contributes `education_erp_open_page`. The model supplies an absolute education application route plus optional primitive query values; the tool opens the education panel, waits for Vue Router to settle, and returns the actual route or a failure reason. It performs no DOM interaction and makes no ERP data changes. `education_erp_api` remains the separate read/write capability.

#### KV Cache effect

The navigation tool schema and result enter the ordinary tool path. The SSE and `postMessage` frames add no prompt content.

## Known Limitations and Deferred Work

- Navigation is limited to route changes. Reading or changing ERP data remains the responsibility of `education_erp_api`.
- Quick-assistant context is deliberately router-derived. Unsaved form fields and arbitrary page DOM are not sent to Harness.
- The quick drawer presents text output and current tool activity. Rich tool cards remain in the full Conversation.
- The current local composition broadcasts a command to connected Harness pages. It is intended for the single-window local workflow; multi-window targeting would require a browser-instance selector.
- ERP bearer binding follows the selected Session in the local browser. Harness browser authentication is not per ERP user, so different users must not share one Session concurrently. A browser that closes without logout leaves a Host-memory binding for at most five minutes; an expired ERP access token requires the embedded page to restore login before tool calls succeed.
- A deployment that sends `X-Frame-Options` or a CSP `frame-ancestors` directive refusing the Harness origin cannot be embedded.
