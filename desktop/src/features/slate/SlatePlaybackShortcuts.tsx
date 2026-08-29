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

  return (
    <div className="slate-playback-shortcut-hint" aria-label="场记播放快捷键">
      Space 播放/暂停 · J 后退 1 秒 · K 暂停 · L 播放
    </div>
  );
}
