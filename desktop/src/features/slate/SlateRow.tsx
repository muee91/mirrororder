import type { ReactNode } from "react";
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
] as const;

export const SLATE_STATUS_OPTIONS: ReadonlyArray<{ value: SlateStatus; label: string }> = [
  { value: "unmarked", label: "待定" },
  { value: "usable", label: "可用" },
  { value: "partial", label: "部分可用" },
  { value: "ng", label: "NG" },
];

export type SlateRowPatch = Partial<Pick<SlateRecord, "episode" | "scene" | "shot" | "take_number" | "status">>;

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
}

interface SlateRowProps {
  row: SlateRowModel;
  onSelect: () => void;
  onEditStart?: () => void;
  onEditEnd?: () => void;
  onPatch: (patch: SlateRowPatch) => void;
  cameraColumns?: readonly SlateCameraColumn[];
  renderMedia: (camera: SlateCameraColumn) => ReactNode;
}

function stopRowSelection(event: { stopPropagation: () => void }): void {
  event.stopPropagation();
}

function columnKeys(cameraColumns: readonly SlateCameraColumn[]): string {
  return [...SLATE_COLUMN_KEYS.slice(0, 5), ...cameraColumns.map((camera) => `camera-${camera}`), "status"].join(" ");
}
export function SlateTableHead({ cameraColumns = SLATE_CAMERA_COLUMNS }: { cameraColumns?: readonly SlateCameraColumn[] } = {}) {
  return (
    <tr data-slate-columns={columnKeys(cameraColumns)}>
      <th className="col-index">序号</th>
      <th className="col-number">集</th>
      <th className="col-text">场号</th>
      <th className="col-text">镜号</th>
      <th className="col-number">次号</th>
      {cameraColumns.map((camera) => <th className="col-media" key={camera}>{camera === "AUX" ? "辅助 / 特殊" : `${camera} 机`}</th>)}
      <th className="col-status">状态</th>
    </tr>
  );
}

export function SlateRow({ row, onSelect, onPatch, renderMedia, onEditStart, onEditEnd, cameraColumns = SLATE_CAMERA_COLUMNS }: SlateRowProps) {
  return (
    <tr
      className={`slate-row ${row.selected ? "is-selected" : ""} ${row.dirty ? "is-dirty" : ""}`}
      data-slate-columns={columnKeys(cameraColumns)}
      data-record-id={row.recordId}
      onFocusCapture={(event) => {
        if (event.target instanceof HTMLInputElement) onEditStart?.();
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onEditEnd?.();
      }}
      onKeyDownCapture={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing && event.target instanceof HTMLInputElement) {
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
      {cameraColumns.map((camera) => <td className="col-media" key={camera}>{renderMedia(camera)}</td>)}
      <td className="col-status">
        <label className="golden-status-control" onClick={stopRowSelection}>
          <SlateStatusIndicator state={row.status} />
          <select value={row.status} aria-label={`第 ${row.rowNumber} 条状态`} onChange={(event) => onPatch({ status: event.target.value as SlateStatus })}>
            {SLATE_STATUS_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
          </select>
        </label>
      </td>
    </tr>
  );
}
