# ZenTao / TAPD external task sync

Support includes ZenTao REST API v1 product Bugs and TAPD Open API Bugs, Stories and Tasks. Real deployment compatibility remains unverified; local validation uses mock HTTP trackers with actual providers, host routes and task stores. Provider metadata drives the shared configuration UI; see the [extension contract](./external-providers.md).

Open board settings and choose **External sync** in the left sidebar. Original options are under **General**; drafts survive menu switches. ZenTao saves a login username and password, using its installation URL without `/api.php/v1`. TAPD supports API Basic Auth or a supplied Bearer Access Token. Explicitly configure the assignee and item types; login/API identities are not necessarily assignee identities.

ZenTao defaults to syncing tasks assigned to the login username. Uncheck “Sync tasks assigned to this login account” to enter another assignee. Existing connections with a different assignee retain that selection. TAPD still requires a separate assignee nickname.

Map product/project IDs to local workspaces. Discover projects from the current form without saving; TAPD discovery also requires a company ID and member nickname. Save before testing or syncing. Blank credentials retain saved values only within an unchanged provider/server/assignee/authentication scope. Changing auth mode requires new credentials but preserves source identity; changing provider/server/assignee establishes a new identity. Old ZenTao token configurations are not supported; configure a username and password.

Use the optional creation date to limit initial imports. New assigned, unresolved items enter Backlog without starting agents. Polling is disabled at 0, otherwise 5–1440 minutes. ZenTao logs in through `POST /api.php/v1/tokens`, reuses its in-memory token within an operation and renews it once after HTTP 401/403. Only username/password configuration is supported; old saved tokens are not loaded or migrated. Saved login usernames are shown again; passwords and generated tokens are never returned by status or task exports. Passwords remain in the host-only plaintext connection file.

ZenTao scans all statuses by page. TAPD scans serially using `order=id desc` and the last string ID as `cursor`, avoiding deep-page limits. Both write content changes only and do not maintain modified-time watermarks. Unchanged cards keep their version. Connection results show the latest successful scan; source metadata shows when its content was last updated locally.

TAPD matches exact semicolon-separated assignee nicknames. Terminal status values default to `closed,resolved,done,rejected`; configure custom workflows explicitly. Priority labels are preserved and configurable urgent/low label lists determine local urgency; unknown values map to normal. This feature does not implement OAuth authorization UI or automatic token renewal.

Identity includes connection, product, type and opaque external ID. Untouched title/description/priority fields follow external updates. Conflicting local edits remain intact and can be resolved in task details. In-progress/review cards keep their content and display conflicts; running tasks cannot resolve conflicts. Completed/canceled cards update only source status and assignees without content conflicts. Archived cards stop updating.

External closure/reassignment does not change local status, claims, comments, checklists, models, branches, execution history or reports. Missing external items are retained. Deleted local items are excluded from reimport; settings can clear all exclusions. Mapping changes affect new cards only. Clearing exclusions does not duplicate cards still in the trash.

Only one scan runs per connection. All mappings/pages must succeed before committing. HTTP 429/5xx retry at most twice; each request times out after 30 seconds and scans after five minutes. Stop sync cancels requests; plugin disposal also cancels work and timers.

The host-only `dsh-taskboard-external.json` under active DSH_HOME stores credentials **in plaintext** and connection configuration. It uses current-user file permissions; it is not encrypted using an OS credential vault. It stays outside board data-directory migration and ordinary task exports. Public status returns presence flags and explicitly non-secret usernames; never passwords or tokens. Protect this file when backing up or moving the connection. Preserve connection identity when restoring backups.

The ledger's `externalSync` field stores source links, deletion exclusions, scan results, failures and attempt timestamps. Successful scans commit this metadata and tasks in one atomic write. Failed scans persist only error status. This non-secret metadata follows board exports and data-directory migration; existing runtime metadata from valid username/password connections is migrated once. ZenTao requests default to a configurable 200 ms minimum interval (0–10000 ms; 0 disables throttling). Unrelated new items are filtered before detail requests, while linked items retain reassignment/closure checks.

Only one active connection is stored. Not included: ZenTao stories/tasks, attachments, webhooks, write-back, concurrent multiple connections or a separate Inbox. Tracker rich text becomes inert text. ZenTao uses standard query links and TAPD uses official-site work item links; customized/private routing needs adaptation.

References: [v1 setup](https://www.zentao.net/book/api/1397.html), [product Bugs](https://www.zentao.net/book/api/720.html), [all statuses](https://www.zentao.net/ask/596733.html).

TAPD references: [Bugs](https://open.tapd.cn/document/api-doc/API文档/api_reference/bug/get_bugs.html), [Stories](https://open.tapd.cn/document/api-doc/API文档/api_reference/story/get_stories.html), [Tasks](https://open.tapd.cn/document/api-doc/API文档/api_reference/task/get_tasks.html), [authentication/query/cursors](https://open.tapd.cn/document/api-doc/API文档/使用必读.html), [participant projects](https://open.tapd.cn/document/api-doc/API文档/api_reference/workspace/user_participant_projects.html).
