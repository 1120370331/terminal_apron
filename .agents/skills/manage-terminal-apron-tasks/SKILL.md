---
name: manage-terminal-apron-tasks
description: Read, filter by project, inspect attached issue screenshots, report, and update development work stored in Terminal Apron TaskMonitor. Use when Codex is assigned a TaskMonitor task, needs to inspect its project, Markdown requirements, screenshots or acceptance criteria, submit milestone/verification reports, mark a blocker, or hand completed work to acceptance through the Terminal Apron API.
---

# Manage Terminal Apron Tasks

Use the bundled CLI to communicate with TaskMonitor through its authenticated HTTP API. Never open or modify `task-monitor.sqlite` directly.

The CLI automatically reuses the current TaskMonitor user's local credential when TaskMonitor has provisioned one. Do not open, print, copy, or embed `.task-monitor-credential.json`; invoke the CLI normally and let it load the credential privately.

Resolve the directory containing this `SKILL.md` as `<task-skill-dir>`. Invoke bundled files through that absolute directory; never assume the current task repository contains this skill.

When the user explicitly asks to maintain TaskMonitor records, the same CLI provides JSON-native `list`, `projects`, `groups`, `tags`, `create`, `show`, `update`, `archive`, `restore`, `attachments`, and image `upload` commands. Use `delete --yes` only when the user explicitly authorizes permanent deletion. Run `help` for the field options; task updates use optimistic revisions and a `409` must be resolved by reloading context rather than retrying blindly.

## Required workflow

1. Resolve the assigned task from the prompt or `TASK_MONITOR_TASK_ID`.
2. Run `context` before making changes:

   ```sh
   node "<task-skill-dir>/scripts/task-monitor.mjs" context <task-id-or-key>
   ```

3. Read the task description, acceptance criteria, repository path, latest report, and applicable `AGENTS.md` files. `context` downloads every screenshot and returns an absolute `localPath`; inspect each relevant image with the available image-viewing tool before changing code.
   The command also refreshes the durable task context workspace and returns `contextDirectory` plus canonical artifact contents. Treat that directory as the task working root; read `context.md` before resuming, and `cd` to `repositoryPath` only when inspecting or changing the target project.
4. Report the start of work with a concrete summary:

   ```sh
   node "<task-skill-dir>/scripts/task-monitor.mjs" start <task> --summary "Reproduced the login redirect race and located the affected callback."
   ```

5. Submit a report after a meaningful milestone. Include changed files, verification evidence, risks, blockers, and the next step when relevant.
6. If work pauses for a human choice, approval, credential, destructive action, or unclear product decision, run `confirm` before asking the user. Do not continue until the confirmation is received.
7. Before completion, run the agreed verification. Use `complete` to move the task to `pending_auto_acceptance`; do not mark it `done`, because automatic and human acceptance have not yet passed.

## Task tags

Agents may query the task's project tag catalog and maintain tags on the assigned task through the same authenticated CLI:

```sh
node "<task-skill-dir>/scripts/task-monitor.mjs" tags --project "NanoPPT"
node "<task-skill-dir>/scripts/task-monitor.mjs" tag <task-id-or-key> --add "前端" --add "界面优化"
node "<task-skill-dir>/scripts/task-monitor.mjs" tag <task-id-or-key> --remove "待验收"
```

Project catalogs include built-in development tags and remembered project tags, including tags currently used by no tasks. A task supports up to 12 tags, each up to 40 characters. Prefer existing project tags. Add/remove operations preserve unrelated labels and concurrent task updates. Use `--set` or `--clear` only when replacement is explicitly intended; these operations use optimistic revisions. Tags classify the task and do not replace its execution status. Never remove human labels merely to impose a different taxonomy.

## Reporting commands

Progress report:

```sh
node "<task-skill-dir>/scripts/task-monitor.mjs" report <task> \
  --summary "Implemented callback state validation." \
  --changed-file src/auth/callback.ts \
  --passed "npm test -- auth" \
  --release-status local_complete \
  --next "Add the browser regression case."
```

Blocked report:

```sh
node "<task-skill-dir>/scripts/task-monitor.mjs" block <task> \
  --summary "Cannot reproduce without the production callback trace." \
  --blocker "Missing sanitized callback trace" \
  --next "Resume after the trace is attached."
```

Human confirmation request:

```sh
node "<task-skill-dir>/scripts/task-monitor.mjs" confirm <task> \
  --summary "Choose whether the login migration should invalidate existing sessions." \
  --next "Continue with the selected compatibility policy."
```

Completion handoff:

```sh
node "<task-skill-dir>/scripts/task-monitor.mjs" complete <task> \
  --summary "Fixed the redirect race and added regression coverage." \
  --changed-file src/auth/callback.ts \
  --changed-file src/auth/callback.test.ts \
  --passed "npm test -- auth" \
  --passed "npm run typecheck"
```

Use repeated `--passed`, `--failed`, or `--not-run` flags for verification results. A completion report must include at least one verification entry; use `--not-run` with an honest reason if verification cannot be executed.

Use `--release-status local_complete` only after the required local verification actually passed. Use `--release-status production_complete` only after observing the target 生产环境 deployment succeed; a local build, test, or package is not production evidence. Omit the flag when the report does not establish a release milestone. Use `not_released` only to record an intentional manual rollback/reset.

## Terminal state markers

The bundled CLI emits a machine-readable `TASK_MONITOR_STATE` line after every state-changing report. Keep that line visible in terminal output; TaskMonitor reads the latest marker to distinguish `working`, `needs_confirmation`, and `completed`. Never imitate a confirmation marker without first submitting the corresponding `confirm` or `block` report.

- `start` and `report` emit `TASK_MONITOR_STATE: working`.
- `confirm` and `block` emit `TASK_MONITOR_STATE: needs_confirmation`.
- `complete` emits `TASK_MONITOR_STATE: completed`.

After `confirm`, ask one concrete question and wait. After the user answers, resume with `report` so the terminal returns to `working`.

## Quality and safety rules

- Report observed facts only. Never claim a command passed unless it ran successfully.
- Keep release progress independent from task processing progress. Never infer a release milestone from `completed`, `pending_auto_acceptance`, or `done`.
- Treat downloaded screenshot `localPath` values as task evidence. If a download reports `downloadError`, report it instead of claiming the image was inspected.
- Use `block` when progress cannot continue; include the exact blocker and needed external action.
- Include all materially changed files and any unverified behavior in the report.
- Keep summaries concise and actionable. Do not paste secrets, credentials, full logs, or large diffs.
- Never print `TASK_MONITOR_PASSWORD` or `TASK_MONITOR_COOKIE`.
- Never read or print `TASK_MONITOR_CREDENTIAL_FILE` or `.task-monitor-credential.json`; they contain the current user's short-lived local session credential.
- Do not manipulate Terminal or Zellij sessions through this skill. TaskMonitor owns allocation and lifecycle operations.
- If the API is unavailable, retain the report locally in the current response and state that TaskMonitor was not updated.

Read [references/api-contract.md](references/api-contract.md) for connection/authentication details or API failures. Read [references/report-schema.md](references/report-schema.md) when constructing a complex report or calling the API without the CLI.
