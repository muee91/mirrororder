const baseUrl = (process.env.MIRRORORDER_HOST_URL || process.argv[2] || "http://127.0.0.1:8765").replace(/\/+$/, "");

async function readJson(path) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`.trim();
    try {
      const payload = await response.json();
      if (payload && typeof payload.error === "string") detail = payload.error;
    } catch {
      // Keep the stable HTTP status fallback.
    }
    throw new Error(`${path}: ${detail}`);
  }
  return response.json();
}

const ping = await readJson("/api/v1/ping");
if (ping?.status !== "ok") {
  throw new Error(`ping status is ${String(ping?.status)}`);
}

const workspace = await readJson("/api/v1/workspace");
if (workspace?.api_version !== "v1") {
  throw new Error(`unexpected workspace api_version: ${String(workspace?.api_version)}`);
}
if (!Array.isArray(workspace?.projects)) {
  throw new Error("workspace response does not contain a projects array");
}

console.log(
  `Host smoke OK · ${ping.service} · ${workspace.workspace || workspace.workspace_id} · ${workspace.projects.length} project(s)`,
);
