import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: vi.fn(() => true),
}));
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn(),
}));

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { DeliveryClient } from "./delivery";
import type { TimelineSnapshot } from "./timeline";

const mockedFetch = vi.mocked(tauriFetch);

function snapshot(projectId = "p1"): TimelineSnapshot {
  return {
    project: {
      version: 1,
      project_id: projectId,
      sources: [{ source_id: "source:a", clip_id: "a", media_id: "ma", name: "A.mov", duration_frames: 240 }],
      multicam_groups: [],
      sequences: [{
        sequence_id: "main",
        name: "Main",
        frame_rate: { numerator: 24, denominator: 1 },
        tracks: [{ track_id: "V1", kind: "video", clips: [] }],
        markers: [],
        transitions: [],
      }],
      active_sequence_id: "main",
    },
    undo_depth: 4,
    redo_depth: 1,
    validation: [],
    authority: { generation: "g-final", revision: 12 },
  };
}

describe("DeliveryClient timeline delivery", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it("posts only the immutable Rust Timeline project and authority token", async () => {
    const current = snapshot();
    mockedFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      contract: "timeline_delivery_export.v1",
      report: {
        contract: "timeline_delivery_report.v1",
        organized_fcpxml: "/tmp/timeline_organized.fcpxml",
        timeline_authority: current.authority,
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } }) as never);

    const payload = await new DeliveryClient("http://127.0.0.1:8765").exportTimeline("p1", current);
    expect(payload.report.timeline_authority).toEqual(current.authority);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockedFetch.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8765/api/v1/projects/p1/timeline-delivery-export");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      contract: "timeline_delivery_request.v1",
      timeline: current.project,
      authority: current.authority,
    });
    expect(String(init?.body)).not.toContain("undo_depth");
    expect(String(init?.body)).not.toContain("redo_depth");
    expect(String(init?.body)).not.toContain("validation");
  });

  it("rejects a cross-project snapshot before making a Host request", async () => {
    const client = new DeliveryClient("http://127.0.0.1:8765");
    await expect(client.exportTimeline("p1", snapshot("p2"))).rejects.toThrow("snapshot project_id 与当前项目不一致");
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});
