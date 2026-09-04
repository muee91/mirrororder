import { useEffect, useState } from "react";
import type { IdentityRow } from "../../api/production";

export function identityKindLabel(row: IdentityRow): string {
  return row.kind === "speaker" ? "声纹" : "人物";
}

export function identityTitle(row: IdentityRow, index: number): string {
  return row.role_name || row.label || `未命名${identityKindLabel(row)} ${String(index + 1).padStart(2, "0")}`;
}

export function confidenceLabel(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function hasFaceCrop(row: IdentityRow): boolean {
  return row.kind === "face" && row.example?.portrait_available === true;
}

function portraitUrl(baseUrl: string, projectId: string, identityId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/v1/projects/${encodeURIComponent(projectId)}/identities/${encodeURIComponent(identityId)}/portrait`;
}

export function IdentityPortrait({
  baseUrl,
  projectId,
  row,
  large = false,
  eager = false,
  title,
}: {
  baseUrl: string;
  projectId: string;
  row: IdentityRow;
  large?: boolean;
  eager?: boolean;
  title: string;
}) {
  const [failed, setFailed] = useState(false);
  const available = hasFaceCrop(row) && !failed;

  useEffect(() => {
    setFailed(false);
  }, [row.identity_id, row.updated_at]);

  return (
    <span className={`identity-portrait ${large ? "is-large" : ""} is-${row.kind}`}>
      {available ? (
        <img
          src={portraitUrl(baseUrl, projectId, row.identity_id)}
          alt={`${title} 人脸样本`}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : (
        <span aria-hidden="true">{row.kind === "speaker" ? "声" : "人"}</span>
      )}
    </span>
  );
}

interface IdentityRowProps {
  baseUrl: string;
  projectId: string;
  row: IdentityRow;
  index: number;
  selected: boolean;
  onSelect: () => void;
}

export function IdentityCandidateRow({ baseUrl, projectId, row, index, selected, onSelect }: IdentityRowProps) {
  const title = identityTitle(row, index);
  return (
    <button
      type="button"
      className={`identity-row identity-candidate-row ${selected ? "is-selected" : ""}`}
      data-authority="candidate"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`${title} · 待人工确认`}
    >
      <IdentityPortrait baseUrl={baseUrl} projectId={projectId} row={row} title={title} />
      <span className="identity-row-copy">
        <strong>{title}</strong>
        <small>{row.suggested_role_name ? `系统建议：${row.suggested_role_name}` : "待人工确认"}</small>
      </span>
      <span className="identity-row-meta">
        <strong>{row.take_count} 个 Take</strong>
        <small>证据匹配 {confidenceLabel(row.average_confidence)}</small>
      </span>
    </button>
  );
}

export function PersonRow({ baseUrl, projectId, row, index, selected, onSelect }: IdentityRowProps) {
  const title = identityTitle(row, index);
  return (
    <button
      type="button"
      className={`identity-row person-row ${selected ? "is-selected" : ""}`}
      data-authority="human"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`${title} · 已人工确认`}
    >
      <IdentityPortrait baseUrl={baseUrl} projectId={projectId} row={row} title={title} />
      <span className="identity-row-copy">
        <strong>{title}</strong>
        <small>人工确认 · {identityKindLabel(row)}</small>
      </span>
      <span className="identity-row-meta">
        <strong>{row.take_count} 个 Take</strong>
        <small>人工事实</small>
      </span>
    </button>
  );
}
