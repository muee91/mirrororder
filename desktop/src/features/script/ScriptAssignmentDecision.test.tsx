// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostConnectionError } from "../../api/host";
import { EditorialClient, type EditorialStorePayload, type EditorialWriteResponse } from "../../api/planning";
import { ScriptAssignmentDecision } from "./ScriptAssignmentDecision";

function editorial(revision = 4, state?: "best" | "keep" | "reject"): EditorialStorePayload {
  return {
    version: 2,
    revision,
    updated_at: "2026-11-11T00:00:00Z",
    opinions: {},
    decisions: state ? {
      "assignment|seg-1|group-1": {
        target: { kind: "assignment", group_id: "group-1", segment_id: "seg-1" },
        state,
        actor: "Editor",
        updated_at: "2026-11-11T00:00:00Z",
      },
    } : {},
  };
}

function response(next: EditorialStorePayload): EditorialWriteResponse {
  return {
    editorial: next,
    group: {
      revision: next.revision,
      opinions: { group: [], assignments: [] },
      decision: { group: null, assignments: [] },
    },
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("ScriptAssignmentDecision", () => {
  let root: Root;
  let host: HTMLDivElement;
  let status: ReturnType<typeof vi.spyOn>;
  let decision: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    status = vi.spyOn(EditorialClient.prototype, "status");
    decision = vi.spyOn(EditorialClient.prototype, "decision");
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it("reads and writes a revision-safe assignment decision in the script context", async () => {
    const initial = editorial();
    const saved = editorial(5, "best");
    status.mockResolvedValue(initial);
    decision.mockResolvedValue(response(saved));

    await act(async () => {
      root.render(<ScriptAssignmentDecision baseUrl="http://127.0.0.1:8765" projectId="p1" groupId="group-1" segmentId="seg-1" actor="Editor" />);
    });
    await settle();
    expect(host.textContent).toContain("当前 Take 尚未形成剧本段最终决定");

    const best = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Best");
    expect(best).toBeTruthy();
    await act(async () => best?.click());
    await settle();

    expect(decision).toHaveBeenCalledWith("p1", {
      targetKind: "assignment",
      groupId: "group-1",
      segmentId: "seg-1",
      state: "best",
      actor: "Editor",
      expectedRevision: 4,
    });
    expect(host.textContent).toContain("剧本段最终：Best");
    expect(host.textContent).toContain("当前剧本段最终 Best");
  });

  it("refreshes after a revision conflict instead of retrying the stale write", async () => {
    status.mockResolvedValueOnce(editorial(4)).mockResolvedValueOnce(editorial(5, "keep"));
    decision.mockRejectedValue(new HostConnectionError("editorial revision 已变化", { status: 409 }));

    await act(async () => {
      root.render(<ScriptAssignmentDecision baseUrl="http://127.0.0.1:8765" projectId="p1" groupId="group-1" segmentId="seg-1" actor="Editor" />);
    });
    await settle();
    const reject = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Reject");
    await act(async () => reject?.click());
    await settle();

    expect(decision).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("已读取最新状态，请重新确认");
    expect(host.textContent).toContain("当前剧本段最终 Keep");
  });
});
