import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: vi.fn(() => false) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

import { SemanticSearchClient } from "./semantic";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

describe("SemanticSearchClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses the Host-local read-only semantic search route", async () => {
    const browserFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      const url = String(input);
      expect(url).toContain("/api/v1/projects/p%2F1/semantic-search?");
      expect(url).toContain("q=%E6%9E%97%E9%9B%AA%E6%8E%A8%E9%97%A8");
      expect(url).toContain("limit=20");
      expect(url).toContain("sources=visual%2Cslate");
      return jsonResponse({
        contract: "semantic_search.v1",
        query: "林雪推门",
        mode: "hybrid",
        results: [{ document_id: "d1", group_id: "g1", clip_id: "c1", media_id: "m1", source: "visual", source_label: "画面", score: 0.1, vector_similarity: null, keyword_rank: 1, vector_rank: null, start: 3, end: 5, snippet: "林雪推门后回头", metadata: {} }],
        summary: { returned: 1 },
        semantics: { read_only: true, result_is_editorial_decision: false },
      });
    });
    vi.stubGlobal("fetch", browserFetch);

    const result = await new SemanticSearchClient("http://127.0.0.1:8765/").search("p/1", "林雪推门", { limit: 20, sources: ["visual", "slate"] });
    expect(result.contract).toBe("semantic_search.v1");
    expect(result.semantics.read_only).toBe(true);
    expect(result.results[0]?.group_id).toBe("g1");
  });

  it("rejects empty queries before issuing a request", async () => {
    const browserFetch = vi.fn();
    vi.stubGlobal("fetch", browserFetch);
    const client = new SemanticSearchClient("http://127.0.0.1:8765");
    await expect(client.search("p1", "   ")).rejects.toThrow("输入要搜索的画面、对白或场记内容");
    expect(browserFetch).not.toHaveBeenCalled();
  });
});
