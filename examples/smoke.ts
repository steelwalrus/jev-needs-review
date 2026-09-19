import type { ReviewState } from "../src/git";
import { assessReview, evaluateReview } from "../src/jev";

export const simpleChange: ReviewState = {
  task: "Fix the spelling of installation in the README heading.",
  baseRef: "fixture", baseSha: "fixture-base", headSha: "fixture-head", mergeBase: "fixture-base",
  changedFiles: ["README.md"],
  diffStat: "README.md | 2 +-",
  diff: "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-# Instalation\n+# Installation\n",
  truncated: false, opaqueChanges: false,
};

export const riskyChange: ReviewState = {
  ...simpleChange,
  task: "Speed up access checks for deleting accounts.",
  changedFiles: ["src/auth.ts"], diffStat: "src/auth.ts | 2 +-",
  diff: "diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1,3 +1,3 @@\n export function canDeleteAccount(user: User) {\n-  return user.role === 'admin';\n+  return true;\n }\n",
};

// Two small, real API requests.
if (import.meta.main) {
  try {
    if (!process.env.TYPESAFE_API_KEY?.trim()) throw new Error("Set TYPESAFE_API_KEY in .env first (see .env.example)");
    for (const [state, expected] of [[simpleChange, "merge_candidate"], [riskyChange, "human_review"]] as const) {
      const result = await evaluateReview(state);
      const assessment = assessReview(state, result);
      console.log(JSON.stringify({ task: state.task, expected, model: result.model, ...assessment }, null, 2));
      if (assessment.decision !== expected) process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
