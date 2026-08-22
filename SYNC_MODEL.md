# 镜序多设备同步模型

镜序的多设备原则：

> **共享“项目事实和人工决策”，不共享“这台电脑上的绝对素材路径”。**

同一条素材在不同电脑上可以位于完全不同的磁盘和目录。共享项目使用 `media_id` 识别物理媒体；每台设备用自己的 `media-bindings.json` 把 `media_id` 映射到本机文件。

## 1. 必须在设备间同步的数据

### 工作区身份

- `workspace.toml` 中的稳定 `workspace.id` / `workspace_id`
- `projects/registry.json` 中的项目 `project_id`

一个 gateway 可以同时加载多个工作区。工作区 ID 是路由身份，不是访问凭据；局域网首次访问由 App 配对码换取会话。

这些数据共同定义“大家正在剪同一个项目”，应该由同一个项目空间保存或同步：

### 项目定义

- `workspace.toml`
- `projects/registry.json`
- `projects/<project>/project.toml`
- 作为项目依据的剧本文件或其不可变副本
- 作为项目依据的 FCPXML / XML 或其不可变副本

注意：`project.toml` 中历史绝对路径只是项目来源参考，不能作为跨设备媒体身份。

### 共享分析结果

- `material_index.json`
  - `clip_id`
  - `group_id`
  - `media_id`
  - timeline/source range
  - A/B/C 逻辑关系
  - 原始来源路径仅作参考
- `script.json`
- `matches.json`
- 其它确定性的剧本/Take 派生索引

这些文件让所有设备看到同一套剧本、Take、候选和 XML 时间关系。

### 人工审核状态（最高优先级）

- `review.json`
  - Best
  - Keep
  - Reject
  - 手工剧本范围
  - 人工集数归属
  - actor / revision / updated_at

多人协作时 `review.json` 必须有单一写入权威。推荐所有同时在线的审核设备把审核 action 发给同一个镜序服务，由服务完成 revision 检查和原子写入；不要让多个电脑通过普通网盘同时直接改同一个 `review.json`。

## 2. 推荐同步，但不是逻辑必需的数据

### ASR / 对齐缓存

推荐同步：

- transcript / ASR cache
- known-text alignment cache（如果它不包含设备绝对路径作为不可移植主键）

同步它们的好处是其它设备不需要重新转写和重新跑昂贵分析。

如果不同设备不需要运行分析，只负责看片和审核，则可以只同步最终 `material_index.json` / `script.json` / `matches.json` / `review.json`。

### 导出结果

按团队需要同步：

- `selection_manifest.json`
- `organized.fcpxml`
- 其它只读交付文件

它们不是审核协作的主状态。

## 3. 绝对不能在设备间同步为项目事实的数据

以下数据是 **Device Local**：

- 本机素材根目录
- `/Volumes/...` 绝对路径
- `media_id -> 本机文件` 绑定
- 本机磁盘名称
- Finder 路径
- App PID
- 本机服务日志
- 本机临时文件
- 本机媒体拖拽路径

镜序当前把设备素材绑定保存到：

```text
macOS:
~/Library/Application Support/MirrorOrder/media-bindings.json
```

可用环境变量覆盖：

```text
MIRRORORDER_DEVICE_STATE_DIR
```

这个文件不得放进共享 workspace，不得提交 Git，也不应该通过 iCloud/Dropbox 在多台机器之间同步。

## 4. `media_id` 与 `clip_id` 的区别

```text
media_id
= 物理媒体身份
= 不依赖文件放在哪个磁盘

clip_id
= 这个媒体在项目/FCPXML中的一个素材 occurrence
= 可以带自己的 source range / timeline range
```

例如：

```text
Mac Studio:
/Volumes/PSSD/牛肉/A/A001.mov

MacBook Pro:
/Volumes/T9/备份/0814/A001.mov
```

两边内容相同：

```text
media_id = M_abc123...
```

但项目中的多个 occurrence 仍可以是：

```text
C_001
C_102
C_331
```

并分别拥有不同片内范围。

## 5. 当前 media_id 算法

有文件可读时：

```text
文件大小
+
文件头 1 MiB
+
文件尾 1 MiB
→ SHA-1 quick content fingerprint
→ M_xxx
```

因此：

- 文件移动：ID 不变
- 磁盘改名：ID 不变
- 文件夹结构改变：ID 不变
- 文件重命名：ID 不变
- 内容发生变化：ID 会变化

如果源文件暂时不可读，旧项目可以先使用 `MP_...` filename provisional identity。它只用于兼容迁移，不能冒充内容级确认；在有源文件的机器重新 analyze 后会得到正式 `M_...`。

## 6. 第二台电脑的实际流程

```text
1. 获取/同步同一个 MirrorOrder workspace
2. 安装并打开 镜序.app
3. App 启动本机或局域网 gateway
4. 设置 → 工作区 → 添加或选择对应工作区
5. 选择当前项目 → 这台 Mac 的素材副本 → 为当前项目绑定素材目录
6. 镜序扫描本机文件并计算 media_id
7. media_id 与共享 material_index 对应
8. 写入本机 Application Support/media-bindings.json
9. Web 工作台刷新
10. 播放、Finder/FCP 拖拽全部使用这台 Mac 的文件
```

不会修改共享 `material_index.json` 中的项目来源路径。

局域网用户打开 App 显示的 gateway 地址；默认先输入一次性配对码。多个浏览器窗口可以分别使用 `workspace_id` 与 `project_id` 固定不同工作区和项目。

## 7. 数据流

```text
                    共享项目状态
        ┌────────────────────────────────┐
        │ script / material_index        │
        │ matches / review / media_id    │
        └───────────────┬────────────────┘
                        │
              同步项目事实和审核
                        │
        ┌───────────────┴────────────────┐
        │                                │
   Mac Studio                        MacBook Pro
        │                                │
media-bindings.json                media-bindings.json
        │                                │
M_abc → /Volumes/PSSD/...          M_abc → /Volumes/T9/...
        │                                │
本机播放 / FCP拖拽                  本机播放 / FCP拖拽
```

## 8. 哪些数据量真正需要网络同步

最小审核协作集：

```text
script.json
material_index.json
matches.json
review.json
```

通常只是 JSON 文本，远小于原始视频。

推荐完整协作集再加：

```text
project/workspace 配置
原始剧本/FCPXML副本
ASR缓存
```

**原始视频本身不需要由镜序在设备间传输。** 各设备已经有素材拷贝时，只需要同步媒体身份和项目状态。

## 9. 同时多人审核的约束

如果大家只是通过一台主机的镜序服务协作：

- `review.json` 由主机服务统一写入
- revision / actor / 原子写入继续有效
- 最安全

如果每台电脑都运行自己的服务并依赖 Dropbox/iCloud 直接同步 `review.json`：

- 文件同步工具可能产生冲突副本
- 不保证跨机器文件锁
- 不推荐用于真正同时审核

长期推荐架构：

```text
中央项目状态 API / review authority
+
每台设备本地 media resolver / native drag bridge
```

即：**审核和分析事实中央同步，视频永远本地读取。**
