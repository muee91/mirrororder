import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildToolMetadata, parseToolVersionOutput } from "./runtime-tools.mjs";

const legalOutput = [
  "ffmpeg version 8.1.2 Copyright (c) 2000-2026 the FFmpeg developers",
  "built with Apple clang 21.0.0",
  "configuration: --enable-gpl --enable-version3 --enable-libx264",
].join("\n");

test("rejects an FFmpeg configuration containing --enable-nonfree", () => {
  assert.throws(
    () => parseToolVersionOutput("ffmpeg", legalOutput.replace("--enable-gpl", "--enable-nonfree --enable-gpl")),
    /forbidden --enable-nonfree/,
  );
});

test("accepts a legal configuration and preserves the complete version output", () => {
  assert.deepEqual(parseToolVersionOutput("ffmpeg", legalOutput), {
    version: "ffmpeg version 8.1.2 Copyright (c) 2000-2026 the FFmpeg developers",
    configuration: "--enable-gpl --enable-version3 --enable-libx264",
    version_output: legalOutput,
  });
});

test("requires provenance and license classification while recording the binary SHA", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mirrororder-runtime-tools-"));
  const binary = path.join(tempRoot, "ffmpeg");
  fs.writeFileSync(binary, "fixture");
  assert.throws(
    () => buildToolMetadata({ toolName: "ffmpeg", output: legalOutput, filePath: binary, source: "", licenseClassification: "GPL-3.0-or-later" }),
    /source\/provenance/,
  );
  const metadata = buildToolMetadata({
    toolName: "ffmpeg",
    output: legalOutput,
    filePath: binary,
    source: "https://formulae.brew.sh/formula/ffmpeg",
    licenseClassification: "GPL-3.0-or-later",
  });
  assert.match(metadata.sha256, /^[0-9a-f]{64}$/);
  assert.equal(metadata.redistributable, true);
});
