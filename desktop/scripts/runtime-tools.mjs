import crypto from "node:crypto";
import fs from "node:fs";

export const NONFREE_CONFIGURATION_FLAG = "--enable-nonfree";

// Distribution hygiene. A previous release bundle shipped the build machine's
// `multicam-audio-sync/scripts/config.json` (absolute volume paths plus a real project
// name) and ~5,000 `.pyc` files, because staging copied directories without exclusions
// and the bundle gate only inspected Mach-O dependencies. These predicates are shared by
// the stager and the bundle gate so the same rule cannot drift between them.
export const BUNDLE_JUNK_PATH_PATTERNS = [
  /(?:^|\/)multicam-audio-sync\/scripts\/config\.json$/,
  /(?:^|\/)__pycache__(?:\/|$)/,
  /\.py[cod]$/,
  /(?:^|\/)\._[^/]+$/,
  /(?:^|\/)\.DS_Store$/,
];

// Volume and home paths routinely contain spaces ("TESTVOL", "交付"), so the tail class
// stops on JSON/prose delimiters rather than whitespace; otherwise the detector would only
// report "/Volumes/PSSD" and could be evaded by any path with a space in it.
const HOST_PATH_TAIL = '[^"\'`,]*';

export const HOST_PATH_PATTERNS = [
  new RegExp(`/Volumes/${HOST_PATH_TAIL}`, "g"),
  new RegExp(`/Users/${HOST_PATH_TAIL}`, "g"),
  new RegExp(`\\b[A-Za-z]:[\\\\/]${HOST_PATH_TAIL}`, "g"),
];

export function isBundleJunkPath(candidate) {
  const normalized = String(candidate).replaceAll("\\", "/");
  return BUNDLE_JUNK_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function findHostPathsInText(text) {
  const hits = [];
  for (const line of String(text).split("\n")) {
    for (const pattern of HOST_PATH_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of line.matchAll(pattern)) {
        const value = match[0].trimEnd();
        if (value) hits.push(value);
      }
    }
  }
  return hits;
}

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be explicit and non-empty`);
  }
  return value.trim();
}

export function parseToolVersionOutput(toolName, output) {
  const name = requireText(toolName, "tool name");
  const raw = requireText(output, `${name} -version output`);
  const lines = raw.split(/\r?\n/);
  const version = lines.find((line) => line.startsWith(`${name} version `))?.trim();
  const configurationLine = lines.find((line) => line.startsWith("configuration:"))?.trim();
  if (!version) throw new Error(`${name} -version output has no version line`);
  if (!configurationLine) throw new Error(`${name} -version output has no configuration line`);
  const configuration = configurationLine.slice("configuration:".length).trim();
  if (configuration.includes(NONFREE_CONFIGURATION_FLAG)) {
    throw new Error(`${name} configuration contains forbidden ${NONFREE_CONFIGURATION_FLAG}`);
  }
  return {
    version,
    configuration,
    version_output: raw,
  };
}

export function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function buildToolMetadata({ toolName, output, filePath, source, licenseClassification }) {
  const parsed = parseToolVersionOutput(toolName, output);
  return {
    ...parsed,
    sha256: sha256File(filePath),
    source: requireText(source, "media tools source/provenance"),
    license_classification: requireText(licenseClassification, "media tools license classification"),
    redistributable: true,
  };
}

export function assertManifestToolMatches(toolName, manifestEntry, actual) {
  if (!manifestEntry || typeof manifestEntry !== "object") {
    throw new Error(`runtime manifest has no ${toolName} metadata`);
  }
  for (const field of ["version", "configuration", "version_output", "sha256"]) {
    if (manifestEntry[field] !== actual[field]) {
      throw new Error(`${toolName} ${field} does not match the final bundled binary`);
    }
  }
  if (manifestEntry.redistributable !== true) {
    throw new Error(`${toolName} is not marked redistributable`);
  }
}
