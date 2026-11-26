# Build and release runbook for Consig's feature-server fork

Verified against the files and live systems on 2026-11-26. Where a step was run, it says so.
Where it was not run, it says that too. This replaces the June 2026 draft in the operator repo
(`cto/docs/jambonz.md`, "Fork Deployment Runbook"); the differences are listed at the end of this file.

Two repos, two steps: (1) publish an image from this fork, (2) pin that image in `consigai/consig-cdk-jam`.
The ledger of Consig changes is `CONSIG.md`. Read it before you change code.

Rules that apply to every step:

- Dev first. Nothing goes to production without RJ's approval (step 8).
- Merge commits only. Never squash, never rebase a branch someone else uses.
- Never run `cdk deploy` from a laptop. Deploys happen only through the GitHub workflows named below.
- Do not paste credentials, signed URLs or transcript text into commits, comments, issues or chat.

## 1. Where to branch from

The branch that is live is named in the cdk-jam pin, not in this repo.

```shell
cd ~/dev/consig/consig-cdk-jam && git fetch origin
for b in dev prod-USE1 prod-CAC1B prod-0.9; do echo "== $b"; git show "origin/$b:cdk/app.py" | grep -n '"fs/fs"'; done
```

State on 2026-11-26 (read from `origin/dev` at `28a64cf`, and the prod branches):

| environment | cdk-jam branch | stack | where the pin is | pin today |
|---|---|---|---|---|
| dev | `dev` | `ConsigDevClusterV2` | `dev_docker_images["fs/fs"]` | `consig_0_9_5_8n` |
| prod US East 1 | `prod-USE1` | `ProdUSE1` | `default_base_docker_images["fs/fs"]` | `consig_0_9_5_8h` |
| prod Canada (new stack) | `prod-CAC1B` | `ConsigJamCAC1B` | `default_base_docker_images["fs/fs"]` | `consig_0_9_5_8h` |
| prod US West 2 and Canada (legacy) | `prod-0.9` | `SQMProdV2`, `SQMProdCACent1`, `SQMProdCACent1V2` | `default_base_docker_images["fs/fs"]` | a commit sha (`fb7a6c0...`), not a `consig_` tag |

Read the pin on the branch you are asking about. The `prod-USE1` and `prod-CAC1B` branches also contain a stale
`dev_docker_images` block (`8l`); the prod stacks do not use it.

Pick the base:

1. Dev work: branch from the dev pin. Today that is `consig-0.9.5-8n`.
2. A fix that must reach production without the dev-only work: branch from the prod pin (`consig-0.9.5-8h` today),
   because `8n` carries the speech-events work that has not been promoted. Ask RJ before starting such a branch.

```shell
cd ~/dev/consig/wt-fs-speech-events        # or: git worktree add ../wt-fs-<topic> -b <branch> origin/consig-0.9.5-8n
git fetch origin --tags
git worktree add ../wt-fs-<topic> -b consig-0.9.5-8o origin/consig-0.9.5-8n
```

`~/dev/jambonz/fork/jambonz-feature-server` is a second checkout (a worktree checked out at `consig-0.9.5-8g` on this date).
Use `git worktree list` to see what exists; do not reuse a worktree that has another branch checked out.
`.dockerignore` already contains `cdk` (needed so the image asset does not package the CDK folder).

## 2. Naming, and what must be in the commit

Today there is one branch per image. The name is `consig-0.9.5-8<letter>`; the next letter after `n` is `o`.
Never reuse a letter: the workflow pushes the branch-name tag on every push to that branch, so a reused letter would
repoint a tag that dev or prod may already run (whether the ECR repository blocks tag overwrites was not checked).
The commit sha tag is pushed alongside and always identifies the build.

The image tag is the branch name with `.` and `-` both replaced by `_` (`cdk/app.py`: `.replace('.', '_').replace('-', '_')`):

| branch | image tag |
|---|---|
| `consig-0.9.5-8n` | `consig_0_9_5_8n` |

A branch may hold several commits (`8n` is 15 commits on `8h`). The rule is one change set per image, not one commit.

Every commit that changes behaviour must carry:

1. `// CONSIG: <ID> ...` comments on each Consig block in an upstream file (what, why, pointer). See `CONSIG.md`, "Conventions".
2. A new or updated entry in `CONSIG.md` (id, files, tests, since, upstream status).
3. A test that fails if the behaviour is removed. Put the test name in the ledger row.
4. The commit trailer required by the session that made it. No customer names or speech-vendor names in new identifiers.

## 3. Test before you push

What runs on this Mac (run on 2026-11-26 on `feat/listen-speech-events`: 368 pass, 0 fail, about 1 minute):

```shell
cd <your worktree>
ENVS=$(node -p "require('./package.json').scripts.test.replace(/ node test\/ *\$/,'')")
eval "$ENVS node -e \"for (const f of ['ws-requestor-retry-unit-test','test_ws_retry_comprehensive','ws-requestor-unit-test','http-requestor-retry-test','http-requestor-unit-test','unit-tests','speech-events-unit-test','sdp-utils-test']) require('./test/'+f)\""
npm run test:redis-failover
node test/sbc-health-monitoring.test.js     # 24 pass, 2 fail on the untouched head today; compare, do not expect green
```

These are the tests that `npm test` runs before it starts Docker (`test/index.js` lines before `docker_start`), plus `sdp-utils-test`.
The speech-events tests (`test/speech-events-unit-test.js`) are among them: they use mocks, no FreeSWITCH.

What does not run here, and why: the rest of `npm test` (`docker_start` onward) needs the Docker test bed in
`test/docker-compose-testbed.yaml` (drachtio, FreeSWITCH, MySQL, Redis) and the `mysql` command line client.
`npm test` was started once on this Mac: Docker came up, then `create-test-db` failed with `mysql: command not found`
and the rest failed. Run `docker-compose -f test/docker-compose-testbed.yaml down` if you start it by accident.

Lint:

```shell
npm run jslint        # eslint app.js tracer.js lib
```

The tree already has 36 lint errors (trailing spaces, `max-len`, unused variables in `create-call.js`, `config.js`,
`sbc-health-monitor.js`, `sbc-pinger.js`). Your change must add none: compare the count before and after.

## 4. Push, and what CI does

```shell
git push origin consig-0.9.5-8o
```

Which workflows run (all in `.github/workflows/`):

| workflow | trigger | what it does |
|---|---|---|
| `AWS Service CI/CD` (`consig.yml` calling `cdk-deploy.yml`) | push to a branch named `consig-*` | The image publish. Runs `cdk deploy jambonzFeatureServer` in `cdk/` (account `533267287636`, `us-east-1`, role `githubdeployrole`). Builds `Dockerfile`, pushes to ECR repository `consig-jambonz-feature-server` with two tags: the commit sha and the branch-derived tag. No running service is touched |
| `CI` (`build.yml`) | every push and pull request | Upstream's test harness: `npm ci`, `npm run jslint`, Docker test bed, `npm test` |
| `Docker` (`docker-publish.yml`) | push to `main` or a tag | Upstream's Docker Hub publish. Needs Docker Hub secrets; not used for Consig images |

A branch that does not start with `consig-` (for example `feat/...`) builds nothing.

Honest state of `CI` on Consig branches: in the 28 `CI` runs on record for this repo none succeeded.
The failing step in the run for `consig-0.9.5-8n` (checked with `gh run view --log-failed`) is `npm run jslint`
(the 36 lint errors above), which runs before `npm test`, so the test bed is never reached on these runs.
So `CI` is red and uninformative today; it is not a gate. `AWS Service CI/CD` is the one that matters. Recent runs:
`8h` through `8n` all succeeded in 2 to 2.5 minutes (one earlier `8h` run failed after 10 seconds; a later run of the same branch succeeded).

```shell
gh run list -R consigai/jambonz-feature-server --limit 12 --json name,conclusion,headBranch
gh run watch -R consigai/jambonz-feature-server $(gh run list -R consigai/jambonz-feature-server --branch consig-0.9.5-8o --workflow "AWS Service CI/CD" --limit 1 --json databaseId -q '.[0].databaseId')
```

## 5. Verify the image exists

Read-only. Run on 2026-11-26 with the `Consig-Infra-Admin` profile (account `533267287636`); it returned `consig_0_9_5_8n`.

```shell
aws --profile Consig-Infra-Admin --region us-east-1 ecr list-images \
  --repository-name consig-jambonz-feature-server \
  --query 'imageIds[?imageTag==`consig_0_9_5_8o`].imageTag' --output text
```

Empty output means the image is not there; do not pin it. If the command fails for credentials, stop and ask RJ.

## 6. Pin it on dev in consig-cdk-jam

Never push to `dev` directly. Use a pull request. Branch names used so far: `chore/fs-8n-review-fixes-dev` (PR #204).

```shell
cd ~/dev/consig/consig-cdk-jam && git fetch origin
git switch -c chore/fs-8o-<topic>-dev origin/dev
```

Edit `cdk/app.py`: in the `dev_docker_images` dict change only the `"fs/fs"` line to
`533267287636.dkr.ecr.us-east-1.amazonaws.com/consig-jambonz-feature-server:consig_0_9_5_8o`, and update the comment above it.
Do not touch `default_base_docker_images` (that is production). A new feature-server environment variable goes in the
`envVars` dict in `cdk/cdk/Jam_stack.py` (starts near line 1150; `JAMBONES_DIAL_USE_OUTBOUND_SBC` is at about line 1169).
That dict is shared with the SBC containers, which ignore feature-server variables. Prefer an opt-in flag set there
over changing a default in the fork.

```shell
git add cdk/app.py && git commit -m "Dev only: feature server consig_0_9_5_8o (<what changed>)"
git push -u origin HEAD
gh pr create -R consigai/consig-cdk-jam --base dev --title "Dev only: feature server consig_0_9_5_8o (<what changed>)" --body "<what changed, roll back to consig_0_9_5_8n, link the fork PR>"
gh pr checks -R consigai/consig-cdk-jam <pr-number> --watch      # workflow "Consig-CDK-Jam - PR Checks"
gh pr merge  -R consigai/consig-cdk-jam <pr-number> --merge      # merge commit. Never --squash, never --rebase
```

The repository allows squash and rebase merges and `dev` is not branch protected (checked with the GitHub API), so "merge commit only"
is a rule you must follow, not one the tool enforces.

The merge to `dev` triggers `Consig-CDK-Jam - Dev` (`.github/workflows/dev.yml`: push to `dev`, paths `cdk/**` or `.github/**`),
which deploys `ConsigDevClusterV2` through `cdk-deploy.yml`. It took about 7 minutes in the last three runs.

```shell
gh run list -R consigai/consig-cdk-jam --branch dev --workflow "Consig-CDK-Jam - Dev" --limit 1
```

Verify that the running task picked up the new image. The task definition holds a CDK asset image (a hash tag in
`cdk-hnb659fds-container-assets-...`), not your `consig_` tag: cdk-jam builds a small image `FROM` your base image
(`cdk/fs/fs/Dockerfile`, `ARG BASE_IMAGE`). So compare the `fs` container between task-definition revisions.
Run on 2026-11-26 (revision 111 against 112): only `fs` differed.

```shell
A() { aws --profile Consig-Dev-Admin --region us-west-2 "$@"; }
C=ConsigDevClusterV2-ECSD299DF54-ABzAHthWQYfI
S=$(A ecs list-services --cluster $C --query 'serviceArns[?contains(@,`FSfsFS`)]|[0]' --output text)
TD=$(A ecs describe-services --cluster $C --services $S --query 'services[0].taskDefinition' --output text); echo $TD
A ecs describe-task-definition --task-definition $TD --query 'taskDefinition.containerDefinitions[].[name,image]' --output text
# repeat for the previous revision number (TD with :N-1) and diff the two lists: only the "fs" image should differ
```

If another container's image also differs, something else was deployed with your change; stop and find out what.
`ecs describe-services` also shows `deployments` with the rollout state.

## 7. Validate on dev before anything else

1. Place test calls that exercise the changed behaviour (the `consig-test` skill and `consig` CLI cover E2E runs).
2. Read the logs for the new task (Axiom, dataset for dev) for errors from the changed code. Do not copy transcript text or signed URLs anywhere.
3. Write down what you saw (calls, counts) in the fork PR. Production is not considered until this is done and RJ has read it.

## 8. Production

- Production pins change only through a separate promotion pull request that RJ approves. Never straight from a dev change, never by editing `default_base_docker_images` in the same PR that pins dev.
- US and Canada are separate pins on separate branches (`prod-USE1`; `prod-CAC1B`; legacy `prod-0.9` covers US West 2 and the old Canada stacks). Canada is never promoted from dev directly: it follows a version that has run in US production and that RJ names for Canada.
- An agent must stop and ask RJ before touching any production branch, stack, workflow or secret. That includes reading a pin for the purpose of changing it. Merging to `prod-*` deploys immediately (`prod-USE1` has no path filter).

## 9. Rollback

Images are immutable per branch, which is why each change gets a new branch. To roll back, pin the previous tag the same way as step 6
(pull request, merge commit, workflow, task-definition check). Dev: the previous tag in the PR body of the last pin (`cdk/app.py` also says how:
"delete dev_docker_images and pass default_base_docker_images to consigDev"). Production: ask RJ; it is a production change.

---

## Updating from upstream jambonz

State on 2026-11-26: the fork is on upstream `v0.9.5-8`; upstream is at `v0.9.15`. The tags are in this repo (`git tag`), upstream remote is `upstream`.
Conflicts measured with `git merge-tree`: six files for both `v0.9.9` and `v0.9.15`. See `CONSIG.md`, "Pulling an upstream release".

### Established practice (done before)

Upstream changes have been merged into a Consig branch with a merge commit, not a rebase. Examples in the history:
`80d28d2 Merge commit 'c5cd488...' into consig-0.9.5-8a`, `49d3e95 Merge commit 'e686a11...' into consig-beep-events-9.4-1`,
`07137e6 0.9.3.15 - Merge commit 'd991c97...' into consig-beep-events`. The result went out as the next image name.
A jump from `v0.9.5-8` to `v0.9.15` has not been done.

### Proposal (not done yet): catch-up branch from the upstream tag

Not current practice. Use it only after RJ agrees. The idea: start from the upstream tag and re-apply each ledger entry,
so every Consig change is re-read and re-tested instead of surviving by an automatic merge. Steps for an agent to tick:

- [ ] Fork issue exists for the catch-up (what tag, why). RJ has agreed.
- [ ] `git fetch upstream --tags`; read upstream's release notes between the two tags for anything touching `lib/tasks/listen.js`, `lib/utils/background-task-manager.js`, `lib/http-routes/api/create-call.js`, `lib/tasks/dial.js`, `lib/tasks/transcribe.js`, `lib/session/call-session.js`.
- [ ] `git switch -c consig-0.9.<x>-<y>a v0.9.15` (a new base name; decide the naming with RJ first, see the proposal below).
- [ ] Re-apply entries in the order given in `CONSIG.md` ("Recommended order"); one commit per ledger id, each with its `CONSIG:` comments and its tests.
- [ ] Resolve the known conflict files (`create-call.js`, `listen.js`, `background-task-manager.js`, `package.json`, `package-lock.json`, `test/index.js`). Regenerate `package-lock.json` with `npm install`; do not hand merge it.
- [ ] Check upstream's Node requirement (`engines.node >= 24.22.1` at `v0.9.15`) against the `Dockerfile` (`node:20-alpine` today) and update the Dockerfile.
- [ ] Rebase or re-pin the verb-specifications fork (`VERB-SPEC-PIN`) or confirm upstream's package accepts `config.beep` and `bargeIn.partialResultHook`.
- [ ] After the pull, re-verify every ledger entry with its guarding test (the table in `CONSIG.md`). An entry with "none (gap)" must get a test now, or be re-checked by hand and noted in the PR.
- [ ] Run the unit tests and lint (step 3). Compare with the baseline of the pre-catch-up head: same pass set, no new lint errors.
- [ ] Re-run the token-level comparison if you changed only comments; for the merge itself, review the diff against upstream (`git diff v0.9.15 HEAD -- lib`) and confirm it contains only Consig blocks.
- [ ] Push under a new branch name; verify the image (step 5); pin on dev (step 6); soak on dev with real test calls (step 7) for as long as RJ says.
- [ ] Promotion to production only by a separate PR that RJ approves (step 8).

Also a proposal, not current practice: replacing one-branch-per-image with a single long-lived Consig branch and image tags on it.
Until RJ decides that, keep the branch-is-image rule in step 2.

## Offering a change upstream

1. Pick an entry marked `candidate` in `CONSIG.md`. Read upstream's `docs/contributing.md` (fork, regression tests, lint) and `README.md`.
2. `git fetch upstream` and branch from upstream's default branch (`main`): `git switch -c fix/<topic> upstream/main`.
3. Carry only the generic change. Remove `CONSIG:` markers, ledger ids, Consig identifiers, issue numbers of Consig repos, customer and vendor names. Upstream's lint (`npm run jslint`) and tests must pass; add a test in upstream's style.
4. Show the branch and the proposed issue or PR text to RJ. Nothing is sent upstream (issue, pull request, comment, Slack message) until RJ has seen it and said so.
5. After upstream accepts, mark the ledger entry `obsolete-when <upstream version>` and plan to delete our copy at the next catch-up.

## Where the June runbook was out of date

| June claim | today | verified in |
|---|---|---|
| `CI` "always fails because it needs the full mysql/redis/drachtio/freeswitch stack" | `CI` failed in all 28 runs on record; in the `8n` run it fails earlier, at `npm run jslint` (lint errors), so the stack is never reached | `gh run list`, `gh run view --log-failed` |
| Tag is the branch name "normalized to underscores" | dots and dashes both become underscores | `cdk/app.py` |
| Edit the `base_docker_images` dict | the dict is `default_base_docker_images` (prod); dev-only pins live in `dev_docker_images` | `cdk-jam` `origin/dev:cdk/app.py` |
| `envVars` dict "~line 891" in `Jam_stack.py` | starts near line 1150 | `origin/dev:cdk/cdk/Jam_stack.py` |
| Push the cdk-jam branch to deploy | changes go by pull request with checks (`pr-checks.yml`) and a merge commit; the push to `dev` is what deploys | PR #204, `.github/workflows/` |
| Wait "about 8 min" | 6.5 to 7.3 minutes in the last three runs | `gh run list` on cdk-jam |
| "one commit off the prior deploy branch" | `8n` is 15 commits on `8h` | `git log origin/consig-0.9.5-8h..origin/consig-0.9.5-8n` |
| Branch from the currently deployed branch | dev (`8n`) and prod (`8h`) differ; a prod fix branches from the prod pin | pins in step 1 |
| "The jambonz test suite can't run locally; use `node --check`" | the unit tests (368, including the speech tests) run locally; only the Docker/MySQL part does not | step 3 |
| Fork path `~/dev/jambonz/fork/jambonz-feature-server` is the working repo | it is one of several worktrees (at `8g` today) | `git worktree list` |
| `cdk-deploy.yml` runner not mentioned | fork workflow now pins `ubuntu-24.04` and Python 3.9 | `.github/workflows/cdk-deploy.yml` |
| "Prod branch to cluster mapping lives in cdk-jam; confirm" | mapping is in step 1 | cdk-jam `.github/workflows/` |

Not verified: whether `prod-0.9` is still deployed by anyone (its workflows exist and trigger on push); how production is validated after a promotion (not documented in the files read); the Axiom dataset name for dev logs.
