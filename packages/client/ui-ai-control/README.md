---
description: "Report one selected AI answer to the enterprise control center and read its handling status."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-ai-control

English | [中文](README.zh.md)

## Summary

Report a finalized Chat answer to the enterprise control center after reviewing editable question and answer excerpts. Check the latest handling status and human reply for that message. ERP owns feedback permissions and processing. ERP Desktop shows enterprise feedback only; ordinary profiles retain native feedback.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

ERP Desktop inserts this plugin as a separate composition row and disables the native Like/Dislike UI, message-feedback service and native /feedback handler in its own overlay. Ordinary Web and non-ERP profiles retain native feedback. This plugin has no configuration fields. The desktop connector supplies authenticated feedback and image routes. Ordinary Web profiles do not mount this package; mounting it explicitly requires the enterprise transport.

The ERP tenant must enable ai_control and grant ai_control:feedback:submit plus ai_control:feedback:mine to the user. Operators use ERP with ai_control:feedback:handle and its configured data scope. Knowledge is optional. Tenant migration and real desktop acceptance remain deployment steps.

The small dislike icon under a completed answer opens its ERP confirmation form. The client-owned /feedback command opens the same Session dialog for the latest completed answer; it does not submit or wake an Agent. With no completed answer the dialog explains that a target is required. The form contains the question, selected answer, category, notes and images you select or paste. Select images or press Ctrl+V anywhere in the open form; thumbnails support preview and removal. You can attach up to 6 JPG, PNG or WebP images, 2 MB each. Selection or paste starts the upload; feedback submission stays disabled until uploads finish. Chat attachments are never attached automatically. A request for a human reply is optional. Unchanged content reuses its submission ID after an unconfirmed response, including when the dialog is closed and reopened; editing a failed submission creates a new ID. A rejected request leaves the draft available. Submission errors and empty status results appear beside the footer actions, outside the scrolling fields.

Once a business text answer without tool calls is logged in the visible conversation, the plugin independently reviews its user request and answer through the existing ERP model gateway, before automatic position-memory maintenance. Maintenance replies do not trigger a review. An incomplete verdict must quote evidence from the answer; explicit ellipses may join quoted spans only when every span occurs in source order. The plugin asks whether to send feedback, with Write feedback and Not now choices. Write feedback opens an editable Not resolved draft with the reason in its notes. Submission includes only the declared feedback fields and always requires confirmation. Incomplete and failed review results appear in dismissible popups when feedback or retry actions are available. Clarification and uncertain results remain hidden, including when no reviewable text is available; a popup with only Not now is never shown. While checking, a compact borderless row above the composer pairs a spinner with status text. Review failures include a safe error category, Retry check and Report manually actions. An existing draft is preserved until an explicit open action. History loads, reconnections, cancelled turns and a dismissed suggestion do not repeat the check. A newer turn cancels presentation of an older pending review.

Status queries resolve the latest submission for this message and the currently authenticated ERP user. No receipt or bearer token is retained in local storage. The desktop main process retains the ERP token.

Submission results separate “My feedback” from “Human reply”, with the status and feedback ID at the top. Notes from a successful submission remain visible, and its question and response excerpts can be expanded. An explicit message appears when no human reply is available. A status query returning a different feedback ID does not display the current draft as submitted content.

<a id="understand-the-implementation"></a>
## Understand the implementation

The plugin owns the review prompt, verdict parsing, live-turn observation and popup policy. ERP checks feedback permission and retains model authentication, redaction, quotas and usage records. The plugin contributes an icon to conversation.chat.assistant-actions, a shared dialog to conversation.input.overlay and a client-owned /feedback action. Its profile row controls activation; no extra boot-global flag can silently suppress these registrations. [message.ts](src/client/message.ts) reads the loaded Chat projection; [Feedback.tsx](src/client/Feedback.tsx) presents editable excerpts and explicit confirmation. The [desktop connector](../../../apps/desktop-host/src/erp-desktop-tools.ts) forwards fixed ERP feedback requests. The Electron main process obtains a signed upload target and sends image bytes directly to storage without forwarding the ERP token. Confirmation sends file IDs; ERP binds the files and feedback in one transaction and controls attachment access. ERP owns all durable processing records.

<a id="model-experience"></a>
## Model Experience

A qualifying new answer adds one independent model request with at most 1,024 output tokens. Its inputs contain only this turn's user request and final answer, each at most 20,000 characters. Images, reasoning, tool results and earlier turns are excluded. The review does not wake the conversation Agent, change its request prefix, submit feedback or record native feedback telemetry. The review uses the ERP gateway's existing quota and usage accounting.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- The action targets the closing finalized answer in Chat. Streaming, interrupted and trajectory messages have no enterprise feedback action.
- A preceding question outside the loaded history is empty. Long text is clipped to the visible editable 20,000-character excerpts; reasoning, original Chat attachments, tool results and other messages are excluded. Only images explicitly selected or pasted into this form are added.
- Completion review only covers new, normally finished turns while the conversation is mounted. Missing or oversized text stays unreviewed; text alone cannot verify real business results. No review result is persisted across application restarts.
- Drafts are not an offline queue and do not survive application shutdown. A normal Like/Dislike event does not create an ERP issue.
- Status checks show ERP replies; original-session reply injection and continuous human takeover are not implemented.

<a id="dev-note"></a>
### Dev Note

Desktop Host references `tsconfig.host.json` for the review request and verdict parser. The Client aggregate references `tsconfig.client.json`; the package root is a solution-only config. Host compilation completes before Typert generates the Remote declarations consumed by the browser code.

Focused component tests use the production Session slot renderer to cover selected-message excerpts, confirmation, an unconfirmed submission retry and status rendering. The root Client aggregate references this package and typechecks its tests during the desktop build. The built-browser regression replays a recorded Session, verifies icon visibility without a boot-global flag, covers image paste, selection, removal and explicit submission to mocked ERP endpoints, and opens the same dialog through /feedback. ERP tenant and packaged desktop acceptance require the target environment.
