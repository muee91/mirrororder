import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildToolMetadata, findHostPathsInText, isBundleJunkPath, parseToolVersionOutput } from "./runtime-tools.mjs";

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

test("rejects per-machine and generated files inside a distribution bundle", () => {
  // The exact shapes a previous release bundle shipped.
  for (const leaked of [
    "/app/Contents/Resources/mirrororder-core/vendor/multicam-audio-sync/scripts/config.json",
    "/app/Contents/Resources/mirrororder-python/lib/python3.11/site-packages/numpy/__pycache__/core.cpython-311.pyc",
    "/app/Contents/Resources/mirrororder-core/src/script_organizer/web_server.pyc",
    "/app/Contents/Resources/mirrororder-core/._project.toml",
    "/app/Contents/Resources/mirrororder-tools/.DS_Store",
  ]) {
    assert.equal(isBundleJunkPath(leaked), true, `must reject ${leaked}`);
  }
  // Real runtime inputs must stay.
  for (const required of [
    "/app/Contents/Resources/mirrororder-core/src/script_organizer/web_server.py",
    "/app/Contents/Resources/mirrororder-core/vendor/multicam-audio-sync/scripts/sync.py",
    "/app/Contents/Resources/mirrororder-core/vendor/multicam-audio-sync/scripts/project_config.py",
    "/app/Contents/Resources/mirrororder-runtime/mirrororder-runtime-manifest.json",
    "/app/Contents/Resources/mirrororder-tools/bin/ffmpeg",
  ]) {
    assert.equal(isBundleJunkPath(required), false, `must keep ${required}`);
  }
});

test("finds host absolute paths in bundle data files but not portable ones", () => {
  const leaked = String.raw`{"BASE": "/Volumes/TESTVOL", "OUT": "/Users/editor/out", "ROOT": "D:\交付"}`;
  const hits = findHostPathsInText(leaked);
  assert.deepEqual(hits.slice(0, 2), ["/Volumes/TESTVOL", "/Users/editor/out"]);
  assert.ok(hits.some((hit) => hit.startsWith("D:")), "a Windows drive path must be caught too");
  assert.deepEqual(findHostPathsInText('{"root": "projects/beef", "src": "media/a.mov"}'), []);
});
