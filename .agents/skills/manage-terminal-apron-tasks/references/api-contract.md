# TaskMonitor API contract

## Connection

The CLI reads these environment variables:

- `TASK_MONITOR_URL`: Terminal Apron origin shared by Terminal Monitor and TaskMonitor; defaults to `http://127.0.0.1:3131`.
- `TASK_MONITOR_TASK_ID`: default task UUID or key such as `TA-42`.
- `TASK_MONITOR_COOKIE`: an existing HTTP Cookie header value.
- `TASK_MONITOR_USER` and `TASK_MONITOR_PASSWORD`: optional password-login credentials. The user defaults to `admin` only when a password is supplied.

The CLI first calls the requested endpoint. On HTTP 401 it performs `POST /api/auth/login` when username/password credentials are available, stores the returned session cookie in memory, and retries once. It never persists or prints credentials.

## Endpoints used by the skill

- `GET /api/tasks`: list active tasks; accepts `q`, `status`, and exact `project` filters. Use an empty `project` value for unassigned tasks.
- `GET /api/tasks?archived=true`: list archived tasks when resolving a task key.
- `GET /api/tasks/projects`: list project names, root directories, and task counts for project-aware assignment.
- `GET /api/tasks/:id`: fetch full task context.
- `GET /api/tasks/:id/reports?limit=50`: fetch report history.
- `GET /api/tasks/:id/attachments/:attachmentId/content`: fetch an authenticated issue screenshot. The CLI `context` command downloads these files and exposes absolute `localPath` values.
- `POST /api/tasks/:id/reports`: create a structured report and update the discrete task stage atomically.

The CLI `confirm` command records a `note` report and then prints a terminal-only `TASK_MONITOR_STATE: needs_confirmation` marker. The marker is intentionally not a database task stage; it represents a live Codex conversation waiting for human input.

Task keys are presentation identifiers, not route IDs. The CLI resolves keys such as `TA-42` against active and archived task lists before calling task-specific endpoints.

## Failure handling

- `400`: fix invalid report fields; do not retry unchanged input.
- `401`: provide a session cookie or password credentials through the environment.
- `404`: verify the task UUID/key and current TaskMonitor server.
- `409`: reload context before attempting another mutation.
- `5xx` or network error: do not claim TaskMonitor was updated. Preserve the intended report in the user-facing handoff.

Never bypass these errors by reading or editing SQLite directly.
