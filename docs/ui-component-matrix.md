# MirrorOrder Professional UI Component Matrix

> 本文补充 `design-system-v2.md`。设计系统规定共同语法；本文规定具体制作对象必须使用哪一种独立组件 anatomy，以及哪些状态不能互相复用。

## 1. Principle

MirrorOrder 不提供一个万能 `Card` 或万能 `Badge`。

允许共享：

- surface / border / radius / typography tokens
- focus ring
- selection rail
- divider
- tooltip / popover / dialog shell
- keyboard behavior

必须独立设计：

- 不同制作对象的内容 anatomy
- 不同 authority 的状态
- Camera categorical identity
- Review / Editorial / Slate 的人类判断
- durable task 与 media health

## 2. Object component matrix

| Object | Component family | Default form | Mandatory fixed regions | Must not become |
| --- | --- | --- | --- | --- |
| Media / Angle | `MediaCard` | thumbnail card / media row | Camera badge, thumbnail, name, shot, duration, health/preferred slot, selection slot | Take Card / generic status card |
| Take group | `TakeCard` | grouped production card/row | Take identity, mapping source, mapping state, duration/action, transcript, A/B/C/AUX slots, issue slot | enlarged MediaCard |
| Camera member | `CameraSlot` | fixed semantic slot | slot label, categorical tone, media/empty body, duplicate count | free-flowing chip |
| Slate record | `SlateRow` | table row | Index, Episode, Scene, Shot, Take, A, B, C, AUX, Slate Status | Card |
| Script segment | `ScriptBlock` | dense script row/block | segment identity, text, placement evidence/action slot | rounded dashboard card |
| AI / search evidence | `EvidenceItem` | neutral evidence row | source, evidence, confidence/score metadata | human decision card |
| Identity candidate | `IdentityCandidateRow` | portrait/evidence row | portrait, name/unknown label, evidence count, confidence, confirmation action | MediaCard |
| Confirmed person | `PersonRow` | library row | portrait, canonical name, aliases/evidence summary, human authority state | candidate row with only color change |
| Project | `ProjectRow` | navigation/management row | name, lightweight activity, attention count, context menu | KPI card |
| Background task | `TaskRow` | operations list row | task, project, status, progress, updated time, retry/cancel | toast card |
| Review Take | `ReviewTakeRow` | review queue row | confidence/evidence region, Take identity, member strip, opinion controls, placement state | Desktop TakeCard clone |
| Review member | `ReviewMemberTile` | compact angle tile | camera, filename/thumbnail, availability, selected state | generic member badge |
| Assistant result | `AssistantEvidenceItem` | low-authority evidence row | source/context, answer/evidence, jump action | AI glow card |
| Timeline clip | `TimelineClip` | timeline object | track position, duration geometry, clip identity, selection, trim handles | list card |
| Marker | `TimelineMarker` | temporal marker | time position, marker type, label | badge detached from time |
| Delivery item | `DeliveryRow` | deliverable list row | target, state, validation, output path/action | project/task card |

## 3. Status family matrix

| Meaning | Component | Authority | Shape/grammar | Color channel | Never reuse as |
| --- | --- | --- | --- | --- | --- |
| Host/Team connection | `ConnectionIndicator` | system fact | 6px dot + label | ready/active/error/neutral | Task status |
| Background job | `TaskStatusIndicator` | durable task fact | fixed icon + label + progress rail | running/success/warn/fail | Connection dot |
| Project activity | `ProjectActivityIndicator` | aggregate system fact | subtle activity marker + count/text | active/error/neutral | project completion KPI |
| Slate shooting status | `SlateStatusIndicator` | human shooting fact | rectangular compact control + dot + label | usable/partial/NG/unknown | Review decision |
| Individual review opinion | `ReviewOpinionControl` | reviewer | segmented human judgement | Best/Keep/Reject + explicit label | Slate status |
| Editorial decision | `EditorialDecisionIndicator` | final editorial authority | stronger authority rail/label | Best/Keep/Reject | individual opinion |
| Media availability | `MediaHealthIndicator` | technical fact | icon + label | ready/offline/pending/warn | Slate NG |
| Index state | `IndexStateIndicator` | technical pipeline fact | small technical label/icon | ready/pending/error | media availability if semantics differ |
| Placement state | `PlacementIndicator` | mapping authority | source rail + scope label | human/automatic/candidate/unplaced | Review judgement |
| AI confidence | `EvidenceConfidence` | evidence only | number/level + source | neutral/accent-low-authority | final status |
| Destructive danger | `DangerAction` | action affordance | button/menu item | danger | persistent object status |

## 4. Camera matrix

| Slot | Tone | Stable position | Empty state | Duplicate behavior |
| --- | --- | ---: | --- | --- |
| A机 | `a` | 1 | A slot remains visible | primary + `+N` |
| B机 | `b` | 2 | B slot remains visible | primary + `+N` |
| C机 | `c` | 3 | C slot remains visible | primary + `+N` |
| AUX | `aux` | 4 | AUX slot remains visible | primary + `+N` |
| Custom | `custom` | after AUX | only when present | one semantic slot per custom source or grouped explicitly |
| Unknown | `unknown` | after Custom | only when present | never silently promoted to A/B/C/AUX |

### No-shift contract

If a Take contains A and C but no B:

```text
A        B(empty)        C        AUX(empty)
```

Never:

```text
A        C        AUX
```

The same rule applies to Slate, Take member strip, multicam compare views and any future Timeline multicam inspector.

## 5. Card anatomy rules

### 5.1 Reserved state slots

Selection, preferred, duplicate count, availability and human authority markers must use reserved slots.

A state appearing/disappearing may change color/visibility but must not change the grid template.

### 5.2 Optional metadata

Optional data can become empty, hidden or ellipsized. It cannot cause sibling semantic regions to move.

### 5.3 Long labels

- filename / path: ellipsis or 2-line clamp
- project name: ellipsis
- transcript: fixed line clamp in list/card; full text in Inspector
- camera: never wrap; custom camera label ellipsizes after a bounded width
- status: never wrap
- timecode/count: fixed/tabular

### 5.4 Selection

Selection never changes border width.

Use:

- same 1px border geometry
- accent border/rail/background/outline
- reserved check slot if needed

### 5.5 Empty and unavailable

An empty slot must keep the same footprint as a filled slot when semantic alignment matters.

An unavailable media item must retain its media identity; do not collapse it or replace the entire object with an unrelated error card.

## 6. Workspace mapping

### Slate

Primary: `SlateRow`, `CameraSlot`, `MediaCard`, `SlateStatusIndicator`.

Secondary: Inspector, Take Picker, auxiliary Review placement disclosure.

### Media Browser

Primary: `MediaRow` / `MediaCard` Grid variant.

Secondary: `MediaHealthIndicator`, Camera filter, Inspector.

### Material / Script

Primary: `TakeCard`, `CameraSlot`, `ScriptBlock`.

Secondary: `EvidenceItem`, Inspector, placement status.

### Identity

Primary: `IdentityCandidateRow` / `PersonRow`.

Secondary: evidence occurrences, Take jump actions.

### Review Web

Primary: `ReviewTakeRow`, `ReviewMemberTile`, Player/Inspector.

Secondary: `ReviewOpinionControl`, placement, comments, evidence.

### Status Center

Primary: `TaskRow` + `TaskStatusIndicator`.

No KPI-card wall.

## 7. Migration status

### Implemented on `work/professional-ui-ux-system`

- Professional UI / UX authority and component matrix
- Product Shell with global-only Sidebar, project toolbar, Current Operator and four Production Areas
- persisted Production page resume with Slate default for new projects
- `MediaCard` stable anatomy and A/B/C/AUX categorical camera identity
- Media Browser List/Grid, camera filter axis, selection Inspector and shared `MediaHealthIndicator` technical-state presentation
- dense Slate production ledger with fixed A/B/C/AUX columns, no-shift media cells, shared 10px evidence floor and editable `SlateStatusIndicator`
- `TakeCard` stable anatomy, fixed A/B/C/AUX slots and Material / Script 10px typography floor
- Identity candidate/evidence/confirmed-human authority split with Take jump evidence
- Status Center current/attention/history operations layout, stale-attempt semantics, shared `TaskStatusIndicator` consumption and narrow-width operations hardening
- Rough Cut editorial-decision workspace, Assembly sequence grammar, Timeline track/lane grammar and Delivery output/validation grammar
- Review Web canonical A/B/C/AUX member ordering, stable `ReviewMemberTile`, explicit Media Health, Review Opinion and Editorial Decision families, plus offline camera-rail protection
- independent status indicator component families and professional UI contract tests

### Remaining visual acceptance targets

1. Review Web: device/browser visual QA with real long filenames, repeated cameras, missing media and mixed custom cameras across breakpoints
2. Status Center: device visual QA for long runtime errors, cancel/retry transitions and live progress at narrow widths
3. Full macOS visual acceptance pass for Sidebar / Slate / Media / Script / Identity / Edit / Review / Status Center before leaving Draft

## 8. Review checklist for every PR

Before merging UI work, ask:

- Is this a new production object or merely a new visual treatment?
- Does an existing object component already own this anatomy?
- Is a new status semantically different from existing status families?
- Can any optional field shift another semantic field?
- Can a missing Camera move another Camera into its slot?
- Is any readable/interactive text below 10px?
- Does selected change geometry?
- Are Focus and Selected distinct?
- Does the same action appear in multiple competing homes?
- Is AI evidence visually weaker than human authority?

If any answer violates the professional contract, the UI is not complete.
