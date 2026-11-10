// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from "vitest";
import { HostConnectionError } from "../../api/host";
import { EditorialClient, type EditorialStorePayload, type EditorialWriteResponse } from "../../api/planning";
import { ReviewDecisionPanel } from "./ReviewDecisionPanel";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function snapshot(revision: number, groupId = "g1", state?: string): EditorialStorePayload {
  return {
    version: 1, revision, updated_at: "",
    opinions: {},
    decisions: state ? {
      [`group|${groupId}`]: {
        target: { kind: "group", group_id: groupId, segment_id: "" },
        state, actor: `决定人 ${revision}`, updated_at: "",
      },
    } : {},
  };
}

function writeResponse(editorial: EditorialStorePayload): EditorialWriteResponse {
  return {
    editorial,
    group: { revision: editorial.revision, opinions: { group: [], assignments: [] }, decision: { group: null, assignments: [] } },
  };
}

describe("ReviewDecisionPanel authority recovery", () => {
  let container: HTMLDivElement;
  let root: Root;
  let status: MockInstance<EditorialClient["status"]>;
  let decision: MockInstance<EditorialClient["decision"]>;
  let onDecisionChange: Mock<() => Promise<void>>;

  beforeEach(() => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.setItem("mirrororder.desktop-v2.review-actor", "剪辑师");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    status = vi.spyOn(EditorialClient.prototype, "status");
    decision = vi.spyOn(EditorialClient.prototype, "decision");
    onDecisionChange = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  async function render(props: { baseUrl?: string; projectId?: string; groupId?: string } = {}) {
    await act(async () => {
      root.render(<ReviewDecisionPanel baseUrl="http://host.test" projectId="p1" groupId="g1" onDecisionChange={onDecisionChange} {...props} />);
    });
  }

  function button(label: string): HTMLButtonElement {
    const found = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
    expect(found, `button ${label}`).toBeTruthy();
    return found!;
  }

  async function click(label: string) {
    await act(async () => button(label).click());
  }

  it("shows a recoverable read failure without claiming there is no decision", async () => {
    status.mockRejectedValueOnce(new Error("连接中断")).mockResolvedValueOnce(snapshot(3, "g1", "keep"));
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("连接中断");
    expect(container.textContent).not.toContain("尚未形成最终决定");
    expect(button("Best").disabled).toBe(true);
    await click("重新读取状态");
    expect(button("Keep").className).toContain("is-selected");
    expect(button("Best").disabled).toBe(false);
    expect(decision).not.toHaveBeenCalled();
  });

  it.each([
    { groupId: "g2" },
    { projectId: "p2" },
    { baseUrl: "http://other-host.test" },
  ])("isolates late reads when the current context changes to %j", async (nextProps) => {
    const oldRead = deferred<EditorialStorePayload>();
    const newRead = deferred<EditorialStorePayload>();
    status.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);
    await render();
    await render(nextProps);
    expect(button("Best").disabled).toBe(true);
    await act(async () => newRead.resolve(snapshot(8, nextProps.groupId ?? "g1", "keep")));
    await act(async () => oldRead.resolve(snapshot(2, "g1", "reject")));
    expect(button("Keep").className).toContain("is-selected");
    expect(container.textContent).not.toContain("决定人 2");
    decision.mockResolvedValueOnce(writeResponse(snapshot(9, nextProps.groupId ?? "g1", "best")));
    await click("Best");
    expect(decision).toHaveBeenCalledWith(nextProps.projectId ?? "p1", expect.objectContaining({
      groupId: nextProps.groupId ?? "g1", expectedRevision: 8, state: "best",
    }));
  });

  it("drops a loaded previous snapshot immediately while the next Take is loading", async () => {
    const nextRead = deferred<EditorialStorePayload>();
    status.mockResolvedValueOnce(snapshot(4, "g1", "reject")).mockReturnValueOnce(nextRead.promise);
    await render();
    expect(button("Reject").className).toContain("is-selected");
    await render({ groupId: "g2" });
    expect(button("Best").disabled).toBe(true);
    expect(container.textContent).not.toContain("决定人 4");
    expect(container.textContent).not.toContain("尚未形成最终决定");
    await act(async () => nextRead.reject(new Error("断线")));
    expect(button("Best").disabled).toBe(true);
    expect(decision).not.toHaveBeenCalled();
  });

  it.each(["success", "conflict"])("ignores a late %s from a write on a Take that has been left", async (outcome) => {
    const oldWrite = deferred<EditorialWriteResponse>();
    status.mockResolvedValueOnce(snapshot(1)).mockResolvedValueOnce(snapshot(5, "g2", "keep"));
    decision.mockReturnValueOnce(oldWrite.promise);
    await render();
    await click("Best");
    await render({ groupId: "g2" });
    await act(async () => {
      if (outcome === "success") oldWrite.resolve(writeResponse(snapshot(2, "g1", "best")));
      else oldWrite.reject(new HostConnectionError("conflict", { status: 409 }));
    });
    expect(button("Keep").className).toContain("is-selected");
    expect(container.textContent).not.toContain("当前 Take 最终：Best");
    expect(status).toHaveBeenCalledTimes(2);
    expect(onDecisionChange).toHaveBeenCalledTimes(outcome === "success" ? 1 : 0);
    expect(button("Best").disabled).toBe(false);
  });

  it("does not refresh another project when a departed project's write succeeds", async () => {
    const oldWrite = deferred<EditorialWriteResponse>();
    status.mockResolvedValueOnce(snapshot(1)).mockResolvedValueOnce(snapshot(9, "g1", "keep"));
    decision.mockReturnValueOnce(oldWrite.promise);
    await render();
    await click("Best");
    await render({ projectId: "p2" });
    await act(async () => oldWrite.resolve(writeResponse(snapshot(2, "g1", "best"))));
    expect(button("Keep").className).toContain("is-selected");
    expect(onDecisionChange).not.toHaveBeenCalled();
  });

  it("ignores a conflict recovery read completed after switching projects", async () => {
    const recovery = deferred<EditorialStorePayload>();
    status.mockResolvedValueOnce(snapshot(1)).mockReturnValueOnce(recovery.promise)
      .mockResolvedValueOnce(snapshot(9, "g1", "keep"));
    decision.mockRejectedValueOnce(new HostConnectionError("conflict", { status: 409 }));
    await render();
    await click("Best");
    await render({ projectId: "p2" });
    await act(async () => recovery.resolve(snapshot(5, "g1", "reject")));
    expect(button("Keep").className).toContain("is-selected");
    expect(container.textContent).not.toContain("决定人 5");
    expect(onDecisionChange).not.toHaveBeenCalled();
  });

  it("blocks duplicate clicks before React renders the pending write", async () => {
    const pending = deferred<EditorialWriteResponse>();
    status.mockResolvedValueOnce(snapshot(3));
    decision.mockReturnValueOnce(pending.promise);
    await render();
    act(() => {
      button("Best").click();
      button("Reject").click();
    });
    expect(decision).toHaveBeenCalledTimes(1);
    expect(button("Best").disabled).toBe(true);
    await act(async () => pending.resolve(writeResponse(snapshot(4, "g1", "best"))));
    expect(button("Best").className).toContain("is-selected");
    expect(onDecisionChange).toHaveBeenCalledTimes(1);
  });

  it("requires fresh confirmation after a conflict, using the new revision", async () => {
    const latest = deferred<EditorialStorePayload>();
    status.mockResolvedValueOnce(snapshot(1)).mockReturnValueOnce(latest.promise);
    decision.mockRejectedValueOnce(new HostConnectionError("conflict", { status: 409 }))
      .mockResolvedValueOnce(writeResponse(snapshot(5, "g1", "best")));
    await render();
    await click("Best");
    expect(button("Best").disabled).toBe(true);
    await act(async () => latest.resolve(snapshot(4, "g1", "reject")));
    expect(button("Reject").className).toContain("is-selected");
    expect(container.textContent).toContain("原操作未重试");
    expect(decision).toHaveBeenCalledTimes(1);
    await click("Best");
    expect(decision).toHaveBeenLastCalledWith("p1", expect.objectContaining({ expectedRevision: 4, state: "best" }));
  });

  it("keeps decisions blocked when a conflict reload fails, with an explicit read-only retry", async () => {
    status.mockResolvedValueOnce(snapshot(1)).mockRejectedValueOnce(new Error("团队服务断线"))
      .mockResolvedValueOnce(snapshot(7, "g1", "keep"));
    decision.mockRejectedValueOnce(new HostConnectionError("conflict", { status: 409 }));
    await render();
    await click("Best");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("最新状态读取失败");
    expect(container.textContent).not.toContain("已读取最新团队状态");
    expect(button("Best").disabled).toBe(true);
    await click("重新读取状态");
    expect(button("Keep").className).toContain("is-selected");
    expect(decision).toHaveBeenCalledTimes(1);
    expect(onDecisionChange).toHaveBeenCalledTimes(1);
  });

  it("reconciles an uncertain write by reading authority, never automatically resubmitting", async () => {
    status.mockResolvedValueOnce(snapshot(1)).mockResolvedValueOnce(snapshot(2, "g1", "best"));
    decision.mockRejectedValueOnce(new Error("请求超时"));
    await render();
    await click("Best");
    expect(container.textContent).toContain("无法确认本次决定是否保存");
    expect(button("Best").disabled).toBe(true);
    await click("重新读取状态");
    expect(button("Best").className).toContain("is-selected");
    expect(decision).toHaveBeenCalledTimes(1);
    expect(onDecisionChange).toHaveBeenCalledTimes(1);
  });

  it("does not turn a successful decision into a failure when the parent refresh rejects", async () => {
    status.mockResolvedValueOnce(snapshot(1));
    decision.mockResolvedValueOnce(writeResponse(snapshot(2, "g1", "keep")));
    onDecisionChange.mockRejectedValueOnce(new Error("queue unavailable"));
    await render();
    await click("Keep");
    expect(container.textContent).toContain("当前 Take 最终：Keep");
    expect(button("Keep").className).toContain("is-selected");
    expect(button("Best").disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
