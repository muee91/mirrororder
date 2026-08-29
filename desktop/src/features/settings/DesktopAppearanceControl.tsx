import { useEffect, useState } from "react";
import {
  desktopAppearanceEventName,
  readDesktopAppearance,
  saveDesktopAppearance,
  type DesktopAppearance,
} from "../../app/desktopAppearance";
import "./desktop-appearance.css";

const OPTIONS: Array<{ value: DesktopAppearance; label: string }> = [
  { value: "system", label: "系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

export function DesktopAppearanceControl() {
  const [appearance, setAppearance] = useState<DesktopAppearance>(() => readDesktopAppearance());

  useEffect(() => {
    const sync = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : null;
      setAppearance(detail === "light" || detail === "dark" ? detail : "system");
    };
    globalThis.addEventListener(desktopAppearanceEventName(), sync);
    return () => globalThis.removeEventListener(desktopAppearanceEventName(), sync);
  }, []);

  function choose(next: DesktopAppearance): void {
    setAppearance(saveDesktopAppearance(next));
  }

  return (
    <div className="desktop-appearance-control" aria-label="Desktop 外观">
      <span>外观</span>
      <div role="group" aria-label="Desktop 外观模式">
        {OPTIONS.map((option) => (
          <button
            type="button"
            className={appearance === option.value ? "is-active" : ""}
            aria-pressed={appearance === option.value}
            key={option.value}
            onClick={() => choose(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
