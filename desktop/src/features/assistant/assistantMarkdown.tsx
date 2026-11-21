import type { AssistantEvidenceItem } from "../../api/production";

function inlineMarkdown(text: string) {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((part, index) => {
    if (index % 2 === 0) return part;
    if (part.startsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    return <strong key={index}>{inlineMarkdown(part.slice(2, -2))}</strong>;
  });
}

export function AnswerMarkdown({ text }: { text: string }) {
  const blocks: { kind: "paragraph" | "ul" | "ol"; lines: string[]; start?: number }[] = [];
  let block: (typeof blocks)[number] | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      block = undefined;
      continue;
    }
    const bullet = /^\s*[-+*]\s+(.+)$/.exec(line);
    const numbered = /^\s*(\d+)[.)]\s+(.+)$/.exec(line);
    const kind = bullet ? "ul" : numbered ? "ol" : "paragraph";
    if (!block || block.kind !== kind) {
      block = { kind, lines: [], start: numbered ? Number(numbered[1]) : undefined };
      blocks.push(block);
    }
    block.lines.push(bullet?.[1] ?? numbered?.[2] ?? line);
  }
  return <div className="assistant-markdown">{blocks.map(({ kind, lines, start }, index) => {
    if (kind === "paragraph") return <p key={index}>{inlineMarkdown(lines.join("\n"))}</p>;
    const List = kind;
    return <List key={index} start={start}>{lines.map((line, i) => <li key={i}>{inlineMarkdown(line)}</li>)}</List>;
  })}</div>;
}

export function formatEvidenceTime(seconds: number): string {
  const tenths = Math.round((Number.isFinite(seconds) ? Math.max(0, seconds) : 0) * 10);
  const minutes = String(Math.floor(tenths / 600)).padStart(2, "0");
  const withinMinute = (tenths % 600 / 10).toFixed(1).padStart(4, "0");
  return `${minutes}:${withinMinute}`;
}

export function evidenceTitle(row: AssistantEvidenceItem): string {
  return row.metadata?.take_label || row.metadata?.file_name || (row.group_id ? `Take ${row.group_id}` : "独立证据");
}
