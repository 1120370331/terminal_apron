# TaskMonitor API contract

## Connection

The CLI reads these environment variables:

- `TASK_MONITOR_URL`: Terminal Apron origin shared by Terminal Monitor and TaskMonitor; defaults to `http://127.0.0.1:3131`.
- `TASK_MONITOR_TASK_ID`: default task UUID or key such as `TA-42`.
- `TASK_MONITOR_COOKIE`: an existing HTTP Cookie header value.
- `TASK_MONITOR_CREDENTIAL_FILE`: optional path to the current user's locally provisioned credential file. TaskMonitor normally provisions and discovers this automatically for Task workspaces.
- `TASK_MONITOR_USER` and `TASK_MONITOR_PASSWORD`: optional password-login credentials. The user defaults to `admin` only when a password is supplied.

Authentication order is: explicit `TASK_MONITOR_COOKIE`, a valid locally provisioned current-user credential, then password login on HTTP 401. Local credential URLs must resolve to loopback, expired or malformed files are ignored, and credential contents are never printed. The CLI stores a login cookie in memory only and retries once.

## Endpoints used by the skill

- `GET /api/tasks`: list active tasks; accepts `q`, `status`, `releaseStatus`, exact `project`, exact `group`, and repeatable exact `tag` filters. Use an empty `project` value for unassigned tasks.
- `GET /api/tasks?archived=true`: list archived tasks when resolving a task key.
- `GET /api/tasks/projects`: list project names, root directories, and task counts for project-aware assignment.
- `GET /api/tasks/groups` and `GET /api/tasks/tags`: list available filter values and their active task counts.
- `GET /api/tasks/tags?project=NanoPPT&catalog=true`: project tag catalog, including built-in development tags and remembered custom labels. Each entry has `name`, `taskCount`, and optional `builtin`.
- `PATCH /api/tasks/:id/tags`: atomically add/remove labels with `{ "add": ["前端"], "remove": ["待验收"] }`, or replace explicitly with `{ "tags": ["前端"], "revision": 12 }`. Only labels change; execution continues. Maximum 12 labels of 40 characters each.
- `GET /api/tasks/:id`: fetch full task context.
- `POST /api/tasks/:id/context/refresh`: atomically refresh the task workspace and ancestor summaries; returns the task including `contextDirectory`, `parentTask`, and `subtasks`.
- `GET /api/tasks/:id/reports?limit=50`: fetch report history.
- `GET /api/tasks/:id/attachments/:attachmentId/content`: fetch an authenticated issue screenshot. The CLI `context` command downloads these files and exposes absolute `localPath` values.
- `POST /api/tasks/:id/reports`: create a structured report and atomically update the discrete task stage and/or independent release stage.

## Management surface

The same authenticated CLI also exposes task-management commands for a human operator or an agent that has been explicitly asked to maintain task records:

- `create`, `show`, `update`, `archive`, `restore`, and guarded `delete --yes` map to the equivalent task REST operations.
- `create-project` and `update-project` map to `POST/PATCH /api/tasks/projects`.
- `attachments` reads task attachment metadata; `upload` posts content-validated PNG, JPEG, WebP, or GIF files to `POST /api/tasks/:id/attachments`.

Task updates include a revision. When a revision conflict returns `409`, reload the task and decide whether the intended edit is still valid; do not retry by blindly replacing the server version. `delete --yes` is intentionally irreversible and only succeeds for leaf tasks, so normal lifecycle operations should use `archive` and `restore`.

The CLI `confirm` command records a `note` report and then prints a terminal-only `TASK_MONITOR_STATE: needs_confirmation` marker. The marker is intentionally not a database task stage; it represents a live Codex conversation waiting for human input.

Task keys are presentation identifiers, not route IDs. The CLI resolves keys such as `TA-42` against active and archived task lists before calling task-specific endpoints.

## Failure handling

- `400`: fix invalid report fields; do not retry unchanged input.
- `401`: open TaskMonitor as the current user so it can refresh the local credential, or provide a credential file, session cookie, or password credentials through the environment.
- `404`: verify the task UUID/key and current TaskMonitor server.
- `409`: reload context before attempting another mutation.
- `5xx` or network error: do not claim TaskMonitor was updated. Preserve the intended report in the user-facing handoff.

Never bypass these errors by reading or editing SQLite directly.
