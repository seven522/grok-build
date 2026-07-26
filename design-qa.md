# Design QA — running-shoe mark across light and dark themes

Date: 2026-07-23

## Source and implementation evidence

- Source visual truth: `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-79330670-1d86-4399-8179-6751292ca7cc.png` (light), `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-85e2411c-6b2a-4ec1-93ec-7b010dab94f7.png` (dark), and the follow-up light-theme regression `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-0080d6b8-7cc9-4bc5-bb34-2587d87ad349.png`. The red frames are annotations, not product chrome.
- Browser-rendered implementation: fresh local Vite preview at `http://127.0.0.1:5173/`, checked at a 1280 × 720 CSS-pixel desktop viewport in empty-chat light, dark, and collapsed-sidebar light states after a server restart.
- Shared scope: the mark beside the sidebar product name, the centered empty-chat lockup, and the collapsed-sidebar brand use the same theme rule.

## Required fidelity surfaces

- Light theme: preserve the existing black running-shoe linework while the baked warm-white source background fully blends into the pale workspace and sidebar.
- Dark theme: render the mark as a high-contrast light linework symbol without leaving a conspicuous light rounded-square tile behind it.
- Motion: the existing short theme transition is retained; the mark's filter and blending follow the same transition so a theme switch has no jump or layout shift.
- Copy and layout: `Grok Build`, all sidebar labels, the composer, spacing, and icon dimensions are unchanged.

## Interaction and accessibility verification

- Browser readback in light theme: `filter: brightness(1.05)`, `mix-blend-mode: multiply` for the centered mark, sidebar mark, and collapsed-sidebar mark.
- Browser readback in dark theme: `filter: brightness(1.05) invert(1) grayscale(1) contrast(1.05)`, `mix-blend-mode: screen` for the centered and sidebar marks.
- Full-view and focused icon review confirm that light preserves the black shoe without a warm-square halo, while dark retains the high-contrast white shoe with no pale badge.

## Findings and resolution

1. P2 before initial fix: the opaque light image background became a distracting pale square on the dark UI.
2. P2 follow-up: the initial dark-only treatment left the same baked warm-white tile visible in the light workspace, as shown by the follow-up reference.
3. Fix: brighten the source background to pure white before applying a theme-appropriate blend mode—`multiply` in light and inverted `screen` in dark—through shared tokens applied to all running-shoe placements.
4. Post-fix review found no actionable P0, P1, or P2 issue within the requested theme-adaptation scope.

## Verification

- `npm run test:typography` — passed.
- `npm run build` — TypeScript and Vite production build passed; the existing bundle-size warning remains non-blocking.
- `./scripts/coding-assistant/verify.sh webui` — registry 6/6, runner 1/1, navigation 2/2, automation 1/1, typography, and production build passed.

final result: passed

---

# Design QA — Artifact preview states and Markdown rendering

Date: 2026-07-25

## Source and implementation evidence

- Source visual truth: `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-9db405be-2e05-482e-bb96-c5f38d6c5ff5.png` (2760 × 1800 px), showing a missing task-linked Markdown file as a raw `ENOENT` message with an absolute local path. The red frame is a user annotation, not product chrome.
- Final missing-file implementation: `/Users/qixiaotong/.codex/visualizations/2026/07/25/019f9952-ca8a-7001-b7cb-05908042fad6/runbuild-preview-missing-file.png` (1952 × 1279 CSS-pixel viewport), restored from the same real `游戏开发 → 继续开发游戏` task and the same missing file link.
- Default-window implementation: `/Users/qixiaotong/.codex/visualizations/2026/07/25/019f9952-ca8a-7001-b7cb-05908042fad6/runbuild-preview-missing-file-default.png` (1280 × 720), confirming the complete `未生成` badge and both recovery actions at the normal 420px Inspector width.
- Final ready-file implementation: `/Users/qixiaotong/.codex/visualizations/2026/07/25/019f9952-ca8a-7001-b7cb-05908042fad6/runbuild-preview-markdown-ready.png` (1952 × 1279), showing an existing project Markdown specification rendered as a readable document.
- Same-input comparison: `/Users/qixiaotong/.codex/visualizations/2026/07/25/019f9952-ca8a-7001-b7cb-05908042fad6/runbuild-preview-comparison.png`. The source and implementation were normalized to the same 1279px height and placed side by side without changing their aspect ratios.

## Findings and fixes

1. P1 baseline: a normal product state—an Agent mentioned a file before creating it—was displayed as a filesystem exception. The preview now maps only the structured `404 file_not_found` response to a calm `文件尚未生成` state and never exposes the absolute project path in the panel.
2. P1 baseline: project Markdown was displayed as source text, so headings, lists, tables, and inline code did not read like an Agent deliverable. Existing `.md` files now render through the product's existing `ReactMarkdown`, GFM, typography, table, and code treatments.
3. P2 baseline: the preview offered no recovery path. The missing and generic failure states now expose `刷新` and `查看执行`; an active task automatically retries a not-yet-created file without flashing the loading card between attempts.
4. P2 visual pass: the first final-package inspection showed the status badge squeezed to one character at the 420px Inspector width. The title region now owns the flexible overflow space and the action group is non-shrinking; `未生成` and `已就绪` remain fully visible while long filenames ellipsize.
5. The final comparison found no remaining actionable P0, P1, or P2 issue in the artifact-preview scope. The Inspector shell, three tabs, project/task context, dark-theme tokens, existing icon family, and resizable 360–420px ownership boundary remain unchanged.

## Interaction, responsive, and accessibility evidence

- Restoring the real task and opening its missing document produced the semantic status `文件尚未生成`, a short explanation, a native `刷新` button, and a native `查看执行` button. Refresh retained the same safe state; `查看执行` selected the real execution tab and exposed its 12 recorded steps.
- Opening `docs/superpowers/specs/2026-07-25-urban-rpg-vertical-slice-design.md` from the file tab produced the `已就绪` badge plus semantic headings, tables, lists, and code. The filename and status remain readable together at the production Inspector width.
- Loading, not-created, and failure surfaces use `role=status` or `role=alert` with polite live-region behavior. Controls keep existing focus behavior and Tabler icons; state meaning is communicated by copy and icon as well as color.
- The final 1952 × 1279 comparison showed no clipped badge, overlapping controls, horizontal page overflow, broken card geometry, or unreadable long path. No new image asset, custom SVG, CSS drawing, gradient, or decorative effect was introduced.
- Browser logs contained an existing burst of task-ledger `idempotencyKey 已用于不同事件` errors while restoring historical execution events. The missing-file and Markdown preview requests completed and rendered correctly; this ledger issue is outside the artifact-preview change and was not expanded into a task-lifecycle refactor.

## Verification

- `npm run test:registry` passed 8/8, including the structured 404 response and absolute-path non-disclosure.
- `npm run test:conversation` passed 31/31, including artifact format and safe failure-state projections.
- `npm run test:frontend-architecture`, `npm run test:typography`, and `npm run build` passed. The existing Vite chunk-size advisory remains non-blocking.
- `./scripts/coding-assistant/verify.sh webui` passed the complete registry, runner, navigation, conversation, automation, desktop, architecture, typography, WebUI build, desktop-main, and preload checks.
- `PERSONAL_AGENT_PACK_BINARY=/tmp/grok-build-target/debug/xai-grok-pager npm run desktop:pack` passed after the final responsive badge fix. `codesign --verify --deep --strict` passed for `webui/release/mac-arm64/RunBuild.app`; the package retains the expected local ad-hoc signature.

final result: passed

---

# Design QA — Task recovery status layout

Date: 2026-07-25

## Source and implementation evidence

- Source visual truth: `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-589d2565-3f15-417c-8839-1f01f62e488b.png` (2760 × 1800 px, dark desktop), showing the recovery message, the Godot message, and the stop action occupying the same vertical area.
- Browser implementation: `artifacts/design-qa/recovery-status-desktop.png` (1380 × 900 CSS-pixel capture) and `artifacts/design-qa/recovery-status-narrow.png` (520 × 900 CSS-pixel capture). The production component was rendered with a temporary `prompt_timed_out` visual fixture; the fixture was removed after capture and the real reliability state remains authoritative.
- Density normalization: the source was downsampled from 2760 × 1800 to 1380 × 900 as `artifacts/design-qa/recovery-status-source-normalized.png`; the implementation capture is 1380 × 900. The browser reported a 1380 × 900 CSS viewport and device pixel ratio 2, while its screenshot API returned the CSS-pixel image.
- Full-view comparison: `artifacts/design-qa/recovery-status-comparison.png`.
- Focused top-region comparison: `artifacts/design-qa/recovery-status-focused-comparison.png`.

## Findings and comparison history

1. P1 source defect: the status Paper and conversation body were sibling grid items inside a stage with only one explicit row. The implicit second row claimed the conversation height, collapsed the status row, and allowed the recovery copy to overlap the Godot message.
2. Fix: the stage now receives `has-recovery-state` only while the status is visible and uses `auto minmax(0, 1fr)`. The status therefore owns its intrinsic height and the conversation begins at its bottom edge.
3. P2 source drift: the original status surface stretched almost across the workbench and read like a blocking warning. The final status bar uses the existing 780px chat-shell width, compact 56px desktop height, neutral/semantic RunBuild tokens, and preserves the existing icon, explanation, reconnect, and stop actions.
4. Responsive fix: below 560px the copy and actions wrap into an 84px status bar. The action row stays right aligned, the document has zero horizontal overflow, and the conversation remains below the status.
5. Post-fix geometry: desktop status bottom and conversation top both measured 123.99px; narrow status bottom and conversation top both measured 147.99px. Computed overlap was 0px in both captures.

## Required fidelity surfaces

- Fonts and typography: existing semantic label, caption, weight, and line-height tokens are retained; no new font or hard-coded text scale was introduced.
- Spacing and layout rhythm: the bar aligns with the existing chat/composer width, uses compact 9–12px internal spacing, and reserves its own grid row instead of floating over content.
- Colors and visual tokens: warning, error, border, panel, muted-text, and danger tokens come from the existing light/dark RunBuild theme.
- Image and icon quality: there are no new raster assets; the existing Tabler alert, refresh, and stop icons remain in use.
- Copy and content: recovery text and button labels are unchanged. The Godot message belongs to the conversation and is no longer visually merged with recovery state.

## Interaction, accessibility, and responsive evidence

- The status retains `role=status` for non-error states and `role=alert` for errors, with `aria-live=polite`. The `请求停止` button remained separately exposed in the accessibility tree.
- Desktop and 520px captures show the persistent composer fully visible. The narrow capture has no horizontal overflow and no status/conversation intersection.
- Browser console inspection and the final source check found no temporary fixture remaining; `activeReliableTask` and `recoveryState` use their real reliability projections.

## Verification

- `npm run test:navigation` passed 31/31, including timeout and reconnect reliability cases.
- `npm run test:typography` passed.
- `npm run build` passed.
- `./scripts/coding-assistant/verify.sh webui` passed: registry 7/7, runner 7/7, navigation 31/31, conversation 27/27, automations 12/12, desktop 72/72, frontend architecture, typography, WebUI production build, desktop main bundle, and preload bundle. The existing Vite chunk-size advisory remains non-blocking.
- `npm run desktop:pack` passed after moving a stale partial Electron output to `/tmp/runbuild-pack-recovery.cI9bjp/mac-arm64`; `codesign --verify --deep --strict` passed for the new ad-hoc-signed `release/mac-arm64/RunBuild.app`. The already-running desktop process was not restarted because active Agent processes were present.

final result: passed

---

# Design QA — Clean chat transcript and clickable resources

Date: 2026-07-25

## Source and implementation evidence

- Source visual truth: `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-de0ecf5b-a712-464a-8016-2fb3b9afa3a8.png` (2760 × 1800 px), showing the leaked `<system-reminder>` background-command payload in a user bubble at 16:21.
- Packaged implementation: `/Users/qixiaotong/.codex/visualizations/2026/07/25/019f9726-22a2-7833-9749-650e070a3e70/chat-clean-internal-log-filtered-bottom.jpeg` (1178 × 768 px), restored from the same real `游戏开发` project task at the same 16:21 conversation position.
- File interaction implementation: `/Users/qixiaotong/.codex/visualizations/2026/07/25/019f9726-22a2-7833-9749-650e070a3e70/chat-project-file-preview.jpeg` (1178 × 768 px), showing `.summer/build-plan.md` opened from the reply into the existing right-side task-context preview.
- Same-input comparison: `/Users/qixiaotong/.codex/visualizations/2026/07/25/019f9726-22a2-7833-9749-650e070a3e70/chat-before-after-comparison.png` (2356 × 768 px). The 2760 × 1800 source was normalized to 1178 × 768 and placed beside the native-density packaged capture; both represent the dark desktop chat state.

## Findings and fixes

1. P1: ACP synthetic context was replayed as an ordinary user message, exposing a call identifier, shell command, duration, and local paths. Synthetic metadata and protocol-prefixed blocks are now rejected before insertion, and the same filter is applied to restored cached messages so existing tasks clean up without rewriting history.
2. P1: Markdown file links and file-looking inline code had no product-owned open behavior. HTTP(S) links now open externally; current-project paths become compact file controls and open in the existing task-context preview.
3. P1: arbitrary local paths cannot be trusted merely because an Agent printed them. Desktop opening now resolves real paths against the default workspace and registered project roots, rejects traversal, symlinks, and executable-shaped files, and surfaces a normal in-app error for unsupported targets.
4. P2: home-relative paths such as `~/.codex` were initially eligible for project-relative parsing. They now remain plain code, avoiding a misleading link to `<project>/~/.codex`.
5. The before/after comparison shows the leaked green protocol bubble removed while the surrounding Agent plan, 16:21 timestamps, task navigation, composer, typography, colors, and message rhythm remain unchanged. The recovered vertical space improves scanning without introducing a replacement status card.

## Required fidelity surfaces

- Fonts and typography: existing RunBuild message, inline-code, metadata, and button tokens are retained; file controls use the same inline-code scale and line height.
- Spacing and layout rhythm: the transcript width and composer are unchanged. Removing the synthetic bubble closes only the false turn's space; file controls stay inline and ellipsize rather than widening the message column.
- Colors and visual tokens: file controls reuse the existing accent, surface, border, and focus tokens in dark and light themes; no new hard-coded palette is introduced.
- Image and icon quality: the existing Tabler file-code icon is used at 14px. No substitute artwork, emoji, or custom SVG was added.
- Copy and content: internal command text is absent from the user transcript. User/Agent prose is preserved verbatim, and unsupported local resources receive a short Chinese explanation instead of a dead navigation attempt.

## Interaction and accessibility evidence

- Reopening the rebuilt `RunBuild.app`, restoring `RPG Game Development Project Start`, and moving to the original 16:21 position returned `systemReminder=false`, `backgroundTask=false`, and no leaked `call-c52fbeb4` in the accessibility tree.
- Clicking the real `.summer/build-plan.md` control opened `任务上下文 → 预览`, displayed the document, and produced no visible open error.
- File controls are native buttons with a filename label and full-path help/title; web resources remain anchors with external-window semantics. Focus-visible styling uses the existing accent token.
- Primary interactions tested: task restore, transcript jump to the reported position, project-file activation, task-context opening, and document preview readback.

## Comparison history

- Initial P1/P2 findings: synthetic protocol content remained visible; reply resources had no reliable product-owned open path; `~/...` could be misresolved.
- Fixes: ingress plus replay filtering, Markdown/inline-code resource rendering, trusted desktop open handler, existing inspector integration, and home-relative parsing guard.
- Post-fix evidence: the combined before/after image contains no internal reminder bubble, and the separate packaged screenshot shows a real project document opened from the reply.

## Verification

- `npm run test:conversation` passed 26/26 after the final parsing guard, covering protocol filtering, ordinary-text preservation, web/file parsing, relative escape rejection, and generated-media boundaries.
- `./scripts/coding-assistant/verify.sh webui` passed the complete registry, runner, navigation, conversation, automation, desktop (72/72), frontend-architecture, typography, production WebUI, desktop-main, and preload checks.
- The final `RunBuild.app` was rebuilt after the last source change. `codesign --verify --deep --strict` passed with the expected local ad-hoc identifier `local.personal-agent.desktop`, the reopened package retained the clean transcript, and its local page returned HTTP 200.

final result: passed

---

# Design QA — Agent question reply card

Date: 2026-07-25

## Source and implementation evidence

- Source visual truth: `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-1008ae5c-6f5a-43de-8746-5aab9d3350a2.png` (2760 × 1800 px), dark theme, live single-choice Agent question. The red rectangle is the user's annotation, not product chrome.
- First packaged implementation: `/Users/qixiaotong/.codex/visualizations/2026/07/25/019f9726-22a2-7833-9749-650e070a3e70/question-card-light.png`, `question-card-light-selected.png`, and `question-card-dark-selected.png`, captured from `webui/release/mac-arm64/RunBuild.app` with a real `ask_user_question` request.
- Compact follow-up implementation: `/Users/qixiaotong/.codex/visualizations/2026/07/25/019f9726-22a2-7833-9749-650e070a3e70/question-card-compact-dark.png` and `question-card-compact-dark-selected.png`, captured from the rebuilt packaged desktop app at 1178 × 768 px in the same dark, single-choice state.
- Full-view follow-up comparison: `/Users/qixiaotong/.codex/visualizations/2026/07/25/019f9726-22a2-7833-9749-650e070a3e70/question-card-compact-full-comparison.png` places the first and compact packaged implementations side by side at their native 1178 × 768 px dimensions.
- Focused follow-up comparison: `/Users/qixiaotong/.codex/visualizations/2026/07/25/019f9726-22a2-7833-9749-650e070a3e70/question-card-compact-focused-comparison.png` uses equal 720 × 420 px crops to compare the selected card and composer relationship before and after the compact-placement change.
- Headerless follow-up source: `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-8fa7924b-e708-4c5d-914b-b8b6d44ae005.png`; the user asked to remove the redundant `Agent 正在提问` strip and reduce the remaining type size.
- Final packaged implementation: `/Users/qixiaotong/.codex/visualizations/2026/07/25/019f9726-22a2-7833-9749-650e070a3e70/question-card-headerless-dark-selected.jpeg`, captured at 1178 × 768 px with the first option selected. The same-state full and focused comparisons are `question-card-headerless-full-comparison.png` and `question-card-headerless-focused-comparison.png`.

## Findings and fixes

1. P1 baseline: the entire question surface used a green success-style wash, while every answer was a dense gray button. The panel did not distinguish question context, option selection, progress, and final submission clearly.
2. Fix: the card now uses the existing neutral RunBuild panel tokens, a separated header and footer, a compact `单选` or `可多选` badge, and bordered option rows built with Mantine `UnstyledButton` plus Tabler radio/checkbox icons.
3. Teal is reserved for actual state: the selected option receives a subtle tinted border and fill, and the primary action becomes active only after every question has an answer. Unselected rows stay neutral in both themes.
4. The existing ACP answer transport, cancel path, single/multiple selection behavior, task state, and composer remain unchanged. The visual layer calls the existing `toggleQuestionOption` and `resolveQuestion` handlers.
5. P2 follow-up: the first redesign still lived at the end of the scrollable conversation and used roughly 350px of vertical space in the 1178 × 768 desktop capture, so it could appear detached from the response control and consume too much of the reading area.
6. Fix: only the Agent question card now moves into a dedicated dock immediately above the composer. Its maximum height is 292px/36vh, option rows shrink from 58px to 42px, the header/footer spacing is reduced, long descriptions truncate safely, and multi-question content scrolls inside the card instead of expanding the whole page. Permission and plan approvals retain their existing inline placement.
7. The post-fix focused comparison found no remaining actionable P0, P1, or P2 issue in the requested compact-placement scope. The selected card is visibly shorter and spatially attached to the composer without covering it.
8. P2 final follow-up: once the card was docked above the composer, the visible `Agent 正在提问` header repeated context that was already clear from the question and blocked extra vertical space.
9. Fix: the visible header row was removed while its accessible name remains on the live status container. Question and option labels now use 13px type, descriptions use 12px type, option rows use a 38px minimum height, and the card ceiling is 232px/30vh. The final focused comparison confirms the card begins directly with the question and is materially shorter without reducing answer clarity.

## Interaction, accessibility, and responsive evidence

- Packaged desktop accessibility exposed the question as one labeled radio group with three radio options. Before selection all values were `0` and `提交给 Agent` was disabled; after selecting `本地开发（推荐）`, its value became `1` and the submit action became enabled.
- In the compact packaged build, the question group immediately precedes the composer in the accessibility tree. The composer remains present and readable while the Agent question is active.
- In the final packaged build, the removed visual header remains available as `aria-label="Agent 正在提问"`; the actual question, `单选` hint, three radio choices, cancel action, and submit action remain separately exposed.
- Light and dark packaged captures showed the same hierarchy without clipping, horizontal overflow, or composer overlap. The existing narrow breakpoint stacks the footer actions and preserves full-width tap targets.
- The option control exposes `aria-checked`, uses semantic radio/checkbox roles, and retains a visible focus ring. Selection is not communicated by color alone because the icon changes from an empty circle/square to a checked state.
- QA did not submit the synthetic answer. A disposable independent task was used so the user's original conversation was not modified.

## Verification

- `npm run build` — passed after the component and stylesheet changes; the existing Vite chunk-size advisory remains non-blocking.
- `npm run test:conversation` — passed 24/24.
- `npm run test:typography` — passed.
- `PERSONAL_AGENT_PACK_BINARY=… npm run desktop:pack` — passed and produced the packaged app used for the live captures.

final result: passed

---

# Design QA — compact slash-command palette

Date: 2026-07-25

## Source and implementation evidence

- Source visual truth: `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-e2bd8db3-1445-4bd6-bdf8-9e72af76a4f2.png` (2760 × 1800 px). The red rectangle is the user's annotation around the oversized command surface, not product chrome.
- Browser-rendered implementation: `artifacts/design-qa/command-menu-final-1952x1273.png` (1952 × 1273 px, CSS viewport 1952 × 1273, DPR 1), dark theme, blank independent task, `/` entered, navigation open.
- Narrow implementation: `artifacts/design-qa/command-menu-560x900.png`, captured at the narrow breakpoint with navigation collapsed and a filtered `/n` result.
- Full-view comparison: `artifacts/design-qa/command-menu-comparison.png` preserves both complete app captures at equal comparison widths. The runtime task state and native screenshot sizes differ, so this image is contextual rather than pixel-fidelity evidence.
- Focused comparison: `artifacts/design-qa/command-menu-focused-comparison.png` places the annotated source command/composer region and implementation command/composer region together on equal 750 × 760 panels without stretching. This is the authoritative visual evidence for the requested redesign.

## Required fidelity surfaces

- Fonts and typography: existing RunBuild semantic type tokens, SF/PingFang stack, compact captions, semibold command names, and muted descriptions remain authoritative. Keyboard hints use the existing compact line-height token.
- Spacing and layout rhythm: the palette is limited to 680px or the composer width, with a 360px/40vh desktop height and internal scrolling. At the narrow breakpoint it uses the full composer width and a 320px/38vh cap. The composer stays visible and spatially connected to the palette.
- Colors and visual tokens: borders, neutral panel surfaces, hover/selected fills, muted copy, and the sparse teal active state all reuse RunBuild tokens. No gradient or decorative effect was added.
- Image and asset fidelity: the component has no raster imagery. Existing Tabler terminal icons are reused; no custom SVG, CSS drawing, emoji, or generated asset was introduced.
- Copy and content: all 20 existing commands and their execution paths remain unchanged. The new header shows the active query, result count, filtering hint, and desktop keyboard controls; commands are grouped by their existing `group` field.

## Findings and comparison history

1. P1 baseline: entering `/` rendered all commands as one composer-width stack, covering most of the conversation and turning a completion menu into a blocking page-sized surface.
2. P2 baseline: repeated icons and an unbroken list provided no useful hierarchy; the selected item was visible, but the movement, selection, filtering, and dismissal model was not explained.
3. Fix: the surface is now a compact popover with a fixed header, grouped scroll region, one active row, result count, and `↑↓ / Enter / Esc` hints. Typing continues to filter against the existing command model.
4. P2 first implementation pass: a 430px maximum height allowed the header to move under the top bar in a 1280 × 720 empty-task state. The final cap is `min(360px, 40vh)`, with `min(320px, 38vh)` on narrow screens; the post-fix capture keeps the header, first results, and composer simultaneously visible.
5. The final focused comparison found no remaining actionable P0, P1, or P2 issue within the command-palette scope. The source's full command set remains available through internal scrolling and filtering rather than being removed.

## Interaction, responsiveness, and accessibility evidence

- Entering `/co` returned exactly `/compact` and `/context`. `ArrowDown` selected `/context`; Enter completed the input to `/context` and closed the palette.
- Escape closed the palette while preserving `/` in the composer. Keyboard selection calls `scrollIntoView({ block: 'nearest' })`, so the active result remains visible while traversing the full list.
- The palette remains a semantic `listbox` with grouped `option` rows and exactly one `aria-selected=true` result. The header and group labels remain readable without taking focus away from the composer.
- The 560 × 900 narrow capture preserves full composer width, truncates long command copy, hides the desktop-only shortcut legend, and has no menu-induced horizontal overflow.
- Browser console inspection returned no warning or error entries.

## Verification

- `npm run build` — passed after the final height correction; TypeScript and the Vite production build completed. The existing bundle-size advisory remains non-blocking.
- `npm run test:frontend-architecture` — passed.
- `npm run test:typography` — passed.
- `npm run test:runner` — passed 7/7 when run independently.
- `PERSONAL_AGENT_PACK_BINARY=… npm run desktop:pack` — passed using the existing bundled Agent executable; `codesign --verify --deep --strict` passed for `webui/release/mac-arm64/RunBuild.app`. The package remains ad-hoc signed because this Mac has no Apple signing identity.
- `./scripts/coding-assistant/verify.sh webui` is not fully green: its Runner phase reproduced an unrelated timing-sensitive failure in `reclaims only an exact stale owned Runner lease and leaves an identity mismatch untouched` on two full-gate runs, while that same Runner suite passed 7/7 independently. No Runner code was changed for this UI task.

final result: passed

---

# Design QA — task-scoped right Inspector

Date: 2026-07-25

## Source and implementation evidence

- Source visual truth: `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-e2baf9ee-733e-49ef-9efd-664a0fabca04.png` (3560 × 2220 px, Retina capture). The red rectangle is an annotation around the target Inspector, not product chrome.
- Browser-rendered implementation: `design-qa/right-inspector-2026-07-25/implementation-activity-desktop.png` (1780 × 989 px) for the default collapsed activity view and `implementation-activity-expanded-desktop.png` for the matching expanded-notification state.
- Full-view comparison: `design-qa/right-inspector-2026-07-25/full-comparison-final.png` places the source app viewport and implementation side by side at equal 1780 × 989 px dimensions.
- Focused comparison: `design-qa/right-inspector-2026-07-25/focused-comparison-final.png` places the source and implementation Inspector regions side by side at 424 × 934 px each.
- Density normalization: the source browser chrome was removed by cropping its 3560 × 1978 px app viewport from y=242, then normalizing it to 1780 × 989 px. The source Inspector crop (838 × 1868 px) was normalized to 424 × 934 px; the implementation crop is 424 × 934 px at device density 1.
- State: dark theme, independent blank task, Agent Bridge offline, `执行` selected, zero tool steps. Both collapsed and expanded local-notification states were captured; the focused comparison uses the expanded state so the same three runtime notices remain readable in both designs.

## Required fidelity surfaces

- Fonts and typography: RunBuild's existing SF/PingFang semantic tokens, caption sizes, compact line heights, and strong/muted hierarchy are retained. The new status title, metadata labels, execution heading, and disclosure titles remain readable without introducing a new type scale.
- Spacing and layout rhythm: the reference's five equal-weight sections are reorganized into a 68px task header, 45px shared-indicator tabs, one compact run-summary card, a 144px execution empty state, and optional 42px disclosures. The existing 360–420px resizable desktop boundary remains authoritative; the matched capture measures 424px because the persisted resize control moves in 16/48px keyboard steps.
- Colors and tokens: all fills, borders, hover states, error/ready colors, and the teal active indicator map to existing RunBuild tokens. No gradient, glow, or unrelated decorative effect was added.
- Image quality and asset fidelity: this Inspector has no product imagery. Existing Tabler icons are reused consistently; no custom SVG, CSS drawing, emoji, raster placeholder, or generated asset was introduced.
- Copy and content: `任务上下文` names the panel's ownership boundary, the subtitle exposes `项目或独立任务 · 当前任务`, and `执行` replaces the ambiguous `活动`. Runtime notices and durable task records are labeled separately and remain available on demand.

## Findings and comparison history

1. P1 baseline: session facts, tool activity, recovered ledger activity, and local notices had equal visual weight, so the panel did not answer the primary question—what is the current task doing. The final design leads with a real connection/execution summary, then a compact step timeline, with task records and local notices collapsed below it.
2. P1 baseline logic: Inspector projections could remain visible while another task was loading, and ordinary tool calls forcibly selected/opened the activity panel. The implementation clears session info, ledger projection, and selection at the task boundary; stale asynchronous responses are ignored; ordinary tool calls update the current task without stealing the user's workspace.
3. P2 first responsive pass: below 1100px the Inspector and its backdrop were below the fixed navigation sidebar, leaving the visible backdrop unable to receive a close click. The mobile/tablet Inspector and backdrop now use z-index 22/21 above the sidebar. Post-fix browser evidence at 900 × 760 measured body scroll width equal to viewport width, an 846px drawer, and a working click-to-close strip.
4. P2 source drift: the initial visual comparison used the default collapsed `本地通知` disclosure while the source showed its three recent items expanded. A second same-input comparison captured the expanded implementation at the same focused size; notification copy, icon alignment, and row rhythm remain readable without returning to the old always-expanded hierarchy.
5. Final full-view and focused comparisons found no remaining actionable P0, P1, or P2 issue within the requested right-Inspector scope. The denser summary card and collapsed secondary records are intentional improvements to the source information architecture.

## Interaction, responsiveness, and accessibility evidence

- The `预览 / 文件 / 执行` tabs expose semantic tab and tabpanel relationships. Mouse selection and `ArrowLeft`, `Home`, and `End` keyboard navigation produced the expected selected tab.
- The local-notification disclosure expanded and collapsed successfully. Closing the narrow drawer via its backdrop worked after the stacking fix; Escape closed it, and reopening preserved the selected `执行` view.
- The existing desktop separator remains keyboard-resizable and exposes its current value through `aria-valuenow`. The internal close control and top-bar toggle retain visible names and return-focus behavior.
- At 1780 × 989 the matched Inspector occupies 424px with no document overflow. At 900 × 760 it becomes an 846px overlay drawer above the sidebar with body scroll width fixed at 900px.
- Browser console inspection returned no warning or error entries.

## Verification

- `npm run test:frontend-architecture` — passed.
- `npm run test:navigation` — 28/28 passed.
- `npm run test:typography` — passed.
- `./scripts/coding-assistant/verify.sh webui` — passed: registry 7/7, runner 7/7, navigation 28/28, conversation 24/24, automations 12/12, desktop 69/69, architecture, typography, production WebUI build, desktop main bundle, and preload bundle.
- The existing Vite chunk-size advisory remains non-blocking and unchanged.

final result: passed

---

# Design QA — compact execution mode menu

Date: 2026-07-24

## Source and implementation evidence

- Source visual truth: `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-b728a196-0b82-41fb-8587-dc9c4d86771a.png`, specifically the annotated permission menu above the composer.
- Browser implementation: `/private/tmp/runbuild-permission-menu-short-dark.png`, captured from the fresh `http://127.0.0.1:5178/` preview with the menu expanded in dark theme.
- Same-input comparison: `/private/tmp/runbuild-permission-menu-comparison.png` stacks the original annotated menu and the final focused implementation at a readable normalized scale.

## Findings and resolution

1. The original menu exposed three scope-heavy choices and two explanatory lines per item, making a routine execution-mode choice unnecessarily tall and technical.
2. The final menu contains only `执行前确认` and `替我执行`; the composer trigger uses the same current-state copy.
3. `替我执行` remains selected by default and maps to the existing all-running-conversations auto-approval mode. `执行前确认` maps to the existing per-tool confirmation mode.
4. The menu width is reduced from 326px to 180px. Existing placement, theme tokens, icons, selected checkmark, and tool-authorization transport remain unchanged.
5. The focused comparison found no clipped copy, spacing collision, or actionable P0, P1, or P2 issue in the requested menu scope.

## Verification

- Browser DOM exposed exactly two menu items with accessible names `执行前确认` and `替我执行`; `替我执行` was the selected/default state.
- Browser console inspection returned no errors.
- `./scripts/coding-assistant/verify.sh webui` passed registry 7/7, runner 2/2, navigation 13/13, automations 1/1, desktop 24/24, frontend architecture, typography, production WebUI build, desktop main bundle, and preload bundle.
- The isolated browser preview intentionally left the Agent Bridge offline, so this pass verifies the menu structure and default state rather than a live mode-switch round trip.

final result: passed

---

# Design QA — Aceternity Animated Modal for desktop permissions

Date: 2026-07-24

## Source and implementation evidence

- Source visual truth: `/private/tmp/runbuild-aceternity-animated-modal-reference.png` (1780 × 933 px), captured from the official Aceternity `Animated Modal` live preview in its open state.
- Browser-rendered implementation: `/private/tmp/runbuild-permission-modal-final.png` (1780 × 933 px), light theme, desktop query surface, incomplete setup, and the final permission-window code after the copy and disabled-state fixes.
- Narrow implementation: `/private/tmp/runbuild-permission-modal-final-narrow.png` (520 × 760 px), showing the one-column scroll state and stacked footer actions.
- Same-input comparison: `/private/tmp/runbuild-permission-modal-final-comparison.png` (3560 × 933 px) places the official component and final RunBuild window side by side at equal CSS-pixel height without stretching.
- Desktop-state evidence: `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/com.openai.sky.CUAService/RunBuild Screenshot 2026-07-24 at 5.37.13 PM.jpeg` records the real Electron surface with clickable macOS permission rows and live native states. No system authorization was accepted during QA.
- Viewport and density normalization: the source and final full comparison use equal 1780 × 933 CSS-pixel captures. The narrow check uses a 520 × 760 CSS viewport and browser screenshot at the same pixel dimensions.

## Required fidelity surfaces

- Fonts and typography: the reference's centered, high-contrast modal hierarchy is translated into RunBuild's existing SF/PingFang semantic tokens. The title, eyebrow, concise supporting copy, card labels, and fixed decision footer remain readable in both full and narrow layouts.
- Spacing and layout rhythm: the reference's strong header, visual content group, supporting details, and separated footer become a title block, progress summary, 2 × 2 permission-card grid, compact authorization-boundary note, and fixed action bar.
- Colors and visual tokens: neutral modal surfaces and sparse teal readiness cues use the existing RunBuild light/dark tokens. Warning states remain amber/red and are reserved for unavailable native permissions or bridge errors.
- Image and icon fidelity: the travel imagery was intentionally not copied because it is not part of the authorization task. Existing Tabler permission icons replace the demo imagery while keeping the selected component's grouped visual rhythm. No placeholder, custom SVG, CSS drawing, or generated raster asset was introduced.
- Copy and content: every visible label maps to the real macOS capabilities and existing handlers. Full Disk Access is marked optional, the three completion-gating permissions are counted separately, and the footer explains how to reopen the window.

## Findings and comparison history

1. P1 baseline: the previous setup window was a long stack of five similar rows, with the authorization boundary and decisions competing in the same scrolling body. The redesign adopts the Animated Modal's focused hierarchy and separated decision footer without changing native permission handlers.
2. P2 first pass: the optional Full Disk Access card initially used the generic `点击开启` hint even though it opens System Settings, and the disabled primary action remained visually too close to an enabled button.
3. Fix: optional and blocked settings actions now say `前往系统设置`; the disabled primary uses the existing disabled foreground/background tokens and remains semantically disabled.
4. Narrow-state verification measured a 468px dialog inside the 520px viewport, a single 430px grid column, column footer actions, and body scroll width equal to viewport width. Persistent actions remain visible while the permission cards scroll.
5. The final same-input comparison found no actionable P0, P1, or P2 mismatch within the requested adaptation scope. The implementation intentionally uses more compact product content than the travel demo and retains RunBuild's existing desktop theme.

## Interaction and accessibility evidence

- The final browser surface exposes one semantic dialog, labeled progress bar, grouped system-permission region, enabled `稍后设置`, and disabled `完成并进入 RunBuild` while required permissions are incomplete.
- The real Electron surface exposed four permission controls with native state labels and preserved the existing close, skip, complete, focus-trap, Escape, and return-focus behavior. QA did not click microphone, screen recording, accessibility, or Full Disk Access because granting system permission is a separate user-controlled action.
- The modal uses the selected component's pop transition plus staggered card entry. The existing global reduced-motion rule collapses these animations for `prefers-reduced-motion`.
- Browser console inspection found no application-origin errors or warnings. The only warnings came from an unrelated Chrome extension content script.

## Verification

- `./scripts/coding-assistant/verify.sh webui` passed registry 7/7, runner 2/2, navigation 13/13, automations 1/1, desktop 24/24, frontend architecture, typography, production WebUI build, desktop main bundle, and preload bundle.
- The existing non-blocking Vite chunk-size advisory remains unchanged.

final result: passed

# Design QA — Aceternity shimmer task loader

Date: 2026-07-24

## Source and implementation evidence

- Source visual truth: `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-d4031088-b2a7-4687-9604-758603724605.png` (3560 × 2220 px), specifically the annotated Aceternity `Shimmer Loader` preview. The red frame is annotation, not product chrome.
- Browser implementation: `design-qa/shimmer-loader-2026-07-24/implementation-light-loading.png` (1280 × 720 px), light theme, real project-to-root task transition, connected local Agent Bridge, and a 1280 × 720 CSS-pixel viewport at DPR 2. `implementation-dark-loading.png` records the same state in the existing dark theme.
- Full-view same-input comparison: `design-qa/shimmer-loader-2026-07-24/full-comparison.png` places the full component reference and RunBuild loading state side by side on equal 960 × 600 canvases without stretching.
- Focused same-input comparison: `design-qa/shimmer-loader-2026-07-24/focused-comparison.png` compares the annotated source loader and RunBuild loader at readable scale. No separate image asset is part of this component.

## Required fidelity surfaces

- Fonts and typography: the loader uses RunBuild's existing UI font, muted text token, 13px semantic label size, semibold weight, and compact line height. The product-specific copy remains `正在打开“任务名”` rather than copying the demo's English placeholder.
- Spacing and layout rhythm: the old 720px card, secondary detail, and four skeleton bars are removed. The single-line loader is centered in the available conversation viewport above the preserved composer.
- Colors and visual tokens: light theme resolves to `rgb(93, 106, 103)` and dark theme to `rgb(146, 152, 161)`, preserving the reference's subdued neutral treatment through existing RunBuild tokens.
- Image and asset fidelity: no raster asset, placeholder, custom SVG, CSS drawing, or icon is introduced. The existing Aceternity `LoaderFive` motion component is reused directly.
- Copy and content: the current task title remains exposed through one accessible label. The removed restoration detail and skeleton content no longer add duplicate visual hierarchy.

## Findings and comparison history

1. P1 baseline: the previous loading state presented a bordered card, secondary explanation, and four skeleton lines, which materially differed from the selected single-line shimmer component.
2. Fix: `TaskSwitchingState` now renders only `LoaderFive` with the current task title. The existing conversation `aria-busy`, status region, polite live announcement, and reduced-motion behavior remain intact.
3. P2 first pass: the simplified loader initially appeared at the top of the scroll content because Mantine's internal scroll-content wrapper collapsed to the loader height.
4. Fix: the chat ScrollArea content wrapper now owns the viewport height, and only the switching task thread receives a definite full height. The final loader center differs from the conversation viewport center by 0px horizontally and about 2px vertically.
5. Post-fix light and dark comparisons found no actionable P0, P1, or P2 issue in the requested loading-state scope.

## Interaction, responsiveness, and accessibility evidence

- Real cross-scope task switching produced `aria-busy=true`, one status label, zero `.task-content-skeleton` elements, and zero restoration-detail elements.
- Consecutive loader characters were observed at different opacity and scale values, confirming the staggered shimmer animation was running. The existing motion component settles to static readable text when reduced motion is requested.
- At 1280 × 720 and a temporary 900 × 720 viewport, the loader remained centered within about 2px, with no horizontal page overflow. The temporary viewport override was reset after QA.
- The selected sidebar row updates immediately, the stable workspace/sidebar and bottom composer remain visible, and the local Agent Bridge reported `Bridge 已连接`.
- Browser console inspection returned no warning or error entries.

## Verification

- `./scripts/coding-assistant/verify.sh webui` passed registry 7/7, runner 2/2, navigation 9/9, automations 1/1, desktop 22/22, frontend architecture, typography, production WebUI build, desktop main bundle, and preload bundle.
- The existing non-blocking Vite chunk-size advisory remains unchanged.

final result: passed

---

# Design QA — Project task alignment

Date: 2026-07-24

## Source and implementation evidence

- Source visual truth: `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-d659f8fd-6f13-4f12-b3a4-25e14bf58670.png` (840 × 1580 px, Retina 2× capture).
- Density-normalized source: `design-qa/sidebar-reference-420x790.png` (420 × 790 px).
- Browser implementation: `design-qa/sidebar-project-task-aligned-420x790.png` (420 × 790 px).
- Comparison viewport: 420 × 790 CSS px at deviceScaleFactor 1. The source was normalized from 2× to 1× before comparison.
- State: light theme, 375px navigation sidebar, project collection scrolled to the top, both real projects expanded, existing task catalog rendered. The independent verification preview intentionally left its Agent bridge offline because alignment is owned by the sidebar layout and session actions were not exercised.
- Full-view comparison evidence: the normalized source and implementation captures were opened together in one comparison input. The visible top toolbar and the larger live task catalog differ from the dated source capture, but neither changes the project/task alignment surface.
- Focused alignment evidence: browser geometry measured each `.project-row-name` at x=55px and every sampled `.project-task-row .history-row-label` at x=55px across both expanded projects. An extra focused crop was unnecessary because the exact text-edge geometry and readable normalized full views expose the requested difference directly.

## Findings and comparison history

1. P2 before fix: `.project-task-list` added a 20px left margin on top of the shared 8px row padding. Browser evidence from the previous 5173 preview measured project labels at x=55px and task labels at x=75px, matching the screenshot's marked misalignment.
2. Fix: removed only the project task list's 20px left margin. Project/task markup, expansion, selection, actions, task data, and history layout are unchanged.
3. Post-fix evidence: the fresh 5178 browser preview computed `margin-left: 0px`; both real project labels and all sampled task labels measured x=55px. Both project expand controls worked, task rows retained their available width, and browser logs contained no warnings or errors.
4. Required fidelity surfaces: typography, weights, colors, icons, row height, copy, and real task content continue to use the existing RunBuild design system. No image asset was introduced or replaced. The only intentional visual change is the requested horizontal alignment.
5. No actionable P0, P1, or P2 finding remains in the requested alignment scope. The toolbar/crop and current task-count differences are runtime-state differences from the source, not regressions introduced by this change.

## Verification

- Primary interactions tested: expanded each of the two real projects and confirmed its task rows rendered without changing task/session data.
- Console checked: no warning or error entries in the fresh implementation preview.
- `./scripts/coding-assistant/verify.sh webui` passed registry, runner, navigation, automation, desktop, frontend architecture, typography, production WebUI build, desktop main bundle, and preload bundle. The existing non-blocking Vite chunk-size advisory remains unchanged.

final result: passed

---

# Design QA — Aceternity text generate + dot background

Date: 2026-07-24

## Source and implementation evidence

- Text source: `design-qa/text-background-build-2026-07-24/reference-text-generate.png` (1280 × 720 px), captured from the official Aceternity Text Generate Effect preview.
- Background source: `design-qa/text-background-build-2026-07-24/reference-dot.png` (1280 × 720 px), captured from the official Aceternity Dot Background preview.
- Browser implementation: `design-qa/text-background-build-2026-07-24/implementation-empty-task.png` (961 × 988 px), light theme, selected blank task, real local Agent session catalog, and `Bridge 已连接`.
- Same-input comparison: `design-qa/text-background-build-2026-07-24/source-vs-implementation.png` (2560 × 720 px). Both official component references are grouped into the left source panel; the complete RunBuild implementation is aspect-preservingly normalized in the right panel.

## Required fidelity surfaces

- The official text behavior is preserved as a one-time opacity-and-blur reveal. RunBuild segments Chinese copy by character so `今天要构建什么？` reveals progressively instead of arriving as one block.
- The official dot treatment is preserved as a static radial dot matrix. Its contrast is reduced and its mask is bounded to the empty-state brand area so it supports, rather than competes with, the composer.
- Existing RunBuild logo, semantic typography tokens, neutral/teal palette, composer, sidebar, project/session selection, and Runner behavior remain authoritative.
- Both primitives are reusable components; the conversation-specific landing component composes them without introducing Mantine inside the feature component tree.

## Findings and comparison history

1. A full-canvas dot texture was visually too close to a decorative page background for a dense coding workspace. The final implementation limits the pattern to a 560px landing surface and fades it before the composer boundary.
2. The official word-by-word animation would treat the Chinese sentence as a single token. The implementation uses character segmentation for non-spaced copy while retaining whitespace-aware word segmentation for Latin text.
3. The generated prompt is subordinate to the RunBuild brand instead of matching the official demo's large headline scale; this is intentional product hierarchy, not a fidelity defect.
4. Same-input review found no clipped content, bad spacing, broken borders, unreadable contrast, or actionable P0, P1, or P2 visual issue in the requested empty-state scope.

## Interaction and accessibility evidence

- Browser readback observed intermediate character states from opacity `0` / blur `8px` through the settled opacity `1` / blur `0px`, confirming the one-time generate effect.
- The visible segmented copy is hidden from assistive technology and one complete `今天要构建什么？` label remains available through the screen-reader-only text.
- The dot layer reports `pointer-events: none`; it cannot block composer or task navigation interactions.
- Selecting an existing task with two message rows removed the landing surface (`welcomeSurface: 0`). Returning to the blank task restored one landing surface and zero message rows.
- The current 961px-wide viewport has no horizontal overflow. Final console inspection contained no error or warning entries; only Vite connection/debug and React development information were present.

## Runtime boundary and verification

- The final browser state used the real `./run web-agent` entry point and displayed `Bridge 已连接`. The check verifies landing composition, session switching, and Agent bridge reachability; it does not claim a fresh provider-backed model response.
- `./scripts/coding-assistant/verify.sh webui` passed registry 7/7, runner 2/2, navigation 8/8, automations 1/1, desktop 22/22, frontend architecture, typography, production WebUI build, desktop main bundle, and preload bundle. The existing non-blocking Vite chunk-size advisory remains unchanged.

final result: passed

---

# Design QA — aligned task rows with direct pin and archive actions

Date: 2026-07-24

## Source and implementation evidence

- Source visual truth: `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-8a6901ab-7a37-4252-a05e-a97bb4083925.png` (2904 × 1800 px). The red frame marks the reported project-task row and is annotation, not product chrome.
- Browser-rendered implementation: `design-qa/task-row-direct-actions-full.png` at a 961 × 988 CSS-pixel viewport, DPR 2, light theme, projects and independent tasks expanded, with a real active root task.
- Full-view same-input comparison: `design-qa/task-row-full-comparison.png` (1237 × 759 px). The source RunBuild region was cropped from the @2x capture and normalized to 613 × 759 CSS-equivalent pixels; the implementation was cropped to the same visible region without stretching.
- Focused same-input comparison: `design-qa/task-row-reference-comparison.png` (1418 × 84 px). The source row was normalized from 680 × 84 to 340 × 42; the implementation row was captured at 357 × 36 and vertically padded to 42 px before both were enlarged 2× for inspection.

## Required fidelity surfaces

- Fonts and typography: the existing semantic label token, medium/semibold selected weight, single-line truncation, and Chinese/Latin font stack are unchanged. The task label now uses a centered 36 px flex line with the compact semantic line-height so its optical center follows the message icon.
- Spacing and layout rhythm: task rows remain 36 px high. Message icon, title, and direct actions share one vertical center; the two 28 px action targets keep the row compact and leave title truncation intact.
- Colors and visual tokens: neutral row, hover, selection, subtle icon, and teal active-state tokens are unchanged. A pinned action uses the existing accent token.
- Image and asset fidelity: no raster asset, logo, custom SVG, CSS drawing, or placeholder was introduced. Existing Tabler message, pin, and archive icons are reused.
- Copy and content: session titles and project/root grouping are unchanged. Tooltips and accessible labels expose `置顶/取消置顶` and `归档` without adding visible copy.

## Findings and comparison history

1. P2 baseline: the message glyph and task title used different vertical line boxes, making them appear offset in the annotated row.
2. P2 baseline: task actions were hidden behind a `…` menu, adding an unnecessary click for the two available actions.
3. Fix: task rows now use centered group alignment; the button icon and title share a centered 36 px inner line. The overflow menu was replaced with direct 28 px pin and archive action icons while preserving the existing preference state callbacks.
4. Post-fix focused comparison shows the message icon and title on the same center line, with pin immediately followed by archive. Browser geometry readback reported identical icon and label centers at 616 px; pin and archive begin at x=345 and x=373.
5. No actionable P0, P1, or P2 issue remains in the requested task-row scope. The source red frame and the implementation teal active rail represent annotation and real selected state, respectively, rather than fidelity defects.

## Interaction and accessibility evidence

- The active task exposed exactly two direct action buttons and no task-level `更多操作` trigger.
- Pin toggled `aria-pressed=false → true → false`, confirming both the action and restoration path; the archive button remained present with a task-specific accessible label.
- The same action component is used by project and independent task rows. Project, conversation, and Runner switching behavior was not changed.

## Verification

- Browser console inspection returned 0 errors after the final preview restart.
- `./scripts/coding-assistant/verify.sh webui` passed: registry 7/7, runner 2/2, navigation 8/8, automations 1/1, desktop 22/22, frontend architecture, semantic typography, WebUI production build, Electron main bundle, and preload bundle.
- The existing Vite chunk-size advisory remains non-blocking.

final result: passed

---

# Design QA — Aceternity Grouped Sidebar for RunBuild

Date: 2026-07-24

## Source and implementation evidence

- Source visual truth: `design-qa/aceternity-grouped-sidebar-full.png` (1280 × 3067 px), captured from the official Aceternity `Grouped Sidebar` block. The focused component sidebar measured 300 × 986 CSS px at x=398, y=315 in the source page.
- Browser-rendered implementation: `design-qa/grouped-sidebar-final.png` (1207 × 988 px), dark RunBuild task workspace with a 224 × 933 CSS-pixel sidebar, real history catalog, real selected task, and `Bridge 已连接` status.
- Same-input comparison: both source and implementation captures were opened together in one local read-only visual comparison. The source page and RunBuild preview were also inspected through the same in-app browser surface; both live tabs reported DPR 2. Density-dependent pixel matching was not claimed because the source block is a 300px light demo while RunBuild preserves the user's 224px dark product sidebar.
- State: project group collapsed, independent-task group expanded, one task selected, footer status visible, no horizontal viewport overflow.

## Required fidelity surfaces

- Fonts and typography: the reference's compact 14px product-navigation hierarchy is mapped to RunBuild's existing semantic label/body tokens and SF/PingFang stack. Brand, group labels, child rows, truncation, and status copy remain readable at the persisted 224px width.
- Spacing and layout rhythm: top-level actions are flat; section dividers are quiet; group headings have icon/label/chevron structure; children are indented behind a continuous vertical guide; the bottom workbench group and Agent status stay fixed outside the scrolling history region.
- Colors and visual tokens: the reference's white neutral surfaces are intentionally translated into existing RunBuild dark tokens. Teal remains limited to focus and current-task selection rather than being introduced as decorative gradient color.
- Image and icon fidelity: the existing RunBuild mark and Tabler icon family are retained. No placeholder asset, custom SVG, CSS drawing, or unrelated Aceternity demo branding was added.
- Copy and content: the reference's dashboard/team/settings mock labels were replaced by real RunBuild objects: new task, search, projects, independent tasks, automations, skills/connectors, and local Agent state.

## Findings and comparison history

1. Baseline P2: the existing sidebar visually separated projects and history with headings, but it did not express the Aceternity grouped-navigation relationship; search lived in the brand row and child lists had no shared group rail.
2. Fix: introduced a reusable `SidebarGroupHeader`, moved Search into the flat primary-action area, applied icon/label/chevron group headers, added child indentation rails, and grouped Automations plus Skills/Connectors under `工作台`.
3. First browser pass briefly showed the prior Vite transform cache. The local preview was restarted and the served source was read back before visual judgment; the final screenshot contains the new module and styles.
4. Post-fix comparison found no actionable P0, P1, or P2 issue. The source block's light card, 300px width, and demo labels are intentional reference-to-product adaptations rather than fidelity defects.

## Interaction and accessibility evidence

- Project group toggled `false → true → false`; its controlled list became visible only while expanded.
- Independent-task group toggled `true → false → true`; its task list hid and returned without losing the selected task.
- Search opened the real history dialog with focused input and existing session results, then closed through the keyboard path.
- The global sidebar collapse/expand control remained reachable and returned the sidebar to its visible state.
- The account footer remained fully visible; the middle collection retained independent vertical scrolling; browser console inspection returned no warnings or errors.

## Verification

- `npm run test:frontend-architecture` — passed; the new navigation module has no Mantine dependency and respects feature boundaries.
- `npm run build` — TypeScript and Vite production build passed; the existing non-blocking chunk-size warning remains.
- `./scripts/coding-assistant/verify.sh webui` — passed: registry 7/7, runner 2/2, navigation 8/8, automations 1/1, desktop 22/22, frontend architecture, typography, production WebUI build, Electron main bundle, and preload bundle.

final result: passed

# Design QA — remove the user-message author label

Date: 2026-07-24

## Source and rendered evidence

- Source visual truth: `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-f43b6be7-bcf2-470c-bc19-a1613cc9ca40.png` (2760 × 1800 px). The red frame identifies the user author label `你`; it is annotation, not product chrome.
- Browser-rendered implementation: `design-qa/user-author-removed-dark.png` (1952 × 1274 px) at a 1952 × 1274 CSS-pixel viewport, DPR 1, dark theme, Bridge connected, task `你是什么模型` restored.
- Full-view same-input comparison: `design-qa/user-author-full-comparison.png`; source and implementation are each normalized to 976 × 637 px without changing their shared aspect ratio.
- Focused comparison: `design-qa/user-author-before-after-comparison.png`, with `design-qa/user-author-source-focus.png` and `design-qa/user-author-removed-dark-focus.png` as the underlying crops.

## Required fidelity surfaces

- Fonts and typography: user message copy keeps the existing semantic body style, weight, and line height; only the separate muted author label is removed.
- Spacing and layout rhythm: the user bubble keeps its padding, maximum width, right alignment, border, and radius. Removing the label also removes its authored 5 px bottom margin, so the bubble starts directly with the message content.
- Colors and visual tokens: the existing dark-theme user background and border tokens are unchanged.
- Image and icon fidelity: no image, icon, or asset is added or replaced.
- Copy and content: user message text remains intact. Agent `RunBuild` headers and system `系统` labels remain intact.

## Findings and comparison history

1. P2 source finding: the redundant user author label `你` appears above every user message and is the field marked for removal.
2. Fix: user messages now render no author-label node; the existing author label is restricted to system messages.
3. Post-fix browser readback found 5 user bubbles and 0 `.message-author` nodes inside them. Each user bubble begins directly with `.message-content`.
4. Focused and full-view comparisons show the user bubbles starting with their real message text, with no remaining actionable P0, P1, or P2 issue in the requested scope.

## Interaction and verification

- Restored the real `你是什么模型` task through the connected local Agent Bridge and checked multiple user-message bubbles in the existing conversation.
- Browser console readback returned 0 warnings and 0 errors.
- `./scripts/coding-assistant/verify.sh webui` passed registry 7/7, runner 2/2, navigation 8/8, automation 1/1, desktop 22/22, typography, WebUI build, Electron main bundle, and preload bundle. The existing Vite chunk-size warning remains non-blocking.

final result: passed

---

# Design QA — Grok-style projects and unified history sidebar

Date: 2026-07-24

## Source and same-state comparison

- Source visual truth: `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-e2e9701e-30dc-4189-b29f-82a5770aef58.png` (502 × 1954 px).
- Browser-rendered implementation: `design-qa/sidebar-after-final-full.jpg` at a 1440 × 928 CSS-pixel viewport and DPR 1. The focused sidebar crop is `design-qa/sidebar-after-final.jpg` (224 × 872 px).
- Same-input reference/implementation comparison: `design-qa/sidebar-reference-comparison.jpg`. The reference was proportionally normalized to 224 × 872 and placed beside the implementation crop without stretching or synthetic content.
- Checked state: light theme, project/history sections expanded, history at the top, root conversation active, Bridge connected, and the account footer fixed at the bottom.

## Frontend logic differences and resolutions

1. P1 baseline: RunBuild split project sessions into nested project trees and showed only the currently loaded Runner scope. A project with stored sessions could therefore appear empty until opened. Resolution: a bounded server-side catalog now reads root and project `.grok` stores and exposes one scoped, deduplicated recent-history stream while projects remain real cwd-backed objects.
2. P1 baseline: a cross-project restore optimistically changed the active row before the target Runner and exact session were available. Failure could leave a false highlight or damaged cache. Resolution: scope switching is transactional, explicit IDs never fall back to another session, restore-time cache writes are suspended, and all failure exits reconnect and restore the exact previous scope/session.
3. P1 baseline: pin, archive, folding, sorting, and width relied on origin-local storage while the packaged desktop server uses a random port. Resolution: desktop preferences now use a validated, bounded, atomically written `userData/sidebar-preferences.json` through the existing protected local API; web preview keeps the local fallback.
4. P2 baseline: Search was hidden behind a command, projects depended on small header icons, titles wrapped to two lines, internal system summaries could leak into history, and the sidebar body competed with the footer for vertical space. Resolution: Search and New Task are primary rows; New Project is explicit; titles are single-line ellipsized; internal reminder/synthetic titles are filtered; only the middle projects/history collection scrolls.
5. Product boundary retained: the reference's `Imagine` and xAI account chrome were not copied because RunBuild has no corresponding product capability. Existing RunBuild branding, project cwd isolation, Runner reconnection, model controls, composer, and account/Bridge status remain real.

## Visual and interaction readback

- At 1440 × 928, the sidebar occupies x=0, y=56, 224 × 872. The account row is fixed at y=867 with a 61 px height. The collections viewport is 518 px high with `overflow-y: auto` and a 1350 px scroll height; the document itself does not grow with history.
- The focused comparison confirms the reference hierarchy: primary actions, flat project objects, explicit project creation, unified one-line history, neutral full-row active state, on-demand overflow action, and a fixed bottom identity row.
- Browser interaction checks covered global history search, project/history collapse and persistence, pin/archive/restore menus, middle-only scrolling, active-row overflow, and cross-scope failure rollback. The project Runner currently returns the existing provider `Authentication required` boundary; the UI correctly returns to the exact root conversation and reconnects the Bridge instead of claiming a successful restore.
- No actionable P0, P1, or P2 visual or interaction issue remained after the same-input comparison.

## Verification

- `npm run test:navigation` — 8/8 passed.
- `npm run test:desktop` — 22/22 passed.
- `npm run build` — TypeScript and Vite production build passed; the existing bundle-size warning remains non-blocking.
- `./scripts/coding-assistant/verify.sh webui` — registry 7/7, runner 2/2, navigation 8/8, automation 1/1, desktop 22/22, typography, WebUI build, Electron main bundle, and preload bundle passed.
- `codesign --verify --deep --strict webui/release/mac-arm64/RunBuild.app` — passed; the packaged executable is arm64 and the bundle name is `RunBuild`.

final result: passed

---

# Design QA — unified chat and sidebar experience

Date: 2026-07-23

## Source visual truth and implementation scope

- Source screenshots: `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-13e4fc30-438e-4163-8911-1b809759f53f.png` and `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-6b6d0005-5167-4d23-b747-7e54eee30373.png`.
- Implementation files: `webui/src/main.tsx` and `webui/src/styles.css`.
- The existing response, project/session, ACP permission, tool activity, attachment, model, and composer data paths were preserved. This pass changes presentation and feedback routing only.

## Implemented corrections

- Chat reply hierarchy now uses a quiet RunBuild author row and an open reading surface rather than an oversized reply card. Paragraphs, headings, lists, strong text, blockquotes, separators, inline code, code blocks, and wide tables have explicit semantic styling.
- Chat thread, composer, message list, and execution/approval surfaces share a 780px shell; ordinary prose uses a narrower 720px reading measure while code and tables can use the full shell.
- The primary New Task control is now a create action instead of a false selected navigation item, and inherits the current project scope. Current project state is intentionally weak; current conversation state has the strong fill and 2px accent rail.
- All conversation rows share a message icon, two-line title clamp, full-title tooltip, and one overflow menu for pin/archive. Project-local create controls use a plus icon; pencil remains reserved for rename.
- Sent, running, tool, permission, question, plan, and completion events remain available in the inline conversation/activity surfaces but do not create top-right feedback. Top-right feedback is reserved for errors and explicit persistent Bridge/xAI blockers.

## Verification

- `npm run build` — TypeScript and Vite production build passed.
- `./scripts/coding-assistant/doctor.sh` — no blocking environment issue; optional MiMo and DeepSeek credentials remain absent.
- `./scripts/coding-assistant/verify.sh webui` — registry 7/7, runner 2/2, navigation 2/2, automation 1/1, desktop 20/20, typography, WebUI build, desktop bundle, and preload bundle passed.
- `./run desktop-build` — produced `webui/release/mac-arm64/RunBuild.app`; the Mach-O executable is arm64 and strict deep code-sign verification passed with the expected local ad-hoc signature.

## Blocked rendered comparison

- A clean Vite preview was started at the established local target, but the selected in-app Browser retained its earlier Chromium error `data:` page and rejected the fresh local navigation under its URL policy.
- No implementation screenshot was captured, so no same-state, same-viewport comparison against the two source screenshots is claimed.
- Manual acceptance remains: open the rebuilt application, select a project conversation with a long title, send one prompt that returns headings/list/separator/code/table content, and confirm the right corner stays empty unless an actual error occurs. Repeat once in light theme.

final result: blocked

---

# Design QA — quieter Agent progress and compact authorization

Date: 2026-07-23

## Source visual truth

- Toast source: `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-d7b44dd9-48ef-4b24-a4f1-62d9fb20df09.png`; the red frame identifies the transient `Agent 正在推理。` notice to remove.
- Content source: `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-120123db-e430-4963-9635-31d30992df17.png`; the red frame identifies the separate execution and authorization cards whose hierarchy needs tightening.

## Implementation

- `agent_thought_chunk` no longer creates a feedback toast. Bridge, authentication, tool completion, failure, and authorization feedback paths remain unchanged.
- Execution and authorization now share one width-constrained stack. Protocol statuses are normalized and displayed in Chinese, known English tool verbs receive concise labels, and the complete operation title remains available in the row tooltip, inspector, and authorization details.
- Long commands render as a muted monospaced second line; status badges have dedicated grid space and cannot collapse into `IN...`.
- Authorization uses a compact neutral surface with an amber state accent, smaller icon and controls, and the existing real permission callbacks and option IDs.
- Existing typography tokens, theme variables, Mantine components, and Tabler icons are reused; no new visual asset or input-composer change was introduced.

## Verification

- `./scripts/coding-assistant/doctor.sh` — no blocking environment issue.
- `./scripts/coding-assistant/verify.sh webui` — registry 7/7, runner 2/2, navigation 2/2, automation 1/1, desktop 20/20, typography, production WebUI build, Electron main bundle, and preload bundle passed.
- `./run desktop-build` — rebuilt the arm64 macOS application. `codesign --verify --deep --strict` passed; the packaged ASAR contains the new authorization copy and activity styles.

## Visual readback gap

- The exact state requires a live Agent turn that emits tool calls and pauses for permission. No synthetic permission state was added solely for a screenshot, and desktop/browser control was not used. The user should verify this state in the rebuilt app using the manual acceptance path in the handoff.

final result: blocked

---

# Design QA — desktop initialization and minimal system permission setup

Date: 2026-07-23

## Source visual truth and rendered evidence

- Initialization source: `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-01bd2447-ecd2-4788-9870-0092fb349b75.png` (2400 × 1440 pixels, Wukong light-theme startup state).
- Permission source: `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-f5692931-dad1-45bd-9874-a33977107bc1.png` (2560 × 1720 pixels, Wukong light-theme permission state).
- Initialization implementation: `/private/tmp/grok-build-startup-implementation-1178x768.jpeg` (1178 × 768 pixels, packaged RunBuild, live `连接本地 Agent` stage).
- Final permission implementations: `/private/tmp/runbuild-final-permission-implementation-1178x768.png` and `/private/tmp/runbuild-final-permission-light-implementation-1178x768.png` (1178 × 768 pixels, packaged RunBuild, current granted microphone state in dark and light themes).
- Final initialized implementation: `/private/tmp/runbuild-final-granted-implementation-1178x768.png` (1178 × 768 pixels, packaged RunBuild after persisting first-run setup).
- Normalized full-view sources: `/private/tmp/grok-build-startup-reference-1178x768.png` and `/private/tmp/grok-build-permission-reference-1178x768.png`. The source screenshots were proportionally resized and center-cropped to the implementation's 1178 × 768 viewport; no stretching was used.
- Focused comparisons: `/private/tmp/grok-build-startup-reference-focus.png` and `/private/tmp/grok-build-startup-implementation-focus.jpg` (700 × 440), plus `/private/tmp/grok-build-permission-reference-focus.png` and `/private/tmp/grok-build-permission-light-implementation-focus.jpg` (700 × 600).
- CSS viewport and density: the Computer Use capture reports the packaged desktop window at 1178 × 768; saved implementation pixels are also 1178 × 768, so the QA comparison uses a normalized 1:1 capture surface. The source images do not expose their original CSS viewport or DPR, so only composition and visible hierarchy—not density-dependent pixel spacing—were judged after normalization.
- The small purple pill at the upper-left of Computer Use captures is a macOS capture indicator and is not rendered by RunBuild.

## Full-view and focused comparison

- Initialization keeps the source's single centered brand lockup, short subtitle, one progress track, and large quiet canvas. RunBuild intentionally uses its existing shoe mark, English product name, semantic dark theme, and real stage text rather than copying Wukong branding or a timer-driven percentage.
- The permission surface retains the source's centered modal, shield/security cue, dimmed workspace, close affordance, grouped permission content, and bottom confirmation actions.
- The RunBuild modal is intentionally smaller because the audited application currently has one required macOS permission instead of Wukong's long multi-product list. The complete content fits without an internal scrollbar or clipped action row at 1178 × 768.
- Focused crops confirm that title, scope note, permission state, project-folder boundary, and both completion paths remain readable and aligned in both light and dark application themes.

## Required fidelity surfaces

- Fonts and typography: the existing SF/PingFang semantic type scale is preserved. The startup hierarchy uses tokenized page/display sizes; modal title, metadata, descriptions, status badge, and buttons retain readable optical weights without raw one-off font values.
- Spacing and layout rhythm: the startup group remains vertically centered with a separated progress region. The permission modal uses the existing compact IDE rhythm, consistent row padding, 16px radii, stable action alignment, and no viewport overflow.
- Colors and visual tokens: all surfaces use the existing light/dark semantic tokens. Teal is reserved for ready/granted state and visible keyboard focus; degraded Agent startup uses the warning token instead of presenting false success.
- Image quality and asset fidelity: the implementation reuses the real RunBuild shoe mark and Tabler icon library. No Wukong mascot, custom SVG, CSS drawing, emoji, placeholder graphic, or unrelated asset was copied.
- Copy and content: all permission copy is scoped to actual behavior. The application declares and reads only microphone state; project folder access is described as an explicit per-project picker boundary, not a macOS permission or Full Disk Access. Agent tool approvals remain separate.

## Interaction, state, and accessibility evidence

- Packaged first launch exposed the real initialization stages `准备本地工作区`, `启动桌面工作台`, and `连接本地 Agent`; readiness now waits for ACP `initialize` plus `session/list` and `session/load` or `session/new`, rather than completing on a timer or socket-open event.
- A deliberately failing isolated Agent process produced the real degraded state and then released the UI into limited mode instead of hanging the desktop window.
- The startup overlay makes the underlying application inert and inaccessible until released. If ACP requests tool approval while the session is starting, the gate exposes the interactive approval state rather than covering it.
- The first-run modal queues behind any real pending ACP approval, reports the current macOS microphone state, exposes a non-blocking `以受限模式继续` path, and places initial keyboard focus on that safer action.
- The modal was dismissed, the existing theme control was switched from dark to light, and a reload reopened the same first-run state using the light token set.
- In the final signed local package, microphone state moved from `not-determined` through the real macOS consent prompt to `granted`. `完成设置` then atomically persisted `/private/tmp/runbuild-signed-qa.OGmtUw/desktop-setup.json` with version `1`, mode `granted`, and a completion timestamp.
- The packaged `Info.plist` contains `NSMicrophoneUsageDescription` and no camera, Bluetooth, generic audio-capture, screen-recording, accessibility, or Full Disk Access usage declaration.
- The real macOS prompt is invoked only from a user action when status is `not-determined`; denied/restricted states route to the fixed System Settings destination. No permission prompt or microphone recording starts automatically during initialization.
- Project selection is a separate, user-initiated folder picker. The UI discloses that RunBuild creates `.grok` and creates or updates `AGENTS.md`; registry and Runner paths reject symlinked metadata/reference directories so writes remain inside the selected real project root.
- No provider credential is copied from another project or read from a fixed `.env`. The isolated final QA therefore correctly showed `Bridge 未连接` without a provider secret; provider configuration must be injected explicitly.

## Findings and comparison history

1. Initial package inspection found Electron's inherited camera, Bluetooth, and generic audio-capture usage descriptions. This was a P1 boundary mismatch because it declared capabilities outside the user's requested minimum.
2. An `afterPack` privacy-manifest cleanup and regression test were added. Post-fix `Info.plist` evidence contains only `NSMicrophoneUsageDescription`.
3. The first project verification pass found two raw startup font sizes outside the existing typography contract. They were replaced with semantic type tokens; the typography gate and full WebUI verification then passed.
4. The final dark/light permission comparisons and initialized state contain no remaining actionable P0, P1, or P2 visual, interaction, or scope mismatch. The smaller permission modal is an intentional consequence of requesting one real permission instead of copying Wukong's broader authorization list.

## Verification boundary

- `./scripts/coding-assistant/doctor.sh` passed with only the expected missing-provider-key and dirty-worktree warnings.
- `./scripts/coding-assistant/verify.sh webui` passed registry 7/7, runner 2/2, navigation 2/2, automation 1/1, desktop 4/4, typography, TypeScript, Vite, and Electron checks.
- `npm run desktop:pack` produced `webui/release/mac-arm64/RunBuild.app`. Direct package inspection confirmed the main bundle declares only microphone usage, every helper declares no system usage permission, and ATS is fail-closed except exact localhost/127.0.0.1 development transport.
- `codesign --verify --deep --strict --verbose=4` passes for the local package with identifier `local.personal-agent.desktop`. Its signature is local ad-hoc (`TeamIdentifier` unset), not Developer ID/notarized distribution; a distributable build must revalidate the consent dialog under its final signing identity.

final result: passed

---

# Interaction QA — composer image and file attachments

Date: 2026-07-23

## Source and implementation evidence

- Source visual truth: `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-64bfab45-06a4-4283-8a44-45687a3a5bad.png` (1522 × 438 px). The requested state is an image thumbnail card above the existing composer, with an always-visible circular remove action; the red frames are annotations rather than product chrome.
- Browser-rendered implementation: `webui/audit/composer-attachments-preview.jpg` (771 × 988 px capture; 735 × 296 CSS-pixel composer crop), from a fresh local Vite preview at `http://127.0.0.1:5173/`. The QA state stages one image and one PDF card with their real remove controls; its temporary staging hook was removed before handoff. The native picker is intentionally unrestricted (no `accept` filter), the paperclip exposes the accessible label `添加图片或文件`, the composer reports `aria-busy=false` when idle, and the drag-state stylesheet is present.
- Same-input comparison: `webui/audit/composer-attachments-comparison.jpg` (735 × 527 px). The source is density-normalized to 735 × 211 px; beneath a 20px separator is the 735 × 296 px implementation crop. The implementation capture uses the collapsed desktop navigation state so the full composer, image tile, file card, remove controls, and toolbar are visible together.
- Delivery path: picker selection, file drag/drop, and clipboard files all converge on `addAttachments`. Images are stored only as local data-URL previews until send; text uses a text resource and arbitrary binary files use the ACP resource `blob` branch.

## Required behavior and visual treatment

- A draft can stage up to six attachments, with a visible 2 MB per-file limit and an in-place preparing state that disables Send until reads finish.
- Image attachments render as compact 156 × 148 px cropped preview tiles with an overlay remove button, matching the visual hierarchy of the supplied reference without changing the existing input or toolbar.
- Text and arbitrary files render as named file cards with extension and size. Removing any card is a labeled, local-only action.
- Dropping files over the composer gives a token-based, reduced-motion-safe `松开即可添加图片或文件` affordance; pasting ordinary text remains native text paste, while pasted files are staged as attachments.
- A local slash command that cannot carry attachments does not silently discard them. `/run`, `/shell`, and `/design-experts` retain attachment forwarding; other commands leave the staged files and draft intact with an explicit message.

## Verification and boundary

- `npm run test:typography` — currently fails on the existing raw values `clamp(34px, 3vw, 42px)` and `32px` in `webui/src/styles.css`; this is outside the attachment change set.
- `npm run build` — TypeScript and Vite production build passed; the pre-existing bundle-size warning remains non-blocking.
- `./scripts/coding-assistant/verify.sh webui` — registry 6/6, runner 1/1, navigation 2/2, automation 1/1, and desktop 1/1 passed; it then stopped at the existing typography contract's raw values `clamp(34px, 3vw, 42px)` and `32px` in `webui/src/styles.css`. The attachment changes add no raw `font-size` values, so that unrelated gate issue is recorded without expanding this scoped fix.
- Browser readback verified the refreshed composer, unrestricted picker, attachment control label, idle busy state, drag-state CSS, normal textarea editing, and the staged image/file cards with their labeled remove actions. The source/implementation comparison found no actionable P0, P1, or P2 difference: the implementation retains the product's compact 156px attachment tile rather than copying the reference's larger empty-input field. The current preview has no connected Agent Bridge, so the final ACP `session/prompt` transfer cannot be exercised against a live Agent in this process; it is wired to the actual text-resource and binary-blob protocol branches rather than a mocked success state.

final result: passed

---

# Design QA — centered empty-task launch group

Date: 2026-07-23

## Source and implementation evidence

- Source visual truth: `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-8adf2f6b-2b19-49de-8cff-22c867e35559.png` (1992 × 1248 px). The red outline is an annotation, not product chrome.
- Browser-rendered implementation: local light desktop preview at `http://127.0.0.1:5173/`, reviewed after a fresh Vite restart.
- State: empty task, then a draft, then a local `/help` response. The same flow was returned to empty with `/clear`.

## Required fidelity surfaces

- Group hierarchy: the existing running-shoe mark, `Grok Build` copy, and unmodified composer are one `.conversation-flow` vertical launch group in the chat area.
- Spacing and alignment: the launch group is vertically centered in the chat body; the composer has a 22px top gap beneath the brand and remains 780 × 124px on desktop.
- Composer fidelity: the ordinary paperclip, permission label, model/reasoning controls, microphone, placeholder, and send arrow remain unchanged.
- Message transition: entering a draft keeps the brand and composer together; after the first message is created, the brand is removed and the existing grid returns the composer to the page bottom.

## Interaction and accessibility verification

- Browser readback confirmed the final launch state: one visible brand at 584 × 255px, composer at 362 × 367px with 780 × 124px dimensions, and zero message rows.
- Typing `/help` retained the visible brand and centered composer. Sending it produced one message row, removed the brand, and moved the composer to y=574px at the 1280 × 720 desktop viewport.
- `/clear` restored the centered launch group. Attachment and send actions retain their original accessible labels and handlers.

## Findings and comparison history

1. The previous state centered two sibling regions and removed the brand as soon as a draft existed, so the intended launch group did not persist while typing.
2. Fix: introduced a single `conversation-flow` wrapper, a landing-state condition based on the absence of messages and active run, and a small 22px brand-to-composer gap.
3. Post-fix browser review shows the requested centered vertical group and the correct transition to the bottom composer after a response. No actionable P0, P1, or P2 issue remains for this scope.

## Verification

- `npm run test:typography` — semantic typography contract passed.
- `npm run build` — TypeScript and Vite production build passed.
- `./scripts/coding-assistant/verify.sh webui` — registry 6/6, runner 1/1, navigation 2/2, automation 1/1, typography, and production build passed.

final result: passed

---

# Design QA — right workspace inspector icon hierarchy

Date: 2026-07-23

## Source and implementation evidence

- Source visual truth: `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-edbfe1e9-057d-4227-a9c2-2a8f654c80ac.png` (968 × 2024 px). The red frames identify the incorrect repeated side-panel glyphs; the red annotation itself is not product chrome.
- Browser-rendered expanded state: `webui/audit/right-inspector-open-fixed.png` (1280 × 720 px, desktop light theme). The header and empty state contain no repeated side-panel glyph.
- Browser-rendered collapsed state: `webui/audit/right-inspector-closed-fixed.png` (1280 × 720 px). The remaining trigger uses the directional right-sidebar expand glyph.
- Same-input comparison: `webui/audit/right-inspector-reference-comparison.png` (1280 × 720 px). The supplied sidebar crop and the fixed inspector crop are shown together in the open/empty state.
- State: desktop conversation, right inspector expanded on the `预览` tab, with no active project, browser, or terminal context.

## Required fidelity surfaces

- Fonts and typography: the existing “工作区上下文” title, subtitle, and `预览 / 文件 / 活动` tab labels retain their type scale, weights, and line treatment.
- Spacing and layout rhythm: the header stays in its existing 68px rhythm; removing the decorative leading icon gives the title its correct left edge without moving the close action or tabs.
- Colors and visual tokens: the current neutral panel, divider, selected-tab teal, and hover/focus tokens are unchanged. The open/close affordance continues to use the existing Tabler stroke style.
- Image quality and asset fidelity: only the existing Tabler right-sidebar `expand` and `collapse` glyphs are used for the toggle. No CSS-drawn substitute or new asset was introduced.
- Copy and content: the panel title, subtitle, tab names, and contextual file/browser/terminal choices are unchanged. Their small semantic icons remain because they identify actual content types; the redundant panel icon itself was removed.

## Interaction and accessibility verification

- The unique `打开上下文侧栏` trigger opens the inspector; its visible glyph is `IconLayoutSidebarRightExpand` while closed.
- With the inspector open, the trigger’s label changes to `收起上下文侧栏` and its glyph changes to `IconLayoutSidebarRightCollapse`.
- The unique `完全收起上下文侧栏` action returns the panel to its hidden state and restores the single open trigger.
- Browser DOM readback confirmed `headerThemeIcons: 0`, `emptyStateThemeIcons: 0`, the selected `预览` tab, and zero browser console warnings/errors.

## Findings and comparison history

1. P2 before fix: the generic right-sidebar glyph was repeated in the outer trigger, header badge, and empty content, obscuring the open/closed state and making the empty panel look like side-panel chrome.
2. Fix: introduced state-specific right-sidebar expand/collapse icons for the outer control, removed the decorative header badge, and removed the duplicate empty-state glyph.
3. Post-fix comparison shows a single directional panel affordance plus content-specific file/browser/terminal choices, matching the requested hierarchy.
4. No actionable P0, P1, or P2 finding remains for the right workspace inspector.

## Verification

- `npm run build` — TypeScript and Vite production build passed.
- `./scripts/coding-assistant/verify.sh webui` — registry 6/6, runner 1/1, navigation 2/2, automation 1/1, typography contract, and TypeScript/Vite build passed.

final result: passed

---

# Design QA — collapsed sidebar brand-to-expand transition

Date: 2026-07-23

## Source and implementation evidence

- Source visual truth: `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-ca7abfeb-c262-4d6d-aeaf-284464a1d3a7.png` (1992 × 1268 px, inferred 2× browser capture). The red outline identifies the collapsed-sidebar entry; the red annotation is not product chrome.
- Browser-rendered idle state: `webui/audit/sidebar-reopen-brand-idle.png` (1280 × 720 CSS viewport, browser-reported device pixel ratio 2, capture normalized to 1280 × 720 px).
- Browser-rendered hover state: `webui/audit/sidebar-reopen-expand-hover.png` at the same viewport, theme, route, content, and sidebar state.
- Full-view comparison: `webui/audit/sidebar-reopen-full-comparison.png` (2426 × 720 px). The source is scaled to 720 px high and placed beside the implementation without changing either aspect ratio.
- Focused comparison: `webui/audit/sidebar-reopen-focused-comparison.png` (960 × 320 px). The source's 128 × 128 px target crop is normalized against 64 × 64 px implementation crops for idle and hover, then each is enlarged to 320 × 320 px for inspection.
- State: light theme, desktop conversation, left navigation collapsed; idle project icon and hover expand icon.

## Required fidelity surfaces

- Fonts and typography: no text, font, weight, line-height, or wrapping changed in this scoped control.
- Spacing and layout rhythm: the existing 28 × 28 px button remains at 12 px from the viewport top and left. Both icon layers occupy the same fixed slot, so the transition causes no layout shift.
- Colors and visual tokens: the idle state uses the selected black-and-white project icon. Hover/focus continues to use the existing `--ide-hover`, `--ide-text`, and light/dark theme tokens.
- Image quality and asset fidelity: the idle state reuses `/grok-build-icon.png`; the hover state uses the existing Tabler `IconLayoutSidebarLeftExpand`. No CSS-drawn or placeholder icon was introduced.
- Copy and content: the control keeps the accessible name and title `打开导航侧栏`; the visual swap does not alter its semantic action.

## Interaction and accessibility verification

- Browser readback confirmed idle computed opacity `brand=1`, `expand=0` and hover computed opacity `brand=0`, `expand=1` after the 150–180ms transition.
- Clicking the unique `打开导航侧栏` button removed that button and exposed one `收起导航侧栏` control; collapsing again restored one reopen button with the project icon idle state.
- Keyboard `:focus-visible` receives the same visual swap as hover. `prefers-reduced-motion: reduce` removes transition duration while preserving both end states.
- Browser console inspection returned no warnings or errors.

## Findings and comparison history

1. Before the change, the collapsed entry always displayed the expand icon, so the newly selected project mark disappeared whenever navigation was closed.
2. Fix: layered the existing project image and expand icon inside the same button, then cross-faded them with a small scale/rotation transition on hover and focus.
3. Post-fix evidence shows the requested project-icon idle state and expand-icon hover state in the same focused comparison. The button location, click target, accessible name, and sidebar behavior are unchanged.
4. No actionable P0, P1, or P2 finding remains for the requested collapsed-sidebar entry.

## Verification

- `./scripts/coding-assistant/verify.sh webui` — registry 6/6, runner 1/1, navigation 2/2, automation 1/1, typography contract, and TypeScript/Vite build passed.

final result: passed

---

# Design QA — compact composer height

Date: 2026-07-23

## Source and implementation evidence

- Source visual truth: `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-d9c61231-0128-4679-8e7b-1cc3fccc5ad2.png` (1856 × 866), supplied as the over-tall empty composer state.
- Before capture: `webui/audit/composer-height-before.png` (1280 × 720 CSS viewport, 1× density), with the local composer measuring 760 × 190 CSS px.
- Revised capture: `webui/audit/composer-height-after.png` (1280 × 720 CSS viewport, 1× density), with the empty composer measuring 760 × 158 CSS px.
- Multiline capture: `webui/audit/composer-height-multiline.png` (1280 × 720), showing four lines growing the component vertically while all controls remain visible.
- Same-input focused comparison: `webui/audit/composer-height-comparison.png` (820 × 720). The user crop is normalized to 760px width and compared with equal-width local before/after crops.
- State: light theme, empty launch screen, full desktop navigation, disconnected Agent draft placeholder.

## Required fidelity surfaces

- Fonts and typography: the existing SF/PingFang stack, 17px prompt text, line height, labels, and optical weights are unchanged.
- Spacing and layout rhythm: desktop minimum height changed from 190px to 158px. The text area changed from 118px to 94px and the toolbar from 68px to 58px; horizontal spacing, 760px width, 34px radius, and control sizes remain unchanged.
- Colors and visual tokens: panel, border, shadow, focus lift, disabled-send state, and light/dark semantic tokens are unchanged.
- Image quality and asset fidelity: no new image asset or icon was required; the existing Tabler controls remain intact.
- Copy and content: placeholder, permission label, runtime model, reasoning effort, voice action, and send semantics are unchanged.

## Interaction and responsive verification

- The empty composer presents the textarea, attachment/tools, permission, model, reasoning, voice, and send controls exactly once after the height reduction.
- Four entered lines expand the textarea and component from the compact baseline without overlapping or hiding the toolbar; clearing the draft restores the compact state.
- The mobile breakpoint retains its existing 226px minimum and stacked 118px toolbar because those controls require two rows below 560px.
- Autosize remains bounded to one through four rows, so long prompts grow predictably instead of returning the empty state to the over-tall size.

## Findings and comparison history

1. P2 before fix: the empty composer reserved 190px despite having a single-line placeholder, producing disproportionate blank space and weakening the title-to-input relationship.
2. Fix: reduced only the desktop baseline and internal vertical padding; preserved width, controls, animation, mobile layout, and multiline growth.
3. Post-fix evidence: the 760 × 158 crop has a tighter visual rhythm, while the four-line capture demonstrates that content capacity was not removed.
4. No actionable P0, P1, or P2 finding remains for the requested composer-height adjustment.

final result: passed

---

# Design QA — Task heading hover actions

Date: 2026-07-23

## Comparison target and normalization

- Source visual truth: `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-a30fb5fd-9dd1-43ab-b949-3c0f200c5a17.png` (1104 × 232 px). The target state is the left-sidebar Task heading with a disclosure chevron, an organize/sort icon, and a new-task pencil icon.
- Browser-rendered implementation: `webui/audit/task-heading-actions.png` (1280 × 720 px, CSS viewport 1280 × 720, 1× density). State: dark theme, Task expanded, no existing general task, pointer hovered over the Task heading.
- Focused comparison: `webui/audit/task-heading-comparison.png` (1396 × 232 px). It stacks the source crop beside the 300 × 232 px implementation sidebar crop without scaling either focused region.
- State caveat: the source is a light-theme cropped reference, while this product keeps its existing dark theme. The comparison therefore judges component hierarchy, spacing, icon affordance, and interaction rather than duplicating colors.

## Findings

- No actionable P0, P1, or P2 finding remains. The Task header now uses the same action container as Project: the ellipsis control opens a real sort menu and the pencil starts a new general task.
- [P3] The source's light neutral treatment is intentionally not copied because Stillpoint's dark/light token system is an existing product constraint. The action icons use the project section's identical hover/focus opacity behavior.

## Required fidelity surfaces

- Fonts and typography: the Task label keeps the existing section-label font, size, weight, chevron spacing, and single-line behavior; the new actions do not disturb its baseline.
- Spacing and layout rhythm: the actions occupy the same right-aligned 2px-gap group as Project. The existing sidebar divider, 30px heading rhythm, and empty-task row remain unchanged.
- Colors and tokens: icon color, hover background, focus treatment, and opacity reuse `.project-section-actions` and `.ide-section-heading` tokens rather than introducing a separate task-only color.
- Image quality and asset fidelity: the source contains standard UI icons only; the implementation uses the existing Tabler icon set, matching the project controls. No raster, CSS-drawn, or placeholder asset was added.
- Copy and content: accessible labels are `整理任务` and `新建任务`; the menu exposes `优先级` and `最近创建`, both backed by actual state changes.

## Interactions and evidence

- Browser snapshot exposed one unique `整理任务` button and one unique Task-heading `新建任务` button alongside the Task disclosure.
- Clicking `整理任务` exposed the two menu items; selecting `最近创建` updated the real task-sort state and closed the menu.
- The new-task button is wired to the existing `newTask()` path and is disabled only while an Agent task is running, matching the primary new-task action.
- Console error/warning check and the WebUI verification command are recorded in this task's final evidence.

## Comparison history

1. Initial state: Task had only its disclosure control, while Project had two title-level actions. This was a P2 interaction/fidelity gap relative to the supplied hover state.
2. Fix: added the reusable action group, task-sort state/menu, and the existing new-task handler to `webui/src/main.tsx`.
3. Post-fix: browser DOM and focused visual comparison show the ellipsis and pencil controls aligned with Project; no P0/P1/P2 gap remains.

## Implementation checklist

- [x] Task header shows organize/sort and new-task controls.
- [x] Sort menu changes the general task order.
- [x] New-task control uses the established session creation path.
- [x] Focused source/implementation comparison captured.

final result: passed

---

# Design QA — unified left navigation and supporting workspaces

Date: 2026-07-23

## Source and implementation evidence

- Source visual truth: `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-61049fba-fc95-461c-8ab6-1521123a9776.png` (1442 × 648), supplied as the Codex project-section organization, sort, and adjacent add-action reference. The other screenshots in the same request define project-row actions, pinned/archived task behavior, and the separation between projects and individual tasks.
- Rendered implementation states: `/private/tmp/grok-build-project-popover-1280x720.png`, `/private/tmp/grok-build-automation-1280x720.png`, `/private/tmp/grok-build-connectors-1280x720.png`, and `/private/tmp/grok-build-session-loading-1280x720.png`, each captured from the selected in-app browser at a 1280 × 720 CSS viewport.
- Same-input comparison: `/private/tmp/grok-build-design-qa-sidebar-comparison.png` (1260 × 710). The reference sidebar crop and implementation sidebar/popover crop are normalized into one horizontal comparison input; the reference's higher-density capture is scaled down without changing its aspect ratio.
- State: light theme, connected local ACP bridge, populated task list, project-add popover open. Automation and connector states use the same shell and semantic tokens.

## Hierarchy and interaction pass

- Primary navigation now contains exactly three work entry points: `新建任务`, `自动化任务`, and `技能和连接器`.
- `项目` and `任务` are separate second-level accordion sections. Each exposes `aria-expanded`; collapse removes its third-level rows from the interaction tree and expansion restores them without changing task data.
- Project rows remain durable workspace containers and nested rows remain their individual sessions. Standalone tasks remain under the task accordion instead of being rendered as pseudo-projects.
- The project-header `+` opens a small right-anchored two-choice popover. `新建空白项目` continues into the real default-workspace flow; `使用现有文件夹` continues into the real external-CWD registration flow. No project is fabricated during visual QA.
- Project organization, sorting, per-project new-task, pin/archive, and disclosure controls follow one compact icon-and-menu grammar and preserve their existing backend actions.
- Session recovery is a viewport-fixed neutral overlay with one centered loader. The accessible status text remains screen-reader-only, and the captured state contains no visible recovery sentence or card.

## Supporting page consistency

- Automation and skills/connectors are no longer placeholder navigation items. Automation suggestions and saved templates use the real `/api/automations` registry, including create, use-for-new-task, and delete behavior.
- Skills and connectors use two explicit catalog tabs, one search treatment, consistent cards, truthful local capability/status copy, and a one-column responsive fallback below 1100px.
- Page titles, primary actions, search fields, cards, borders, radii, spacing, empty states, and dark/light variables are shared instead of being restyled independently per page.
- All visible interface assets use the existing Tabler icon library. No emoji, custom SVG, CSS illustration, or placeholder product art was introduced.

## Comparison history and findings

1. P1 before fix: the previous task section was not independently collapsible, so project and task hierarchy read as one long list.
2. P1 before fix: project creation used a centered workflow/dialog entry and an empty-list row, which conflicted with the supplied Codex header-action model.
3. P1 before fix: session recovery displayed a text card inside the conversation, producing a second transient content layer.
4. P2 before fix: automation and skills/connectors did not share a complete, consistent page system.
5. Post-fix browser checks exercised task collapse/expand, project add popover and both downstream choices, automation creation form, skills/connectors tabs, and a real session-switch loading frame. The focused comparison shows no overlap, clipped controls, or hierarchy inversion.
6. No actionable P0, P1, or P2 visual or interaction finding remains for the requested sidebar and supporting-page scope.

## Verification

- `npm run build`
- `npm run test:registry` — 5/5 passed
- `npm run test:navigation` — 2/2 passed
- `npm run test:automations` — 1/1 passed
- `npm run test:runner` — 1/1 passed

final result: passed

---

# Design QA — Codex-style project and task hierarchy

Date: 2026-07-23

## Source and implementation evidence

- Source visual truth: `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-61049fba-fc95-461c-8ab6-1521123a9776.png` (Codex project header, organization menu, sort choices, and adjacent `+` entry) plus the supplied project/task hover and row-menu crops from the same request.
- Rendered implementation: `webui/audit/project-task-sidebar-light.jpg` at 1280 × 720 CSS px, 1× density, light theme, connected ACP Agent, populated task list.
- Same-input full-view comparison: `webui/audit/project-task-sidebar-light-comparison.jpg` at 2882 × 752. The reference and implementation are side by side at matched 720 px content height; browser chrome and the source's partial right canvas are treated as non-product crop differences.
- State: desktop local WebUI; project registry intentionally empty, so the comparison validates the project header, empty project CTA, task hierarchy, and real task controls. The project creation chooser and existing-folder form were also opened and verified through the browser accessibility tree without creating user data.

## Required fidelity surfaces

- Fonts and typography: compact system UI typography keeps the Codex-like hierarchy: muted section labels, stronger task titles, single-line truncation, and icon-sized secondary controls.
- Spacing and layout rhythm: the project header retains a dedicated action lane for organization and add actions; projects and standalone tasks are split by a divider rather than interleaving as one history list.
- Colors and visual tokens: the light state maps the source's pale neutral navigation and selected surface to existing semantic light tokens; the dark alternative remains available through the existing theme control.
- Image quality and icon fidelity: the target uses interface icons only. The implementation uses the existing Tabler icon library for folders, ellipsis, pin, archive, plus, and chevrons; no custom image or SVG substitute was introduced.
- Copy and content: `项目` is now the persistent folder/context container, while `任务` is the individual ACP conversation list. The obsolete workspace-path header, ready badge, and empty-task onboarding copy are absent.

## Interaction verification

- `新建项目` / `创建第一个项目` opens a two-choice dialog: `新建空白项目` and `使用现有文件夹`.
- `使用现有文件夹` exposes real folder-path, display-name, and instructions fields; submit is disabled until a folder path is supplied.
- The registry test proves an imported existing directory is stored as an external project and used as the real project CWD.
- Task rows expose named pin and archive actions; project sorting offers `按项目` / `在一个列表中` plus priority, recent, and manual sort modes.
- Browser console check found no errors. Production TypeScript/Vite build and registry/navigation tests passed.

## Findings and comparison history

1. Earlier state mixed long-lived projects with every recent conversation and repeated workspace/status information in the main canvas. The change separates those objects, removes the redundant chrome, and moves project creation to the Codex-like header action.
2. The reference's exact pale green Codex sidebar is intentionally not copied as a hard-coded color; it is represented by the application's existing light semantic tokens, with dark mode still supported.
3. No actionable P0, P1, or P2 visual or interaction mismatch remains for the requested project/task structure. The live registry had no project rows during the capture, so the project-row menu is validated by the same rendered component path and named controls rather than by fabricating a project in user state.

## Implementation checklist

- [x] Project header organization and sorting menu.
- [x] Project creation chooser and real existing-folder binding API.
- [x] Separate task list, task pinning, and task archive action.
- [x] Remove redundant workspace path, ready badge, and empty-task onboarding copy.
- [x] Build, registry, navigation, and browser interaction verification.

final result: passed

---

# Design QA — Stillpoint Personal Coding IDE

Date: 2026-07-22

## Source and comparison

- Selected source: `/Users/qixiaotong/.codex/generated_images/019f880d-a4e3-7ac1-ab5b-f4f15c05fd81/exec-85357b6d-d36c-4639-9b0f-7dd976eac13a.png` (1487 × 1058).
- Implementation capture: `webui/qa-implementation.png` at the same 1487 × 1058 viewport.
- Same-input comparison: `webui/qa-comparison.png` contains the source and implementation side by side and was used for every visual judgment below.
- Theme comparison: `webui/qa-theme-comparison.png` contains the verified dark implementation and the new light implementation at the same 1487 × 1058 viewport; the light capture is `webui/qa-light-theme.png`.
- Collapsed-rail source: `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-80c0fd43-7cdd-4bf1-a4c9-e9d9d4705427.png` (994 × 1898, approximately 2× density for a 72px rail pattern).
- Collapsed-rail implementation: `webui/qa-collapsed-sidebar-dark.png` (1487 × 1058 CSS viewport at 1× capture density). `webui/qa-collapsed-comparison.png` normalizes the source to the implementation height and places both artifacts in one comparison input.

## Fidelity pass

- Layout and spacing: the 300px sidebar divider, centered 830px composer, title baseline, composer top edge, 206px composer height, textarea/footer split, borders, radii, and main-column offset now align with the source.
- Typography: the sparse title hierarchy, compact sidebar labels, muted metadata, and coding-task placeholder remain readable without wrapping or clipping.
- Colors and surfaces: dark canvas, slightly raised composer, restrained borders, muted secondary text, teal accent, active rows, hover states, and focus indicators are coherent with the selected direction.
- Light theme: warm gray-white canvas, pale neutral sidebar, white composer, graphite text, soft green selection surfaces, teal accents, disabled controls, shadows, menus, messages, approvals, dialogs, and form surfaces all map through semantic theme tokens without changing layout.
- Collapsed navigation: the desktop sidebar now contracts from 300px to a persistent 72px icon rail rather than disappearing. Its vertical rhythm, 40px actions, selected task surface, subtle divider, and circular bottom expand control preserve the reference pattern while retaining Stillpoint's teal theme.
- Icons: Tabler icons are used consistently; new task uses a pencil, attachment uses a paperclip, and send uses a paper-plane icon. No custom SVG/CSS illustration substitutes were added.
- Copy: `Personal Coding IDE` is an intentional product correction from the generated source's `Personal Agent`. Project and history counts are runtime data rather than hard-coded screenshot content.
- Runtime-state differences: disabled attachment/send controls in the QA capture reflect the isolated ACP restore state. A healthy ready session uses the teal enabled send treatment. This is not represented as a fake ready state.

## Interaction and resilience pass

- Project creation produced a real isolated project registry entry and filesystem workspace.
- Project expand → collapse → expand was exercised; nested session rows disappear and return correctly.
- Desktop sidebar collapse → 72px rail → 300px full sidebar was exercised; project/history actions remain available through labeled rail controls and the main canvas never shifts off-screen.
- Auto → Expert → Auto was exercised; the selected mode label and menu check state updated correctly.
- Dark → light → dark → light was exercised from the account-row control; the accessible label/icon updated in both directions, and a reload preserved the saved light preference.
- Desktop: 1487 × 1058 comparison state has no overlap or horizontal overflow.
- Tablet: 900 × 900 has `scrollWidth === innerWidth`; the 564px composer remains clear of the sidebar.
- Mobile: 390 × 844 has no horizontal overflow; the full-width navigation still collapses completely (instead of leaving a desktop rail) and reopens from the main surface.
- Light mobile: 390 × 844 also has `scrollWidth === innerWidth`; the 366px composer and full-width navigation remain intact.
- Browser console check returned no warnings or errors during the verification run.

## Verification

- `npm run build`
- `npm run test:registry` — 3/3 passed
- `npm run test:runner` — 1/1 passed

## Result

No unresolved P0, P1, or P2 fidelity findings remain for the requested IDE home screen.

The reference is a narrow portrait crop while the implementation evidence is the full desktop product canvas, so exact full-frame matching would be false precision. The focused rail comparison confirms the requested proportion and interaction pattern; the broader implementation capture confirms that the content area remains usable after collapse.

final result: passed

---

# Design QA — project hierarchy hover and disclosure

Date: 2026-07-22

## Source and implementation evidence

- Source visual truth: the four user-provided sidebar crops: `codex-clipboard-bb17b32e-4b8a-4124-9f12-6f120ba1ed1d.png` (1038 × 68), `codex-clipboard-a008ed37-632f-4e26-b313-8d1b5eef05b8.png` (1030 × 69), `codex-clipboard-3b4314e8-6bbe-411c-b2c4-ccbe26a025a2.png` (1027 × 60), and `codex-clipboard-f0de1792-6e63-44bb-b1b4-4bddebd67a62.png` (1038 × 70).
- Rendered implementation: `webui/audit/project-section-idle.png`, `project-section-hover.png`, `project-row-open-idle.png`, `project-row-open-hover.png`, and `project-row-closed-hover.png`, captured from the in-app browser at a 1280 × 720 CSS viewport and 1× density.
- Same-input focused comparison: `webui/audit/project-hierarchy-comparison.png` (1320 × 840). Reference crops and 300px implementation-sidebar crops are normalized into paired rows; source aspect ratios are preserved and implementation crops are enlarged only for legibility.
- States: project section idle, project section revealed through keyboard focus (the same controls use CSS hover), project row idle, project row expanded/focused, and project row collapsed/focused.

## Required fidelity surfaces

- Fonts and typography: the existing SF/PingFang stack and compact Stillpoint label weights remain unchanged. The section and project labels stay single-line and readable at 300px sidebar width.
- Spacing and layout rhythm: the section heading keeps the existing 34px rhythm; project rows remain 38px high with a 7px radius. Revealed controls do not shift labels or change row height.
- Colors and visual tokens: idle rows remain transparent. Hover and `focus-within` use the existing semitransparent `--ide-hover` token; keyboard focus additionally retains the existing teal accessibility outline.
- Image quality and icon fidelity: no raster asset is required. Tabler supplies the real folder, open-folder, chevron, ellipsis, pencil, and plus icons; no custom SVG or CSS drawing was added.
- Copy and content: real project names and sessions remain data-driven. The section menu exposes truthful `全部展开` and `全部收起` actions; the row menu opens the existing project settings flow, and the pencil preserves the existing new-session behavior.

## Interaction and accessibility verification

- The top-level `项目` control changed `aria-expanded` from true → false → true and hid/restored the project tree.
- `grok-build` changed `aria-expanded` from true → false → true; its leading icon changed between `IconFolderOpen` and `IconFolder`, and nested sessions hid/restored with the same state.
- Section controls and project-row controls are visually hidden while idle, reveal on hover or `focus-within`, and remain visible on touch-only devices where hover is unavailable.
- `项目更多操作` exposed `全部展开` and `全部收起`; both actions were exercised across `grok-build` and `nis`.
- The project-row menu exposed `项目设置` and opened the existing project dialog without modifying project data.
- Every new control remains a named button/menuitem; the hidden idle controls remain keyboard reachable and reveal when focused.

## Findings and comparison history

1. The prior implementation used a rotating chevron as the project icon and kept the new-session action visible at all times. This did not match the supplied hierarchy or idle/hover distinction.
2. The revised implementation uses folder/open-folder state icons, hides secondary controls until hover/focus, adds a semitransparent row hover surface, and separates top-level project-list disclosure from per-project disclosure.
3. The focused comparison shows a teal outline not present in the mouse-hover reference. This is an intentional keyboard-only accessibility state; pointer hover uses the same background and revealed controls without that outline.
4. No actionable P0, P1, or P2 visual or interaction mismatch remains for the requested project hierarchy states.

final result: passed

---

# Design QA — composer control semantics

Date: 2026-07-22

## Source and implementation evidence

- Source visual truth: `webui/audit/output-composer-2026-07-22/reference.png` (1176 × 252 pixels), supplied by the user as the composer format target.
- Rendered implementation: `webui/audit/output-composer-2026-07-22/implementation-light.png` (1280 × 720 pixels) from the in-app browser in the light, disconnected empty-task state.
- Focused same-input comparison: `webui/audit/output-composer-2026-07-22/comparison.png` (1280 × 560 pixels). The source is centered without scaling; the implementation composer is cropped at its rendered 760 × 190 size and centered without scaling. Capture density is 1× for the saved screenshots; the browser reports a 1280 × 720 CSS viewport.
- State difference: the reference displays “完全访问,” while the implementation truthfully displays the safer unresolved/default state “逐项授权” until the active Agent confirms a permission preference. The elevated state maps to the same orange semantic treatment after a successful permission change.

## Full-view and focused comparison

- Both states use one large rounded surface, a generous free-entry region, and a single bottom action row.
- Left controls map to the actual product: `+` opens file, tool/skill, and plugin/connector entry points; the adjacent text control opens the permission policy menu.
- Right controls map to the actual ACP session: runtime model, low/medium/high reasoning effort, browser voice input, and the circular send action.
- The narrower 760px implementation is an intentional existing Stillpoint constraint from the prior user direction; it keeps the composer coordinated with the central coding workspace instead of copying the reference's screenshot-wide measure.

## Required fidelity surfaces

- Fonts and typography: existing SF/PingFang system typography remains intact. The prompt area is 17px at 1.55 line height; the model, effort, permission, and action labels use compact 16px UI text with clear truncation and optical weight.
- Spacing and layout rhythm: 190px desktop height, 34px radius, 26px prompt inset, 68px toolbar, 40px secondary actions, and a 48px circular send action match the reference hierarchy. The mobile breakpoint stacks the two toolbar groups to avoid clipping rather than shrinking tap targets.
- Colors and tokens: the implementation uses Stillpoint's existing light/dark semantic tokens. Full access uses `--ide-warning`; listening uses `--ide-danger`; disabled send remains visibly distinct. No source brand palette was copied.
- Image and icon fidelity: the component requires no raster imagery. All visible controls use the project's existing Tabler icon library; no custom SVG, CSS drawing, emoji, or placeholder asset was added.
- Copy and content: reference-only strings such as “5.6 Sol” and “随心输入” were not copied. The runtime model name, connection-aware placeholder, real permission state, and actual feature labels are preserved.

## Interaction and accessibility verification

- The add menu opened and exposed three reachable actions: File, Tools and Skills, and Plugins and Connectors.
- The permission menu opened in the disconnected state and exposed per-session/manual and two auto-approval scopes without falsely changing state before the Agent confirms it.
- The reasoning menu opened, exposed Low/Medium/High, and changed the pre-session preference from High to Low and back to High. Ready sessions use `session/set_model` with ACP `_meta.reasoningEffort`; new sessions apply the preferred effort immediately after `session/new` through the same supported ACP method.
- Voice input invokes the browser speech-recognition surface, reports missing microphone permission when denied, and returns to the idle button state. The listening button has `aria-pressed`, a visible pulse, and reduced-motion coverage.
- `/help` enabled the otherwise disabled disconnected send button, sent exactly once, cleared the composer, and rendered the local command response. Empty send remains disabled.
- Menus and actions are named buttons/menuitems in the accessibility tree; focus-visible and reduced-motion rules remain active.

## Comparison history and findings

1. First rendered comparison found no actionable P0/P1/P2 mismatch after accounting for the intentional narrower workspace measure and truthful disconnected permission state.
2. P3 residual: the reference uses a slightly lighter neutral shadow and wider frame. Stillpoint retains its existing tokenized shadow and central-column width to preserve product consistency.

## Verification boundary

- The disconnected UI and pre-session reasoning preference were exercised visibly. A model-backed reasoning switch and successful microphone transcript require an authenticated Agent and granted operating-system microphone permission, respectively; neither success state was fabricated.
- The 390px responsive branch is covered by explicit stacked-toolbar CSS and the production build, but the selected in-app browser exposes a fixed 1280 × 720 viewport for this run, so no mobile screenshot is claimed.

final result: passed

---

# Design QA — SuperGrok-inspired composer

Date: 2026-07-22

## Source and implementation evidence

- Source visual truth: `webui/audit/composer-reference-2026-07-22/reference-supergrok-composer.png` (2576 × 858 pixels). The focused source crop is `reference-composer-crop.png` (1620 × 250 pixels).
- Rendered implementation: `webui/audit/composer-reference-2026-07-22/implementation-desktop-focus.png` at a 1280 × 720 CSS viewport and 1× capture density. The focused component crop is `implementation-composer-focus.png` (805 × 205 pixels).
- Same-input comparison: `webui/audit/composer-reference-2026-07-22/composer-comparison.png`. Both component crops preserve their source aspect ratio and are padded to the same 1320px comparison canvas; no density-only differences were filed.
- State: dark theme, empty textarea focused, Agent unavailable, and no duplicate project action inside the composer. This intentionally compares the reference's active composer structure with the implementation's truthful local runtime state.

## Full-view and focused comparison

- The full implementation capture confirms the 760px composer remains centered in the available desktop workspace and does not collide with the pinned project sidebar.
- The focused comparison confirms the reference's main visual grammar: one uninterrupted rounded surface, generous prompt space, a compact bottom toolbar, a plus attachment action, right-aligned mode controls, and a circular up-arrow send action.
- A focused comparison is required because the source is a standalone light-theme component while the implementation is part of a dark coding IDE. The full pages are not the same product state and were not treated as pixel-identical targets.

## Required fidelity surfaces

- Fonts and typography: the existing SF/PingFang system stack is preserved. Prompt text is 16px with a 1.55 line height; compact toolbar controls retain the current product's readable weights and truncation behavior.
- Spacing and layout rhythm: the composer is 760px wide and 158px tall at desktop, with a 30px radius, 28px prompt inset, a 58px bottom toolbar, and no hard footer divider. At 520 × 800 it measures 496px wide with `scrollWidth === innerWidth` and no horizontal overflow.
- Colors and visual tokens: the reference's soft neutral surface maps to Stillpoint's semantic dark/light panel, border, text, hover, focus, and accent tokens. No reference brand color was hard-coded.
- Image quality and asset fidelity: the composer contains only application controls, so no raster assets were required. Tabler provides the plus, folder, shield, chevron, and up-arrow icons; no custom SVG, CSS drawing, emoji, or placeholder asset was introduced.
- Copy and content: the reference brand and its `test` content were not copied. Project context remains in the navigation and page toolbar; the composer shows response mode, runtime-provided model, permission policy, and truthful send availability.

## Interaction verification

- Focus changes the composer transform to `matrix(1.004, 0, 0, 1.004, 0, -3)`, adds a semantic accent outline, and increases the soft elevation.
- Hover and press states animate the attachment, project, mode, model, permission, and send controls. The enabled send control uses a lift/scale transition; reduced-motion preferences collapse animation duration through the existing accessibility rule.
- The Auto mode menu opened and exposed Auto, Fast, Expert, and custom instruction actions. The duplicate current-project chip was removed because project selection already belongs to the left navigation.
- The 520 × 800 responsive pass had no horizontal overflow. The compact layout hides the secondary response-mode label while retaining attachment, model, permission, and send controls.
- Browser console verification returned no warnings or errors.

## Comparison history

1. The first motion pass used animation fill mode `both`, which kept the entrance keyframe's final transform and prevented the focus lift from becoming visible.
2. The fill mode was removed. Post-fix browser evidence confirmed the focused transform reaches 1.004 scale and -3px vertical translation.
3. The first reference adaptation placed a current-project chip beside attachment. User-flow review found it duplicated the left project navigation, so it was removed.
4. No actionable P0, P1, or P2 fidelity or interaction finding remains. The missing microphone is intentional because this product does not currently expose a verified voice-input capability.

## Verification

- `./scripts/coding-assistant/verify.sh webui` — registry 4/4 passed, runner 1/1 passed, TypeScript/Vite production build passed.
- In-app browser — desktop focused state, mode menu, real project chip, light theme, 520px responsive boundary, console, and focus transform verified.

final result: passed

---

# Design QA — Codex/Wukong artifact workspace

Date: 2026-07-22

## Source and implementation evidence

- Source state: the Wukong half of `webui/audit/wukong-interactions-comparison.png`, normalized to a 1280 × 860 frame. It establishes the programming-tool hierarchy: navigation on the left, conversation/execution in the center, and a persistent result/file surface on the right.
- Implementation state: `webui/audit/wukong-file-preview-implemented.png` at a 1280 × 720 CSS viewport, showing the real `grok-build/AGENTS.md` file returned by the local project API.
- Same-input comparison: `webui/audit/wukong-file-preview-comparison.png` at 2560 × 860. The implementation was vertically padded without scaling so both halves retain a 1280px-wide desktop frame.
- Responsive evidence: `webui/audit/wukong-file-preview-narrow.png` at 900 × 720 verifies that the preview becomes a dismissible overlay without clipping its tabs, file heading, close actions, or code content.

## Fidelity and behavior pass

- Layout: the implementation now uses the same three-surface hierarchy as the reference. The right surface is no longer primarily a context/activity drawer; it is a persistent artifact workspace with Preview, Files, and Activity tabs.
- Spacing and density: the 300px project navigation remains intact, the center composer retains its existing compact coding controls, and the 411px desktop preview is wide enough for readable code while preserving the conversation column.
- Typography and copy: file names, relative paths, code text, empty-state guidance, refresh behavior, and connection errors are explicit and do not imply unavailable functionality. Monospace content preserves source line breaks.
- Colors and surfaces: the dark Stillpoint theme is an intentional product constraint rather than a copy of Wukong's white shell. New tabs, borders, active states, error treatment, and preview surfaces use existing semantic tokens in both themes.
- Icons and assets: Tabler icons are used consistently. No fake product imagery, CSS illustration, placeholder avatar, or custom SVG substitute was introduced.
- States and interactions: project selection, real file listing, manual refresh, text preview, preview close, Files/Activity navigation, right-panel close, desktop persistence, and narrow overlay behavior were exercised. The browser console returned no warnings or errors.
- Accessibility: the panel is a complementary landmark; tabs use tab semantics and selected state; file rows and refresh/close actions are real labeled buttons; the preview image path supplies alt text; keyboard focus styles and reduced-motion behavior remain inherited from the existing application.

## Comparison history

1. The first implementation pass made Activity the dominant inspector content and limited tool output to 180 characters. This conflicted with the reference's result-viewer purpose.
2. The revised pass promotes Preview and Files, expands tool-result text to 12,000 characters, adds a real project file API, blocks path traversal and symlink escape, and adds a visible refresh control for newly generated files.
3. The 900px pass confirmed the preview overlay remains readable and dismissible. No unresolved P0, P1, or P2 visual or interaction finding remains for the requested artifact workspace.

## Runtime boundary

- The local page and project file API are reachable; selecting `grok-build`, listing files, and reading `AGENTS.md` were verified through the visible UI.
- Model-backed output is not represented as successful: the current environment lacks approved model credentials, so the center pane correctly shows the real Agent connection error.

final result: passed

---

# Interaction QA — Wukong reference adaptation

Date: 2026-07-22

## Source visual truth and normalization

- Primary source state: `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-062f2997-a7f8-4161-9444-271e736fb835.png` (2560 × 1720, light theme, right preview panel open).
- Supporting source states: the seven `codex-clipboard-*.png` screenshots supplied in this task, covering the left project tree, right preview panel, model menu, permission menu, response typography, and settings. Settings were explicitly excluded from this task.
- Rendered implementation: `webui/audit/wukong-interactions-dark-final.png` (1280 × 720 CSS viewport, 1× capture density, dark theme, right context panel open).
- Same-input comparison: `webui/audit/wukong-interactions-comparison.png` (2560 × 860). The source was normalized to 1280 × 860; the implementation was padded to the same comparison frame before horizontal stacking.
- Focused states: `webui/audit/wukong-interactions-collapsed-dark.png` and `webui/audit/wukong-interactions-collapsed-light.png` (1280 × 720) verify the 72px rail, right panel, composer controls, and theme-token mapping together.
- State caveat: the local Agent is reachable as a page but cannot initialize a model-backed session because the current process has no approved model credential. The screenshots therefore show the real connection-error state, not fabricated reply content.

## Full-view comparison evidence

- Layout and spacing: the implementation preserves Stillpoint's existing 300px left sidebar, 72px collapsed rail, 830px composer, dark/light tokens, and message-column proportions. The Wukong reference contributes only the second collapsible panel and bottom-control grouping; its white shell, title bar, branding, settings launcher, and wider content measure were intentionally not copied.
- Right panel: the 352px inspector matches the reference's distinct bordered side region and close affordance, but shows Stillpoint business data: ACP session usage, project sources, sent attachments, and tool activity.
- Composer: response mode, runtime-provided model selector, permission strategy, attachment, and send controls remain inside the existing Stillpoint composer surface. At 1280px no control clips or overlaps the right panel.
- Left navigation: project expansion and nested session rows remain unchanged; the right panel does not replace or distort the existing project hierarchy.

## Required fidelity surfaces

- Fonts and typography: existing SF/PingFang system stack and Stillpoint weights are preserved. Agent replies now render semantic headings, lists, blockquotes, tables, inline code, and code blocks with a readable 1.72 line height.
- Spacing and rhythm: left/right rails, composer footer, inspector sections, row heights, and close controls retain the project's compact IDE rhythm. The implementation intentionally keeps the pre-existing taller composer rather than copying Wukong's shorter input.
- Colors and tokens: every new surface uses existing semantic variables for dark and light themes; no Wukong colors were hard-coded.
- Image quality and assets: no new raster assets, custom SVGs, emoji, or CSS illustrations were introduced. Existing Tabler icons are used for navigation and state actions; uploaded images retain their original preview data.
- Copy and content: labels describe actual ACP/session/project behavior. “运行中的会话自动批准” explicitly says it does not persist across restart. Unavailable settings and global permission promises were not added.
- Accessibility and state: both sidebars use labeled buttons, `aria-expanded`, a complementary landmark, keyboard focus styles, real empty/error messages, and responsive overlay behavior below 900px.

## Comparison history

1. Initial implementation capture showed the inspector toggle tooltip remaining over the panel after activation. The toggle was changed to hover-only tooltip behavior, and the final capture was taken after moving focus to the error card.
2. Post-fix evidence: `webui/audit/wukong-interactions-dark-final.png` has no overlay covering the inspector header or content. No actionable P0/P1/P2 visual finding remains.

## Residual verification gaps

- Dynamic model selection and permission changes compile against the real ACP methods, but their model-backed end-to-end execution is not covered in this process because `MIMO_API_KEY` and `DEEPSEEK_API_KEY` are absent.
- The right panel's real token/context snapshot requires a ready ACP session; the disconnected-state copy was verified visually.
- Model harness incompatibility can legitimately reject a switch after turns have run; the UI reports that server error and preserves the previous model.

final result: passed

---

# Design QA — compact initialization settings

Date: 2026-07-23

## Source visual truth and rendered evidence

- Source visual truth: `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-41dd5448-427a-44e2-a05f-d352ddf78cfa.png` (2760 × 1800 px). Red outlines are user annotations, not product chrome.
- Density-normalized source: `/private/tmp/runbuild-initialization-reference-1952x1273.png` (1952 × 1273 px), resized without changing the source aspect ratio.
- Browser-rendered implementation: `/private/tmp/runbuild-initialization-1952x1273.png` at a 1952 × 1273 CSS-pixel viewport and 1× capture density, dark theme, first-run microphone state `not-determined`.
- Responsive implementation: `/private/tmp/runbuild-initialization-390x844.png` at a 390 × 844 CSS-pixel viewport and 1× capture density.
- The normalized source and implementation were opened together in one comparison input at the same aspect ratio. The implementation intentionally has a shorter modal because the requested title subtitle, scope banner, and long descriptions were removed.

## Full-view and focused comparison

- Full view confirms that the existing centered modal, dimmed application shell, shield cue, close control, permission grouping, project boundary, and bottom actions remain intact.
- The title now contains only `初始化设置`; the redundant scope banner is absent; microphone, project-folder, and Agent-approval descriptions are reduced to single short statements.
- The microphone row retains the existing chevron but is now a semantic full-row button only when the current desktop snapshot exposes an available action. The project-folder row remains informational because it has no chevron or initialization-time settings action.
- A separate focused crop was unnecessary: at the normalized 1952 × 1273 comparison, all four annotated regions and their copy are readable. The narrow capture verifies the same content without horizontal overflow (`documentScrollWidth === innerWidth === 390`).

## Required fidelity surfaces

- Fonts and typography: existing SF/PingFang tokens, weights, badges, and hierarchy remain unchanged; removal of the subtitle leaves one clear modal heading.
- Spacing and layout rhythm: existing width, padding, radii, borders, and action alignment are preserved. Content removal lets the modal height contract naturally instead of adding fixed dimensions.
- Colors and visual tokens: existing dark-theme surfaces, teal focus/accent, muted copy, warning state, and hover tokens are reused; no new palette was introduced.
- Image quality and asset fidelity: the existing Tabler shield, microphone, folder, chevron, and completion icons are retained. No new raster, SVG, CSS drawing, or placeholder asset was added.
- Copy and content: `用于语音输入，不会自动发送。`, `添加项目时选择目录，仅访问所选项目。`, and `Agent 工具操作仍需逐项授权。` accurately describe the current boundary without adding permissions.

## Interaction and accessibility evidence

- `not-determined`: the unique row button exposed the accessible name `允许麦克风`; clicking it invoked the request path and changed the staged browser state to granted.
- `denied`: the unique row button exposed the accessible name `打开麦克风系统设置`; clicking it invoked the settings path and changed the staged browser state to granted.
- `granted/not-required`: the row becomes static and displays the completion mark; `unknown` exposes neither a chevron nor a false action.
- The actionable row is a native button with Enter/Space support, visible focus, disabled busy state, and `aria-describedby` for its short explanatory copy.
- These browser state transitions used a temporary local preview adapter only to exercise the existing callbacks; the adapter was removed before the final build. They prove UI routing, not that macOS permission was granted. The production IPC remains the authority for the actual system prompt and System Settings page.
- The final clean preview at `http://127.0.0.1:5178/?desktop=1` reported no browser console warnings or errors. Without the Electron preload it truthfully shows an unavailable permission state rather than fabricating host access.

## Findings and comparison history

1. Before the fix, the title and descriptions were overly long, the scope banner repeated the same boundary, and the microphone chevron sat on a non-interactive `div`.
2. Fix: removed the redundant content, reduced the copy, and mapped the microphone row to the snapshot's `canRequest` / `canOpenSettings` capabilities.
3. Post-fix same-input comparison and the 390px responsive pass found no actionable P0, P1, or P2 visual, interaction, or overflow issue in the requested scope.

## Verification

- `npm run build` — TypeScript and Vite production build passed; the existing bundle-size warning remains non-blocking.
- `./scripts/coding-assistant/verify.sh webui` — registry 7/7, runner 2/2, navigation 2/2, automation 1/1, desktop 5/5, typography, WebUI build, desktop bundle, and preload bundle passed.
- In-app browser — pending, denied, granted, unknown, desktop, narrow, accessible-name, full-row click, and console states checked.

final result: passed

---

# Design QA — persistent top divider and sidebar controls

Date: 2026-07-23

## Source and implementation evidence

- Source visual truth: `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-964297ca-6421-469f-bd28-a6cb8e463c44.png`, `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-eb13acf3-5a80-4f2a-8336-83dba1f9cd26.png`, and `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-c02a7419-ecae-47b3-8892-16a038d6ec31.png`. Red frames identify the divider and the left/right sidebar controls; they are annotations rather than product chrome.
- Implementation: `webui/src/main.tsx` adds one persistent `workbench-topbar`; `webui/src/styles.css` provides the full-width divider and shared positioning token. Existing chat output, landing state, and composer markup are unchanged.
- Local preview target: `http://127.0.0.1:5173/`. The in-app Browser security policy rejected a fresh readback of this existing local tab after hot reload, so no new browser screenshot is claimed for this patch.

## Required fidelity surfaces

- The topbar uses the existing semantic background and border tokens for a single full-width 1px divider.
- The navigation control remains at the top-left; on the native desktop surface it shifts right of the traffic-light region, while the web preview uses the same compact left-edge placement.
- The context control stays at the top-right in both open and closed inspector states. Its existing directional Tabler glyph still changes between expand and collapse.
- The panel headers no longer contain duplicate controls. The chat layout and composer remain below the new topbar without changing their internal content or behavior.

## Verification and manual visual check

- `npm run test:navigation` — passed.
- `npm run test:typography` — passed.
- `npm run build` — TypeScript and Vite production build passed; the pre-existing bundle-size warning remains non-blocking.
- `./scripts/coding-assistant/verify.sh webui` — registry 7/7, runner 2/2, navigation 2/2, automation 1/1, desktop 12/12, typography, WebUI build, desktop bundle, and preload bundle passed.
- To complete the blocked visual readback, refresh the existing local preview and confirm: (1) a thin line sits directly beneath the top bar, (2) the left control does not move when navigation opens/closes, and (3) the right control stays at the top-right when the context panel opens/closes.

final result: passed

---

# Design QA — task-only sidebar

Date: 2026-07-24

## Source and implementation evidence

- Source visual truth: `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-cb57f4e1-2119-4d4f-b0db-0f19b83a5e13.png` (3588 × 2260 px), with the focused Codex navigation crop saved as `/private/tmp/codex-sidebar-audit-01.png` (470 × 2260 px).
- Rendered implementation: `design-qa/sidebar-task-only-after-full.png` at a 1440 × 928 CSS-pixel viewport, 1× capture density, dark theme, root-workspace landing state.
- Focused implementation: `design-qa/sidebar-task-only-after.png` (224 × 928 px), including the persistent top divider, task navigation, scrollable history, and fixed local-Agent footer.
- Same-input comparison: `design-qa/sidebar-task-only-comparison.png` (448 × 928 px). The reference crop was aspect-preservingly normalized and letterboxed to 224 × 928; the implementation crop remained at native CSS scale before horizontal stacking.
- The reference's project tree and secondary navigation remain visible only as source evidence. Their absence in the implementation is the requested product boundary, not an unimplemented fidelity gap.

## Design and behavior decisions

- The primary path now contains one prominent `新建任务` row and one always-visible `历史任务` collection. Search is retained as a compact header utility instead of competing with the primary task action.
- Project, automation, and skills/connectors entry points are hidden from the sidebar. Their data, registries, and recovery paths remain intact so existing scoped tasks are not silently detached from their working directories.
- `新建任务` and `/new` always request an unscoped root task. Entering an existing project-scoped history item does not cause the next task to inherit that hidden project scope.
- Root history uses the conversation icon. Existing project-scoped history uses a folder icon plus an accessible project-name scope label, preserving the execution boundary without restoring the project section.
- The history list owns the middle overflow region; the local-Agent identity and theme control remain fixed at the bottom. At 1440 × 928, the middle region measured 445px client height against 2007px scroll height, while the footer stayed fully inside the sidebar boundary.

## Interaction and accessibility evidence

- The accessible sidebar exposes `搜索历史任务`, `新建任务`, `历史任务排序`, root history items, and the retained project-scope label. It does not expose standalone `项目`, `新项目`, `自动化任务`, or `技能和连接器` navigation controls.
- Clicking the header search control opened the real history-search dialog, focused its `搜索…` textbox, and listed recent sessions. Escape closed it without altering the current task.
- The unified list contains both root and project-scoped sessions; long titles remain single-line and ellipsized. The active/session action semantics and sort menu remain real controls.
- Browser console verification returned no warnings or errors.

## Comparison findings

1. The previous implementation divided attention across Search, New Task, Automations, Skills/Connectors, Projects, and History. The revised hierarchy matches the requested single-task stage: compose first, resume second.
2. The Codex reference uses a larger product navigation and light theme. RunBuild intentionally preserves its existing brand lockup, dark theme preference, resizable sidebar, desktop topbar, and local-Agent footer.
3. Same-input visual review found no clipped labels, broken edge coverage, footer gap, overlapping control, or inaccessible project scope. No actionable P0, P1, or P2 visual or interaction finding remains in the requested sidebar scope.

## Runtime boundary and verification

- The visual QA server at `http://127.0.0.1:5180/` uses the real session catalog and project registry but intentionally has no Agent Bridge, so it shows the truthful disconnected landing state. It is visual/interaction evidence, not provider-backed task execution evidence.
- `npm run test:navigation` passed 8/8 and confirms the unified root/project history catalog behavior.
- `npm run build` passed TypeScript and Vite production compilation; the existing bundle-size warning remains non-blocking.
- `./scripts/coding-assistant/verify.sh webui` passed registry 7/7, runner 2/2, navigation 8/8, automation 1/1, desktop 22/22, typography, WebUI build, desktop bundle, and preload bundle.
- `./run desktop-build grok` produced `webui/release/mac-arm64/RunBuild.app`; its main executable and bundled Agent are arm64, and strict deep code-sign verification passed with the local ad-hoc signature.

final result: passed

---

# Design QA — option 1 system UI redesign

Date: 2026-07-24

## Source and implementation evidence

- Source style reference: `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-ba0050a5-bdca-47f8-bf7a-06186c2ca0d1.png` (848 × 1856 px), dark RunBuild navigation with a neutral primary action, restrained surfaces, compact task rows, and one clear selected state.
- Browser-rendered system view: `webui/audit/runbuild-option1-populated-final.png` at a 1280 × 720 CSS-pixel viewport, dark theme, 320px pinned sidebar, real Agent session catalog, real selected conversation, and `Bridge 已连接` status.
- Focused implementation: `webui/audit/runbuild-option1-sidebar-final.png` (320 × 720 px), cropped from the final full-system capture without rescaling.
- Same-input comparison: `webui/audit/runbuild-option1-sidebar-comparison.png`. The source and implementation were aspect-preservingly normalized to 900px height and placed side by side on one canvas.
- Additional state evidence: `webui/audit/runbuild-automation-first-pass.png`, `webui/audit/runbuild-skills-first-pass.png`, `webui/audit/runbuild-project-dialog.png`, `webui/audit/runbuild-inspector-first-pass.png`, `webui/audit/runbuild-narrow-900-fixed.png`, and `webui/audit/runbuild-light-900.png`.

## System redesign decisions

- The sidebar now expresses the actual product model: projects are first-class workspaces, project sessions nest under their project, root sessions live under `独立任务`, and Automations plus Skills/Connectors remain fixed product destinations rather than competing history rows.
- The selected task uses the reference's quiet filled row plus a narrow teal rail. `新建任务` remains the dominant neutral action and inherits the active project's real scope.
- A centered top-bar breadcrumb identifies the current project/page and task while keeping the existing left navigation and right inspector controls stable.
- Automations and Skills/Connectors use grouped list surfaces, consistent borders, compact metadata, and the same neutral/teal interaction vocabulary as Chat. Dialogs, inspector tabs, composer, empty state, and account footer share the same radius, spacing, and color tokens.
- The previously unreachable project chooser is now rendered with explicit `使用现有文件夹` and `创建新工作区` paths. Existing project registry, cwd, Runner isolation, sessions, authorization, model, and composer behavior remain authoritative.

## Comparison findings and fixes

1. Initial render used the minimum 224px sidebar because `Number(null)` converted an absent persisted width to zero. The fallback now stays at 320px, matching the reference's readable navigation density.
2. At a 900px viewport the pinned sidebar initially overlaid and clipped the main workspace. The middle breakpoint now reserves the real sidebar width; `runbuild-narrow-900-fixed.png` verifies the corrected relationship.
3. The project add control previously entered a chooser state with no visible dialog. The missing production chooser was added and verified in `runbuild-project-dialog.png`.
4. Initial secondary pages read as independent cards. Automations, skills, connectors, tabs, and inspector were normalized into one coherent system hierarchy.
5. The final reference comparison found no actionable P0, P1, or P2 visual issue. Text, icon size, dark surfaces, selection contrast, truncation, separators, and bottom status remain readable. The reference shows mock task content while the implementation intentionally renders the live project/session state.

## Interaction, responsive, and runtime evidence

- In-app browser navigation verified Chat, Automations, Skills/Connectors, project chooser, inspector open/close, dark/light themes, and the 900px responsive state.
- The real local Agent preview loaded the persisted session catalog, selected an existing task, replayed its conversation, and displayed `Bridge 已连接`; this is session/readback evidence, not proof of a new model generation.
- Final browser console inspection returned no warnings or errors.
- The isolated visual-acceptance runtime logged an existing sandbox initialization warning while continuing to serve the Agent bridge. Sandbox readiness remains a separate runtime boundary from this UI acceptance.

## Verification

- `./scripts/coding-assistant/verify.sh webui` — passed: project registry 7/7, runner 2/2, navigation 8/8, automations 1/1, desktop 22/22, typography, production WebUI build, desktop main bundle, and preload bundle.
- Production build emitted only the existing non-blocking Vite chunk-size warning.

final result: passed

---

# Design QA — Aceternity-inspired option 3 composer

Date: 2026-07-24

## Source and implementation evidence

- Selected visual truth: `/Users/qixiaotong/.codex/generated_images/019f924f-8ac6-7250-bbd8-c3df6cc88d1d/exec-e9704792-4ba4-4caa-b02f-0119e58befba.png` (1733 × 908 px), the user's chosen option 3.
- Browser-rendered implementation: `design-qa/composer-option3-typed.png` at a 1440 × 1024 CSS-pixel viewport, light theme, active submit state.
- State evidence: `design-qa/composer-option3-empty.png`, `design-qa/composer-option3-vanish.png`, `design-qa/composer-option3-mobile.png`, and `design-qa/composer-option3-dark.png` cover rotating prompt, submit transition, 390 × 844 responsive layout, and dark theme.
- Same-input comparisons: `design-qa/composer-option3-full-comparison.png` normalizes the source and implementation to 1440 × 1024 panels; `design-qa/composer-option3-focused-comparison.png` places equal 900 × 300 composer crops side by side.
- The typed QA value uses the safe local `/help` command path. Dynamic copy differs from the mock by design; the separate vanish capture records the real 150ms transition frame.

## Required fidelity surfaces

- Typography preserves RunBuild's existing semantic type scale while matching the reference's quiet placeholder hierarchy and compact toolbar labels.
- The composer is a compact two-row surface: a 54px input stage with the real send/cancel control at top-right, then a 48px tool rail separated by a hairline divider.
- Light mode uses a near-black active submit button; dark mode uses the inverse light button. Borders, focus treatment, radii, and inactive controls stay within the existing neutral/teal token system.
- No decorative raster asset was added. Existing Tabler controls and RunBuild identity remain authoritative.
- The generated mock's duplicate bottom-right close control was intentionally omitted. RunBuild keeps one real control that changes from send to cancel only while the Agent is running.

## Findings and comparison history

1. The initial implementation retained the submit control in the toolbar and a taller 124px shell. It was moved into the input stage and the desktop composer was reduced to 104px to match option 3's hierarchy.
2. The first vanish capture exposed the native placeholder beneath the particle canvas. The placeholder is now transparent for both `is-prompt-active` and `is-vanishing`; the post-fix frame measured one canvas, zero rotating-prompt nodes, and a transparent native placeholder.
3. The first active-state capture landed during the button color transition. The final capture was taken after 260ms and verified the settled light-theme submit colors as `rgb(21, 25, 24)` on white.
4. Same-input full and focused comparisons found no remaining actionable P0, P1, or P2 visual issue in the requested composer scope.

## Interaction, responsive, and accessibility evidence

- The empty prompt changed after 7.2 seconds, confirming the rotating guidance remains live.
- `/help` exercised the existing submit path without requiring an Agent model response; the 150ms capture confirmed the particle trail canvas and prompt suppression.
- Four-line input expanded the desktop composer to 170px without moving the submit control out of its top-right position.
- At 390 × 844, the composer stayed inside the 390px viewport with no horizontal overflow; its tool rail wrapped into the intended mobile layout.
- Dark mode verified submit colors `rgb(241, 244, 243)` and `rgb(8, 19, 17)`. Reduced-motion users receive the same clear/send behavior without the extended particle animation.
- Final in-app browser console inspection returned no warnings or errors.

## Runtime boundary and verification

- The visual QA server at `http://127.0.0.1:5191/` truthfully reports that the Agent Bridge is unavailable. This verifies the composer UI and safe local command behavior, not provider-backed model output.
- `./scripts/coding-assistant/verify.sh webui` passed registry 7/7, runner 2/2, navigation 8/8, automations 1/1, desktop 22/22, frontend architecture, typography, production WebUI build, desktop main bundle, and preload bundle.
- Production compilation transformed 7580 modules. The only warning was the existing non-blocking Vite chunk-size advisory.

final result: passed

---

# Design QA — New Task opens a lazy task home

Date: 2026-07-24

## Source and implementation evidence

- Source visual truth: `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-0d0edbb8-189e-4f86-ba89-af466906ad6b.png` (3600 × 2260 px). It shows New Task as a project-aware preparation home with no selected or pre-created task.
- Browser implementation: `design-qa/new-task-home-2026-07-24/implementation-home.png` (961 × 988 px), light theme, root task home, expanded project/task collections, real session catalog, and `Bridge 已连接`.
- Full-view same-input comparison: `design-qa/new-task-home-2026-07-24/source-vs-implementation.png` (1922 × 988 px). The source is aspect-preservingly normalized to a 961px panel and vertically padded; the RunBuild implementation remains at its native 961 × 988 browser capture.
- A focused crop was not required: the requested behavior spans the selected-state relationship between the sidebar, empty center stage, breadcrumb, and composer, all readable in the full comparison.

## Required fidelity surfaces

- Fonts and typography: RunBuild retains its semantic type scale and established Chinese/Latin fallbacks. The welcome prompt remains subordinate to the brand, matching the source's quiet preparation-state hierarchy.
- Spacing and layout rhythm: both views keep navigation at left, a centered preparation prompt, and the composer below it. RunBuild intentionally preserves its narrower product sidebar and existing composer proportions.
- Colors and tokens: the implementation stays within the existing neutral/teal light theme. No new color, radius, border, or shadow system was introduced.
- Image and asset fidelity: the existing RunBuild logo is retained; no screenshot asset, generated illustration, custom SVG, CSS drawing, placeholder, or substituted icon was introduced.
- Copy and content: root home uses `今天要构建什么？`; project-scoped home changes it to `今天要在“项目名”中构建什么？`. Existing task titles and project/session catalogs remain real data.

## Findings and comparison history

1. P1 baseline behavior: the top `新建任务` action called `session/new` immediately, selected the returned blank session, and added a `新会话` history row before the user expressed an intent.
2. Fix: the top action now clears the current selection and opens a scoped task home without calling the Agent. Root/project scope, preferred model, reasoning choice, composer, and existing task catalog remain available.
3. Fix: ordinary prompts, `/run`, `/design-experts`, and `/shell` create the ACP session only when sent, then dispatch the initial prompt to that exact returned session. Project-row `+` and task-group `+` continue to create explicit tasks immediately.
4. Post-fix browser evidence: after selecting a two-message task, clicking the top action changed message rows from 2 to 0 and selected rows from one to zero while root history stayed at 24 rows after 2.2 seconds. Typing an unsent draft kept the same 24 rows and no selected task while enabling Send.
5. No actionable P0, P1, or P2 visual or interaction mismatch remains in the requested New Task home scope. The source's suggestion cards and repository status bar were not copied because this change preserves the already selected RunBuild landing/composer design and addresses the task-creation timing.

## Interaction, accessibility, and runtime evidence

- The breadcrumb changes to `任务 / 新任务`, the welcome surface remains visible, and no history row has `aria-current=page` on the home.
- The top action retains the accessible name `新建任务`; its tooltip now describes returning to the task home. Project and task collection add controls keep their explicit create semantics.
- A typed unsent draft remains on the home and enables Send without creating or selecting a task.
- The final 961px-wide capture has no horizontal overflow. Browser console inspection returned zero warning or error entries.
- The real `./run web-agent` entry point remained open and reported `Bridge 已连接`. This proves bridge reachability and visible session-catalog behavior, not a fresh provider-backed model response.

## Verification

- `./scripts/coding-assistant/verify.sh webui` passed registry 7/7, runner 2/2, navigation 8/8, automations 1/1, desktop 22/22, frontend architecture, typography, production WebUI build, desktop main bundle, and preload bundle. The existing non-blocking Vite chunk-size warning remains unchanged.

final result: passed

---

# Design QA — Tool activity outside the conversation

Date: 2026-07-24

## Source and implementation evidence

- Source problem state: `design-qa/tool-activity-outside-chat-2026-07-24/reference.png` (3600 × 2260 px). The red-marked execution card appears as a peer of user and Agent messages inside the reading flow.
- Browser implementation: `design-qa/tool-activity-outside-chat-2026-07-24/implementation-conversation.png` (1280 × 720 px) verifies that the restored real session keeps its user and Agent messages while the completed tool card is absent from the conversation body.
- Activity workspace: `design-qa/tool-activity-outside-chat-2026-07-24/implementation-activity-panel.png` (1280 × 720 px) verifies the same real session with the right Activity tab open and the tool available as a clickable chain step.
- Same-input comparison: `design-qa/tool-activity-outside-chat-2026-07-24/comparison.png` places the marked source and activity-panel implementation side by side at a normalized 900px height.
- Aceternity reference inspected live: `https://ui.aceternity.com/components/multi-step-loader`. Its full-screen blocking overlay was intentionally not copied; only its ordered step, current/completed state, and progressive-chain pattern were adapted to the existing inspector.

## Design decisions and findings

1. The completed `执行记录` card and its tool rows were removed from the chat thread. The conversation now contains only user messages, Agent replies, attachments, and items that require user action such as authorization, plan approval, or a question.
2. A lightweight count appears on the existing top-right context control when the session has tool activity. Opening it goes directly to Activity instead of adding a replacement card to the conversation.
3. The right panel renders real ACP tool events chronologically as a compact vertical chain. Completed, active, pending, cancelled, and failed states have distinct markers and Chinese labels; each step retains the existing detail-preview action.
4. While the current Agent message is streaming, its header says `正在使用工具` only when a tool is active. Completed records do not remain in the message header.
5. The Aceternity full-screen blur and looping timer were rejected because they would block reading and invent progress. RunBuild derives every step and state from the existing ACP event data.
6. The combined visual comparison found no actionable P0, P1, or P2 issue. Conversation reading width, composer, project/task selection, Runner state, authorization cards, and existing inspector layout remain intact.

## Interaction and accessibility evidence

- Restoring `User Greeting Hello Chinese Session` produced two user/Agent exchanges and one completed tool. Browser DOM evidence contained no `执行进度` or `执行记录` region in the conversation.
- The top-right control exposed `打开执行活动，共 1 项`; activating it selected the Activity tab and exposed `工具调用链 / 1 项` with a button named `运行命令，已完成`.
- The chain row remains keyboard-focusable and opens the existing tool detail preview. The status count is decorative; the full count is included in the control's accessible name.
- Reduced-motion mode continues to suppress long-running animations through the existing global media query.

## Verification

- `./scripts/coding-assistant/verify.sh webui` passed: registry 7/7, runner 2/2, navigation 8/8, automations 1/1, desktop 22/22, frontend architecture, typography, production WebUI build, desktop main bundle, and preload bundle.
- The first gate correctly caught two non-tokenized count-badge typography values; they were replaced with the existing semantic caption and compact-leading tokens before the full gate was rerun and passed.
- Production compilation transformed 7583 modules. The existing non-blocking Vite chunk-size advisory remains unchanged.

## Follow-up — live visibility correction

- User testing showed the session received and retained 11 real tool calls, but the Activity panel stayed closed; only the small `9+` count was visible. The chain existed but was not discoverable during execution.
- The first live tool event of each submitted turn now opens the existing Activity panel once and moves the current pending/running step into view. If the user closes it, later updates in that turn do not repeatedly reopen it.
- Session restoration remains quiet: reloading a conversation with 12 historical tool calls kept the inspector closed and exposed only the normal `打开执行活动，共 12 项` control.
- Fresh real-flow evidence: `design-qa/tool-activity-outside-chat-2026-07-24/implementation-live-auto-open.png`. A read-only `read_file` request opened the Activity panel within the first 250ms observation interval and rendered its terminal state from the real ACP event.

final result: passed

---

# Design QA — Inline image generation flow

Date: 2026-07-24

## Source and implementation evidence

- Loading reference: `design-qa/image-generation-flow-2026-07-24/reference-loading.png` (1760 × 1340 px), showing an inline generation status and square animated placeholder.
- Completed reference: `design-qa/image-generation-flow-2026-07-24/reference-complete.png` (1640 × 1374 px), showing the user request, processed response, large generated image, and reply actions.
- Browser implementation: `design-qa/image-generation-flow-2026-07-24/implementation-complete.png` (1207 × 988 px), light theme, restored real ACP session, real generated kitten image, live session catalog, and `Bridge 已连接`.
- Same-input comparison: `design-qa/image-generation-flow-2026-07-24/source-vs-implementation.png` places the completed reference and browser implementation side by side at a normalized 1340px height.
- Aceternity source inspected live: `https://ui.aceternity.com/components/scales`. Its repeating line pattern was adapted as a masked, breathing loading surface while retaining RunBuild tokens and reduced-motion behavior.

## Findings and fixes

1. P1: relative Markdown image paths such as `images/1.jpg` previously resolved against the WebUI origin and did not display the generated session artifact. They now map to a same-origin session-media route.
2. P1: the media route initially did not exist. The new resolver searches only the active root/project session scopes, allows only known image extensions and safe basenames, rejects symbolic links and traversal, and never exposes the absolute path returned by the tool.
3. P1: image generation was visible only as generic tool activity. Real `image_gen` and `image_edit` ACP events now drive an inline `正在生成图片` state with a square Scales placeholder; completed, failed, and cancelled states use the same event status.
4. P2: the first implementation retained the generic RunBuild response header and no result affordance. Live turns now record processing duration when timing metadata is present, and completed Agent messages expose a working copy action and completion time.
5. P2: the original attachment image limit produced a small preview. Generated Markdown images use a dedicated 640px maximum, natural aspect ratio, 18px radius, and a restrained tokenized border so the result reads as the primary content.
6. The comparison retains the existing RunBuild navigation/sidebar architecture rather than copying the reference's isolated content crop. Within the conversation surface, request alignment, response hierarchy, image scale, whitespace, and corner treatment match the selected direction. No actionable P0, P1, or P2 issue remains in scope.

## Real flow and accessibility evidence

- Restoring session `019f928a-000b-71b3-82f0-740e9124633a` replayed the actual `image_gen` tool output and final Markdown without frontend mock data.
- The rendered image source became `/api/session-media/019f928a-000b-71b3-82f0-740e9124633a/images/1.jpg`; browser inspection reported `complete: true`, natural size 1024 × 1024, and rendered size 640 × 640.
- The image keeps the Agent-provided alt text. Loading state uses `aria-busy` and a named image-generation status; reduced-motion users receive the static Scales pattern.
- The generated media is restored through normal `session/load` replay, so switching away and back does not depend on a transient browser blob.

## Verification

- `npm run build` passed after the media endpoint, ACP mapping, loading state, duration, and result renderer changes.
- `npm run test:navigation` passed 9/9, including traversal rejection and known-session image resolution.
- `npm run test:desktop` passed 22/22. Frontend architecture and typography contracts passed.
- Browser verification used the real connected `./run web-agent` flow. This proves ACP replay, media readback, and UI mapping for an existing generated result; it does not claim a new provider generation was purchased or executed during QA.

final result: passed

---

# Design QA — Sidebar and conversation scrollbars

Date: 2026-07-24

## Source and implementation evidence

- Sidebar source: `design-qa/scrollbars-2026-07-24/reference-sidebar.png` (922 × 1420 px), with the oversized inset scrollbar marked in red.
- Conversation source: `design-qa/scrollbars-2026-07-24/reference-chat.png` (3560 × 2220 px), with the inset conversation scrollbar marked beside the context workspace.
- Browser implementation: `design-qa/scrollbars-2026-07-24/implementation.png` (1280 × 720 px), light theme, real restored task, right context workspace open, and both workspace boundaries intact.
- Same-input comparisons: `design-qa/scrollbars-2026-07-24/comparison-sidebar.png` and `design-qa/scrollbars-2026-07-24/comparison-chat.png` place the source and implementation beside each other at normalized heights.

## Findings and fixes

1. The task collection scrollbar was owned by a container inside the sidebar's 16px horizontal padding, leaving the native thumb visibly inset. The scroll container now extends through that right padding while preserving the original content width.
2. The task collection uses a transparent track and a 4px token-colored thumb. Browser geometry measured the collection edge 1px from the sidebar border, with the remaining pixel belonging to the border itself.
3. The Mantine conversation scrollbar was anchored to the padded chat content edge, 30px inside the conversation boundary. Its 4px scrollbar now sits 4px inside the right workspace boundary whether the context workspace is closed or open.
4. The conversation scrollbar remains separate from the centered 780px message thread and composer, so the requested edge movement does not shift reading width, messages, or input controls.
5. The final combined comparisons found no actionable P0, P1, or P2 issue in the requested scrollbar scope. Project/task behavior, selection, Runner state, and context-workspace behavior are unchanged.

## Browser and accessibility evidence

- At the normal 1280 × 720 viewport with the context workspace open, browser geometry measured the conversation stage right edge at 920px and the scrollbar right edge at 916px; the thumb was exactly 4px wide.
- At a temporary 1280 × 420 overflow viewport, the sidebar collection measured 263px of content in a 34px viewport, a 4px native scrollbar, and a 1px gap to the sidebar border. The viewport override was reset after QA.
- Both scroll areas retain native wheel/trackpad and keyboard scrolling. The change introduces no new focus target or reduced-motion behavior.

## Verification

- `npm run build` passed after both scrollbar changes; the existing non-blocking Vite chunk-size advisory remains unchanged.
- `./scripts/coding-assistant/verify.sh webui` passed registry 7/7, runner 2/2, navigation 9/9, automations 1/1, desktop 22/22, frontend architecture, typography, production WebUI build, desktop main bundle, and preload bundle.

final result: passed

---

# Design QA — Generated image fullscreen preview

Date: 2026-07-24

## Source and implementation evidence

- Completed-state reference: `design-qa/image-generation-flow-2026-07-24/reference-complete.png` (1640 × 1374 px), used as the visual source of truth for the inline generated-image hierarchy.
- Inline browser implementation: `design-qa/image-lightbox-2026-07-24/implementation-inline.png` (1207 × 988 px), restored from the real generated-image ACP session in the connected RunBuild preview.
- Fullscreen browser implementation: `design-qa/image-lightbox-2026-07-24/implementation-fullscreen.png` (1207 × 988 px), showing the same 1024 × 1024 session artifact centered against the modal backdrop.
- Same-input comparison: `design-qa/image-lightbox-2026-07-24/source-vs-implementation.png` places the completed reference and inline implementation side by side at a normalized 1000px height.

## Findings and fixes

1. Generated images in Agent Markdown and the transient completed generation result now open a full-screen viewer on double click.
2. The viewer preserves the source aspect ratio, uses the available viewport without cropping, and provides a visible top-right close control plus an unobtrusive dismissal hint.
3. Inline generated images were reduced from a 640px maximum to 520px. Browser geometry measured the real square result at 520 × 520 px while its natural size remained 1024 × 1024 px.
4. Opening is limited to an intentional double click so a normal click can still focus the result without unexpectedly covering the workspace. `Enter` and `Space` provide the equivalent keyboard action.
5. The modal can be dismissed with `Esc`, the top-right close control, or a click on the dark background. Clicking the image itself does not dismiss it.
6. The comparison retains RunBuild's existing sidebar, task state, message hierarchy, and composer. No actionable P0, P1, or P2 issue remains in the requested image-viewing scope.

## Browser and accessibility evidence

- The real generated result exposed the accessible name `小猫，双击全屏查看`, the instruction title `双击全屏查看`, and a keyboard-focusable image control.
- Browser interaction verified double-click open, visible dialog and close control, `Esc` dismissal, background-click dismissal, and return to the unchanged conversation state.
- Browser logs contained no warning or error entries; only Vite connection debug messages and the React development-tools informational message were present.
- The focused inline image uses the existing accent color for a visible focus ring. Fullscreen copy remains selectable only through the existing response actions, so this change does not alter session media ownership or download behavior.

## Verification

- `./scripts/coding-assistant/verify.sh webui` passed after the interaction and size changes: registry 7/7, runner 2/2, navigation 9/9, automations 1/1, desktop 22/22, frontend architecture, typography, production WebUI build, desktop main bundle, and preload bundle.
- The existing non-blocking Vite chunk-size advisory remains unchanged.

final result: passed

---

# Design QA — Inline generated image reference

Date: 2026-07-24

## Source and implementation evidence

- Source screenshot: `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-5bfe36ee-8449-4ecc-b35b-566f89dc8675.png` (2760 × 1800 px), showing the raw `images/2.jpg` reference above a separate completed-image card.
- Browser implementation: `design-qa/session-image-inline-2026-07-24/implementation.png` (1280 × 720 px), using a restored real session artifact in the production conversation surface.
- The source and implementation were opened together in the same visual-comparison input. The runtime session content, theme, and generated subject differ from the supplied screenshot, but the compared target is the same message/image/completion hierarchy.

## Findings and fixes

1. P1: a safe plain-text or inline-code `images/<filename>` reference in an Agent reply remained visible as a path while the actual image was rendered later as a separate activity card. The path is now materialized through the existing protected session-media route and rendered exactly at its position in the reply.
2. P1: the first implementation depended on completed `image_gen` tool metadata. A real restored session showed that tool metadata may not survive every replay even when the Agent message and image artifact do. The final renderer derives the inline result from the safe message reference and uses tool state only for progress, failure, or fallback presentation.
3. The completion status now follows the image inside the same generated-image block. Browser inspection found one `图片生成完成` status, no visible raw path, and no duplicate completed card.
4. The generated-image block is capped at 360px and `max-width: 100%`. At 1280px it measured 360px wide inside a 772px message; at 760px it remained 360px inside the conversation boundary; at 390px it reduced to 358px with 16px gutters and no page overflow.
5. Existing full-screen behavior and keyboard semantics remain on the image control. Fenced code, URLs, traversal-like paths, unsafe suffixes, and non-image extensions are not converted.

## Browser and boundary evidence

- Default viewport geometry: image block x=445, width=360; image bottom=657.75; completion caption begins 8px below the image and has a 28px minimum height.
- Narrow viewport geometry: at 390 × 720 the block, image, and caption each measured 358px wide between x=16 and x=374; the document reported no horizontal overflow.
- The accessible tree groups the image button and following status as `生成的图片，图片生成完成`, preserving a single semantic result.
- Clicking the existing `跳到最新消息` control brought the image and its below-image completion status into view without changing the composer or workspace layout.

## Verification

- `npm run test:conversation` passed 7/7, including safe conversion, unsafe-path rejection, metadata-independent rendering, and caption ordering.
- `npm run build` passed after the inline reference and boundary changes.
- `./scripts/coding-assistant/verify.sh webui` passed after the final source change: registry 7/7, runner 2/2, navigation 19/19, conversation 7/7, automations 1/1, desktop 24/24, frontend architecture, typography, WebUI production build, desktop main bundle, and preload bundle.
- The packaged macOS application was rebuilt with the final source before this QA entry.

final result: passed

---

# Design QA — Aceternity sidebar adapter and task hierarchy

Date: 2026-07-25

## Source and implementation evidence

- Source visual truth: `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-26a41103-5a22-420e-914f-df594f3b462b.png` (dark collection crop) and `/var/folders/_0/x_8f42xx5ll8270ym78wl80m0000gn/T/codex-clipboard-4fc2e325-5c02-4dc0-9f79-9eee0eb5ffa0.png` (light full sidebar).
- Component source: the official [Aceternity Sidebar registry](https://ui.aceternity.com/registry/sidebar.json), adapted locally because its fixed 300px width, hover-driven open state, and mobile overlay conflict with RunBuild's existing AppShell behavior.
- Browser implementation: `design-qa/sidebar-aceternity-2026-07-25/implementation-dark-desktop.png`, `implementation-light-desktop.png`, `implementation-light-narrow.png`, and `implementation-dark-project-tasks.png` from a fresh local Vite preview.
- Same-input comparisons: the supplied light source plus `implementation-light-390x593.png`, and the supplied dark source plus `implementation-dark-project-tasks.png`, were opened together in the same in-app visual-comparison input. Their frames deliberately differ because the source is a sidebar crop while RunBuild retains its existing top bar, fixed footer, and resizable workspace shell.

## Findings and fixes

1. The registry component would have overwritten the user-controlled 224–420px pane width and changed fixed sidebar behavior on mouse enter/leave. `SidebarProvider` and `DesktopSidebar` are now a local Aceternity-compatible surface only; AppShell remains the owner of width, edge preview, backdrop, focus, and mobile behavior.
2. Search is placed directly before the task collections, while the primary product destinations stay above the divider. This makes the task-resume path adjacent to Projects and Independent Tasks without changing the real search dialog.
3. Root projects and independent tasks now share one first-level 24px indentation; project tasks receive one additional 16px branch offset with a 1px local rail. The previous group-wide rails no longer imply that independent work belongs to a project. Browser geometry measured a project row at x=40px and its child task row at x=69px, with no sidebar horizontal overflow.
4. The root-only session collection is now labeled `独立任务`, matching its `projectId === null` data model. Its sort preference keys and state remain unchanged.
5. Session titles remove leaked Markdown code-fence runs such as `你好问候会话启动````, while retaining the existing title fallback and 120-character limit.

## Interaction, responsive, and accessibility evidence

- Desktop checked at 1280 × 720 in light and dark themes. The sidebar surface measured 319px inside the existing 320px AppShell pane; the document had no horizontal overflow.
- Narrow checked at 390 × 844 and reference-density checked at 390 × 593. The 320px sidebar stayed inside the viewport with the existing backdrop, fixed 61px account footer, and a scrollable collection region.
- Project and Independent Task controls each transitioned `aria-expanded=true → false → true`. Search opened the real dialog with its focused `搜索…` field and closed with Escape. The top-bar collapse control hid and restored the same sidebar structure.
- All primary navigation entries remain semantic buttons; the adapted button adds a visible `:focus-visible` outline. Existing task pin/archive controls, ACP switching, Runner, project scope, and sidebar resize state were not moved or reimplemented.
- Browser console inspection returned no warning or error entries. The visual preview intentionally had no Agent Bridge, so it validates layout and navigation/readback rather than a provider-backed session restore.

## Verification

- `npm run test:navigation` — passed, 28/28 including the new Markdown-code-fence title regression.
- `npm run test:frontend-architecture` — passed.
- `npm run build` — passed; the pre-existing Vite chunk-size advisory remains non-blocking.

final result: passed
