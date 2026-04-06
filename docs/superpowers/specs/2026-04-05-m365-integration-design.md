# Microsoft 365 CLI Integration — Design Spec

## Overview

Integrate the Microsoft 365 CLI (`m365`) into smolerclaw as an intelligent wrapper, making smolerclaw a first-class citizen for controlling Microsoft 365 suites on Windows. The integration uses device code flow for authentication, caches results with per-resource TTL, composes multi-command actions, and exposes everything under the `/m365` namespace in the TUI.

## Phases

- **Phase 1**: Personal productivity — Outlook (emails, calendar, contacts), OneDrive, To Do, OneNote
- **Phase 2**: Collaboration — Teams, SharePoint, Planner
- **Phase 3**: Administration — Azure AD, Power Automate, licenses

This spec covers **Phase 1** implementation. Phases 2 and 3 follow the same patterns.

## Architecture

### Directory Structure

```
src/m365/
  index.ts          — barrel exports, registration
  auth.ts           — device code login, status, logout
  executor.ts       — m365 CLI subprocess wrapper + JSON parsing
  cache.ts          — TTL-based in-memory cache
  outlook.ts        — emails, calendar, contacts
  onedrive.ts       — files, sharing
  todo.ts           — task lists, tasks
  onenote.ts        — notebooks, pages
  tools.ts          — Claude tool schemas
  commands.ts       — TUI /m365 command handler
  types.ts          — shared M365 types
```

### Executor

Core subprocess wrapper for `m365` CLI:

- Runs `m365 <command> --output json` via `Bun.spawn`
- Parses JSON output, falls back to raw text on parse failure
- Configurable timeout (default 30s)
- Detects auth expiration errors and prompts re-login
- Returns typed `M365Result<T>` with success/error discrimination
- Checks `m365` is installed on first call; shows install instructions if missing

### Cache

In-memory TTL cache keyed by command string:

| Resource   | TTL    |
|------------|--------|
| emails     | 2 min  |
| calendar   | 5 min  |
| files      | 5 min  |
| contacts   | 30 min |
| todo       | 3 min  |
| onenote    | 10 min |

- Manual invalidation via `/m365 refresh`
- Bypass with `--fresh` flag on any command
- Cache is per-session (cleared on restart)

### Authentication

- **Method**: Device code flow (`m365 login`)
- Token management delegated entirely to m365 CLI (no secrets stored by smolerclaw)
- `m365 status` checked before operations; if not logged in, prompt user
- Event `m365:auth_changed` emitted on login/logout

## Phase 1 — Commands

### Auth Commands

| Command | Action |
|---------|--------|
| `/m365 login` | Initiate device code login |
| `/m365 status` | Show connection status |
| `/m365 logout` | Disconnect |
| `/m365 refresh` | Clear cache |

### Outlook — Email

| Command | m365 CLI mapping |
|---------|-----------------|
| `/m365 emails` | `m365 outlook mail list --output json` |
| `/m365 email read <id>` | `m365 outlook mail get --id <id> --output json` |
| `/m365 email send --to <to> --subject <subj> --body <body>` | `m365 outlook mail send` |

### Outlook — Calendar

| Command | m365 CLI mapping |
|---------|-----------------|
| `/m365 calendar` | `m365 outlook event list --output json` |
| `/m365 calendar add --subject <s> --start <dt> --end <dt>` | `m365 outlook event add` |

### Outlook — Contacts

| Command | m365 CLI mapping |
|---------|-----------------|
| `/m365 contacts` | `m365 outlook contact list --output json` |

### To Do

| Command | m365 CLI mapping |
|---------|-----------------|
| `/m365 todo` | `m365 todo task list --output json` |
| `/m365 todo add <title>` | `m365 todo task add --title <title>` |
| `/m365 todo done <id>` | `m365 todo task set --id <id> --status completed` |
| `/m365 todo lists` | `m365 todo list list --output json` |

### OneDrive

| Command | m365 CLI mapping |
|---------|-----------------|
| `/m365 onedrive [folder]` | `m365 onedrive list --output json` |
| `/m365 onedrive get <path>` | file download via m365 |

### OneNote

| Command | m365 CLI mapping |
|---------|-----------------|
| `/m365 onenote` | `m365 onenote notebook list --output json` |
| `/m365 onenote pages <notebook>` | `m365 onenote page list --output json` |

### Composite Actions

These combine multiple m365 calls in parallel:

| Command | What it does |
|---------|-------------|
| `/m365 briefing` | Parallel fetch: unread emails + today's calendar + pending todos. Summarized via Claude. |
| `/m365 digest` | Weekly activity summary: emails sent/received, meetings attended, tasks completed. |
| `/m365 search <query>` | Unified search across emails + OneDrive files. |
| `/m365 prepare <event-id>` | Meeting prep: event details + recent emails with attendees + shared docs. |

## Claude Tool Schemas

New tools registered when m365 is authenticated:

- `m365_list_emails` — list inbox emails with optional filters
- `m365_read_email` — read a specific email by ID
- `m365_send_email` — send an email
- `m365_list_events` — list calendar events
- `m365_create_event` — create a calendar event
- `m365_list_todos` — list To Do tasks
- `m365_create_todo` — create a To Do task
- `m365_complete_todo` — mark a To Do task as completed
- `m365_list_files` — list OneDrive files
- `m365_briefing` — composite M365 morning briefing

## Integration with Existing Modules

### Briefing (`/briefing`)

When M365 is authenticated, the morning briefing pulls real M365 data instead of Outlook COM:
- Calendar events from M365 API (more reliable than COM)
- Unread email count and top senders
- Pending To Do tasks

### Event Bus

New events:
- `m365:auth_changed` — login/logout state change
- `m365:data_fetched` — emitted after successful data fetch (for plugins)

### Tool Safety

- Read operations: safe (no approval needed)
- Send/create operations: classified as 'write' (approval based on `toolApproval` setting)
- Delete operations: classified as 'dangerous' (always requires confirmation)

## Security

- No tokens or secrets stored by smolerclaw — delegated to m365 CLI
- All m365 commands executed via the existing `Bun.spawn` pattern (not through shell)
- Input sanitization on all user-provided parameters (reuse existing `validatePsInput` patterns)
- Admin commands (Phase 3) disabled by default, enabled via config flag

## Prerequisites

- m365 CLI installed globally: `npm i -g @pnp/cli-microsoft365`
- Microsoft 365 account (personal or organizational)
- First-time setup: `/m365 login` triggers device code flow

## Suggested Future Windows Integrations

After M365, these integrations would complement smolerclaw's Windows-first positioning:

1. **Windows Notifications Center** — read/dismiss notifications programmatically
2. **Windows Terminal profiles** — switch terminal profiles, create new tabs
3. **Windows Credential Manager** — secure secret storage for API keys
4. **Windows Search Index** — query the Windows Search index for local file search
5. **WSL bridge** — execute commands in WSL distros from smolerclaw
6. **Windows Widgets** — smolerclaw widget for at-a-glance briefing
7. **Power Automate Desktop** — trigger/monitor desktop flows
8. **Windows Copilot integration** — bidirectional context sharing
