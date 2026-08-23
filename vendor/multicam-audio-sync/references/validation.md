# 校验清单与命令

交付前必须全部通过。任何一项失败都先定位修复再交付，不要带病交付让用户试错。

## 1. 官方 DTD 校验（FCP 导入的第一道检查）

DTD 从 Final Cut Pro 应用包提取（FCP 没装就装 Creator Studio 版，包内有同款 Interchange.framework）。**build_fcpxml.py 输出 1.8，必须用 `FCPXMLv1_8.dtd` 校验**（1.7 的 DTD 里 version 是 `#FIXED "1.7"`，会拒绝 1.8 文件）：

```bash
# 找到 DTD（本机 Creator Studio 有 1.0~1.14 全系列）
find /Applications -name "FCPXMLv1_8.dtd" 2>/dev/null
# 例如:
# /Applications/Final Cut Pro Creator Studio.app/Contents/Frameworks/Interchange.framework/Versions/A/Resources/FCPXMLv1_8.dtd

# xmllint 的 --dtdvalid 对含 % 参数实体的 DTD 会报 xmlSAX2ResolveEntity，
# 正确做法：复制 DTD 到本地，在 XML 里加 DOCTYPE 引用后校验
cp /path/to/FCPXMLv1_8.dtd /tmp/
sed -i '' 's|<fcpxml version="1.8">|<!DOCTYPE fcpxml SYSTEM "/tmp/FCPXMLv1_8.dtd">\n<fcpxml version="1.8">|' 输出.fcpxml
xmllint --noout 输出.fcpxml
# 期望输出: 无任何 error/warning，命令返回 0
```

注意：`FCPXMLv1_8.dtd` 相比 1.7 只新增了 `caption`（字幕）元素，clip/mc-clip/asset/media/format 等结构完全一致，1.7 的合法结构在 1.8 下同样合法。

## 2. 帧边界审计（FCP 导入的第二道检查）

解析全部元素的 offset/duration/start/tcStart，必须是 `整数/50000s` 且整数 % 1000 == 0：

```python
import xml.etree.ElementTree as ET, re
r = ET.parse("输出.fcpxml").getroot()
bad = 0; n = 0
for e in r.iter():
    for attr in ("offset", "duration", "start", "tcStart"):
        v = e.get(attr)
        if v is None: continue
        m = re.match(r"^(\d+)/50000s$", v)
        if not m or int(m.group(1)) % 1000 != 0:
            bad += 1; print("OFF-BOUNDARY:", e.tag, attr, v)
        n += 1
print(f"{n} values, {bad} off-boundary")  # 期望 bad == 0
```

帧率不是 50 时把 1000 换成对应帧的 tick 数。

## 3. 素材可达性

- FCPXML：所有 `<asset src="file://...">` 解码（urllib.parse.unquote）后 os.path.exists 为 True。
- Premiere XML：所有 `<pathurl>file://localhost...` 同理。
- 素材目录名/路径变更会导致链接失效——在报告里写明"需保持目录原名与路径"。

## 4. 引用完整性

- FCPXML：mc-clip ref → media id；asset-clip ref → asset id；multicam format → format id；angle clip 的 video/audio ref → asset id；mc-source angleID → mc-angle angleID。全部解析无缺失。
- Premiere XML：clipitem 的 file id 全部存在于 file 定义。

## 5. 同步精度

- 交叉闭合：AB 中位数 + BC 中位数 ≈ AC 中位数，残差应 <10ms。
- 独立抽查：从训练集中预留的随机 A/B、A/C 对，预测偏移 vs 音频实测，应 <50ms。
- 间隙压缩后：同活跃区间内配对偏移变化必须为 0（用 positions 表验证，不要只看 XML）。

## 6. 结构抽查

- FCPXML：event 内 children 计数（keyword-collection / project / mc-clip / asset-clip）；每个 mc-angle 内部 clip 单调（offset+duration 不重叠、无负长 gap）；合并序列第二段 offset == 第一段 duration。
- Premiere XML：每序列 3 视频轨 + 3 音频轨；单日序列 duration == 末端帧。

## 7. 交付前自问

- [ ] 两个 XML 都在 `交付/`，脚本/位置表在 `同步脚本/`，报告更新了吗？
- [ ] 报告里写了间隙策略（保留/压缩）和理由了吗？
- [ ] 没有把文件散到素材盘根目录或其他无关位置了吗？
