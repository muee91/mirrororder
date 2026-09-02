# MirrorOrder Design System v2

> 当前实现位于 `desktop/src/design-system-v2.css` 与 `web/design-system-v2.css`。
>
> Product authority remains `docs/ux-principles.md` and `docs/app-information-architecture.md`. This document translates those principles into reusable UI rules and migration constraints.

## 1. Goal

MirrorOrder is a professional post-production application, not an AI dashboard. V2 therefore standardizes **interaction grammar and semantic tokens** while preserving different workspace identities.

The design system must make Desktop Production and Team Web feel related without forcing them to share one page template.

## 2. Shared grammar

Use the following primitives as the default vocabulary:

- `Pane / Divider / Split View` for spatial organization;
- `Table / List` for dense production data;
- `Inspector` for the current selection;
- `Drawer` for contextual tools such as Xiaojing;
- `Popover` for temporary choice;
- `Modal` for creation, permissions and destructive actions;
- `Toast` for transient action feedback;
- `Status Center` for durable background work.

Cards are reserved for objects that are actually card-like, especially visual media objects. Pills are reserved for short semantic states.

## 3. Tokens

Desktop tokens live in `desktop/src/design-system-v2.css` and use the `--mo-*` namespace.

Required semantic groups:

- surfaces: app, sidebar, pane, raised, control, hover, selected;
- borders: subtle, default, strong;
- text: primary, secondary, muted, disabled;
- semantics: accent, success, warning, danger;
- geometry: control/pane/overlay radius and control height;
- typography: system sans, monospace, compact size scale;
- focus: one keyboard-visible focus ring.

Feature CSS should gradually consume semantic tokens instead of introducing new hexadecimal palettes for equivalent meanings.

## 4. Typography

Production density must come from row height, pane allocation, disclosure and column width—not unreadably small copy.

V2 floor:

- utility / tertiary copy: about 10 px;
- dense table / toolbar: 11 px;
- normal production copy: 12 px;
- primary labels / headings: 13–17 px depending on hierarchy.

Timecode, media IDs and paths use tabular/monospaced numerals where appropriate.

## 5. Focus and keyboard

Removing browser focus without replacement is prohibited.

All interactive controls must expose a consistent `:focus-visible` state. Workspace-specific keyboard behavior can differ, but visual focus cannot disappear.

## 6. Desktop Production

The four stable production areas remain:

- 素材
- 剧本
- 剪辑
- 审阅

V2 does not turn these areas into one generic dashboard template. Each area keeps its own canvas grammar.

### Slate

Slate is a production ledger:

- table first;
- selected row uses a restrained selection rail/background;
- Inspector is contextual and never becomes secondary navigation;
- status color has semantic meaning only;
- small corner radius and dividers take precedence over nested cards.

### Media

Media can use visual cards in Grid mode because thumbnails are the primary recognition object. List mode should remain metadata-dense.

### Script / Take / Review

These workspaces favor split panes with a stable selection thread across script, candidate Take, viewer and Inspector.

## 7. Team Web Review

Review deliberately uses slightly larger controls than Desktop Production.

Responsive contract:

- `> 1260 px`: Script / Takes / Inspector in three panes;
- `901–1260 px`: Script + Takes above, Inspector as a full-width lower pane;
- `<= 900 px`: single-column review flow with Inspector/Player first, then candidate Takes, then Script;
- `<= 680 px`: Take rows stack vertically and toolbars can scroll instead of requiring a fixed desktop canvas.

Team Web must not require a 1500 px minimum viewport.

## 8. Feedback hierarchy

1. Toast — transient confirmation or short error.
2. Inline status — current operation or local attention state.
3. Status Center — durable task history, progress, failure, cancellation and retry.

Do not use navigation changes as toast messages.

## 9. Migration rule

`design-system-v2.css` is intentionally loaded after the current legacy/fidelity layers so migration can proceed incrementally. New feature work should prefer V2 tokens and primitives; older page-specific CSS can be reduced in later passes after visual verification.

The target end state is fewer duplicated palettes and fewer page-specific control definitions—not a single visual template for every workspace.
