import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TypeSafeClient, type SystemOneResult } from "@typesafe-ai/sdk";
import { simpleChange } from "../examples/smoke";
import { prepareState } from "../src/git";
import { assessReview, evaluateReview, reviewRequest, validateThresholds } from "../src/jev";
import { reviewQuestions } from "../src/questions";

function response(probability = 0.1): SystemOneResult<typeof reviewQuestions> {
  return {
    model: "test-model", usage: { input_tokens: 10, output_tokens: 8 },
    answers: Object.fromEntries(Object.keys(reviewQuestions).map(id => [id, { type: "noul", noul: probability }])) as SystemOneResult<typeof reviewQuestions>["answers"],
  };
}

test("the real SDK sends one typed request and its answers drive the decision", async () => {
  let calls = 0;
  const client = new TypeSafeClient({ apiKey: "test-only", fetch: async (url, init) => {
    calls++;
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    const body = JSON.parse(String(init?.body));
    expect(body.state.diff).toBe(simpleChange.diff);
    expect(body.questions).toEqual(JSON.parse(JSON.stringify(reviewQuestions)));
    return Response.json(response());
  } });
  const result = await evaluateReview(simpleChange, client);
  expect(calls).toBe(1);
  expect(assessReview(simpleChange, result).decision).toBe("merge_candidate");
  expect(assessReview(simpleChange, response(0.2)).decision).toBe("merge_candidate");
  const highRisk = { ...response(), answers: { ...response().answers, securityBoundary: { type: "noul" as const, noul: 0.9 } } };
  expect(assessReview(simpleChange, highRisk)).toMatchObject({ decision: "human_review", riskScore: 90, reasons: ["securityBoundary"] });
  expect(assessReview(simpleChange, highRisk, 20, { securityBoundary: 90 }).decision).toBe("merge_candidate");
  expect(assessReview(simpleChange, response(0.1), 20, { securityBoundary: 5 })).toMatchObject({
    decision: "human_review", reasons: ["securityBoundary"],
    signals: expect.arrayContaining([{ id: "securityBoundary", risk: 10, threshold: 5 }]),
  });
});

test("opaque or truncated input cannot qualify; malformed answers fail closed", () => {
  for (const state of [
    { ...simpleChange, truncated: true },
    { ...simpleChange, opaqueChanges: true },
  ]) expect(assessReview(state, response(0)).decision).toBe("human_review");
  for (const invalid of [NaN, Infinity, -0.1, 1.1]) {
    expect(() => assessReview(simpleChange, response(invalid))).toThrow("invalid Jev answer");
  }
  expect(() => assessReview(simpleChange, { answers: {} } as ReturnType<typeof response>)).toThrow("invalid Jev answer");
  expect(() => assessReview(simpleChange, response(), NaN)).toThrow("max-risk");
  expect(() => validateThresholds({ typo: 20 })).toThrow("Invalid threshold: typo");
  expect(() => validateThresholds({ securityBoundary: -1 })).toThrow("Invalid threshold: securityBoundary");
  expect(() => validateThresholds([])).toThrow("thresholds must be an object");
});

test("policy requires one valid threshold for every built-in question", () => {
  const policy = Object.fromEntries(Object.keys(reviewQuestions).map(id => [id, 20]));
  expect(validateThresholds(policy, true)).toEqual(policy);
  expect(() => validateThresholds({ ...policy, securityBoundary: undefined }, true)).toThrow("Invalid threshold: securityBoundary");
  expect(() => validateThresholds({ ...policy, securityBoundary: 101 }, true)).toThrow("Invalid threshold: securityBoundary");
  expect(() => validateThresholds({ ...policy, extra: 10 }, true)).toThrow("Invalid threshold: extra");
  const { securityBoundary: _, ...missing } = policy;
  expect(() => validateThresholds(missing, true)).toThrow("every built-in question");
});

test("SDK transport failures propagate rather than produce a decision", async () => {
  const client = new TypeSafeClient({ apiKey: "test-only", retry: { maxRetries: 0 },
    fetch: async () => Response.json({ error: { message: "Unavailable" } }, { status: 503 }),
  });
  await expect(evaluateReview(simpleChange, client)).rejects.toThrow();
});

test("real git and CLI: merge base, filenames, bounded evidence, outputs, and exit codes", async () => {
  const repo = await mkdtemp(join(tmpdir(), "jev-review-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  try {
    git("init", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Jev test");
    await writeFile(join(repo, "README.md"), "# Instalation\n");
    const policyPath = ".jev-review.json";
    const policy = { ...Object.fromEntries(Object.keys(reviewQuestions).map(id => [id, 20])), securityBoundary: 5 };
    await writeFile(join(repo, policyPath), JSON.stringify(policy));
    git("add", "."); git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD").trim();
    git("checkout", "-qb", "change");
    await writeFile(join(repo, "README.md"), "# Installation\n");
    const oddName = " leading\nname.txt";
    await writeFile(join(repo, oddName), "example\n");
    git("add", "."); git("commit", "-qm", "fix heading");
    git("checkout", "-q", "main");
    await writeFile(join(repo, "base-only.txt"), "not in the branch diff\n");
    git("add", "."); git("commit", "-qm", "advance main");
    git("checkout", "-q", "change");
    const state = await prepareState("fix heading", "main", repo);
    expect(state.mergeBase).toBe(base);
    expect(state.changedFiles).toEqual([oddName, "README.md"]);
    expect(state.diff).not.toContain("base-only.txt");
    expect(state.diff).toContain("+# Installation");
    const cli = execFileSync(process.execPath, ["--no-env-file", "src/cli.ts", "--repo", repo, "--base", "main", "--task", "fix heading", "--dry-run"], { encoding: "utf8", env: { ...process.env, TYPESAFE_API_KEY: "" } });
    expect(JSON.parse(cli)).toEqual(JSON.parse(JSON.stringify(reviewRequest(state))));
    // Exercise the actual CLI and SDK together, replacing only the HTTP transport.
    const preload = join(repo, ".git", "mock-fetch.ts");
    const output = join(repo, ".git", "action-output");
    for (const [probability, enforce, expectedExit] of [[0.1, true, 0], [0.9, false, 0], [0.9, true, 2]] as const) {
      await writeFile(preload, `globalThis.fetch = async () => Response.json(${JSON.stringify(response(probability))});`);
      await writeFile(output, "");
      const child = Bun.spawn([process.execPath, "--no-env-file", "--preload", preload, "src/cli.ts", "--repo", repo, "--base", "main", "--task", "fix heading", "--json", ...(enforce ? ["--enforce"] : [])], {
        env: { ...process.env, TYPESAFE_API_KEY: "test-only", GITHUB_OUTPUT: output }, stdout: "pipe", stderr: "pipe",
      });
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(stderr).toBe("");
      expect(exit).toBe(expectedExit);
      const report = JSON.parse(stdout);
      expect(report.decision).toBe(probability > 0.2 ? "human_review" : "merge_candidate");
      const outputs = await readFile(output, "utf8");
      expect(outputs).toContain(`head-sha=${state.headSha}\n`);
      expect(outputs).toContain(`decision=${report.decision}\n`);
      const triage = JSON.parse(outputs.match(/^triage=(.*)$/m)?.[1] ?? "null");
      expect(triage).toMatchObject({ decision: report.decision, headSha: state.headSha, baseSha: state.baseSha, reasons: report.reasons, signals: report.signals });
      expect(triage).not.toHaveProperty("diff");
    }
    await writeFile(preload, `globalThis.fetch = async () => Response.json(${JSON.stringify(response(0.1))});`);
    const custom = Bun.spawn([process.execPath, "--no-env-file", "--preload", preload, "src/cli.ts", "--repo", repo, "--base", "main", "--task", "fix heading", "--thresholds", '{"securityBoundary":5}', "--json", "--enforce"], {
      env: { ...process.env, TYPESAFE_API_KEY: "test-only", GITHUB_OUTPUT: "" }, stdout: "pipe", stderr: "pipe",
    });
    const [customExit, customOutput] = await Promise.all([custom.exited, new Response(custom.stdout).text()]);
    expect(customExit).toBe(2);
    expect(JSON.parse(customOutput).reasons).toEqual(["securityBoundary"]);
    await writeFile(join(repo, policyPath), JSON.stringify({ bypass: 100 }));
    git("add", "."); git("commit", "-qm", "change policy in PR");
    const policyCli = execFileSync(process.execPath, ["--no-env-file", "src/cli.ts", "--repo", repo, "--base", "main", "--task", "fix heading", "--policy", policyPath, "--dry-run"], { encoding: "utf8", env: { ...process.env, TYPESAFE_API_KEY: "" } });
    expect(JSON.parse(policyCli).questions).toEqual(JSON.parse(JSON.stringify(reviewQuestions)));
    expect(JSON.parse(policyCli).questions).not.toHaveProperty("bypass");
    const policyRun = Bun.spawn([process.execPath, "--no-env-file", "--preload", preload, "src/cli.ts", "--repo", repo, "--base", "main", "--task", "fix heading", "--policy", policyPath, "--json", "--enforce"], {
      env: { ...process.env, TYPESAFE_API_KEY: "test-only", GITHUB_OUTPUT: "" }, stdout: "pipe", stderr: "pipe",
    });
    const [policyExit, policyOutput] = await Promise.all([policyRun.exited, new Response(policyRun.stdout).text()]);
    expect(policyExit).toBe(2);
    expect(JSON.parse(policyOutput).reasons).toEqual(["securityBoundary"]);
    await expect(prepareState("task", "--help", repo)).rejects.toThrow();
    await expect(prepareState("task", "HEAD", repo)).rejects.toThrow("No committed changes");
    await writeFile(join(repo, "large.txt"), "x".repeat(65_000));
    git("add", "."); git("commit", "-qm", "large change");
    const bounded = await prepareState("task", "main", repo);
    expect(bounded.truncated).toBe(true);
    expect(bounded.opaqueChanges).toBe(false);
    expect(bounded.diff.length).toBe(30_000);
    await writeFile(output, "");
    const large = Bun.spawn([process.execPath, "--no-env-file", "src/cli.ts", "--repo", repo, "--base", "main", "--task", "large change", "--json", "--enforce"], {
      env: { ...process.env, TYPESAFE_API_KEY: "", GITHUB_OUTPUT: output }, stdout: "pipe", stderr: "pipe",
    });
    const [largeExit, largeStdout, largeStderr] = await Promise.all([large.exited, new Response(large.stdout).text(), new Response(large.stderr).text()]);
    expect(largeExit).toBe(2);
    expect(largeStderr).toBe("");
    expect(JSON.parse(largeStdout)).toMatchObject({ decision: "human_review", riskScore: null, reasons: ["truncated_diff"], signals: [] });
    expect(await readFile(output, "utf8")).toContain("risk-score=\n");
    await writeFile(join(repo, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    git("add", "."); git("commit", "-qm", "binary change");
    expect((await prepareState("task", "main", repo)).opaqueChanges).toBe(true);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
