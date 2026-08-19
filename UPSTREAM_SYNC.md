# Upstream Sync Process

This fork tracks `cstaelen/tidarr` through the `upstream` remote. Use this
process when reviewing upstream commits for possible adaptation into this fork.

## Source Of Truth

The durable marker is `.github/upstream-sync.json`.

Use:

```bash
jq . .github/upstream-sync.json
```

The important fields are:

- `last_reviewed_commit`: the upstream commit already reviewed through.
- `next_range`: the range to inspect next, normally
  `<last_reviewed_commit>..upstream/main`.
- `commits`: per-upstream-commit disposition from the last sync.

## Standard Workflow

1. Confirm the worktree state before starting:

   ```bash
   git status --short --branch
   git remote -v
   ```

2. Fetch upstream:

   ```bash
   git fetch upstream --prune
   ```

3. Read the marker and list the upstream commits to review:

   ```bash
   jq -r .next_range .github/upstream-sync.json
   git log --reverse --date=short --pretty=format:'%H %ad %s' "$(jq -r .next_range .github/upstream-sync.json)"
   ```

4. Compare patches and local equivalents:

   ```bash
   git cherry -v HEAD upstream/main
   git log --reverse --date=short --pretty=format:'%h %ad %s' --all --grep='<issue-or-keyword>'
   git show --stat --oneline <upstream-commit>
   ```

5. Decide per commit:

   - `already-equivalent`: the fork already has the behavior, possibly under a
     different commit hash.
   - `adapted`: bring over the upstream behavior manually because this fork has
     divergent code or product behavior.
   - `cherry-picked`: use only when the upstream commit applies cleanly and does
     not overwrite fork-specific behavior.
   - `skipped-dependency-only`: reviewed but left to this fork's own dependency
     update/security cadence.
   - `skipped-doc-only`: docs do not apply to this fork, or the fork docs have
     intentionally diverged.
   - `skipped-not-applicable`: upstream behavior conflicts with fork goals.

6. Preserve fork-specific behavior. In this fork, pay special attention to:

   - Lidarr/SABnzbd bridge behavior.
   - `tidarr_source` and `tidarr_relative_paths` history metadata.
   - Queue persistence and API tests.
   - Node 22 CI and dependency/security policy.
   - Fork-specific GitHub Actions changes.

7. Verify the adapted changes. For runtime or API changes, run at least:

   ```bash
   yarn --cwd api test
   ```

   If frontend code changed, also run:

   ```bash
   yarn --cwd app build
   ```

   Run lint when the sync touches TypeScript/TSX broadly:

   ```bash
   yarn eslint
   ```

8. Update `.github/upstream-sync.json` after the review is complete:

   - Set `previous_reviewed_commit` to the old `last_reviewed_commit`.
   - Set `last_reviewed_commit` to the current upstream HEAD that was reviewed.
   - Set `next_range` to `<new-last-reviewed-commit>..upstream/main`.
   - Refresh the `commits` list with every reviewed upstream commit and its
     final disposition.
   - Add any notes needed for the next sync.

9. Validate the marker:

   ```bash
   jq empty .github/upstream-sync.json
   git diff --check
   ```

## Current Baseline

As of the current marker, the next upstream review should start from:

```bash
e96f41eee26e573b3ad4f88f8d29666a8d19d781..upstream/main
```

Do not rely on memory or commit subjects alone. Upstream commits may have been
manually adapted into this fork under different hashes, so check behavior and
tests before deciding.
