export async function verifyReviewQueueNavigation(page, { timeout = 10000 } = {}) {
  await page.waitForFunction(
    () => Boolean(document.querySelector(".review-queue, .review-empty-state")),
    undefined,
    { timeout },
  );
  const queued = await page.locator(".review-queue .review-take-card").count();
  if (queued < 1) throw new Error("审阅队列为空，无法看片");
  const anglesByPosition = await page.evaluate(async () => {
    const project = new URL(location.href).searchParams.get("project_id") || "project";
    const response = await fetch(`/api/v1/projects/${encodeURIComponent(project)}/review-model`);
    if (!response.ok) throw new Error("读取审阅验收数据失败");
    return (await response.json()).take_groups.map(take => take.angles.map(({ clip_id, name }) => ({ clip_id, name })));
  });

  async function selection(expectedPosition) {
    try {
      await page.waitForFunction(({ expected, angles }) => {
        const navigation = document.querySelector(".review-transport-actions > span")?.textContent?.match(/(\d+)\s*\/\s*(\d+)/);
        if (!navigation) return false;
        const position = Number(navigation[1]);
        const current = document.querySelector(`.review-queue [data-queue-index="${position - 1}"]`);
        const viewer = document.querySelector(".review-monitor-heading h3")?.textContent;
        const clip = document.querySelector(".review-viewer-pane .take-player")?.dataset.clipId;
        return (!expected || position === expected) && current?.getAttribute("aria-pressed") === "true"
          && angles[position - 1]?.some(angle => angle.name === viewer && (!clip || angle.clip_id === clip));
      }, { expected: expectedPosition, angles: anglesByPosition }, { timeout });
    } catch {
      throw new Error("当前 Take 未切换，或队列选择与 Viewer 不一致");
    }
    const text = await page.locator(".review-transport-actions > span").innerText();
    const [, position, total] = text.match(/(\d+)\s*\/\s*(\d+)/);
    return { position: Number(position), total: Number(total) };
  }

  const initial = await selection();
  const positions = [initial.position];
  // A single-Take project is valid; verify as many real transitions as its queue permits.
  const transitions = Math.min(2, initial.total - 1);
  if (initial.total > 1 && initial.position + transitions > initial.total) {
    await page.locator(".review-queue .review-take-select").first().click({ timeout });
    positions[0] = (await selection(1)).position;
  }
  for (let index = 0; index < transitions; index += 1) {
    await page.getByRole("button", { name: "下一条", exact: true }).click({ timeout });
    positions.push((await selection(positions.at(-1) + 1)).position);
  }
  if (initial.total === 1 && !(await page.getByRole("button", { name: "下一条", exact: true }).isDisabled())) {
    throw new Error("单 Take 队列的下一条按钮应禁用");
  }
  return { rendered_rows: queued, total: initial.total, positions };
}

// Chromium reports an HTTP 404 from a video source as MEDIA_ERR_SRC_NOT_SUPPORTED
// (code 4) on Linux. Keep that browser detail out of the UX contract: the Review
// surface already uses “素材无法读取” for any media playback failure.
export function formatPlaybackFailure(errorCode) {
  return Number(errorCode) === 4 ? "素材无法读取" : `媒体解码错误 ${errorCode}`;
}

export async function verifyReviewPlayback(page, { timeout = 15000 } = {}) {
  // Sample the load outcome atomically: resolving the wait and then re-reading
  // the DOM in a second round trip races a React remount after a media error
  // (the fresh <video> has no error yet, so a 404 can read back as "duration
  // 无效"). waitForFunction returns the payload from the exact poll that matched.
  let state;
  try {
    const handle = await page.waitForFunction(() => {
      const failure = document.querySelector(".review-viewer-pane .player-empty");
      const video = document.querySelector(".review-viewer-pane video.take-player");
      if (failure) return { failure: failure.textContent?.trim() || "", duration: video?.duration };
      if (video?.error) return { error_code: video.error.code, duration: video.duration };
      if (video && video.readyState >= 1) return { failure: "", duration: video.duration };
      return false;
    }, undefined, { timeout });
    state = await handle.jsonValue();
  } catch {
    throw new Error("审阅媒体加载超时，未取得 metadata");
  }
  if (!state || typeof state !== "object") throw new Error("审阅媒体加载超时，未取得 metadata");
  if (state.error_code !== undefined) state.failure = formatPlaybackFailure(state.error_code);
  if (state.failure) throw new Error(`审阅媒体不可播放：${state.failure}`);
  if (!Number.isFinite(state.duration) || state.duration <= 0) throw new Error("审阅媒体 duration 无效");

  const start = await page.locator(".review-viewer-pane video.take-player").evaluate(async (video, timeoutMs) => {
    // Muting the automated probe permits browser playback; sound/native A/V sync need their own acceptance.
    video.muted = true;
    const startTime = video.currentTime;
    let timer;
    try {
      await Promise.race([
        video.play(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("审阅媒体启动播放超时")), timeoutMs); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    return startTime;
  }, timeout);
  try {
    await page.waitForFunction(startTime => {
      const video = document.querySelector(".review-viewer-pane video.take-player");
      return video && !video.error && video.readyState >= 2 && video.currentTime > startTime + 0.05;
    }, start, { timeout });
  } catch {
    throw new Error("审阅媒体播放时间未推进");
  }
  return page.locator(".review-viewer-pane video.take-player").evaluate(video => {
    video.pause();
    return { duration: video.duration, current_time: video.currentTime, ready_state: video.readyState, muted_probe: true };
  });
}
