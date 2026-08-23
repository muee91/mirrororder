# 踩坑清单（按代价排序）

这些坑都真实发生并修复过。规则带"为什么"，因为理解了原因才不会再犯。

## 1. corr_offset 符号与直觉相反（最贵的一个坑）

`corr_offset(a, b)` 返回 **pos_a − pos_b**，不是 pos_b − pos_a。即 b 比 a 晚 delay 秒时返回 +delay；b = a 的子片段（晚 40.5s 开始）返回 −40.5。

约束公式必须是：
```
delta = tcX − tcY − off        # 其中 off = pos_X − pos_Y
```
（早期写成 `+ off` 导致所有约束反号，拟合出 +41.29s 而真实是 −41.29s。）

**每次跑全量前先做确定性合成信号测试**：构造已知延迟的 sin 信号对，断言符号正确；再用真实片段做子片段测试。

## 2. TC 先验被残留片段污染

8.14 目录混入了一个 8.13 的 0.48s 残留片段（`B003C001_260813BH`），其 TC 与当日素材差 1829s，把候选窗口带偏，初版拟合 delta_B 算成 +1919s（完全错误）。

**修复**：先验只取时长 ≥5s 的片段；候选配对也跳过 dur<5s。教训：先按天/相机分组，先探查数据里有没有"异类"（跨天文件、0 时长、TC 突变）再定先验。

## 3. FCPXML 结构必须严格符合 DTD（library 的坑）

FCP 导入报错：`Element library content does not follow the DTD, expecting (event | smart-collection)*`。

正确的 1.8 结构（用 FCP 应用包里的官方 `FCPXMLv1_8.dtd` 对照确认；**版本号必须 ≥1.8**，剪映硬门槛，1.7 会被拒）：
```
<fcpxml version="1.8">
  <resources>          ← (asset | effect | format | media)*
    <format id="format_0" .../>       ← 同格式素材共用一个 format
    <asset id="day1_asset_0" .../>*   ← src 用 file:// + 百分号编码绝对路径
    <media id="day1_media" name="...">   ← multicam 必须在这里
      <multicam format="format_0" tcStart="0/50000s" tcFormat="NDF">
        <mc-angle name="A" angleID="angle_A"> <clip/> <gap/> ... </mc-angle>
  <library>
    <event name="...">   ← (%event_item;)*：project|mc-clip|asset-clip|keyword-collection 任意顺序
      <keyword-collection .../>
      <project name="..."><sequence ...><spine><mc-clip ref="day1_media"/>...</spine></sequence></project>
      <mc-clip name="..." duration="..." ref="day1_media"><mc-source angleID="angle_A" srcEnable="video"/></mc-clip>
      <asset-clip name="..." ref="day1_asset_0" duration="..." start="0/50000s" tcFormat="NDF">...</asset-clip>
```
- `media` 元素只允许出现在 `resources`（Sidus 导出文件实测确认）。
- event 级 `mc-clip`（ref 指向 media）让多机位片段出现在事件浏览器，是 FCP 原生导出模式。
- asset 需要 `start="0/50000s"`、`hasVideo/hasAudio/audioSources/audioChannels/audioRate`；metadata 里可带 `cameraName`。
- **剪映专用变体（build_capcut_fcpxml.py）**：剪映只认 `asset-clip` 作为时间线片段（反汇编实证），不认 mc-clip/multicam/gap。剪映版 spine 直接放 asset-clip（lane=机位序号、offset=绝对时间轴位置、间隙靠 offset 定位），不用 media/multicam/mc-clip/gap。用 build_fcpxml.py 的 multicam 版导入剪映会得到**空时间线**。

## 4. 时间值必须整帧吸附（"不在编辑帧边界上"）

FCP 导入报错：`此项不在编辑帧边界上`（The item is not on an edit frame boundary）。

音频同步位置是亚帧精度，直接换算 tick（1/50000s）后 offset/duration 不是 1000 的整数倍（50fps 一帧 = 1000 tick）。**所有** offset/duration/start/tcStart 必须吸附到整帧：

```python
FRAME_TICKS = 1000  # 50fps；其他帧率 = round(frameDuration_denominator / fps)
def sec_to_ticks(s):
    return int(round(round(s * 50000) / FRAME_TICKS)) * FRAME_TICKS
```

角度内剪辑的兜底也要整帧（`end_t = start_t + FRAME_TICKS`，不能 +1 tick）。吸附误差 ≤ 半帧（10ms@50fps），在同步精度范围内可接受。帧率变了 FRAME_TICKS 必须跟着变。

## 5. Premiere xmeml v4 的两个坑

- **file id 必须全文档唯一**：三个序列共享素材时，若每个序列内部分别从 file_0 计数，后生成的序列会覆盖前面的 file 定义（引用错乱）。用全局 fid 状态（`fid_state = {"next":0, "map":{}}`）跨序列分配。
- **单日序列 duration 不能是 sum(day_totals)**：单日序列的 day_totals=[0] 会算出 duration=0。正确取该序列所有 clipitem 的 max(end)。
- 用标准 FCP7 结构：clipitem **内联完整 `<file>` 块**（name/pathurl/rate/duration/media），不要用"文本引用 + 外部文件表"——那是非标准形态。

## 6. macOS multiprocessing 崩溃

`Pool(8)` 在 heredoc 主模块（`python3 - <<EOF`）里跑会触发 "An attempt has been made to start a new process before the current process has finished its bootstrapping phase"。修复：脚本写文件 + `mp.set_start_method("fork", force=True)` + `if __name__ == "__main__":` guard。

## 7. 素材 ID 与格式资源的唯一性

- 多天素材若共用 format 资源 id，asset id 必须按天唯一（`day1_asset_0` / `day2_asset_0`），否则跨天撞 id。
- 合并序列里混用两个 format（序列声明 format_1 却内嵌 format_2 的 multicam）是隐患：同格式素材统一成一个 format 资源最稳妥（Sidus 参考文件也是多 format 并存，但单 format 更少歧义）。

## 8. 低置信度配对先试包络互相关，再判失败

syncdrop 仓库实测证明：对原始波形直接相关的置信度，会被不同话筒距离、增益差异、环境噪声压低；改成 **diff 预加重 + abs + 50ms 平滑包络** 后再相关，打击类瞬态主导匹配，混合来源下显著更稳（详见 lessons-from-reference-repos.md）。

- 触发条件：同一对片段用现有 8kHz 原始波形相关 conf < 10，但内容上（TC 差/场景）应当对齐。
- 做法：`env = abs(diff(x))` 卷积 50ms 均值窗 → 零均值单位方差 → 同一套 `correlate(mode="full")` + peak/median 置信度，比较两者峰值是否一致。
- 先做确定性测试（合成含打击瞬态的信号）确认符号，再全量跑，与坑 #1 同一原则。


## 9. 剪映草稿 JSON 包裹键与时长类型（"草稿损坏"真相，2026-08-21）

剪映**所有** draft_info.json 顶层就是 draft 对象本身，**无 `{"draft":...}` 包裹键**（解码全部剪映保存过的草稿实证：顶层 keys 是 id/name/tracks/...）。外部生成写包裹键 → 剪映读取阶段直接判"草稿损坏"（draft_info.json 保持明文、无 .backup 生成）。同时所有 duration 字段必须 int（µs），float 会让剪映解析异常。

## 10. 剪映多机位"媒体丢失"根因（2026-08-21 三次实测定位）

多机位轨显示媒体丢失 = 剪映打开时找不到子草稿关联。三个独立必要条件，缺一即丢：
1. **主草稿 materials.drafts 必须内嵌 combination（完整 3 角度轨 draft）**，多机位轨 segment 的 `extra_material_refs` = 7 个且 **[0] 指向 combination.id**（1-track 成功版实证：7 refs 含 drafts；只有 6 个 companions → 媒体丢失）。仅把 combination 放 subdraft 顶层不够。
2. **combination 三个路径（draft_config_path/draft_cover_path/draft_file_path）必须用同一个占位符**（`##_draftpath_placeholder_<UUID>_##`，主草稿；`##_subdraft_placeholder_<UUID>_##`，subdraft 顶层）。只改 file、留 config/cover 旧占位符 → 解析失败。
3. **subdraft 根目录必须有 draft_content.json + sub_draft_config.json**（剪映按 `./subdraft/sub_draft_config.json` 解析，实证：剪映保存版 meta type18 自动新增第二条 file_Path="./subdraft/sub_draft_config.json"、subdraft 根目录自动补文件）。UUID 子目录版是兼容保留，根目录版才是剪映实际读的。
另外：多机位轨 segment 的 `render_index` 必须是**轨道索引**（4 轨时 = 3，04:43 模板实证），不是轨道数。

## 11. 磁吸开关是草稿级配置：config.maintrack_adsorb

"主轨磁吸"不是应用偏好，是**草稿 config 里的字段**（用户两个对照草稿实证：`主轨磁吸打开` config={"use_float_render":true}，`主轨磁吸关闭` config={"maintrack_adsorb":false, "use_float_render":true}）。磁吸打开时剪映**自动压缩主轨（tracks[0]）间隙**（对照实证：磁吸开版第2段 target.start 被吸到紧贴第1段末尾，磁吸关版保留真实间隙 2860000µs）。3+1 草稿**必须显式写 `config.maintrack_adsorb=false`**，否则普通轨 A/B/C 的对齐间隙被吸掉、时间轴错位。多机位轨（1 段无间隙）不受影响，普通轨是受害者。

## 12. 外置盘 AppleDouble 残留（._* 文件）

macOS 在**外置盘（PSSD）**上写任何文件都会自动生成同名 `._*` AppleDouble 文件，json.dump/shutil.copy 都会产生。剪映解析子草稿会被 `._draft_content.json` 等干扰 → 生成脚本最后必须 `os.walk` 全目录删除 `._*`；rsync 用 `--exclude="._*"` 是**不够的**（写入时就产生了，rsync 只排除了复制阶段）。校验：`find <draft> -name '._*' | wc -l` 必须为 0。

## 13. 剪映沙盒权限：fcpxml 导入"素材未链接/弹窗"的头号原因（2026-08-23 实证）

剪映（VideoFusion-macOS.app）是 **App Sandbox 应用**（codesign entitlements 实证
`com.apple.security.app-sandbox=true`）。导入 fcpxml 时如果素材在**剪映从未被授权
访问过的路径**（典型：新外置盘 PSSD、新项目目录），剪映**解析 fcpxml 完全正常**
（asset 全部登记、src 解码正确、文件全部存在），但**时间线内容是空的**：
draft_info.json 只有 1 条空轨（segments=0），draft_meta_info.json 里 1502 个
file_Path 全部正确存在。表现 = 导入弹窗 + 素材没链接上 + 空时间线。

**关键实证（人不狠 2026-08-23）**：
- 同一份 capcut.fcpxml，素材在已授权路径（示例拍摄日/）→ 导入成功 4 轨 1502 段；
  素材在未授权路径（《人不狠，站不稳》/素材/）→ 导入 3 次全部空轨。
- **路径字符（书名号《》、全角逗号，、双空格、中文）不是问题**：剪映用
  `FCPXMLUtility::urlDecode` 标准百分号解码 src（反汇编实证），解码后路径与磁盘
  完全一致、1502 个全部 exists；用户提供的可导入老版 XML（Sidus XML 1）src 与
  我们生成文件**逐字节相同**。
- 回收站证据：导入失败后草稿被移入 `.recycle_bin/`，解码加密版可见同样空轨。

**排查顺序（先权限后文件）**：
1. 先看草稿 draft_info.json：`tracks` 只有 1 条空轨 + `materials.videos=[]` +
   `name` 用了 project name（非文件名）→ 大概率权限问题。
2. 再看 draft_meta_info.json：file_Path 全部存在 → 不是路径/编码问题。
3. 授权：macOS 系统设置 → 隐私与安全性 → 文件与文件夹（或完全磁盘访问），
   给剪映（VideoFusion）勾选素材所在外置卷/目录；或首次导入时剪映弹窗选允许。
4. 授权后**重新导入**同一份 fcpxml 即可成功（不用改任何文件）。

**不要做的事**：不要因为"导入失败"就怀疑 src 编码、改路径写法、加 file:// 变体
——权限问题下改这些全无效，且会破坏已验证可用的格式。

## 14. 诊断剪映草稿问题的证据闭环（codec 闭环）

剪映打开草稿后保存，会把明文草稿**加密**（官方 AES-GCM，capcut_draft_codec.py 可解码）。所以：
- 打开前 draft_info.json 是明文（我生成）→ 打开/保存后是加密 → **解码加密版就是剪映接受/重写后的结构**，与我的生成稿 diff，差异就是剪映的解析行为证据。
- 判断成功：保存后轨3 仍带 7 refs、drafts 仍内嵌 3 轨、mc_video/multi_camera_info 关联完整 = 多机位被正确识别。
- 判断失败：剪映自动补文件/补 meta 条目 = 它按另一条路径解析（如 subdraft 根目录）。
