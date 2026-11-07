import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const { mockedIsTauri, mockedTauriFetch } = vi.hoisted(() => ({
  mockedIsTauri: vi.fn(() => false),
  mockedTauriFetch: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: mockedIsTauri }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: mockedTauriFetch }));

import { fetchWithTimeout } from "./requestWithTimeout";

describe("fetchWithTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedIsTauri.mockReturnValue(false);
    mockedTauriFetch.mockReset();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("aborts a browser request at the deadline", async () => {
    const pending = fetchWithTimeout("http://127.0.0.1:8765/ping", {}, 25);
    const assertion = expect(pending).rejects.toMatchObject({ message: "Host 请求超过 0.025 秒未响应" });
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({ signal: expect.any(AbortSignal) });
  });

  it("uses a bounded Tauri connection timeout", async () => {
    mockedIsTauri.mockReturnValue(true);
    mockedTauriFetch.mockReturnValue(new Promise<Response>(() => undefined));
    const pending = fetchWithTimeout("http://127.0.0.1:8765/ping", {}, 25);
    const assertion = expect(pending).rejects.toMatchObject({ message: "Host 请求超过 0.025 秒未响应" });
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    expect(mockedTauriFetch.mock.calls[0]?.[1]).toMatchObject({ connectTimeout: 25 });
  });
});
