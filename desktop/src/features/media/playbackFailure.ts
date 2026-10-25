// 媒体播放失败的共享分类：video.error 本身分不清 HTTP 404（素材缺失）和解码失败
// （Chromium 都报 code 4），三个现有失败文案也各自为政。这里用一次 1 字节 Range
// 探测把失败分成三种可行动的原因；只在 video 报错后调用一次，不进正常读路径。
export type PlaybackFailureKind = "missing" | "decode" | "network";

export interface PlaybackFailure {
  kind: PlaybackFailureKind;
  title: string;
  detail: string;
}

export const PLAYBACK_FAILURES: Record<PlaybackFailureKind, PlaybackFailure> = {
  missing: {
    kind: "missing",
    title: "素材缺失",
    detail: "素材盘可能未挂载，或文件已被移动。重新挂载后重试；仍未恢复时到素材·恢复重新绑定。",
  },
  decode: {
    kind: "decode",
    title: "解码失败",
    detail: "素材已定位，但当前 WebView 无法解码这个编码格式。可导出到外部 NLE 继续，或先在本机播放器确认原片。",
  },
  network: {
    kind: "network",
    title: "连接失败",
    detail: "无法连接本机 Host 服务。确认镜序桌面应用仍在运行后重试。",
  },
};

export async function classifyPlaybackFailure(url: string): Promise<PlaybackFailure> {
  try {
    const response = await fetch(url, { headers: { Range: "bytes=0-1" }, cache: "no-store" });
    if (response.ok) return PLAYBACK_FAILURES.decode;
    return response.status === 404 || response.status === 410 || response.status === 403
      ? PLAYBACK_FAILURES.missing
      : PLAYBACK_FAILURES.network;
  } catch {
    return PLAYBACK_FAILURES.network;
  }
}
