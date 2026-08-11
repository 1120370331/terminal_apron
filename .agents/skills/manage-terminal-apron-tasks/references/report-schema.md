# Task report schema

`POST /api/tasks/:id/reports` accepts:

```json
{
  "status": "progress",
  "summary": "Implemented login form validation",
  "changedFiles": ["src/login.tsx"],
  "verification": [
    {
      "command": "npm test",
      "result": "passed",
      "details": "17 tests passed"
    }
  ],
  "risks": [],
  "blockers": [],
  "nextStep": "Add browser regression coverage",
  "taskStatus": "in_progress"
}
```

## Fields

- `status` (required): `started`, `progress`, `blocked`, `completed`, or `note`.
- `summary` (required): concise Markdown-free report text, maximum 2,000 characters.
- `changedFiles`: up to 50 repository-relative paths.
- `verification`: up to 20 entries. `result` is `passed`, `failed`, or `not_run`.
- `risks` and `blockers`: up to 20 concise entries each.
- `nextStep`: the next executable action, maximum 2,000 characters.
- `taskStatus`: optional TaskMonitor stage: `not_started`, `in_progress`, `pending_auto_acceptance`, `pending_manual_acceptance`, `done`, or `blocked`.

TaskMonitor applies safe defaults:

- `started` moves `not_started` tasks to `in_progress`.
- `blocked` moves the task to `blocked`.
- `completed` moves the task to `pending_auto_acceptance`, never directly to `done`.

The report insert and task update occur in one SQLite transaction through the backend service.

For a human decision that is required before work can continue, use the CLI `confirm` command. It submits a `note` report without changing the discrete task stage and emits `TASK_MONITOR_STATE: needs_confirmation` in the Terminal output for the live monitor.
