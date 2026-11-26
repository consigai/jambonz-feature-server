# Consig's jambonz-feature-server fork

This is `consigai/jambonz-feature-server`, Consig's fork of the open-source `jambonz/jambonz-feature-server` (MIT).
It is based on upstream tag `v0.9.5-8`; upstream is at `v0.9.15`. The Consig diff is small on purpose and is listed in `CONSIG.md`.
Upstream's own docs still apply: `README.md` and `docs/contributing.md`.

## Where to look

- `CONSIG.md`: the ledger. One entry per Consig change (id, why, files, tests, upstream status), how to pull an upstream release, how to reduce the diff, conventions.
- `docs/CONSIG-BUILD-AND-RELEASE.md`: how to branch, build an image, pin it on dev, verify, roll back, and update from upstream. Follow it step by step.
- `docs/SBC_HEALTH_MONITORING.md`: the SBC health monitor (`SBC-HEALTH`).

## Hard rules

1. Dev first. Never change anything in production, and never touch a production branch, stack or workflow, without RJ's approval. Production pins change only in a separate promotion pull request that RJ approves.
2. Merge commits only. Never squash. Never push to `dev` in `consigai/consig-cdk-jam`; use a pull request.
3. Every Consig change carries all three: a `// CONSIG: <ID> ...` comment (what, why, pointer), an entry in `CONSIG.md`, and a test that fails if the behaviour is removed.
4. Keep the diff in upstream files small. Put logic in Consig-only modules (for example `lib/utils/speech-events.js`) and leave call sites in upstream files.
5. One image per branch: a push to `consig-*` publishes it. Never reuse a branch letter (`consig-0.9.5-8o` is next after `8n`).
6. No customer names and no speech-vendor names in new identifiers, comments or docs ("the speech engine", "the audio analyzer").
7. Never log transcript text, and never log a signed URL or its query, above debug level. Logs for listens go through `lib/utils/listen-redact.js`.
8. Nothing is sent upstream (issue, pull request, comment) without RJ seeing it first.
9. A comments-only change must not change code: compare the token streams (comments removed) before and after, and run the tests.

## Checks before you push

- Unit tests that run on a laptop (368 pass today): see step 3 of `docs/CONSIG-BUILD-AND-RELEASE.md`. The full `npm test` needs the Docker test bed and the `mysql` client.
- `npm run jslint`: the tree has 36 existing errors; add none.
- The GitHub `CI` workflow is red on every Consig branch at the lint step; the image publish workflow (`AWS Service CI/CD`) is the one that matters.
