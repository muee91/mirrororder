import type { SlateAttachment } from "../../api/production";
import { cameraPresentation } from "../media/cameraPresentation";

export function SlateInspectorClipHeader({ camera, filename, hidden }: {
  camera: string;
  filename: string;
  hidden: boolean;
}) {
  const source = cameraPresentation(camera);
  return <header className="golden-inspector-clip-head" hidden={hidden}>
    <span className="mo-media-camera-badge" data-camera-tone={source.tone}>{source.label}</span>
    <h3>{filename || "素材"}</h3>
  </header>;
}

export function SlateInspectorSources({ attachments, selected, preferred, onSelect, selectedCamera }: {
  attachments: readonly SlateAttachment[];
  selected: string;
  preferred: string;
  onSelect: (key: string) => void;
  selectedCamera?: string;
}) {
  const currentCamera = selectedCamera === undefined ? null : cameraPresentation(selectedCamera);
  const sources = attachments.map((clip) => ({ clip, camera: cameraPresentation(clip.camera) }))
    .filter(({ camera }) => !currentCamera || (currentCamera.key && camera.key === currentCamera.key))
    .sort((a, b) => a.camera.sortOrder - b.camera.sortOrder);
  if (!sources.length || (currentCamera && sources.length < 2)) return null;
  const totals = new Map<string, number>();
  const positions = new Map<string, number>();
  for (const { camera } of sources) totals.set(camera.label, (totals.get(camera.label) ?? 0) + 1);

  return (
    <div className="golden-inspector-sources" role="group" aria-label={currentCamera ? "同机位素材" : "机位素材"}>
      {sources.map(({ clip, camera }) => {
        const key = clip.clip_id || clip.media_id;
        const position = (positions.get(camera.label) ?? 0) + 1;
        positions.set(camera.label, position);
        const label = (totals.get(camera.label) ?? 0) > 1 ? `${camera.label} ${position}` : camera.label;
        const name = clip.display_name || label;
        return <button type="button" key={key} data-camera-tone={camera.tone}
          className="golden-inspector-source" aria-pressed={key === selected} aria-label={`选择 ${label} · ${name}`}
          title={name} onClick={() => onSelect(key)}>
          <span className="golden-inspector-camera-dot" aria-hidden="true" />
          {label}
          {key === preferred ? <span aria-label="场记首选">★</span> : null}
        </button>;
      })}
    </div>
  );
}
