import { useEffect } from "react";

export type SlatePlaybackKey = "j" | "k" | "l" | " ";

export async function applySlatePlaybackKey(video: HTMLVideoElement, key: SlatePlaybackKey): Promise<void> {
  if (key === " ") {
    if (video.paused) await video.play();
    else video.pause();
    return;
  }
  if (key === "k") {
    video.pause();
    return;
  }
  if (key === "l") {
    video.playbackRate = 1;
    await video.play();
    return;
  }
  // Browser video elements do not provide reliable negative playbackRate across
  // the supported Desktop webviews. J is therefore an explicit one-second
  // backward shuttle step, not fake reverse playback.
  video.pause();
  video.currentTime = Math.max(0, video.currentTime - 1);
}

function activeSlateVideo(): HTMLVideoElement | null {
  return document.querySelector<HTMLVideoElement>(".golden-slate-player video");
}

export function SlatePlaybackShortcuts() {
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=true]")) return;
      const key = event.key === " " ? " " : event.key.toLowerCase();
      if (key !== "j" && key !== "k" && key !== "l" && key !== " ") return;
      const video = activeSlateVideo();
      if (!video) return;
      event.preventDefault();
      void applySlatePlaybackKey(video, key).catch(() => undefined);
    };
    globalThis.addEventListener("keydown", keydown);
    return () => globalThis.removeEventListener("keydown", keydown);
  }, []);

  // Space: play/pause. J: step backward one second. K: pause. L: play.
  // Keep the professional transport keys without a permanent teaching badge
  // over the production canvas; the frozen Swift workbench did not show one.
  return null;
}
