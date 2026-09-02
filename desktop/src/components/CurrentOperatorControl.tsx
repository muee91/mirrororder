import { useEffect, useId, useState } from "react";
import "./current-operator.css";

const OPERATOR_KEYS = [
  "mirrororder.productionActor",
  // Compatibility with the previous Media Library key while surfaces migrate.
  "mirrororder.desktop-v2.review-actor",
] as const;

export function readCurrentOperator(): string {
  try {
    for (const key of OPERATOR_KEYS) {
      const value = globalThis.localStorage?.getItem(key)?.trim();
      if (value) return value;
    }
  } catch {
    // Device-local convenience must not block the production app.
  }
  return "";
}

export function writeCurrentOperator(value: string): string {
  const next = value.trim().slice(0, 40);
  try {
    for (const key of OPERATOR_KEYS) globalThis.localStorage?.setItem(key, next);
    globalThis.dispatchEvent(new CustomEvent("mirrororder:operator-change", { detail: next }));
  } catch {
    // Keep the current session usable even if storage is unavailable.
  }
  return next;
}

interface Props {
  onChange?: (operator: string) => void;
}

export function CurrentOperatorControl({ onChange }: Props) {
  const inputId = useId();
  const [operator, setOperator] = useState(readCurrentOperator);
  const [draft, setDraft] = useState(operator);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const sync = (event: Event) => {
      const next = event instanceof CustomEvent && typeof event.detail === "string" ? event.detail : readCurrentOperator();
      setOperator(next);
      setDraft(next);
    };
    globalThis.addEventListener("mirrororder:operator-change", sync);
    globalThis.addEventListener("storage", sync);
    return () => {
      globalThis.removeEventListener("mirrororder:operator-change", sync);
      globalThis.removeEventListener("storage", sync);
    };
  }, []);

  function commit(): void {
    const next = writeCurrentOperator(draft);
    setOperator(next);
    setDraft(next);
    setOpen(false);
    onChange?.(next);
  }

  return (
    <div className="current-operator-control">
      <button
        type="button"
        className={`current-operator-chip ${operator ? "has-operator" : "needs-operator"}`}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className="current-operator-avatar" aria-hidden="true">{operator ? operator.slice(0, 1).toUpperCase() : "?"}</span>
        <span className="current-operator-copy"><small>当前操作者</small><strong>{operator || "未设置"}</strong></span>
        <span className="current-operator-chevron" aria-hidden="true">⌄</span>
      </button>
      {open ? (
        <div className="current-operator-popover" role="dialog" aria-label="当前操作者">
          <header><strong>当前操作者</strong><span>用于场记、归集和素材人工修改的审计记录。</span></header>
          <label htmlFor={inputId}><span>昵称</span><input id={inputId} autoFocus maxLength={40} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commit(); } if (event.key === "Escape") setOpen(false); }} placeholder="例如：大王" /></label>
          <div className="current-operator-actions"><button type="button" className="secondary" onClick={() => { setDraft(operator); setOpen(false); }}>取消</button><button type="button" disabled={!draft.trim()} onClick={commit}>使用此身份</button></div>
        </div>
      ) : null}
    </div>
  );
}
