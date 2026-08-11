---
name: manage-terminal-apron-tasks
description: Read, filter by project, inspect attached issue screenshots, report, and update development work stored in Terminal Apron TaskMonitor. Use when Codex is assigned a TaskMonitor task, needs to inspect its project, Markdown requirements, screenshots or acceptance criteria, submit milestone/verification reports, mark a blocker, or hand completed work to acceptance through the Terminal Apron API.
---

# Manage Terminal Apron Tasks

Use the bundled CLI to communicate with TaskMonitor through its authenticated HTTP API. Never open or modify `task-monitor.sqlite` directly.

## Required workflow

1. Resolve the assigned task from the prompt or `TASK_MONITOR_TASK_ID`.
2. Run `context` before making changes:

   ```sh
   node .agents/skills/manage-terminal-apron-tasks/scripts/task-monitor.mjs context <task-id-or-key>
   ```

3. Read the task description, acceptance criteria, repository path, latest report, and applicable `AGENTS.md` files. `context` downloads every screenshot and returns an absolute `localPath`; inspect each relevant image with the available image-viewing tool before changing code.
4. Report the start of work with a concrete summary:

   ```sh
   node .agents/skills/manage-terminal-apron-tasks/scripts/task-monitor.mjs start <task> --summary "Reproduced the login redirect race and located the affected callback."
   ```

5. Submit a report after a meaningful milestone. Include changed files, verification evidence, risks, blockers, and the next step when relevant.
6. If work pauses for a human choice, approval, credential, destructive action, or unclear product decision, run `confirm` before asking the user. Do not continue until the confirmation is received.
7. Before completion, run the agreed verification. Use `complete` to move the task to `pending_auto_acceptance`; do not mark it `done`, because automatic and human acceptance have not yet passed.

## Reporting commands

Progress report:

```sh
node .agents/skills/manage-terminal-apron-tasks/scripts/task-monitor.mjs report <task> \
  --summary "Implemented callback state validation." \
  --changed-file src/auth/callback.ts \
  --passed "npm test -- auth" \
  --next "Add the browser regression case."
```

Blocked report:

```sh
node .agents/skills/manage-terminal-apron-tasks/scripts/task-monitor.mjs block <task> \
  --summary "Cannot reproduce without the production callback trace." \
  --blocker "Missing sanitized callback trace" \
  --next "Resume after the trace is attached."
```

Human confirmation request:

```sh
node .agents/skills/manage-terminal-apron-tasks/scripts/task-monitor.mjs confirm <task> \
  --summary "Choose whether the login migration should invalidate existing sessions." \
  --next "Continue with the selected compatibility policy."
```

Completion handoff:

```sh
node .agents/skills/manage-terminal-apron-tasks/scripts/task-monitor.mjs complete <task> \
  --summary "Fixed the redirect race and added regression coverage." \
  --changed-file src/auth/callback.ts \
  --changed-file src/auth/callback.test.ts \
  --passed "npm test -- auth" \
  --passed "npm run typecheck"
```

Use repeated `--passed`, `--failed`, or `--not-run` flags for verification results. A completion report must include at least one verification entry; use `--not-run` with an honest reason if verification cannot be executed.

## Terminal state markers

The bundled CLI emits a machine-readable `TASK_MONITOR_STATE` line after every state-changing report. Keep that line visible in terminal output; TaskMonitor reads the latest marker to distinguish `working`, `needs_confirmation`, and `completed`. Never imitate a confirmation marker without first submitting the corresponding `confirm` or `block` report.

- `start` and `report` emit `TASK_MONITOR_STATE: working`.
- `confirm` and `block` emit `TASK_MONITOR_STATE: needs_confirmation`.
- `complete` emits `TASK_MONITOR_STATE: completed`.

After `confirm`, ask one concrete question and wait. After the user answers, resume with `report` so the terminal returns to `working`.

## Quality and safety rules

- Report observed facts only. Never claim a command passed unless it ran successfully.
- Treat downloaded screenshot `localPath` values as task evidence. If a download reports `downloadError`, report it instead of claiming the image was inspected.
- Use `block` when progress cannot continue; include the exact blocker and needed external action.
- Include all materially changed files and any unverified behavior in the report.
- Keep summaries concise and actionable. Do not paste secrets, credentials, full logs, or large diffs.
- Never print `TASK_MONITOR_PASSWORD` or `TASK_MONITOR_COOKIE`.
- Do not manipulate Terminal or Zellij sessions through this skill. TaskMonitor owns allocation and lifecycle operations.
- If the API is unavailable, retain the report locally in the current response and state that TaskMonitor was not updated.

Read [references/api-contract.md](references/api-contract.md) for connection/authentication details or API failures. Read [references/report-schema.md](references/report-schema.md) when constructing a complex report or calling the API without the CLI.
