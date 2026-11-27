import { describe, expect, it } from "vitest";
import { encodeQrMatrix, qrSvgData } from "./qrSvg";

describe("qrSvg", () => {
  it("encodes short and typical LAN URLs with valid finder patterns", () => {
    const shortMatrix = encodeQrMatrix("http://192.168.1.10:8766/");
    expect(shortMatrix.length).toBeGreaterThanOrEqual(21);
    expect(shortMatrix[0][0]).toBe(true);
    expect(shortMatrix[0][6]).toBe(true);
    expect(shortMatrix[6][0]).toBe(true);
    expect(shortMatrix[3][3]).toBe(true);

    const lanUrl = "http://192.168.31.188:8766/?workspace_id=ws_demo_001&project_id=proj_shazi_2026";
    const svg = qrSvgData(lanUrl);
    expect(svg.size).toBeGreaterThan(30);
    expect(svg.path).toContain("M4,4h1v1h-1z");
  });

  it("produces distinct matrices for different inputs", () => {
    const a = qrSvgData("http://192.168.1.10:8766/?p=a").path;
    const b = qrSvgData("http://192.168.1.10:8766/?p=b").path;
    expect(a).not.toBe(b);
  });
});
