---
description: "Use the ERP account logged in inside the embedded ERP page for API calls and permission-scoped read-only queries."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-erp

English | [中文](README.zh.md)

## Summary

Use the current ERP account to discover business resources, call approved APIs, run scoped read-only queries, and search or read authorized knowledge documents. The backend enforces permissions and data scope; the model receives no ERP credentials.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Position shared memory uses `erp_position_memory_read` and `erp_position_memory_update`. ERP restricts automatic writes to the caller’s current position and its fixed `岗位工作.md`; it checks contribution/read scope and version tokens, then queues verified publication without per-write confirmation or review. Generic knowledge writes retain confirmation. Missing memory documents are initialized from verified duties, formal source references or shared agreements on the first useful contribution; completed practical work is not required; no new local memory store is installed. Each position has its own document; combine only experience belonging to that position. The Desktop Host requests one consolidation pass at the end of each eligible root turn, adding at least one model request; no new duties, agreements or experience means no write for an existing document; creation, submission, normal queueing/indexing, successful publication and skips are silent. The Host clears automatic maintenance reply text before live delivery and logging while preserving tool calls; failed or unreadable tool results allow a failure explanation. Human status questions retain normal replies. After submission the background publisher owns completion; no progress-only polling or user follow-up is required. Only a real failure requiring user action is reported, unless the user explicitly asks for status. Shared memory is limited to 12,000 characters.

Knowledge search and read results with an engine chunk number include a snapshot-bound `citation_url`. Answers use numbered Markdown source links without changing these addresses. The source preview proxies the current Session’s ERP identity through `/api/knowledge/read` on every open; changed sources and revoked access fail closed. It never calls WeKnora chat or bypasses ERP content protection.

For new documents, select a managed base with `erp_knowledge_list_bases`, then save an online Markdown draft with `erp_knowledge_create_document`. No existing document or edit token is required. Confirmed creation returns the document and draft version IDs for status lookup and review submission. Creation does not publish or grant read access; a local Markdown file is not an ingestion result. A 404 distinguishes missing routes from a tenant feature not enabled; an empty menu or search result does not establish an absent module. Check ERP before retrying an unconfirmed creation.

Save ERP drafts with `erp_knowledge_update_document`, check versions with `erp_knowledge_version_status`, and submit review with `erp_knowledge_submit_version`. Humans review in ERP; approval queues publication, and verified indexing makes the version effective. Drafts leave published content available.

For local edits, send exact `before` / `after` fragments in `replacements`; ERP preserves the remaining original. Omit `document_name` to keep the title. Up to 20 replacements are allowed; missing, repeated, overlapping or stale edits reject the whole operation. Use `content` only for a complete document supplied by the user, never together with `replacements` or reconstructed from truncated or redacted excerpts.

Knowledge write confirmations describe the operation and show the title, draft text, changes, or attachment name as applicable. File submission shows the selected documents and their local changes or attachments. The general ERP tool uses the same wording for supported knowledge writes and directs other knowledge writes that require confirmation to the ERP knowledge page.

New and edited online Markdown bodies support up to 200,000 characters, including punctuation, whitespace and Markdown markup. ERP validates the complete body after fragment replacements.

Mount this plugin through the ERP composition in `integrations/erp/README.md`, which supplies the ERP base URL. Log in to ERP before using these tools. Compose a user-approval answerer for writes; `writeApprovalTimeoutMs` defaults to 300,000 ms. Update the Electron client when the tool changes. Desktop requests use Electron's authenticated bridge, keeping the access token in the main process. Standalone web development uses a short-lived Session binding; no password or refresh token is sent to Harness.

The authenticated Host exposes `/api/erp/knowledge-bases` for the composer picker, backed by ERP `/api/knowledge/readable-base-options` through the existing `/api/harness/api` gateway and Desktop authentication bridge. Desktop Host publishes the picker entry before ERP sign-in completes; its data provider follows the current authenticated capabilities, so reads remain unavailable until that provider loads. This requires `knowledge:read`, rather than document-management permission, and returns only IDs and names. An `@[name](knowledge-base:id)` reference in the latest user message overrides the search base IDs for that message, including calls through `erp_api`; older `[knowledge-base:id]` references retain the same restriction. ERP intersects selected bases, optional document IDs, and current read grants before retrieval and rechecks that scope before returning results; an empty selected list never falls back to all bases. Later messages without a reference retain the usual search behavior.

Use `erp_discover` to search approved ERP resources and load selected definitions, `erp_api` for approved HTTP operations, and `erp_query` for read-only queries, grouped aggregates and approved relational plans. All tools use the current ERP account; the backend enforces permissions, protected fields and data scope. No separate ERP account or Harness query key is required. The query tool cannot execute SQL or access arbitrary PostgreSQL tables.

Use `erp_knowledge_search` and `erp_knowledge_read_document` for internal policies: search authorized documents, read pages, then cite the returned document name and chunk index. `erp_knowledge_update_document` saves an ERP draft without modifying WeKnora or interrupting the published version. Query `erp_knowledge_version_status` for its version ID and content hash, then submit the frozen version with `erp_knowledge_submit_version` after user confirmation. Only humans may review or request publication in ERP. Uploaded files (including .md) remain read-only; Wiki editing is unsupported. All knowledge tools use the current ERP login and its governed endpoints; Harness stores no WeKnora key. ERP rechecks grants and source changes on each read. Empty scope, revocation or an unavailable service provides no basis for an answer. The Agent composes its answer from returned text; these tools do not call WeKnora chat.

Skill roots are configured per ERP capability package. The provider requests the current tenant's enabled skill keys before listing or loading a package's skills, and refreshes its catalog at most 15 seconds after an ERP-side activation change. Built-in skill ownership is declared in the ERP package's `plugin.toml`; customer skills in that package's custom root inherit the same tenant gate.

Desktop Host negotiates `protocol_version = 1` and the generic `erp.data` / `erp.navigation` capabilities through `/api/plugins/ai-capabilities`. These plugins are independent of industry-package activation; the backend filters and authorizes each requested resource or operation for the current user and tenant. Navigation resolves a stable `menu_key` through `/api/harness/navigation` before sending the current authorized route to the ERP window; legacy paths must also match an authorized menu. All business packages share the same `erp_*` tool identifiers.

-----

With `knowledgeFiles: true`, explicitly associate a Markdown file with `erp_knowledge_bind_file`, then use `erp_knowledge_check_file` to review local changes. Successful file-tool edits check associated files automatically. The human chooses review submission, draft only, or defer; unchanged deferred content stays quiet. Associations and the previous local text persist in Host domain storage, scoped by Session and file identity. The frozen candidate uses the normal ERP write-grant mechanism after the human decision. Unknown write results block automatic recreation; reconcile in ERP and bind the verified document ID. This feature requires the mounted filesystem, user-question answerer, and domain storage; it never watches unrelated files or approves knowledge. Desktop ERP composition enables it.

To submit multiple explicitly selected Markdown files, bind each one to the same target library and call `erp_knowledge_submit_files`. One confirmation displays 1–10 candidates, with local Markdown diffs and original attachment names, sizes and fingerprints. Word, PDF, Excel and PowerPoint files can be submitted as new attachments up to 20 MiB each, alongside Markdown. Upload subsequent attachment versions in ERP. Each file keeps its own ERP draft, review, and result. Verify uncertain results in ERP before retrying.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Discovery posts to `/api/harness/discovery`: search by question, describe selected IDs with their `catalog_revision`, then validate and execute using those definitions. The backend combines exact names, Chinese aliases, BM25, optional pgvector retrieval and optional reranking after authorization. It returns candidate summaries before detailed definitions. Reviewed metrics execute fixed backend recipes. Missing embedding configuration uses lexical retrieval; stale revisions require a new search. The API tool posts to `/api/harness/api`. Business operations use the current ERP permissions; authentication and credential operations are isolated. The backend filters personal fields and unknown text before returning reads; hidden values do not mean empty or zero. Writes require `ctx.approval` to allow this call once after showing the exact method, path with query string, and body. The tool obtains a short-lived grant bound to the user and exact request, then retries once; the grant stays out of model-visible output. Rejection, cancellation, timeout or a missing confirmation service stops the write. Writes return status; knowledge document creation also returns the document ID, version ID and draft status. Queries post to `/api/harness/query`; include `catalog_revision` to reject outdated definitions. Tool arguments contain no user identity or credentials.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Architecture](../../../docs/architecture.md) — composition and plugin roles.
- [Adding a tool](../../../docs/cookbook/adding-a-tool.md) — tool registration and presentation.

-----

<a id="model-experience"></a>
## Model Experience

### ERP tool schemas

#### What the model sees

The model sees standard ERP and position-memory [tool schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-erp). Discovery returns authorized candidates, selected definitions and reviewed metric descriptions. Query operation `plan` joins described executable relations by ID, up to execution.max_joins returned by describe; the backend applies permissions and data scope separately to each table. Plan aggregates deduplicate root records per group; aggregate fields must belong to the root. When `group_totals_additive` is false, group values may overlap and must not be summed as a total. Row results preserve joined-row grain; `total` counts output rows or groups. The plan and its pagination options go inside `plan`; only `operation`, `plan` and the required `catalog_revision` belong outside it. The access token is never a tool argument.

#### Token effect

The ten standard tool schemas, plus two file tools when enabled, add fixed context while mounted. Discovery returns at most 12 candidates and describes at most six IDs per call; it avoids loading the complete table and API catalogs. Returned data is bounded by backend limits and the configured response-length cap.

#### KV Cache effect

The tool schema prefix remains stable across calls with unchanged configuration. Tool calls and results append to the conversation; changing tool registration or descriptions changes that prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The database catalog is an explicit backend allowlist, not automatic exposure of all tables. New resources need a repository and authorization review.
- Embedding keys, pgvector and semantic definitions live on the ERP server. Build the metadata index explicitly after approved definitions or models change; no business rows enter the vector index. Plans allow approved equality relations only, without SQL, HAVING or mixed-entity aggregate grain. Complete write-parameter schemas remain deferred.
- The backend's existing `related` scope returns no rows until the corresponding relationship rule is implemented.
- Standalone web bindings last at most five minutes without browser renewal. Desktop credential failures request ERP login; neither mode can query without a valid account.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The browser-to-Host binding is Session-specific and kept only in process memory. Keep credentials out of Session events, model-visible text, tool arguments, and persisted configuration.

</details>
