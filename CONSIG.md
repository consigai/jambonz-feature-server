# CONSIG.md: the fork ledger

This repo is `consigai/jambonz-feature-server`, Consig's fork of `jambonz/jambonz-feature-server` (MIT).
It is based on upstream tag `v0.9.5-8`. Upstream is at `v0.9.15` (checked 2026-11-26).
Every Consig change is listed here once. Every Consig block in the code starts with `CONSIG:` and names
its ledger id, so `grep -rn "CONSIG:" lib` finds all of them and `grep -rn "<ID>" lib` finds one entry.

Build, release and upstream-update steps are in `docs/CONSIG-BUILD-AND-RELEASE.md`.

Code state described here: branch `feat/listen-speech-events` (image `consig-0.9.5-8n`), 2026-11-26.
Wire contract for the speech entries: `docs/architecture/speech-events-contract-v1.md` in `consigai/outbound` (sections 1 to 14).
Several guards came out of an outside review on 2026-11-26; each one's reason is stated in its ledger entry and in the code comment.
Pull request with the speech work: consigai/jambonz-feature-server#3.

## The ledger

Upstream status values: `candidate` (a generic fix or feature another jambonz user would want),
`consig-only` (depends on Consig's audio analyzer or infrastructure), `obsolete-when` (upstream changed it later),
`unknown` (what would settle it is stated). "Consig-only files" do not exist at `v0.9.5-8`.

| id | what it does | why | files | tests | since | upstream status |
|---|---|---|---|---|---|---|
| `BEEP-DETECT` | `config` verb option `beep`: starts FreeSWITCH AVMD in the background, sends each detected beep to `beep.actionHook`. | Know when a voicemail greeting ends. | upstream: `lib/tasks/config.js`. Consig-only: `lib/utils/beep-utils.js` | none (gap). Audio fixtures `test/scenarios/wav/4-beeps.wav`, `uac-vm1.xml` exist but no test uses them | carried into `8a` (from the `consig-beep-events` lineage) | `candidate`. PR: "config verb: background beep detection with actionHook". Needs the verb-specifications change too. Fix the `this.logger` defect in `stopBeep` first. `stopBeep` also removes upstream AMD's `AvmdEvents.Beep` listener (not verified whether both run on one call) |
| `EARLY-TRANSCRIBE` | REST `create-call` accepts `transcribe`; the transcribe task starts during early media and is killed at 200 OK (unless `stopOnAnswer:false`). Sets `call_sid` on the requestor early. | Hear the callee's early-media speech (ringback, carrier messages). | upstream: `lib/http-routes/api/create-call.js`, `lib/http-routes/schemas/create-call.js` | none (gap) | `8a` (checkpoint), fixes in `8b`, `8c`, `8d` | `candidate`, but the code (about 150 lines inline in `connectStream`) should be rewritten as a small function first. PR: "create-call: optional early-media transcription" |
| `EARLY-RECORD` | `create-call` field `recordEarlyMedia:true` forces the background call recording to start during early media (`newTask('record', {force:true})`, listen `earlyMedia:true`). | Record the part of the call before answer. | upstream: `lib/utils/background-task-manager.js`, `lib/http-routes/api/create-call.js` | none (gap). `RECORD-DEDUP` tests cover the forced start | `8a` | `unknown`. Upstream `0922087` ("Update recording", v0.9.7 or earlier) changed `_initRecord` and moved the `record_all_calls` check. Settle by reading upstream `call-session.js` around line 3152 and create-call to see whether early recording is now possible |
| `BGTASK-GUARDS` | `BackgroundTaskManager` tolerates a task with no span, returns no task when creation throws, and does not track partial tasks. | A quick CANCEL raced with background task start and crashed the manager. | `lib/utils/background-task-manager.js` | none directly (partly covered by the `background starts:` tests) | before `8a` (commit `115dd70`) | `candidate`. PR: "BackgroundTaskManager: do not crash when a background task is created during early call termination". v0.9.15 still has unguarded `task.span.end()` |
| `BARGEIN-PARTIAL` | `config.bargeIn.partialResultHook` is copied to the background gather. | The application wants partial transcripts from the barge-in gather. | `lib/tasks/config.js` | none (gap) | `8e` | `candidate`, one line. Needs `bargeIn.partialResultHook` in verb-specifications (`VERB-SPEC-PIN`) |
| `DIAL-OUTBOUND-SBC` | Env `JAMBONES_DIAL_USE_OUTBOUND_SBC=1`: an inbound call's dial/transfer leg uses the outbound SBC pool, not the ingress SBC. Set for the stack in consig-cdk-jam `Jam_stack.py`. | In a split-SBC deployment the inbound SBC cannot route outbound, so the B leg got a fast 480. | `lib/tasks/dial.js`, `lib/config.js` | none (gap) | `8f` (always on), `8g` (opt-in flag). Issue consigai/jambonz-feature-server#777 | `candidate`. PR: "dial: option to send dial legs of inbound calls to the outbound SBC pool". v0.9.15 `dial.js` still assigns the ingress SBC unconditionally |
| `SBC-HEALTH` | Counts failed OPTIONS pings per SBC and removes an SBC from the redis `active-sip` set and the local list after N failures. Never removes the last SBC. | A crashed SBC stayed in the pool forever. | upstream: `lib/utils/sbc-pinger.js`, `lib/config.js`. Consig-only: `lib/utils/sbc-health-monitor.js`, `docs/SBC_HEALTH_MONITORING.md` | `test/sbc-health-monitoring.test.js` (24 pass, 2 fail on the untouched head; not listed in `test/index.js`) | before `8a` (commit `4be5d80`) | `candidate`. PR: "sbc-pinger: remove SBCs that stop answering OPTIONS". The doc says "auto-recovery"; the code only clears the counter, it does not re-add an SBC |
| `VALKEY-FAILOVER` | `reconnectOnError` set on the realtimedb and speech-utils redis clients so READONLY/LOADING replies reconnect and resend. | An ElastiCache failover crashed services on 2026-10-31. consigai/consig-cdk-jam#155. | upstream: `lib/utils/install-srf-locals.js`. Consig-only: `lib/utils/redis-failover.js` | `test/redis-failover` (`npm run test:redis-failover`, passes) | `8h` | `unknown`, likely `candidate` in `@jambonz/realtimedb-helpers` rather than here. Settle by reading `realtimedb-helpers` 0.8.21 and `speech-utils` 1.0.x for `reconnectOnError` |
| `WS-PAYLOAD` | Default websocket max payload 24 KiB to 48 KiB. | Larger application messages. | `lib/utils/ws-requestor.js` | none | before `8a` (`2e833f2`) | `consig-only`. Removable: `JAMBONES_WS_MAX_PAYLOAD` already sets it, so set that env var and drop the patch |
| `TRANSCRIBE-KILL` | `TaskTranscribe.kill()` removes its vendor event handlers at once. | Stop transcripts after the early-media task is killed. | `lib/tasks/transcribe.js` | none | `8a` range (`dee2876`) | `unknown`. Upstream (v0.9.7, `44fbd91`) removes them when `exec()` returns. Ours also drops a final transcript that arrives during kill's 1 s wait. Settle with a test that sends a late final transcript after kill |
| `VERB-SPEC-PIN` | `@jambonz/verb-specifications` pinned to the `consigai/jambonz-verb-specifications` fork, branch `consig-0.9.5-8a`. | The validator must accept `config.beep`, `bargeIn.partialResultHook` and the `create-call` additions. | `package.json`, `package-lock.json` | none | `8a` | `obsolete-when` upstream verb-specifications accepts those properties. Upstream is at `^0.1.13`. Settle by grepping that package for `beep` and `partialResultHook` |
| `CDK-DEPLOY` | `cdk/` stack and workflows `consig.yml`, `cdk-deploy.yml`: a push to `consig-*` builds the image and pushes it to ECR. Also `.dockerignore`. | Publish images for consig-cdk-jam. | `cdk/*`, `.github/workflows/consig.yml`, `cdk-deploy.yml`, `.dockerignore`, `.gitignore` | none | before `8a`; runner fix in `8h` | `consig-only` |
| `TEST-GCP-SKIP` | `test/create-call-test.js` skips the AMD test when `GCP_JSON_KEY` is not set. | Tests ran without Google keys. | `test/create-call-test.js` | itself | before `8a` (`1e14112`) | `candidate`, trivial |
| `SPEECH-RELAY` | A background listen with `metadata.speech.mode` of `shadow` or `drive` relays analyzer speech events (`mod_audio_fork::json`, `kind:"speech"`) to the application as `verb:status` `speech-event`, with `fs_received_ms` and `listen_id`. Also sends one `stream_closed` (`connect_failed`, `disconnected`, `task_ended`) per listen. Contract sections 3, 4, 11. | One speech connection per call, run by the audio analyzer (consigai/outbound#1331). | upstream: `lib/tasks/listen.js`. Consig-only: `lib/utils/speech-events.js` | `test/speech-events-unit-test.js` (`speech-events:`, `listen wiring:`) | `8j`, `listen_id` and `task_ended` order in `8l` | `consig-only` (the event shape is the Consig contract) |
| `SPEECH-CUT` | In `drive` mode an admitted `speech_started` calls `cs.kill(true)` (like the gather's barge-in), then `uuid_break` and clears the TTS stream. The relay carries `cut`. Contract sections 4, 8. | The caller's interruption stops the agent in the same tick. | `lib/tasks/listen.js`, `lib/utils/speech-events.js` | `test/speech-events-unit-test.js` (`listen wiring: drive mode...`, `drive cut audio kill...`) | `8j`, audio kill in `8k` | `consig-only` |
| `SPEECH-ADMIT` | A speech event is admitted (per `stream_id`: `seq` increasing, `turn` increasing, superseded streams never again) before it may cut. A refused `speech_started` is relayed with `cut.reason` `not_admitted`. Contract sections 3, 5. | A duplicate or reordered start must not stop the agent twice (review findings 3 and 6). | `lib/utils/speech-events.js`, `lib/tasks/listen.js` | `test/speech-events-unit-test.js` (`admitSpeechEvent`, `listen admission:`, `superseded stream ids`) | `8m`; superseded streams `8n` | `consig-only` |
| `LISTEN-OWNERSHIP` | A listen task keeps references to the event handlers it added and removes only those. `forkListens` and `forkOwners` (WeakMaps by endpoint) record which listen tasks share an endpoint and who owns a bugname. | FreeSWITCH audio-fork events carry no fork name, and upstream removed handlers by event name for everyone, so stopping the analyzer listen removed the recording's handlers. | `lib/tasks/listen.js` | `test/speech-events-unit-test.js` (`listen cleanup:`) | `8m` | `obsolete-when` partly. Upstream v0.9.7 (`44fbd91`) added `Task.addCustomEventListener` and `removeCustomEventListeners` (the same handler-by-reference removal), a `bugname` getter on listen, and `eventIsForOurBug(fsEvent)` which filters on the `media-bugname` header. Whether our FreeSWITCH module sends that header is `unknown`: log `fsEvent.getHeader('media-bugname')` on a dev call to settle. If it does, the foreign-fork policy below is not needed |
| `RECORD-SAFETY` | `_ignoreForeignForkEvent`: while another audio-fork listen is on the endpoint, the call recording ignores `disconnect`, `error` and `connect_failed`, and a speech listen ignores `connect_failed` once it has seen a connect. The recording survives the analyzer closing its socket. | A far-end close of the analyzer socket ended the call recording (review finding 1). | `lib/tasks/listen.js` | `test/speech-events-unit-test.js` (`fork events (1)` to `(5)`, `fork timing:`) | `8m` | `obsolete-when` fork identity is in the events (same question as `LISTEN-OWNERSHIP`). Otherwise `consig-only`: it is a workaround for missing fork identity |
| `LISTEN-FAIL-STOP` | A speech listen that fails (`connect_failed`, `error`, exec failure) stops its own fork, relays `stream_closed`, then completes. | Without it the bug stayed attached and the next start with the same bugname failed "already attached". | `lib/tasks/listen.js` | `test/speech-events-unit-test.js` (`fork failure:`) | `8m` | `candidate`: upstream's `_onConnectFailure` only calls `notifyTaskDone()`. PR: "listen: stop the fork when the listen fails to connect". Generic, apart from the `stream_closed` relay |
| `FORK-SERIAL` | A stop and the next start of one audio-fork type (`listen`, `record`) are serialised in `BackgroundTaskManager` (`starting`, `stopping`, `STOP_WAIT_MS`); a speech listen start can be cancelled by a stop; `_stopFork` is bounded at 1 s and never stops a bugname a newer listen owns. | A late stop of listen A stopped listen B's fork after a restart (review findings 2 and 4). | `lib/utils/background-task-manager.js`, `lib/tasks/listen.js` | `test/speech-events-unit-test.js` (`restart:`, `bounded stop:`, `background starts: stop during a start...`) | `8n` | `candidate` for the manager part (PR: "BackgroundTaskManager: wait for the previous stop before starting the same background task"). The `forkOwners` part is `obsolete-when` bugname filtering works (see `LISTEN-OWNERSHIP`) |
| `RECORD-DEDUP` | Concurrent starts of one audio-fork background task type (`record`, `listen`) collapse to one; every other type (`bargeIn`, `transcribe`, `ttsStream`) starts as in upstream, so overlapping starts with different options both run; a failed duplicate cannot untrack the live task. | The account-level record start and the forced early-media start produced two record forks (consigai/consig-cdk-jam#197). Limited to the fork types because a collapse on every type dropped the second caller's options (review finding D6). | `lib/utils/background-task-manager.js` | `test/speech-events-unit-test.js` (`background starts:`, incl. `other types are not collapsed`) | `8m` | `candidate`, with `FORK-SERIAL`. Needed upstream only if upstream can start the same type twice (v0.9.15 has the same `tasks.has` check and no in-flight tracking) |
| `LOG-REDACT` | Log lines and span names for listens go through an allowlist (`listenForLog`, `urlForLog`): no signed URL query, credentials, metadata or keyterms. What is sent on the wire is unchanged. | A listen URL can carry a bearer token; metadata and keyterms can carry phone numbers or names (review finding 5). | upstream: `lib/tasks/listen.js`, `lib/tasks/config.js`, `lib/utils/background-task-manager.js`, `lib/session/call-session.js`. Consig-only: `lib/utils/listen-redact.js` | `test/speech-events-unit-test.js` (`listen-redact:`) | `8m` (URL), allowlist `8n` | `candidate`. PR: "do not log listen URLs with credentials in the query string" |

Not in this tree: branch `consig-0.9.5-8i` (not merged into this branch) adds `TaskTranscribe.doesVendorContinueListeningAfterFinalTranscript`
(env `JAMBONZ_FLUX_TRANSCRIBE_PERSISTENT`, consigai/outbound#1328). It is `consig-only`. Add it here when it joins the main line.

### Where upstream already overlaps (measured against `v0.9.15`)

- `lib/tasks/listen.js`: upstream has `get bugname()`, `eventIsForOurBug()` filtering on header `media-bugname`, and removal by handler reference through `Task.addCustomEventListener`. Ours predates it and removes by reference inside `listen.js` (`_epHandlers`). After a merge use upstream's `addCustomEventListener` for the removal and keep the foreign-fork policy only if the header is absent.
- `lib/utils/background-task-manager.js`: upstream `0922087` rewrote `_initRecord` (no `record_all_calls` check inside it). Our `force` flag and `earlyMedia:true` must be re-applied on top.
- `lib/tasks/transcribe.js`: upstream removes handlers when `exec()` returns (see `TRANSCRIBE-KILL`).
- `lib/tasks/dial.js`: upstream added `_aLegAlreadyAnswered` and inverted `JAMBONZ_DIAL_PAI_HEADER`, nearby but not on our lines. Still unconditional ingress SBC.
- Node: upstream `package.json` now says `node >= 24.22.1`. Our `Dockerfile` uses `node:20-alpine`. A catch-up must bump the Dockerfile.

## Pulling an upstream release

Measured 2026-11-26 with `git merge-tree --write-tree --name-only HEAD <tag>` (no merge was made):

| target | conflicting files |
|---|---|
| `v0.9.9` | `lib/http-routes/api/create-call.js`, `lib/tasks/listen.js`, `lib/utils/background-task-manager.js`, `package.json`, `package-lock.json`, `test/index.js` |
| `v0.9.15` | the same six files |

Which entries each conflict belongs to:

- `create-call.js`: `EARLY-TRANSCRIBE`, `EARLY-RECORD` (upstream: `cf0b392`, `6147ec3`, `315eb98`, `db18b55`).
- `listen.js`: `LISTEN-OWNERSHIP`, `RECORD-SAFETY`, `FORK-SERIAL`, `LISTEN-FAIL-STOP`, `LOG-REDACT`, `SPEECH-*` (upstream: `b598cd9`, `bd435df`, `44fbd91`, plus the `bugname` getter).
- `background-task-manager.js`: `FORK-SERIAL`, `RECORD-DEDUP`, `EARLY-RECORD`, `BGTASK-GUARDS`, `LOG-REDACT` (upstream: `0922087`).
- `package.json` / `package-lock.json`: `VERB-SPEC-PIN`, script `test:redis-failover`, and many upstream dependency bumps. Regenerate the lock file; do not hand merge it.
- `test/index.js`: our `speech-events-unit-test` line against upstream's new test lines (`hold-unhold-test`, `tts-tokens-missing-id-test`). Keep both.

Files that merge cleanly but need a read: `lib/tasks/dial.js`, `lib/session/call-session.js` (upstream changed about 320 lines),
`lib/tasks/transcribe.js`, `lib/utils/sbc-pinger.js` (upstream added a SIGUSR1 handler), `lib/config.js`, `lib/utils/ws-requestor.js`.
A clean text merge is not proof that an entry still works.

Recommended order for a catch-up (a proposal; the procedure is in the runbook):

1. Branch from the upstream tag, not from our branch. Start with `v0.9.9` (smaller), then go to `v0.9.15`, or go straight to `v0.9.15` if the dev soak is not needed in between.
2. Re-apply the small, independent entries first: `DIAL-OUTBOUND-SBC`, `WS-PAYLOAD` (or the env var instead), `BARGEIN-PARTIAL`, `VALKEY-FAILOVER`, `SBC-HEALTH`, `BEEP-DETECT`, `VERB-SPEC-PIN`, `CDK-DEPLOY`, `TEST-GCP-SKIP`.
3. Then `background-task-manager.js`: upstream's new `_initRecord`, then `EARLY-RECORD`, `BGTASK-GUARDS`, `RECORD-DEDUP`, `FORK-SERIAL`.
4. Then `listen.js`: take upstream's version, check whether the `media-bugname` header is real (see `LISTEN-OWNERSHIP`), then add `LISTEN-FAIL-STOP`, `FORK-SERIAL`, `RECORD-SAFETY` (if still needed), `SPEECH-*`, `LOG-REDACT`.
5. Then `create-call.js`: `EARLY-TRANSCRIBE`.
6. Bump the Dockerfile Node version; run the unit tests and lint; run every guarding test named in the ledger.
7. Build under a new image name, soak on dev, promote only with RJ's approval.

## Reducing the diff

Ordered by how much upstream-file diff each removes. None of this is done.

1. Speech code out of `lib/tasks/listen.js` into a Consig-only module (for example `lib/tasks/listen-speech.js`) added to `TaskListen.prototype`:
   `_onSpeechMessage` and `_killAudioAfterCut` (about lines 575 to 650), the stream-closed helpers `_failSpeechListen`,
   `_endSpeechListenOnFailure`, `_relayStreamClosed`, `_claimStreamClosed`, `_sendStreamClosed` (about 505 to 570).
   Call sites left in `listen.js`: the constructor block (82 to 90), the `exec` catch (about 139), `kill` (153 to 190),
   the json entry in `_initListeners` (about 320), and the first line of `_onConnectFailure`, `_onDisconnect`, `_onError`.
2. Fork ownership and the foreign-fork policy (`forkListens`, `forkOwners`, `_stopFork`, `_otherForkActive`, `_ignoreForeignForkEvent`, about lines 22 to 40, 195 to 226, 385 to 432) into `lib/utils/fork-registry.js`.
   Better: drop them if the `media-bugname` header exists, and use upstream's `eventIsForOurBug`.
3. `BackgroundTaskManager` serialisation (`starting`, `stopping`, `_trackStop`, `_waitForStop`, `_stopTask`) into a subclass in a Consig-only file, so the upstream file keeps only the `_init*` methods. Or offer it upstream (`FORK-SERIAL`, `RECORD-DEDUP`).
4. `create-call.js` early-media block (about 150 lines in `connectStream`) into `lib/utils/early-media.js` with one call.
5. Replace `WS-PAYLOAD` with the env var. Offer `BGTASK-GUARDS`, `DIAL-OUTBOUND-SBC`, `LISTEN-FAIL-STOP`, `LOG-REDACT` upstream; each removed entry shrinks the next merge.
6. Fix the two known defects found while documenting: `this.logger` in `beep-utils.js` `stopBeep`; and the doc/code mismatch in `SBC_HEALTH_MONITORING.md` ("auto-recovery"). Not done: this task changed comments only.

## Conventions

1. Every Consig block in an upstream file starts with `// CONSIG: <ID> ...` and says what it does, why, and a pointer (`consigai/<repo>#<n>`, contract section, or the ledger id). Longer blocks use `// CONSIG: begin <name>` and `// CONSIG: end <name>`. Consig-only files carry a header comment: purpose, why it is separate, who calls it, invariants.
2. One ledger entry per divergence, added in the same commit as the change. A change that touches an upstream file with no entry is not finished.
3. Each entry has a test that fails if the behaviour is removed. "none (gap)" in the table is debt, not a goal.
4. Put logic in Consig-only files and keep the upstream-file diff to call sites.
5. Do not name speech vendors or customers in new identifiers, comments or docs. Never log transcript text or signed URLs above debug.
6. Branch names double as image names today: a push to `consig-*` publishes an image whose tag is the branch name with `.` and `-` replaced by `_` (`consig-0.9.5-8n` is image `consig_0_9_5_8n`). One change per branch, next letter, never reuse a letter.

Branches (from commit messages, 2026-11-26):

| branch | purpose |
|---|---|
| `consig-0.9.5-8a` | merge of upstream and the earlier Consig lines (beep, SBC health, early-media transcription checkpoint) on `v0.9.5-8` |
| `consig-0.9.5-8b` | stop early-media transcription correctly |
| `consig-0.9.5-8c` | manage early-media transcription on call status changes |
| `consig-0.9.5-8d` | early-media transcription on answer |
| `consig-0.9.5-8e` | forward `partialResultHook` from `bargeIn` to the background gather |
| `consig-0.9.5-8f` | dial: do not reuse the ingress SBC for inbound-call dial legs (#777) |
| `consig-0.9.5-8g` | dial: same fix as an opt-in flag (#777) |
| `consig-0.9.5-8h` | Valkey failover reconnect (consig-cdk-jam#155), CI runner fix. Pinned on `prod-USE1` and `prod-CAC1B` (2026-11-26) |
| `consig-0.9.5-8i` | persistent speech-engine connection for transcribe (env-gated). A side line, not under `8j` to `8n` |
| `consig-0.9.5-8j` | speech event relay and drive-mode cut |
| `consig-0.9.5-8k` | drive cut also stops endpoint audio and the TTS stream |
| `consig-0.9.5-8l` | `listen_id` on every relay; `task_ended` after the fork stops |
| `consig-0.9.5-8m` | failed speech listen stops its own fork |
| `consig-0.9.5-8n` | review fixes: recording safety, admission, serialised stop and start, log allowlist. Pinned on dev (2026-11-26) |

Older lines (`consig-beep-events*`, `consig-0.9.4.1c-earlymedia`, `consig-0.9.5-rc*`, `consig-main`) predate this scheme.
