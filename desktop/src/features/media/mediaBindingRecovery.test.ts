import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("Desktop media reconnect recovery", () => {
  it("distinguishes moved-media reconnect from adding a search location", () => {
    const source = read("./MediaBindingWorkbench.tsx");

    expect(source).toContain("async function reconnectMovedMedia()");
    expect(source).toContain('submitScan(values, true, "reconnect")');
    expect(source).toContain("async function addSearchLocations()");
    expect(source).toContain('submitScan(merged, false, "add")');
    expect(source).toContain("重新连接已移动素材…");
    expect(source).toContain("添加搜索位置…");
    expect(source).not.toContain("替换目录并重扫");
    expect(source).not.toContain("扫描新增目录");
  });

  it("explains that local reconnect preserves project media identity and old bindings until success", () => {
    const source = read("./MediaBindingWorkbench.tsx");

    expect(source).toContain("项目记住媒体身份；这里仅告诉当前 Mac 去哪里找到对应文件。");
    expect(source).toContain("这不会新建或更改项目中的媒体身份");
    expect(source).toContain("不会修改共享项目");
    expect(source).toContain("旧位置和绑定会保留到新扫描成功后才替换");
    expect(source).toContain("失败或取消不会破坏当前连接");
    expect(source).toContain("已校验素材会按内容身份重新连接");
    expect(source).toContain("旧项目只有文件名线索的素材仍会要求你逐项确认");
    expect(source).toContain("confirmProvisionalMediaBinding");
  });

  it("tracks one live scan inline, exposes cancellation, and refreshes automatically", () => {
    const source = read("./MediaBindingWorkbench.tsx");

    expect(source).toContain("new ProjectTaskClient(baseUrl)");
    expect(source).toContain("newestActiveScan");
    expect(source).toContain("activeMediaScan");
    expect(source).toContain("async function cancelScan()");
    expect(source).toContain("取消扫描");
    expect(source).toContain("完成后连接结果会自动刷新");
    expect(source).toContain("当前已有素材扫描正在进行");
    expect(source).toContain("error.status === 409");
    expect(source).not.toContain("扫描完成后点“刷新结果”");
  });

  it("does not silently truncate large result sets", () => {
    const source = read("./MediaBindingWorkbench.tsx");

    expect(source).toContain("const RESULT_LIMIT = 300");
    expect(source).toContain("显示前 ${RESULT_LIMIT}/${items.length}");
    expect(source).toContain("统计数字仍按全部素材计算");
  });

  it("loads the reconnect fidelity layer after the frozen global theme layers", () => {
    const main = read("../../main.tsx");
    const css = read("./media-binding-recovery.css");

    expect(main).toContain('import "./features/media/media-binding-recovery.css"');
    expect(main.indexOf('import "./features/media/media-binding-recovery.css"')).toBeGreaterThan(main.indexOf('import "./desktop-theme-frozen-surfaces.css"'));
    expect(css).toContain(".media-binding-scan-state");
    expect(css).toContain('html[data-mirrororder-theme="light"] .media-binding-recovery-state');
    expect(css).toContain('html[data-mirrororder-theme="dark"] .media-binding-recovery-state');
  });
});
