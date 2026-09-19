# Jev - Needs review?

Decides whether a pull request needs a human reviewer. Returns `merge_candidate` or `human_review`.

It does not merge, approve, comment, or run code from the reviewed repository.

> **Prototype.** This is experimental and Jev is very new. Measure it against your own merged PRs before using it to waive reviews.

## Why Jev

[Jev](https://typesafe.ai) is a decision layer. Each question is scored with `noul`, the probability that the answer is yes, and code compares that number against a threshold.

This repo asks six questions about the diff. If `securityBoundary` scores high, the change likely touches auth, permissions, or secrets, so it goes to a human.

## GitHub Action

Add a repository secret `TYPESAFE_API_KEY`, then:

```yaml
name: Jev triage
on:
  pull_request:
    types: [opened, synchronize, reopened, edited]
permissions:
  contents: read
jobs:
  jev:
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    outputs:
      triage: ${{ steps.jev.outputs.triage }}
    steps:
      - uses: steelwalrus/jev-needs-review@v1
        id: jev
        with:
          api-key: ${{ secrets.TYPESAFE_API_KEY }}
```

The Action checks out the PR head, uses the PR title and description as the task and the base SHA as the comparison point, and installs its own dependencies. Your repository needs no Bun, checkout, or extra job.

The example uses the `v1` tag for this initial advisory release.

| Input | Default | |
| --- | --- | --- |
| `api-key` | required | TypeSafe API key |
| `task` | PR title and description | Intended change |
| `base` | PR base SHA | Comparison commit |
| `max-risk` | `20` | Default threshold for every question |
| `thresholds` | `{}` | Per-question overrides as JSON |
| `policy` | empty | Repo-relative JSON file with all six thresholds, read from the PR base commit |

| Output | |
| --- | --- |
| `decision` | `merge_candidate` or `human_review` |
| `risk-score` | Highest individual signal, 0–100; empty when Jev is skipped |
| `head-sha` | Exact reviewed commit |
| `triage` | Full JSON: decision, both SHAs, per-signal scores, thresholds, reasons |

Read it downstream as `needs.jev.outputs.triage`.

The `if:` line skips fork PRs, which GitHub does not give secrets to. Pin `v1` to a release SHA if you need stricter versioning.

## Thresholds

Each signal returns 0–100. **A score above its threshold sends the PR to a human**, so a *lower* threshold is *stricter*.

| | Effect |
| --- | --- |
| `securityBoundary: 5` | Strict: any hint of auth or secrets goes to a human |
| `coverageGap: 40` | Lenient: tolerates missing tests |
| `20` (default) | Applies to every question you do not override |

Set one bar for everything, or override per question:

```yaml
with:
  max-risk: '30'
  thresholds: '{"securityBoundary":5,"coverageGap":40}'
```

For an organization policy, commit a JSON file to the consuming repository, for example `.github/jev-review.json`:

```json
{
  "unrelatedChanges": 20,
  "publicBehavior": 10,
  "coverageGap": 20,
  "complexityRisk": 20,
  "securityBoundary": 5,
  "insufficientContext": 20
}
```

Then set the Action input:

```yaml
with:
  api-key: ${{ secrets.TYPESAFE_API_KEY }}
  policy: .github/jev-review.json
```

Or use the same file from the CLI: `bun run triage --repo /path/to/project --base origin/main --task "Fix invoice deduplication" --policy .github/jev-review.json`.

Every built-in question needs one threshold from 0 to 100. Missing, extra, or invalid entries fail the run. `policy` cannot be combined with `max-risk` or `thresholds` overrides. The file is read from the comparison commit, so changes to the policy within a PR do not affect that run. Merge the policy file before enabling the Action, because it must already exist in the base commit.

## Signals

All six live in [`src/questions.ts`](src/questions.ts).

| Signal | Flags |
| --- | --- |
| `unrelatedChanges` | Work outside the stated task |
| `publicBehavior` | API, CLI, or data-contract changes |
| `coverageGap` | Removed, weakened, or missing regression tests |
| `complexityRisk` | Complexity, coupling, dependencies, concurrency, lifecycle |
| `securityBoundary` | Auth, permissions, secrets, validation, exposure |
| `insufficientContext` | Not enough evidence to judge |

Questions are fixed in code. The policy file configures their thresholds, not their wording or behavior.

## CLI

Requires Bun 1.3.14+ and Git.

```sh
bun install --frozen-lockfile
cp .env.example .env          # add your TypeSafe API key; Bun loads it automatically

git -C /path/to/project fetch origin main
bun run triage --repo /path/to/project --base origin/main --task "Fix invoice deduplication"
```

| Flag | |
| --- | --- |
| `--task` / `--task-file` | Intended change; combine or use either |
| `--base` | Comparison ref (default `origin/main`) |
| `--policy` | Repo-relative JSON file containing all six thresholds, read from the base commit |
| `--max-risk` / `--thresholds` | Default threshold and optional JSON overrides when no policy is used |
| `--json` | Full report including the native SDK response |
| `--dry-run` | Print what would be sent, call nothing |
| `--enforce` | Exit 2 on `human_review` (default is advisory, always exit 0) |

Operational errors exit 1.

## What leaves your machine

Task text, changed filenames, the diff, and commit SHAs. Nothing else. Diffs over 30,000 characters go straight to human review without an API call. Jev sees the supplied diff, not the repository.

The `triage` output contains no diff or task text.

## Limits

- **`merge_candidate` does not mean CI passed or the PR is ready to merge.** It means review may be optional. Branch protection stays independent.
- Fails closed: binary files, submodules, oversized diffs, Git errors, empty diffs, API errors, and invalid answers all produce `human_review` or a non-zero exit, never a merge candidate.
- Uncommitted and untracked changes are excluded. Comparisons use the merge base.
- `risk-score` is the highest single signal, not a calibrated probability that the PR contains a bug.
- Anything consuming the decision must verify `headSha` still matches the PR and fail closed on a missing output.
- Not calibrated. Compare against human-labelled PRs, especially false `merge_candidate`s, before trusting it.

## Development

```sh
bun run check   # typecheck
bun test        # offline tests
bun run smoke   # two live API calls with synthetic examples
```

No workflow runs these automatically.
