import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function sourceRevision() {
  const cwd = fileURLToPath(new URL("../../", import.meta.url));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    const commit = git("rev-parse", "--short=12", "HEAD");
    return git("status", "--porcelain", "--untracked-files=normal") ? `${commit}+dirty` : commit;
  } catch {
    return "";
  }
}
