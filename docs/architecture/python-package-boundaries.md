# Python Package Boundaries

Status: **Planned — no package moves on main**  
Updated: 2026-09-02

## Purpose

`src/script_organizer/` 的 flat namespace 已同时承载 Product Core、media、editorial、intelligence、durable tasks、Host adapters 与 FCPXML。目标不是一次性“整理目录”，而是让 ownership、依赖方向、runtime install 和 packaging 更容易审计。

当前 `main` 不进行批量搬包；真实迁移按小的 coherent domain slice 完成，并保持业务行为与 authority 不变。

## Target ownership

```text
script_organizer/
├── foundation/      # config, workspace, models, timebase, source descriptors
├── media/           # file identity, inventory, reader, roles, waveform, multicam
├── editorial/       # review, slate/script supervisor, placement, coverage, rough cut, delivery
├── intelligence/    # identity, semantic, vision, assistant/audit/automation
├── execution/       # durable tasks, scheduler, device runtime state, diagnostics
├── adapters/        # fcpxml, desktop, web, cli
├── runtime_stack.py # explicit composition root
└── <temporary compatibility facades>
```

## Dependency direction

- `foundation` 可被各 domain 使用，但不得反向 import adapters、AI provider 或 runtime installer。
- `media` 可依赖 foundation；不得反向依赖 rough cut/delivery。
- `editorial` 可消费稳定 media evidence/read model。
- `intelligence` 只消费 evidence/read model 并产生 proposal/score，不直接获得 Review/Editorial/Timeline authority。
- `execution` 提供任务与资源调度，不拥有业务 authority。
- `adapters` 位于最外层；domain 不依赖 Desktop/Web/FCPXML adapter 语义。
- `runtime_stack.py` 可以组合各 installer；其它 domain 不得 import 它来触发全栈安装。

## Migration contract

每个 slice 必须满足：

1. 一次只迁一个 coherent domain，不顺手改 schema、API、业务行为或 authority。
2. 新 package 使用正常 `src` layout 与 `__init__.py`，禁止 `sys.path` hack、动态 alias 或 import hook。
3. 临时 root facade 只能 re-export；不得产生 import-time side effect。
4. 新 first-party caller 使用新 package path；旧 caller 迁完后删除 facade。
5. Desktop staging 必须继续递归复制完整 `src/script_organizer/**`。
6. source import、package discovery、staged runtime import、pytest 与适用 gate 都必须真实通过。

最低验证入口：

```bash
python scripts/check_python.py
python scripts/check_fast.py
python scripts/check_full.py
```

高风险 slice 还需要 packaged/runtime import smoke；不能只证明 source checkout 能 import。

## Recommended order

### Slice A — FCPXML adapter

候选：`fcpxml_reader.py`、`fcpxml_exporter.py` → `adapters/fcpxml/`。

职责清晰、处于系统边界，适合作为首个真实迁移 slice。

### Slice B — Delivery domain

候选：`delivery_semantics.py`、`delivery_runtime.py` → `editorial/delivery/`。

涉及 runtime installer 和 Delivery contracts，需验证 staged Host import。

### Slice C — Media roles

候选：`media_role_store.py`、`media_role_projection.py`、`media_role_runtime.py` → `media/roles/`。

必须保持 Media Role 在 Coverage/Rough Cut 前的真实 install order。

### Deferred — Identity family

`identity_index[_legacy|_v2|_v3]`、`identity_runtime[_v2|_v3]` 以及 library/rescue/worker/API runtime 高耦合，并带 version facade/native runtime contract。先用前三个 slice 验证迁移机制，再单独 consolidation。

### Deferred — Foundation

`workspace.py`、`workspace_db.py`、`config.py`、`models.py` 等被大量模块依赖，等边界 domain 稳定后再处理。

## Prohibited

- 不做一次性 mass move。
- 不在搬包同时删除 v2/v3、改 schema/API/authority。
- 不把所有 `*_runtime.py` 机械塞进统一 `runtime/`；runtime 仍跟随业务 owner。
- 不把 compatibility facade 变成永久公共 API。
