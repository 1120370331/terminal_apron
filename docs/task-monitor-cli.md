# TaskMonitor CLI

The bundled CLI exposes the authenticated TaskMonitor API as JSON output, so Codex, other coding agents, and ordinary shell automation use the same task data and audit trail as the web UI. It never accesses the SQLite database directly.

From the TaskMonitor skill directory:

```powershell
node "<task-skill-dir>/scripts/task-monitor.mjs" <command>
```

The PowerShell examples below use:

```powershell
$cli = "<task-skill-dir>/scripts/task-monitor.mjs"
```

The CLI reads `TASK_MONITOR_URL` when supplied. Otherwise it uses the current user's locally provisioned loopback credential, and falls back to the local TaskMonitor origin. Do not read, copy, or print the credential file.

## Management commands

```powershell
# Discover work
node $cli list --project "Terminal Apron" --status in_progress --tag codex
node $cli projects
node $cli groups
node $cli tags
node $cli show TA-42

# Maintain project metadata
node $cli create-project --name "Terminal Apron" --root-directory "C:\work\terminal-apron"
node $cli update-project "Terminal Apron" --root-directory "C:\work\terminal-apron"

# Create and update task records
node $cli create --title "Repair task handoff" --project "Terminal Apron" --priority P1 --tag codex --tag bug --description-file .\request.md
node $cli update TA-42 --status in_progress --group "Release train" --revision 7
node $cli update TA-43 --parent TA-42
node $cli update TA-43 --parent none

# Keep a task reversible by default
node $cli archive TA-42
node $cli restore TA-42
node $cli delete TA-42 --yes

# Image evidence accepted by TaskMonitor (PNG, JPEG, WebP, GIF)
node $cli attachments TA-42
node $cli upload TA-42 --file .\failure.png
```

All `list` filters are exact except `--query`: `--status`, `--release-status`, `--project`, `--group`, and repeatable `--tag`. Task fields support inline text or `--description-file` / `--acceptance-file`; passing `--tag` replaces the complete tag list. `update` uses the fetched task revision unless `--revision` is supplied, so concurrent edits return the server's `409` conflict instead of silently overwriting data.

`delete` is deliberately guarded by `--yes`. It permanently removes a leaf task's reports, attachments, context workspace, and associated task links; use archive for normal task closure.

## Agent handoff commands

Workers should begin with `context`, which refreshes the durable task workspace and emits the task, reports, canonical artifacts, and downloaded attachment locations.

```powershell
node $cli context TA-42
node $cli start TA-42 --summary "Located the affected task router."
node $cli report TA-42 --summary "Implemented the CLI surface." --changed-file ".agents/skills/manage-terminal-apron-tasks/scripts/task-monitor.mjs" --passed "npm test"
node $cli complete TA-42 --summary "Local verification passed." --passed "npm test" --passed "npm run typecheck"
```

Use `confirm` before pausing for a human decision and `block` for an external blocker. State markers emitted after report commands are intended for TaskMonitor's live terminal state only; they do not bypass server-side task status transitions.

## HTTP interfaces

The CLI is a thin client for the authenticated `/api/tasks` interface:

| CLI capability | HTTP interface |
| --- | --- |
| task discovery | `GET /api/tasks`, `GET /api/tasks/:id`, `GET /api/tasks/projects`, `GET /api/tasks/groups`, `GET /api/tasks/tags` |
| task and project mutation | `POST/PATCH /api/tasks`, `POST/PATCH /api/tasks/projects`, `POST /api/tasks/:id/archive`, `POST /api/tasks/:id/restore` |
| artifacts | `GET/POST /api/tasks/:id/attachments` and authenticated attachment content URLs |
| agent context and reporting | `POST /api/tasks/:id/context/refresh`, `GET/POST /api/tasks/:id/reports` |

Responses and errors are JSON. Clients must respect `400`, `401`, `404`, and `409` responses, refresh on conflict, and never work around an API failure by editing local task storage.
