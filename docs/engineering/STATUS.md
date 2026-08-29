# Engineering Status

更新时间：2026-08-29

## 当前基线

- 主线：`main`
- 建立工程控制层时的主线 commit：`4e112efebf70159ff2d1ef91b530947e5efb7c3e`
- 当前管理改动：`chore/engineering-control-plane`
- GitHub Actions：当前不可作为必要 gate；本地验证优先。

## 当前 P1

| 工作包 | 状态 | 说明 |
| --- | --- | --- |
| Media inventory durable scan | 已收口 | GET 只读 device-local snapshot；显式扫描进入 `media_inventory_scan` durable task。 |
| Waveform durable build | 已收口 | GET 只读 cache；显式生成进入 `waveform_build` durable task。 |
| Runtime heavy-work audit | 待执行 | 审计剩余 GET/页面路径是否仍触发全目录枚举、FFmpeg/FFprobe、模型下载/加载、全项目 embedding/index rebuild 或长 provider/network 工作。 |
| Engineering control plane | 待本地验证 | worktree 规则、本地 gate、状态/决策/不变量文档和 repository guard 已接入；`main` 暂未修改。 |

## 当前验证状态

针对 `chore/engineering-control-plane`：

- Source / diff review：PASS（相对 `main@4e112ef`，仅工程文档、gate 脚本和 repository layout guard）
- `python scripts/check_fast.py`：NOT RUN
- `python scripts/check_full.py`：NOT RUN
- Native packaged runtime smoke：NOT RUN
- GitHub Actions：NOT RUN / 不作为当前必要条件

任何未实际执行的命令都不得标为 PASS。

## 下一工作包

### P1 — Runtime heavy-work audit

目标：保证普通 GET、打开页面、切换项目/对象、展开 Inspector 等轻交互只消费 cache/snapshot/read model，不触发分钟级工作。

优先检查：

- `src/script_organizer/*_runtime.py`；
- Production Host GET routes；
- media enumeration / fingerprint loops；
- FFmpeg / FFprobe；
- model download / load；
- perception / embedding / index rebuild；
- 长 provider/network call。

发现违规时：

```text
lightweight read path
        ↓
cache/snapshot miss
        ↓
明确 UI 状态
        ↓
用户显式动作
        ↓
durable task
        ↓
Status Center
```

### P2 — Runtime installation order

审计 `editorial_runtime.py` 等安装链，确保 monkeypatch/runtime install 顺序确定、幂等，并有 contract test。

### P2 — Python package migration plan

`src/script_organizer/` 的 flat namespace 是历史兼容区。先划分 coherent domains 和兼容 import / packaging / stage-runtime contract，再独立迁移；不与产品功能混改。

## 状态维护规则

- `STATUS.md` 只写“现在是什么状态”，不要堆实现日志。
- 完成的历史验收证据移到 `docs/verification/`；这里保留当前结论。
- 新发现但不属于当前 scope 的事项进入 `BACKLOG.md`。
- 新长期约束进入 `DECISIONS.md` 或 `INVARIANTS.md`。