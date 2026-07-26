# RunBuild frontend modularization

## Decision

RunBuild keeps React, TypeScript, Vite, Electron, and the existing ACP/runtime
contracts. The UI layer migrates from Mantine to locally owned shadcn and
Aceternity source components. Aceternity provides enhanced visual components;
shadcn/Radix-style primitives provide buttons, dialogs, menus, inputs, and
accessibility behavior that Aceternity does not replace.

The migration is incremental. Mantine remains only as a compatibility layer
until the last feature module has moved; new feature UI must not add Mantine
dependencies.

## Target source tree

```text
src/
  app/                    providers, runtime gates, page composition
  components/
    ui/                   local shadcn and Aceternity source components
    layout/               workbench shell and resizable regions
  features/
    conversation/         messages, task switching, composer, approvals
    navigation/           history and project navigation
    projects/             project creation and editing
    automations/          automation list and editor
    inspector/            tool, file, and context inspection
    desktop-setup/        initialization and permission surfaces
  lib/                    pure utilities and protocol adapters
  styles/                 tokens and framework integration
```

## Dependency rules

1. `app` composes feature modules; it does not own feature rendering details.
2. A feature may import `components/ui`, `components/layout`, and `lib`.
3. `components/ui` contains presentation and accessibility behavior only. It
   must not import ACP sessions, project registries, Electron APIs, or features.
4. Features communicate through typed props and callbacks, not direct imports
   from another feature's internal files.
   Application composition imports each feature through its public `index.ts`.
5. Runtime and ACP state remain authoritative in the current controller until
   a later state extraction has dedicated regression coverage.
6. Aceternity registry files are committed source. Review every generated diff;
   do not overwrite a locally adapted component through the CLI.

## Design-system boundary

- Existing `--ide-*` and semantic typography variables remain the source of
  truth during migration.
- `src/styles/aceternity.css` maps those variables into Tailwind theme tokens.
- Feature code consumes semantic classes such as `bg-card`, `text-foreground`,
  and `text-muted-foreground`; it must not introduce arbitrary product colors.
- Motion must respect `prefers-reduced-motion` and must never conceal task,
  approval, error, or connection state.

## Migration slices

1. Foundation: Tailwind v4 Vite plugin, shadcn registry config, theme bridge,
   `cn`, and one real Aceternity loader in task switching.
2. Overlays: tooltips, menus, popovers, and dialogs.
3. Navigation: history rows, project tree, footer, and resizable sidebar shell.
4. Conversation: message list, activity, approvals, and task transition states.
5. Composer: textarea, attachments, permission mode, model menu, and send flow.
6. Cleanup: remove `MantineProvider`, Mantine CSS, and Mantine dependencies only
   after browser and desktop acceptance passes for every prior slice.

## Verification for every slice

- Run the closest feature test, then `npm run build`.
- Run `./scripts/coding-assistant/verify.sh webui` before handoff.
- Check the same task and interaction state in the browser.
- Recheck Electron for native setup, menus, file picking, or lifecycle changes.
- Record remaining Mantine imports so migration progress is measurable.
