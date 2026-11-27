import type { ReviewScriptBlock } from "../../api/host";

function dialogueCharacters(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

export function spokenScriptText(text: string): string {
  return text.replace(/[（(][^()（）]*[)）]|【[^【】]*】/gu, "").trim();
}

export function scriptSpeechClauses(block: ReviewScriptBlock | undefined): string[] {
  if (!block || (block.type !== "dialogue" && block.type !== "narration")) return [];
  const normalizedSpeaker = spokenScriptText(block.speaker).normalize("NFKC");
  return spokenScriptText(block.text).normalize("NFKC").split(/[。！？；!?;\n]/).map(part => {
    const line = part.trim();
    return dialogueCharacters(normalizedSpeaker && line.startsWith(`${normalizedSpeaker}:`)
      ? line.slice(normalizedSpeaker.length + 1) : line);
  }).filter(part => part.length >= 2);
}

export function matchesScriptSpeech(text: string, clauses: readonly string[]): boolean {
  const heard = dialogueCharacters(text);
  return clauses.some(clause => clause.length < 3 ? heard === clause : heard.includes(clause));
}
