import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
// ponytail: character count approximates token size; tune against real PR token usage if needed.
const MAX_DIFF_CHARS = 30_000;

export async function prepareState(task: string, baseRef: string, repo = process.cwd()) {
  const git = async (...args: string[]) => (await exec("git", args, {
    cwd: repo, maxBuffer: 10 * 1024 * 1024, timeout: 30_000,
  })).stdout;
  const [baseSha, headSha] = await Promise.all([
    git("rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`).then(s => s.trim()),
    git("rev-parse", "--verify", "HEAD").then(s => s.trim()),
  ]);
  const mergeBase = (await git("merge-base", baseSha, headSha)).trim();
  const diffArgs = ["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none"];
  const [names, diffStat, diff, numstat] = await Promise.all([
    git(...diffArgs, "--name-only", "-z", mergeBase, headSha, "--"),
    git(...diffArgs, "--stat", mergeBase, headSha, "--"),
    git(...diffArgs, "--unified=3", mergeBase, headSha, "--"),
    git(...diffArgs, "--numstat", mergeBase, headSha, "--"),
  ]);
  const changedFiles = names.split("\0").filter(Boolean);
  if (!changedFiles.length) throw new Error("No committed changes against the base. Commit your change or choose an earlier --base.");
  return {
    task, baseRef, baseSha, headSha, mergeBase, changedFiles,
    diffStat: diffStat.trim(), diff: diff.slice(0, MAX_DIFF_CHARS),
    truncated: diff.length > MAX_DIFF_CHARS,
    opaqueChanges: /^-\t-\t/m.test(numstat) || /^[-+]?Subproject commit /m.test(diff),
  };
}

export type ReviewState = Awaited<ReturnType<typeof prepareState>>;

export async function readBaseFile(baseSha: string, path: string, repo = process.cwd()) {
  return (await exec("git", ["show", `${baseSha}:${path}`], {
    cwd: repo, maxBuffer: 1024 * 1024, timeout: 30_000,
  })).stdout;
}
