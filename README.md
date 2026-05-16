# assign-reviewers-after-resolve

## Why this action exists

When a PR is opened, AI code review tools such as CodeRabbit and GitHub Copilot start their review immediately — but so does GitHub's built-in reviewer assignment, meaning human reviewers receive a Review Request at the same time as the AI.

The desired workflow is:

1. Open a PR
2. AI review runs automatically
3. Address all AI review comments
4. **Only then** request a review from human reviewers

GitHub provides no native way to implement this flow. Defining reviewers in `.github/CODEOWNERS` causes Review Requests to be sent the moment a PR is opened, with no way to delay until AI feedback has been resolved.

This repository provides a GitHub Action that solves exactly this problem: it waits until all review threads on a PR are resolved, then assigns the designated human reviewers — enabling a clean "AI review first, human review after" workflow.

A GitHub Composite Action that automatically assigns reviewers from a CODEOWNERS-compatible file once all PR review threads are resolved.

## Features

- Counts unresolved review threads via the GitHub GraphQL API (paginated, handles large PRs)
- Skips threads authored by the PR author and any configured bot/excluded accounts
- Assigns individual user reviewers listed in a CODEOWNERS-style file
- Configurable behavior when unresolved threads remain (`fail` / `warn` / `skip`)
- Dry-run mode for safe testing
- Exposes `unresolved-count` and `assigned-reviewers` as step outputs

## Usage

> **Prerequisite**: `actions/checkout` must run before this action so it can read the reviewers file.

```yaml
name: Auto-assign reviewers after resolve

on:
  pull_request:
    types: [labeled]

permissions:
  pull-requests: write
  contents: read

jobs:
  assign:
    if: github.event.label.name == 'ReviewReady'
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4

      - uses: ysknsid25/assign-reviewers-after-resolve@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          reviewers-file: .github/REVIEWERS
          trigger-label: ReviewReady
          exclude-authors: 'coderabbitai,renovate[bot]'
          on-unresolved: fail
```

See [`examples/caller-workflow.yml`](examples/caller-workflow.yml) for a full annotated example.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `github-token` | Yes | — | GitHub token with `pull-requests: write` permission. |
| `reviewers-file` | No | `.github/REVIEWERS` | Path to a CODEOWNERS-compatible file (relative to repo root). |
| `trigger-label` | No | `ReviewReady` | Label name that triggers assignment. The action no-ops when the event label does not match. Set to empty string to disable label matching. |
| `exclude-authors` | No | `""` | Comma-separated logins excluded from unresolved-thread counting **and** from being auto-assigned (in addition to the PR author). Useful for bot accounts. |
| `pr-number` | No | `github.event.pull_request.number` | Pull request number. |
| `pr-author` | No | `github.event.pull_request.user.login` | PR author login. |
| `repository` | No | `github.repository` | Target repository (`owner/repo`). |
| `on-unresolved` | No | `fail` | Behavior when unresolved threads remain: `fail` (exit 1), `warn` (log warning, exit 0), `skip` (silent exit 0). |
| `dry-run` | No | `false` | When `"true"`, log planned assignments without calling the API. |
| `assign-count` | No | `all` | Number of reviewers to assign. `"all"` assigns everyone in the reviewers file. A positive integer assigns that many reviewers picked at random from the eligible candidates. If the number exceeds the available candidates, all candidates are assigned. |

## Outputs

| Output | Description |
|---|---|
| `unresolved-count` | Number of unresolved review threads (after applying author/exclude filters). |
| `assigned-reviewers` | Comma-separated logins newly requested as reviewers. |

## Reviewers file format

The reviewers file uses the same format as GitHub CODEOWNERS:

```
# Lines starting with # are comments and are ignored.
* @user1 @user2
src/ @user3
```

- Only **individual user** handles (`@username`) are used; `@org/team` entries are ignored.
- The file does not need to be `.github/CODEOWNERS`. Using a different name (e.g. `.github/REVIEWERS`) prevents GitHub from auto-assigning reviewers on every PR open, so you can control assignment timing with this action instead.

## Reviewer assignment rules

After filtering out the PR author, already-requested reviewers, and any `exclude-authors`, the action selects who to assign based on `assign-count`:

| `assign-count` value | Behaviour |
|---|---|
| `all` (default) | Assigns every eligible reviewer from the file. |
| positive integer (e.g. `2`) | Picks that many reviewers **at random** from the eligible candidates. |
| integer ≥ candidates count | Falls back to assigning all eligible candidates. |

**Example — assign 2 random reviewers:**

```yaml
- uses: ysknsid25/assign-reviewers-after-resolve@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    reviewers-file: .github/REVIEWERS
    assign-count: '2'
```

## Required permissions

The calling workflow (or the token passed via `github-token`) must have:

```yaml
permissions:
  pull-requests: write
  contents: read
```

## Security notes

### Fork PRs

When triggered by a PR from a fork, the `GITHUB_TOKEN` from a `pull_request` event has **read-only** permissions and cannot write to pull requests. To handle fork PRs, use `pull_request_target` instead — but be aware of the security implications:

```yaml
on:
  pull_request_target:
    types: [labeled]
```

> With `pull_request_target`, **never** checkout the PR head code and then run it, as this can execute untrusted code with elevated permissions.

### Token scope

Pass `secrets.GITHUB_TOKEN` as `github-token`. Avoid using a PAT with broader scope unless cross-repository reviewer assignment is required.

## Marketplace publishing

To reference it from any repository:

```yaml
uses: ysknsid25/assign-reviewers-after-resolve@v1
```

> **Pinning by SHA is recommended** for production use:
> ```yaml
> uses: ysknsid25/assign-reviewers-after-resolve@<commit-sha>
> ```

## License

MIT — see [LICENSE](LICENSE).
