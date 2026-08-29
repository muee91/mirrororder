# Python Package Boundary Plan

状态：**Planned / no moves on current branch**  
日期：2026-08-29

## 目的

`src/script_organizer/` 当前 flat namespace 已经承担 Product Core、媒体、场记/审阅/剪辑规划、本地智能、durable task、Host adapter、FCPXML 和兼容 facade 等多种职责。继续把新模块全部放在根目录会让 import graph、runtime install order、打包和兼容关系越来越难审计。

本计划只定义未来迁移边界与 contract。**`fix/runtime-read-paths` 不执行文件搬迁。** 当前分支必须先在完整 checkout 上通过适用的 Python / fast / full gate，再另开 migration worktree。

## 不变原则

1. Python 仍是 MirrorOrder Product Core；包整理不能改变 Rust Timeline authority、Review/Editorial authority 或 project/device task scope。
2. 不把产品 API 的旧 route 留作兼容。内部 Python import facade 只允许作为短期迁移脚手架，并必须有删除里程碑。
3. 一次 migration slice 只迁一个 coherent domain，默认 2–5 个实现文件；不得顺手重写业务逻辑。
4. root compatibility module 只能 re-export；不得在 import 时 install runtime、写磁盘、加载模型或修改全局 registry。
5. 新代码在 slice 完成后使用新 package path；旧 import 只供尚未迁移的调用者过渡。
6. 每个 slice 必须同时验证 import、pytest、Desktop staging 和 runtime installer path；不能只证明源码能 import。
7. `runtime_stack.py` 继续是 Production Host 唯一全栈安装编排器。

## 目标结构

这是目标 ownership map，不要求一次性创建全部目录：

```text
script_organizer/
├── foundation/
│   ├── config
│   ├── workspace
│   ├── workspace_db
│   ├── models
│   ├── timebase
│   └── source_descriptor
├── media/
│   ├── identity            # media file identity，不是人物 Identity
│   ├── inventory
│   ├── reader
│   ├── roles
│   ├── waveform
│   └── multicam
├── editorial/
│   ├── review
│   ├── script_supervisor
│   ├── placement
│   ├── coverage
│   ├── rough_cut
│   ├── assembly
│   └── delivery
├── intelligence/
│   ├── identity/           # face / speaker / identity library
│   ├── semantic/
│   ├── vision/
│   └── assistant/          # assistant / audit / automation / agent
├── execution/
│   ├── tasks
│   ├── device_tasks
│   ├── resource_scheduler
│   ├── device_runtime_settings
│   └── diagnostics
├── adapters/
│   ├── fcpxml/
│   ├── desktop/
│   ├── web/
│   └── cli/
├── runtime_stack.py        # composition root，保持显式
└── <temporary root facades>
```

`runtime_stack.py` 暂留 package root 是有意的：它是 composition root，不属于某个业务 domain，也便于在迁移期间稳定引用各 domain installer。

## 依赖方向

### Foundation

- 可以被所有 domain 使用。
- **不得** import Desktop/Web/FCPXML adapter、Assistant/Audit、domain runtime installer。

### Media / Editorial

- 可以依赖 `foundation`。
- Editorial 可以依赖稳定的 media identity/read model。
- Media 不应反向依赖 Rough Cut/Assembly/Delivery。

### Intelligence

- 可以消费 media/editorial 的 evidence/read model。
- 只能生成 evidence/proposal/score，不能直接写 Final Editorial Decision 或 Rust Timeline authority。
- Domain Core 不应为了 AI provider 反向依赖 `intelligence`。

### Execution

- 提供 durable task、resource scheduling、device-local task state 等执行基础设施。
- 不拥有 Review/Editorial/Timeline 业务 authority。

### Adapters

- Desktop/Web/CLI/FCPXML 在最外层，依赖 domain public surface。
- Domain module 不得 import Desktop React/Tauri 语义；Web/CLI 不能成为第二业务 truth。

### Composition root

- `runtime_stack.py` 可以依赖各 runtime installer。
- 其他 domain 不得 import `runtime_stack` 来触发全栈安装。

## 兼容 facade 策略

内部 source import compatibility 与产品旧 API compatibility 是两件事：

```python
# 允许：短期 root facade
from .intelligence.identity.runtime import IdentityRuntime
__all__ = ["IdentityRuntime"]
```

```python
# 禁止：旧 route / 隐式 bootstrap
install_identity_runtime()  # import 时执行
register_old_api_route()
```

每个 facade 必须满足：

- 只 re-export；
- 新旧 import 指向同一个公开对象；
- 有对应 import contract test；
- 新调用点不得继续增加旧路径依赖；
- 最迟在该 domain 所有 first-party caller 已迁移且连续两个 migration slice 的 full gate 通过后删除；
- 若项目仍处雏形且没有外部 Python SDK consumer，可在同一独立 migration worktree 的收尾 slice 直接删除 facade，不长期背兼容包袱。

现有 `identity_runtime.py` 是 facade 模式参考：它只 re-export active implementation，并明确禁止 import-time runtime install。

## Packaging / staging contract

当前 Desktop staging 使用递归目录复制：

```text
src/script_organizer/**
    ↓ recursive copy
mirrororder-core/src/script_organizer/**
```

因此子 package 不需要额外 Tauri 文件白名单，但每个 migration slice 仍必须证明：

1. 新目录包含 `__init__.py`；
2. setuptools 在 `src` layout 中发现新 subpackage；
3. `python -m compileall -q src/script_organizer` 成功；
4. source checkout 中新旧 import contract 成功；
5. staged runtime 的 isolated import probe 成功；
6. `desktop/scripts/stage-runtime.mjs` 继续递归复制完整 `script_organizer`；
7. `pytest`、fast、full gate 都不依赖偶然 cwd 或 root-only module path。

如果 setuptools 自动发现行为在真实 package build 中不能被明确证明，则在首个迁移 slice 中把 package discovery 显式写入 `pyproject.toml`，而不是依赖环境差异。

## Migration slice 模板

每个 slice 必须单独 branch/worktree，例如：

```text
refactor/python-fcpxml-package
refactor/python-delivery-package
refactor/python-media-roles-package
```

关闭条件：

1. 列出 moved modules 和 owner package；
2. 只迁相关实现和 import，不做业务行为重写；
3. 建立 root facade 或明确证明可直接删除旧 import；
4. 新增 old/new import identity contract；
5. 更新 `runtime_stack.py` installer import（若涉及 runtime）；
6. 验证 source + staged runtime import；
7. `python scripts/check_python.py` PASS；
8. `python scripts/check_fast.py` PASS；
9. 高风险/跨 runtime slice 再执行 `python scripts/check_full.py`；
10. diff review 确认没有新增 import-time side effect、循环依赖或第二 authority。

## 推荐迁移顺序

### Slice A — FCPXML adapter

候选：

- `fcpxml_reader.py`
- `fcpxml_exporter.py`

目标：`adapters/fcpxml/`。

理由：职责明确、属于边界 adapter，且不拥有业务 authority。风险主要是 Delivery、CLI/tests 的 import 更新。**建议作为首个真实 package migration。**

### Slice B — Delivery domain

候选：

- `delivery_semantics.py`
- `delivery_runtime.py`

目标：`editorial/delivery/`。

理由：Stage 5 已明确 shared artifact / localhost path contract，边界较清楚。涉及 runtime installer，必须更新中央 runtime stack 并做 staged Host import contract。

### Slice C — Media roles

候选：

- `media_role_store.py`
- `media_role_projection.py`
- `media_role_runtime.py`

目标：`media/roles/`。

理由：Store/Projection/Runtime 已形成 coherent group，但 Coverage/Rough Cut 对 projection install order 有真实依赖，因此风险高于 A/B；必须保持 Media Role 在 Coverage/Rough Cut 前安装。

### 暂缓 — Identity family

当前同时存在：

- `identity_index.py` / `identity_index_legacy.py` / `identity_index_v2.py` / `identity_index_v3.py`
- `identity_runtime.py` / `identity_runtime_v2.py` / `identity_runtime_v3.py`
- library/rescue/role inference/worker/API runtime

这是一组高耦合、带版本 facade 和 native runtime contract 的模块。**不作为首批迁移。** 先在前 3 个 slice 验证迁移机制、package discovery、staging 和 facade 删除流程，再单独设计 Identity consolidation worktree。

### 暂缓 — Core foundation

`workspace.py`、`workspace_db.py`、`config.py`、`models.py` 等被大量模块依赖。它们放到 `foundation/` 是终态方向，但应在叶子/边界 domain 迁移稳定后再处理，避免一次修改整个 import graph。

## 禁止事项

- 不创建一个巨大 `script_organizer/runtime/` 后把所有 `*_runtime.py` 一次塞进去；runtime 文件仍应跟随其业务 owner，只有跨域执行基础设施进入 `execution/`。
- 不同时删除 v2/v3、改 schema、改 API、改 authority 和搬包。
- 不通过 `sys.path` hack、动态 module alias 或 import hook 掩盖错误 package 边界。
- 不把 migration facade 当永久 API。
- 不在当前 `fix/runtime-read-paths` 分支开始真实文件搬迁。

## 启动首个迁移 slice 的前置条件

必须先在完整 checkout 上取得当前大分支的真实 executable evidence：

```bash
python scripts/check_python.py
python scripts/check_fast.py
python scripts/check_full.py
```

如果这些 gate 暴露 Stage 1–8 回归，先修回归；**不要用 package migration 把失败原因进一步复杂化。**
