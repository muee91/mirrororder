import crypto from "node:crypto";
import fs from "node:fs";

export const NONFREE_CONFIGURATION_FLAG = "--enable-nonfree";

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
