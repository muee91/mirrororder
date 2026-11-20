import type { CSSProperties } from "react";

export type StudioIconName =
  | "back"
  | "library"
  | "search"
  | "sparkle"
  | "team"
  | "tools"
  | "activity"
  | "settings"
  | "folder"
  | "file"
  | "film"
  | "sync-task"
  | "sync-inspect"
  | "sync-delivery"
  | "slate"
  | "script"
  | "identity"
  | "media-library"
  | "media-binding"
  | "watch"
  | "timeline"
  | "takes";

interface Props {
  name: StudioIconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
}

const ICON_PATHS: Record<StudioIconName, readonly string[]> = {
  back: ["M15 18l-6-6 6-6"],
  library: ["M3.5 6.5a2 2 0 0 1 2-2h4.2l1.8 2H18.5a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"],
  search: ["M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z", "M21 21l-4.35-4.35"],
  sparkle: [
    "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z",
    "M18.5 16l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8z",
  ],
  team: [
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2",
    "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
    "M22 21v-2a4 4 0 0 0-3-3.87",
    "M16 3.13a4 4 0 0 1 0 7.75",
  ],
  tools: [
    "M4 7h4m4 0h8",
    "M10 7a2 2 0 1 0 0 .01",
    "M4 17h10m4 0h2",
    "M16 17a2 2 0 1 0 0 .01",
    "M4 12h8m4 0h4",
    "M14 12a2 2 0 1 0 0 .01",
  ],
  activity: ["M3 12h4l2.5-6.5L14.5 18l2.5-6h4"],
  settings: [
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.85 1 1.51 1H21a2 2 0 1 1 0 4h-.09c-.66 0-1.25.4-1.51 1z",
  ],
  folder: ["M3.5 6.5a2 2 0 0 1 2-2h4.2l1.8 2H18.5a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"],
  file: [
    "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z",
    "M14 2v6h6",
    "M8 13h8",
    "M8 17h5",
  ],
  film: [
    "M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13z",
    "M8 4v16",
    "M16 4v16",
    "M4 9h4",
    "M4 15h4",
    "M16 9h4",
    "M16 15h4",
  ],
  "sync-task": [
    "M21 12a9 9 0 0 0-15.5-6.3L3 8",
    "M3 3v5h5",
    "M3 12a9 9 0 0 0 15.5 6.3L21 16",
    "M16 16h5v5",
  ],
  "sync-inspect": [
    "M3.5 5.5A1.5 1.5 0 0 1 5 4h5.5v7H3.5z",
    "M13.5 4H19a1.5 1.5 0 0 1 1.5 1.5V11h-7z",
    "M3.5 14h17v4.5A1.5 1.5 0 0 1 19 20H5a1.5 1.5 0 0 1-1.5-1.5z",
    "M10 17h4",
  ],
  "sync-delivery": [
    "M12 3v12",
    "M7 8l5-5 5 5",
    "M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15",
  ],
  slate: [
    "M4 9h16v10.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19.5V9z",
    "M4 9L5.4 4.7A1.2 1.2 0 0 1 6.5 4h11a1.2 1.2 0 0 1 1.1.7L20 9",
    "M8.5 4l-1.5 5",
    "M14.5 4l-1.5 5",
    "M8 14h8",
  ],
  script: [
    "M6 3.5h9l4 4V20a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 20V5A1.5 1.5 0 0 1 6 3.5z",
    "M14.5 3.5V8H19",
    "M8.5 12h7",
    "M8.5 16h5",
  ],
  identity: [
    "M12 12a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z",
    "M5.5 19.5a6.5 6.5 0 0 1 13 0",
    "M4 7V5a1 1 0 0 1 1-1h2",
    "M20 7V5a1 1 0 0 0-1-1h-2",
  ],
  "media-library": [
    "M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13z",
    "M10 9.5l5 2.5-5 2.5v-5z",
  ],
  "media-binding": [
    "M4 14.5A1.5 1.5 0 0 1 5.5 13h13a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-4z",
    "M4.6 13.5l2-6.2A1.5 1.5 0 0 1 8 6.2h8a1.5 1.5 0 0 1 1.4 1.1l2 6.2",
    "M15.5 16.5h.01",
  ],
  watch: [
    "M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12z",
    "M12 14.8a2.8 2.8 0 1 0 0-5.6 2.8 2.8 0 0 0 0 5.6z",
  ],
  timeline: [
    "M3 7h8",
    "M14 7h7",
    "M3 12h13",
    "M19 12h2",
    "M3 17h5",
    "M11 17h10",
    "M11 4v16",
  ],
  takes: [
    "M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13z",
    "M10 9.5l5 2.5-5 2.5v-5z",
  ],
};

export function StudioIcon({ name, size = 14, className, style }: Props) {
  const paths = ICON_PATHS[name] ?? ICON_PATHS.film;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.65}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ? `mo-studio-icon ${className}` : "mo-studio-icon"}
      style={style}
      aria-hidden="true"
    >
      {paths.map((d, index) => (
        <path key={index} d={d} />
      ))}
    </svg>
  );
}
