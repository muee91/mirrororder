import { expect, it } from "vitest";
import type { SyncRecordingPlacement } from "../../api/syncTimeline";
import { recordingForMasterFrame, recordingKey, recordingSecondsAtMasterFrame, shouldSeekRecording } from "./syncRecordingClock";

const rows: SyncRecordingPlacement[] = [
  { media_id: "wav-a", name: "A.wav", at: 25, source: 50, frames: 50 },
  { media_id: "wav-b", name: "B.wav", at: 75, source: 0, frames: 50 },
];

it("maps delivered master frames into source WAV seconds with no cross-file extrapolation", () => {
  const rate = { numerator: 25, denominator: 1 };
  expect(recordingSecondsAtMasterFrame(rows[0], 25, rate)).toBe(2);
  expect(recordingSecondsAtMasterFrame(rows[0], 50, rate)).toBe(3);
  expect(recordingSecondsAtMasterFrame(rows[0], 24, rate)).toBeNull();
  expect(recordingSecondsAtMasterFrame(rows[0], 75, rate)).toBeNull();
  expect(recordingSecondsAtMasterFrame(rows[0], 50, null)).toBeNull();
  expect(recordingSecondsAtMasterFrame(rows[0], 50, { numerator: 0, denominator: 1 })).toBeNull();
  expect(recordingSecondsAtMasterFrame(rows[1], 100, { numerator: 30000, denominator: 1001 }))
    .toBeCloseTo(25 * 1001 / 30000);
});

it("preserves manual choice in solo mode and follows the recording active on the master", () => {
  const key = recordingKey(rows[0]);
  expect(recordingForMasterFrame(rows, 90, key, false)?.media_id).toBe("wav-a");
  expect(recordingForMasterFrame(rows, 90, key, true)?.media_id).toBe("wav-b");
  expect(recordingForMasterFrame(rows, 40, key, true)?.media_id).toBe("wav-a");
  expect(recordingForMasterFrame([], 40, "", true)).toBeNull();
});

it("keeps paused seek exact without scrubbing a playing element on every frame", () => {
  expect(shouldSeekRecording(2, 2.04, false)).toBe(true);
  expect(shouldSeekRecording(2, 2.04, true)).toBe(false);
  expect(shouldSeekRecording(2, 2.2, true)).toBe(true);
});
