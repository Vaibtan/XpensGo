# Issue tracker: GitHub

Issues, PRDs, and implementation tickets for this repository live in GitHub Issues. Use the `gh` CLI for operations and infer the repository from `git remote`.

## Conventions

- Create, read, comment on, label, and close work using `gh issue`.
- When a skill says “publish to the issue tracker,” create a GitHub issue.
- When a skill says “fetch the relevant ticket,” read the issue body, labels, and comments.
- Use GitHub sub-issues and native dependencies for ticket relationships where available.
- Fall back to explicit `Part of:` and `Blocked by:` references when native relationships are unavailable.
- Claim implementation work by assigning the issue before making changes.

## Pull requests as a triage surface

**PRs as a request surface: no.**

Pull requests are reviewed as code changes, not treated as feature-request or issue-triage inputs.
