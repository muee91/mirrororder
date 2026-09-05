import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

describe("Slate editable status indicator adoption", () => {
  it("renders the shared SlateStatusIndicator while keeping direct select editing", () => {
    const row = source("./SlateRow.tsx");
    expect(row).toContain('import { SlateStatusIndicator } from "../../components/StatusIndicators"');
    expect(row).toContain("<SlateStatusIndicator state={row.status} />");
    expect(row).toContain('select value={row.status} aria-label={`第 ${row.rowNumber} 条状态`}');
    expect(row).not.toContain('className={`golden-status-control status-${row.status}`}');
    expect(row).not.toContain('className="status-dot"');
    expect(row).not.toContain('className="status-label"');
    expect(row).not.toContain("function statusLabel(status: SlateStatus)");
  });

  it("keeps the select hit target full-size without changing the status column geometry", () => {
    const css = source("./golden-slate-media-experience.css");
    const legacy = source("./golden-slate.css");
    expect(legacy).toContain(".golden-slate-table .col-status { width: 110px; }");
    expect(css).toContain(".golden-status-control .mo-slate-status-indicator");
    expect(css).toContain("height: 28px");
    expect(css).toContain(".golden-status-control select");
    expect(css).toContain("inset: 0");
    expect(css).toContain("opacity: 0");
    expect(css).toContain("cursor: pointer");
  });

  it("retains explicit keyboard focus and the shared shooting-state semantic family", () => {
    const css = source("./golden-slate-media-experience.css");
    const shared = source("../../components/status-indicators.css");
    expect(css).toContain(".golden-status-control:focus-within .mo-slate-status-indicator");
    expect(css).toContain("outline: 2px solid var(--mo-accent");
    expect(shared).toContain('.mo-slate-status-indicator[data-state="usable"]');
    expect(shared).toContain('.mo-slate-status-indicator[data-state="partial"]');
    expect(shared).toContain('.mo-slate-status-indicator[data-state="ng"]');
  });
});
