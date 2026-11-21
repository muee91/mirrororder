import type { AssistantDiagnosis, AssistantEvidenceItem } from "../../api/production";
import { formatEvidenceTime } from "./assistantMarkdown";

const SOURCE_LABELS: Record<string, string> = {
  visual: "画面",
  speech: "对白",
  slate: "场记",
  file: "文件名",
  script: "剧本",
};

export const DIAGNOSTIC_LABELS: Record<AssistantDiagnosis["destination"], string> = {
  "sync-task": "查看同步任务",
  "media-binding": "检查本机素材",
  "sync-delivery": "查看工程交付",
};

const FALLBACK_HINTS: Record<string, string> = {
  http_401: "模型连接认证失败",
  http_403: "模型连接权限不足",
  timeout: "模型响应超时",
  local_model_not_downloaded: "本地模型尚未下载",
  local_server_unavailable: "本地模型服务暂不可用",
  network_error: "模型连接中断",
  invalid_json: "模型回答格式不受支持",
  invalid_response: "模型回应无法读取",
  empty_response: "模型未返回回答",
};

export const SELECTION_CUE = /(这条|这组|当前镜头|当前片段|这个片段|这镜|当前\s*take|这一条|这一组)/i;
export const PROJECT_PROMPTS = ["项目现在还有哪些缺口和待处理？", "帮我找特写片段", "列出场记标了 NG 或部分可用的镜头"];
export const SELECTION_PROMPT = "这条素材的依据和问题是什么？";

export function diagnosticPage(page?: string | null): AssistantDiagnosis["destination"] | undefined {
  return page && Object.hasOwn(DIAGNOSTIC_LABELS, page) ? page as AssistantDiagnosis["destination"] : undefined;
}

export function assistantFallbackHint(reason = ""): string {
  if (Object.hasOwn(FALLBACK_HINTS, reason)) return FALLBACK_HINTS[reason];
  return /^http_\d{3}$/.test(reason) ? "模型服务暂不可用" : "";
}

export function assistantAnswerMode(mode?: string): string {
  return mode === "diagnosis" ? "同步诊断" : mode === "llm" ? "AI 管家" : "离线直检";
}

export function evidenceSourceLabel(row: AssistantEvidenceItem): string {
  const source = row.source ?? "";
  return row.source_label || (Object.hasOwn(SOURCE_LABELS, source) ? SOURCE_LABELS[source] : "证据");
}

export function evidenceTimeRange(start: number, end?: number): string {
  return end !== undefined && end > start
    ? `${formatEvidenceTime(start)} – ${formatEvidenceTime(end)}`
    : formatEvidenceTime(start);
}

export function evidenceHitTime(row: AssistantEvidenceItem): string {
  const start = Number.isFinite(row.start) ? row.start! : 0;
  const end = Number.isFinite(row.end) ? row.end! : start;
  return end > start || row.source === "speech" ? evidenceTimeRange(start, end) : "";
}

export function itemKindLabel(value?: string): string {
  switch (value) {
    case "decision": return "需要判断";
    case "production": return "制作提醒";
    case "people": return "人物线索";
    case "attention": return "需要留意";
    default: return "项目事项";
  }
}
