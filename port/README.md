> **Note for this repo.** The Port blueprints, entities and actions here are the
> declarative catalogue model — they are checked in as data and need no credentials to
> read. The `port:validate` / `port:sync` runner scripts referenced below live in the
> Zero Downtime repo, not this one; the commands are kept for reference so the model
> stays traceable to the workflow that applies it.

# Port integration

This directory is the Git-controlled source of truth for the Port factory control plane. The original product-neutral delivery workflow remains intact, and Mend's constrained SERPINA1/AATD X/Y/Z catalog is layered on top of it.

## Repository artifacts

- `blueprints/` models project context, replaceable services, workflow runs, decisions, the scientific brief, X/Y/Z integrations, generated software changes, and repair requests.
- `entities/` seeds goals, constraints, technical choices, risks, and service boundaries.
- `actions/submit-change.json` starts plan/build/test from a brief.
- `actions/release-change.json` is a separate day-2 action with `requiredApproval: true`. A Port decline leaves the backend uninvoked.
- `actions/retry-run.json` reruns the failed stage with the same workflow/correlation identifier.
- `.github/workflows/port-delivery.yml` is the backend shared by all three actions.
- `scripts/lib/port-workflow.mjs` implements the local state machine and audit trail.

## Mend X/Y/Z control-plane model

The active scientific brief is `mendScientificBrief/serpina1-aatd-xyz`. Its three `mendAxisIntegration` entities make X, Y, and Z independently visible, including their source, versioned adapter path, factory version, health state, last record count, and evidence requirement. X explicitly records Bright Data as its acquisition provider.

`mendSoftwareChange` is the human review packet. It requires the proposed factory version, author, Git ref, changed files, test command, structured test evidence, affected integrations, workflow run, and an audit list. A change may be approved through the existing **Approve and release change** action only after the workflow reaches `awaiting_approval`; rejection never invokes the release backend.

`mendRepairRequest` records the isolated X failure without overwriting the healthy dataset. It requires the failed run, previous and current counts, quarantine state, last-known-good state, validation reason, and the repair artifacts the coding agent must produce. The eventual repair change and human `zdDecision` link back to it, preserving the failure-to-recovery audit chain.

Validated payload examples are deliberately not seeded because their workflow IDs, Git evidence, reviewer, and timestamps must come from a real run:

- `fixtures/port/software-change-v1.json`
- `fixtures/port/x-repair-request.json`
- `fixtures/port/repair-approval.json`

Replace every `REPLACE_WITH_*` value with evidence from the actual GitHub/Port run before upserting an example. Never mark `candidate-v1` as deployed or an integration as healthy merely because its repository tests pass; those state transitions require the live approval and runtime evidence described in the critical-slice spec.

The repeatable state path is:

```text
brief -> plan -> build -> test -> awaiting_approval -> release -> audit
                         |                |
                         v                v
                 retry_pending        rejected
                         |
              retry or escalated
```

A changed brief increments `requirement_revision`, derives a new plan and hash, reruns verification, and records `plan_revised`; it does not replay a fixed plan.

## Credential-free smoke test (validated locally)

```sh
npm ci
npm run port:smoke
npm run port:prepare
npm run port:release
```

Inspect `artifacts/port/local-demo/run.json`. It contains the brief, derived plan/hash, build/test/release outputs, correlation ID, approval actor, and ordered audit events.

Approval rejection:

```sh
node scripts/port-workflow.mjs prepare --brief fixtures/port/brief.json --run-id rejected-demo
node scripts/port-workflow.mjs release --run-id rejected-demo --decision reject --actor local-reviewer --reason "Evidence incomplete"
```

Controlled failure, successful retry, and approval:

```sh
node scripts/port-workflow.mjs prepare --brief fixtures/port/brief.json --run-id retry-demo --fail-stage test
node scripts/port-workflow.mjs retry --run-id retry-demo
node scripts/port-workflow.mjs release --run-id retry-demo --decision approve --actor local-reviewer
```

The first command intentionally exits nonzero with `retry_pending`. To prove escalation, pass `--fail-stage test` to both retry commands; the third failed attempt becomes `escalated` because `max_retries` is two.

Requirement change:

```sh
node scripts/port-workflow.mjs prepare --brief fixtures/port/brief.json --run-id revision-demo
node scripts/port-workflow.mjs revise --brief fixtures/port/revised-brief.json --run-id revision-demo
```

Compare the two `plan_hash` values in command output and inspect the `plan_revised` audit event.

`npm run port:sync` is dry-run only and makes no network changes. No Port credentials or UI access are needed for any command above.

## Port account setup (user-required; not locally validated)

1. Install Port's GitHub integration for the repository and permit it to dispatch `.github/workflows/port-delivery.yml`.
2. In ignored `.env.local`, set `PORT_CLIENT_ID`, `PORT_CLIENT_SECRET`, `PORT_GITHUB_ORG`, and `PORT_GITHUB_REPO`. Use `PORT_API_URL=https://api.us.port.io` for a US-region account; the default is the EU API.
3. Add `PORT_CLIENT_ID` and `PORT_CLIENT_SECRET` as GitHub Actions repository secrets. Do not put their values in Port JSON, workflow inputs, logs, or commits.
4. Run `npm run port:validate`, then `npm run port:sync -- --live`. The sync creates or replaces the eight blueprints, seed entities, and three generic workflow actions. Re-running it is idempotent. Validated example payloads are not automatically synced.
5. Restrict action execution/approval RBAC in Port to the intended teams or users. Assign approvers to `zd_release_change`; its repository definition enforces manual approval and disables outbound approval notifications.
6. After each real build or repair workflow, upsert the corresponding software-change, repair-request, and decision payloads using the action run ID for correlation. Attach the Git compare/commit URL and GitHub test artifact before requesting approval.

If API sync is unavailable, create the blueprints in manifest order, then seed entities, then create the actions by pasting their JSON in Port. Replace the two `REPLACE_WITH_GITHUB_*` values when using this manual route.

## Connected smoke test (user-required)

1. Run **Submit brief or change** with the values from `fixtures/port/brief.json`.
2. Confirm its GitHub run passes validation/build/test and the resulting `zdWorkflowRun` entity is `awaiting_approval` with a matching correlation ID and attached Port action-run history.
3. Run **Approve and release change** on that entity. First decline it and confirm no GitHub workflow is dispatched. Run it again, approve it, and confirm status `released` with approval and audit events.
4. Trigger a controlled failure in a local/demo branch with `--fail-stage test`, sync its run artifact, and invoke **Retry failed run**. Repeat failure through the retry budget to confirm `escalated`, or omit the flag to confirm successful recovery.
5. Submit the revised fixture and confirm the revision and plan hash change. Repeat the original brief with a new run ID to confirm no manual reconstruction is required.

The repository validates schemas, relationships, action wiring, approval policy, rejection behavior, bounded retry/escalation, requirement-driven replanning, and repeatability. Port account creation, GitHub installation/dispatch, live action history, approver RBAC, and UI evidence remain user-required because this repository has no Port credentials or authenticated UI session.
