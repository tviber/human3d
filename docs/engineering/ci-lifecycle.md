# CI lifecycle and required check

The `test` workflow handles pull requests opened, synchronized, reopened, marked ready for review, or converted to draft, plus pushes to `main`. Same-ref runs cancel older runs, and every job has a timeout.

| Event state | `fast` | `full` | `dynamics` | `test / required` |
| --- | --- | --- | --- | --- |
| Draft pull request | Runs bounded A1 checks | Skipped | Skipped | Fails with `draft_deferred` after fast succeeds; otherwise fails with the fast job status reason |
| Ready pull request | Runs | Runs all type, contract, unit, and build checks | Runs dynamics validation | Green only when `full` and `dynamics` succeed; `fast` may be skipped or successful |
| Push to `main` | Runs | Runs all type, contract, unit, and build checks | Runs dynamics validation | Green only when `full` and `dynamics` succeed; `fast` may be skipped or successful |
| Required work failed, cancelled, stale, skipped, or unrun | Status recorded | Status recorded | Status recorded | Fails with a reason naming the unsuccessful work |

`required` is the stable aggregate job and uses `always()` so it reports deferred or unsuccessful work. Configure branch protection to require **`test / required`** (workflow name `test`, job `required`). Do not require the conditional `full` or `dynamics` jobs directly: they are intentionally skipped on draft pull requests.

Event-matrix evidence (PR #15, head `da7e5c3`): `converted_to_draft` ran `fast` only, skipped `full`/`dynamics`, and `required` failed with `{"ok":false,"reason":"draft_deferred"}` (run 39224448924); `ready_for_review` ran all four jobs green including `docs:check` (run 39224764959). Not yet exercised: the `push` event on `main` (fires only after merge) and branch protection enforcement — `main` has no protection rules configured as of this change, which requires repository admin access and is deliberately not part of this PR.

Draft checks run only the three focused A1 tests. Ready pull requests and pushes run the complete local CI gates, with Python dynamics validation in a separate job. Caches are limited to npm and pip package caches.

For local worktrees, install dependencies from each worktree with `npm ci`. Use distinct ports such as `HUMAN3D_WEB_PORT=5174`, `HUMAN3D_PREVIEW_PORT=4174`, and `HUMAN3D_PORT=8789`; check selected ports and workspace links with `npm run worktree:check -- --source-root <source-checkout> --worktree-root <worktree>`. Workspace links must resolve to the package directory declared by that worktree's own `package.json` workspaces — a link that merely lands inside the worktree is rejected. Browser QA requires exclusive service ownership by default: the service port must be free so the run spawns this checkout's own service. Browser QA verifies the dev server's checkout identity too: it probes `/@fs/<abs path>` — a Vite server only serves files under its own `server.fs.allow` root, so a foreign worktree's server answers 403 and default mode fails before the browser launches. `QA_WEB_URL` overrides the dev-server URL as an explicit opt-in: if the probe cannot verify the identity, the run is annotated as unverified rather than silently trusted. `QA_SERVICE_URL` explicitly opts into an external service, which is then verified to be a human3d-motion v1 service whose `SERVICE_VERSION` equals this checkout's `packages/motion-core/src/protocol.ts` — port reachability alone is never sufficient. Set `HUMAN3D_BUILD_OUT_DIR` to `dist` (the default) or a nested path under `.out`, such as `.out/<worktree>/<run>/build`. Vite clears the selected output directory, so use a dedicated build directory; paths that leave these generated areas after symlink resolution are rejected.

Script outputs routed through `scripts/lib/qa-output.mjs` are published atomically (sibling temp file + rename), so a failed run cannot leave a partially written final artifact. Playwright-driven writes such as screenshots and `download.saveAs` need a path up front and still write directly; only helper-mediated writes carry the no-partial-write guarantee.

## Browser QA workflow

`browser-qa` (`.github/workflows/browser-qa.yml`) runs the two library browser suites — `scripts/library-backup-qa.mjs` and `scripts/library-concurrency-browser-qa.mjs` — against a real dev server and Chromium on Linux. They are kept out of the `test` workflow so its four-job required-gate contract (and the `ci-gate` truth table) is unchanged; to gate merges on them, require **`browser-qa / library`** alongside `test / required`. Triggered on `opened`, `synchronize`, `reopened` and `ready_for_review`, plus manual dispatch. Run the same entry point locally with `npm run qa:library`.
