import type { ReactNode } from "react";
import type { SlateRecord, SlateStatus } from "../../api/production";
import { SlateStatusIndicator } from "../../components/StatusIndicators";

export const SLATE_CAMERA_COLUMNS = ["A", "B", "C", "AUX"] as const;
export type SlateCameraColumn = typeof SLATE_CAMERA_COLUMNS[number];

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
  onPatch: (patch: SlateRowPatch) => void;
  renderMedia: (camera: SlateCameraColumn) => ReactNode;
}

function stopRowSelection(event: { stopPropagation: () => void }): void {
  event.stopPropagation();
}

export function SlateTableHead() {
  return (
    <tr data-slate-columns={SLATE_COLUMN_KEYS.join(" ")}>
      <th className="col-index">序号</th>
      <th className="col-number">集</th>
      <th className="col-text">场号</th>
      <th className="col-text">镜号</th>
      <th className="col-number">次号</th>
      <th className="col-media">A 机</th>
      <th className="col-media">B 机</th>
      <th className="col-media">C 机</th>
      <th className="col-media">辅助 / 特殊</th>
      <th className="col-status">状态</th>
    </tr>
  );
}

export function SlateRow({ row, onSelect, onPatch, renderMedia }: SlateRowProps) {
  return (
    <tr
      className={`${row.selected ? "is-selected" : ""} ${row.dirty ? "is-dirty" : ""}`}
      data-slate-columns={SLATE_COLUMN_KEYS.join(" ")}
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
      {SLATE_CAMERA_COLUMNS.map((camera) => <td className="col-media" key={camera}>{renderMedia(camera)}</td>)}
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
