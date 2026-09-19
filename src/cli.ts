#!/usr/bin/env bun
import { appendFile, readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { prepareState, readBaseFile } from "./git";
import { assessReview, evaluateReview, isRisk, reviewRequest, validateThresholds } from "./jev";

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    base: { type: "string", default: "origin/main" },
    repo: { type: "string", default: process.cwd() },
    task: { type: "string" },
    "task-file": { type: "string" },
    "max-risk": { type: "string", default: "20" },
    thresholds: { type: "string", default: "{}" },
    policy: { type: "string", default: "" },
    json: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    enforce: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  } });
  if (values.help) {
    console.log("Usage: bun run triage --task <description> [--base origin/main] [--repo path]\n  --task-file path     Append task text from a file\n  --policy path        Complete question thresholds from the base commit\n  --max-risk 20        Default per-question threshold, 0–100 (experimental)\n  --thresholds JSON    Per-question threshold overrides\n  --json              Full report including native SDK results\n  --dry-run           Print the state and questions passed to the SDK\n  --enforce           Exit 2 for human_review; default is advisory");
    return;
  }
  const task = [values.task, values["task-file"] ? await readFile(values["task-file"], "utf8") : ""].filter(Boolean).join("\n\n").trim();
  if (!task) throw new Error("Provide --task and/or --task-file");
  const maxRisk = values["max-risk"].trim() ? Number(values["max-risk"]) : NaN;
  if (!isRisk(maxRisk)) throw new Error("max-risk must be a number from 0 to 100");
  const state = await prepareState(task, values.base, values.repo);
  if (values.policy && (values["max-risk"] !== "20" || values.thresholds !== "{}")) {
    throw new Error("Use --policy alone, without --max-risk or --thresholds overrides");
  }
  const policy = values.policy
    ? validateThresholds(JSON.parse(await readBaseFile(state.baseSha, values.policy, values.repo)), true)
    : undefined;
  const thresholds = policy ?? validateThresholds(JSON.parse(values.thresholds));
  if (values["dry-run"]) {
    console.log(JSON.stringify(reviewRequest(state), null, 2));
    return;
  }
  if (!state.truncated && !state.opaqueChanges && !process.env.TYPESAFE_API_KEY?.trim()) throw new Error("Set TYPESAFE_API_KEY in .env (see .env.example)");
  const result = state.truncated || state.opaqueChanges ? undefined : await evaluateReview(state);
  const assessment = assessReview(state, result, maxRisk, thresholds);
  const report = { mode: values.enforce ? "enforce" : "advisory", ...state, ...assessment, result };
  const triage = {
    decision: assessment.decision, headSha: state.headSha, baseSha: state.baseSha,
    riskScore: assessment.riskScore, reasons: assessment.reasons, signals: assessment.signals,
  };
  console.log(values.json ? JSON.stringify(report, null, 2) : [
    `Jev: ${assessment.decision} | ${assessment.riskScore === null ? "not scored" : `highest signal ${assessment.riskScore.toFixed(1)}/100`}`,
    `Files: ${state.changedFiles.length} | HEAD: ${state.headSha}`,
    ...assessment.signals.map(signal => `  ${signal.id}: ${signal.risk.toFixed(1)}/100 (threshold ${signal.threshold})`),
    `Reasons: ${assessment.reasons.join(", ") || "all signals within threshold"}`,
  ].join("\n"));
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `decision=${assessment.decision}\nrisk-score=${assessment.riskScore ?? ""}\nhead-sha=${state.headSha}\ntriage=${JSON.stringify(triage)}\n`);
  }
  if (values.enforce && assessment.decision === "human_review") process.exitCode = 2;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
