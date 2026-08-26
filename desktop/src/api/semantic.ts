import { isTauri } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { HostConnectionError } from "./host";

export interface SemanticSearchResult {
  document_id: string;
  group_id: string;
  clip_id: string;
  media_id: string;
  source: "visual" | "speech" | "slate" | string;
  source_label: string;
  score: number;
  vector_similarity: number | null;
  keyword_rank: number | null;
  vector_rank: number | null;
  start: number;
  end: number;
  snippet: string;
  metadata: Record<string, unknown>;
}

export interface SemanticSearchPayload {
  contract: "semantic_search.v1" | string;
  query: string;
  mode: string;
  results: SemanticSearchResult[];
  summary: {
    returned?: number;
    documents?: number;
    vectors?: number;
    sources?: Record<string, number>;
    fts?: boolean;
    vector_available?: boolean;
    [key: string]: unknown;
  };
  semantics: Record<string, boolean>;
}

async function transportFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return isTauri() ? tauriFetch(input, init) : globalThis.fetch(input, init);
}

export class SemanticSearchClient {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(this.baseUrl)) throw new HostConnectionError("项目搜索 Host 地址无效");
  }

  async search(projectId: string, query: string, options?: { limit?: number; sources?: string[] }): Promise<SemanticSearchPayload> {
    const project = projectId.trim();
    const text = query.trim();
    if (!project) throw new HostConnectionError("项目搜索需要 project_id");
    if (!text) throw new HostConnectionError("输入要搜索的画面、对白或场记内容");
    const params = new URLSearchParams({ q: text, limit: String(Math.max(1, Math.min(60, options?.limit ?? 16))) });
    if (options?.sources?.length) params.set("sources", options.sources.join(","));
    const response = await transportFetch(`${this.baseUrl}/api/v1/projects/${encodeURIComponent(project)}/semantic-search?${params.toString()}`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`.trim();
      try {
        const payload = await response.json() as { error?: string };
        message = payload.error || message;
      } catch {
        // Keep HTTP fallback.
      }
      throw new HostConnectionError(message, { status: response.status });
    }
    return await response.json() as SemanticSearchPayload;
  }
}
