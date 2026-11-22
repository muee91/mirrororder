import { memo, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref } from "react";
import type { SlateRecord, SlateStatus } from "../../api/production";
import { SlateStatusIndicator } from "../../components/StatusIndicators";
import "./slate-row.css";

export const SLATE_CAMERA_COLUMNS = ["A", "B", "C", "AUX"] as const;
export type SlateCameraColumn = string;

export const SLATE_COLUMN_KEYS = [
  "index",
  "episode",
  "scene",
  "shot",
  "take",
  "camera-A",
  "camera-B",
  "camera-C",
  "camera-AUX",
  "status",
  "note",
] as const;

export const SLATE_STATUS_OPTIONS: ReadonlyArray<{ value: SlateStatus; label: string }> = [
  { value: "unmarked", label: "待定" },
  { value: "usable", label: "可用" },
  { value: "partial", label: "部分可用" },
  { value: "ng", label: "NG" },
];

export type SlateRowPatch = Partial<Pick<SlateRecord, "episode" | "scene" | "shot" | "take_number" | "status" | "note">>;

export interface SlateRowModel {
  recordId: string;
  rowNumber: number;
  selected: boolean;
  dirty: boolean;
  derivedSource: string;
  episode: number | null;
  scene: string;
  mappedScenePlaceholder: string;
  shot: string;
  takeNumber: number | null;
  status: SlateStatus;
  note: string;
}

export interface SlateRowProps {
  row: SlateRowModel;
  rowRef?: Ref<HTMLTableRowElement>;
  onSelect: () => void;
  onEditStart?: () => void;
  onEditEnd?: () => void;
  onPatch: (patch: SlateRowPatch) => void;
  onQuickParse?: (text: string) => void | Promise<void>;
  cameraColumns?: readonly SlateCameraColumn[];
  renderMedia: (camera: SlateCameraColumn) => ReactNode;
}

function stopRowSelection(event: { stopPropagation: () => void }): void {
  event.stopPropagation();
}

function columnKeys(cameraColumns: readonly SlateCameraColumn[]): string {
  return [...SLATE_COLUMN_KEYS.slice(0, 5), ...cameraColumns.map((c) => `camera-${c}`), "status", "note"].join(" ");
}

const RESIZABLE_COLUMN_BOUNDS: Record<string, readonly [number, number]> = {
  scene: [56, 220],
  shot: [56, 220],
  status: [96, 180],
  note: [180, 560],
};

function columnBounds(key: string): readonly [number, number] | null {
  if (key.startsWith("camera-")) return [188, 320];
  return RESIZABLE_COLUMN_BOUNDS[key] ?? null;
}

function columnLabel(key: string, camera?: SlateCameraColumn): string {
  if (camera) return camera === "AUX" ? "辅助 / 特殊" : `${camera} 机`;
  return { scene: "场号", shot: "镜号", status: "状态", note: "备注" }[key] ?? key;
}

export interface SlateTableHeadProps {
  cameraColumns?: readonly SlateCameraColumn[];
  columnWidths?: Record<string, number>;
  onResizeColumn?: (columnKey: string, width: number) => void;
  onResetColumnWidth?: (columnKey: string) => void;
}

export function SlateTableHead({ cameraColumns = SLATE_CAMERA_COLUMNS, columnWidths, onResizeColumn, onResetColumnWidth }: SlateTableHeadProps = {}) {
  const resizeColumn = (event: ReactPointerEvent<HTMLSpanElement>, key: string): void => {
    event.preventDefault();
    event.stopPropagation();
    const header = event.currentTarget.parentElement;
    const bounds = columnBounds(key);
    if (!header || !bounds) return;
    const startWidth = header.getBoundingClientRect().width;
    const startX = event.clientX;
    const move = (moveEvent: PointerEvent) => {
      const width = Math.min(bounds[1], Math.max(bounds[0], Math.round(startWidth + moveEvent.clientX - startX)));
      onResizeColumn?.(key, width);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    window.addEventListener("pointercancel", stop, { once: true });
  };

  const header = (key: string, className: string, label: string, camera?: SlateCameraColumn) => {
    const resizable = Boolean(columnBounds(key));
    return (
      <th className={className} key={key} style={columnWidths?.[key] ? { width: columnWidths[key] } : undefined}>
        {label}
        {resizable ? <span
          className="slate-col-resizer"
          role="separator"
          aria-hidden="true"
          aria-orientation="vertical"
          aria-label={`调整${columnLabel(key, camera)}列宽`}
          onDoubleClick={(event) => { event.stopPropagation(); onResetColumnWidth?.(key); }}
          onPointerDown={(event) => resizeColumn(event, key)}
        /> : null}
      </th>
    );
  };

  return (
    <tr data-slate-columns={columnKeys(cameraColumns)}>
      <th className="col-index">序号</th>
      <th className="col-number">集</th>
      {header("scene", "col-text", "场号")}
      {header("shot", "col-text", "镜号")}
      <th className="col-number">次号</th>
      {cameraColumns.map((camera) => header(`camera-${camera}`, "col-media", columnLabel(`camera-${camera}`, camera), camera))}
      {header("status", "col-status", "状态")}
      {header("note", "col-note", "备注")}
    </tr>
  );
}

export function looksLikeQuickSlateCommand(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  return [
    /\bep\s*\d+\b/i,
    /第\s*\d+\s*集/,
    /\d+\s*集/,
    /\d+[a-z]?\s*场/i,
    /\d+[a-z]?\s*镜/i,
    /\bT\s*\d+\b/i,
    /第\s*\d+\s*[条次]/,
    /\d+\s*[条次]/,
    /\b\d+-\d+(?:-\d+)?\b/,
    /(?:^|[\s,，/])(?:[A-Z]\s*机?\s*(?:大远景|全景|中近景|中景|近景|大特写|特写|插入|全|中|近|特)|(?:大远景|全景|中近景|中景|近景|大特写|特写|插入镜头))/i,
    /(?:^|[\s,，/])(?:可用|部分可用|部分|NG|误录|待定)(?=$|[\s,，/])/i,
    /(?:同上|同场|下一条)/,
  ].some((pattern) => pattern.test(value));
}

export const SlateRow = memo(function SlateRow({ row, rowRef, onSelect, onPatch, onQuickParse, renderMedia, onEditStart, onEditEnd, cameraColumns = SLATE_CAMERA_COLUMNS }: SlateRowProps) {
  return (
    <tr
      ref={rowRef}
      className={`slate-row ${row.selected ? "is-selected" : ""} ${row.dirty ? "is-dirty" : ""} ${row.status === "ng" ? "is-ng" : ""}`}
      data-slate-columns={columnKeys(cameraColumns)}
      data-record-id={row.recordId}
      onFocusCapture={(event) => {
        if (event.target instanceof HTMLInputElement) onEditStart?.();
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onEditEnd?.();
      }}
      onKeyDownCapture={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing && event.target instanceof HTMLInputElement && !event.target.closest(".col-note")) {
          event.preventDefault();
          event.target.blur();
        }
      }}
      tabIndex={0}
      aria-current={row.selected ? "true" : undefined}
      onClick={onSelect}
      onKeyDown={onSelect ? (event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onSelect();
      } : undefined}
    >
      <td className="col-index">
        <strong>{String(row.rowNumber).padStart(3, "0")}</strong>
        {row.derivedSource ? <small className="derived-source">{row.derivedSource}</small> : row.dirty ? <small>未保存</small> : null}
      </td>
      <td className="col-number">
        <input
          type="number"
          min={1}
          value={row.episode ?? ""}
          onClick={stopRowSelection}
          onChange={(event) => onPatch({ episode: event.target.value ? Number(event.target.value) : null })}
        />
      </td>
      <td className="col-text">
        <input
          value={row.scene}
          placeholder={row.mappedScenePlaceholder}
          title={row.mappedScenePlaceholder ? `剧本场景 ${row.mappedScenePlaceholder}` : undefined}
          onClick={stopRowSelection}
          onChange={(event) => onPatch({ scene: event.target.value })}
        />
      </td>
      <td className="col-text">
        <input value={row.shot} onClick={stopRowSelection} onChange={(event) => onPatch({ shot: event.target.value })} />
      </td>
      <td className="col-number">
        <input
          type="number"
          min={1}
          value={row.takeNumber ?? ""}
          onClick={stopRowSelection}
          onChange={(event) => onPatch({ take_number: event.target.value ? Number(event.target.value) : null })}
        />
      </td>
      {cameraColumns.map((camera) => (
        <td className="col-media" key={camera} onClick={stopRowSelection}>{renderMedia(camera)}</td>
      ))}
      <td className="col-status">
        <label className="golden-status-control" onClick={stopRowSelection}>
          <SlateStatusIndicator state={row.status} />
          <select value={row.status} aria-label={`第 ${row.rowNumber} 条状态`} onChange={(event) => onPatch({ status: event.target.value as SlateStatus })}>
            {SLATE_STATUS_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
          </select>
        </label>
      </td>
      <td className="col-note">
        <input
          type="text"
          value={row.note}
          aria-label={`第 ${row.rowNumber} 条备注与快录`}
          placeholder="备注 / EP3 12场 B近 可用 ↵"
          onClick={stopRowSelection}
          onChange={(event) => onPatch({ note: event.target.value })}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            event.stopPropagation();
            if (onQuickParse && looksLikeQuickSlateCommand(row.note)) void onQuickParse(row.note);
            event.currentTarget.blur();
          }}
        />
      </td>
    </tr>
  );
});
