export async function verifyReviewQueueNavigation(page, { timeout = 10000 } = {}) {
  await page.waitForSelector(".review-queue", { timeout });
  const queued = await page.locator('.review-queue [data-ui-authority="take-compact"]').count();
  if (queued < 1) throw new Error("审阅队列为空，无法看片");

  async function selection(expectedPosition) {
    try {
      await page.waitForFunction(expected => {
        const navigation = document.querySelector(".review-transport-actions > span")?.textContent?.match(/(\d+)\s*\/\s*(\d+)/);
        const current = document.querySelector('.review-queue [data-take-state="current"] .mo-take-list-heading strong')?.textContent;
        const viewer = document.querySelector(".review-viewer-pane .inspector-heading h3")?.textContent;
        return navigation && (!expected || Number(navigation[1]) === expected) && current && current === viewer;
      }, expectedPosition, { timeout });
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
    await page.locator(".review-queue .take-virtual-scroll").press("Home");
    positions[0] = (await selection(1)).position;
  }
  for (let index = 0; index < transitions; index += 1) {
    await page.getByRole("button", { name: "下一个", exact: true }).click({ timeout });
    positions.push((await selection(positions.at(-1) + 1)).position);
  }
  if (initial.total === 1 && !(await page.getByRole("button", { name: "下一个", exact: true }).isDisabled())) {
    throw new Error("单 Take 队列的下一个按钮应禁用");
  }
  return { rendered_rows: queued, total: initial.total, positions };
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
      if (video?.error) return { failure: `媒体解码错误 ${video.error.code}`, duration: video.duration };
      if (video && video.readyState >= 1) return { failure: "", duration: video.duration };
      return false;
    }, undefined, { timeout });
    state = await handle.jsonValue();
  } catch {
    throw new Error("审阅媒体加载超时，未取得 metadata");
  }
  if (!state || typeof state !== "object") throw new Error("审阅媒体加载超时，未取得 metadata");
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
