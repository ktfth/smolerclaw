import { describe, test, expect, beforeEach } from 'bun:test'
import {
  cacheGet, cacheSet, cacheInvalidate, cacheInvalidatePrefix,
  cacheClear, cacheStats,
} from '../src/m365/cache'
import {
  formatEmailList, formatEventList, formatContactList,
} from '../src/m365/outlook'
import {
  formatTodoList, formatTodoLists,
} from '../src/m365/todo'
import {
  formatFileList,
} from '../src/m365/onedrive'
import {
  formatNotebookList, formatPageList,
} from '../src/m365/onenote'
import {
  formatM365Status,
} from '../src/m365/auth'
import type {
  M365Email, M365Event, M365Contact,
  M365TodoTask, M365TodoList, M365DriveItem,
  M365Notebook, M365OneNotePage, M365ConnectionInfo,
} from '../src/m365/types'
import { CACHE_TTL } from '../src/m365/types'

// ─── Cache Tests ────────────────────────────────────────────

describe('m365 cache', () => {
  beforeEach(() => {
    cacheClear()
  })

  test('cacheGet returns null for missing key', () => {
    expect(cacheGet('nonexistent')).toBeNull()
  })

  test('cacheSet and cacheGet round-trip', () => {
    cacheSet('test-key', { hello: 'world' }, 'emails')
    expect(cacheGet('test-key')).toEqual({ hello: 'world' })
  })

  test('cacheGet returns null for expired entry', () => {
    cacheSet('expired', 'data', 'emails', 1) // 1ms TTL
    // Wait for expiry
    const start = Date.now()
    while (Date.now() - start < 5) { /* busy wait */ }
    expect(cacheGet('expired')).toBeNull()
  })

  test('cacheInvalidate removes specific entry', () => {
    cacheSet('a', 1, 'emails')
    cacheSet('b', 2, 'emails')
    expect(cacheInvalidate('a')).toBe(true)
    expect(cacheGet('a')).toBeNull()
    expect(cacheGet('b')).toBe(2)
  })

  test('cacheInvalidate returns false for missing key', () => {
    expect(cacheInvalidate('missing')).toBe(false)
  })

  test('cacheInvalidatePrefix removes matching entries', () => {
    cacheSet('outlook:mail:1', 'a', 'emails')
    cacheSet('outlook:mail:2', 'b', 'emails')
    cacheSet('todo:tasks', 'c', 'todo')
    const removed = cacheInvalidatePrefix('outlook:')
    expect(removed).toBe(2)
    expect(cacheGet('outlook:mail:1')).toBeNull()
    expect(cacheGet('todo:tasks')).toBe('c')
  })

  test('cacheClear removes all entries', () => {
    cacheSet('a', 1, 'emails')
    cacheSet('b', 2, 'calendar')
    cacheClear()
    expect(cacheStats().size).toBe(0)
  })

  test('cacheStats returns correct info', () => {
    cacheSet('x', 1, 'emails')
    cacheSet('y', 2, 'calendar')
    const stats = cacheStats()
    expect(stats.size).toBe(2)
    expect(stats.keys).toContain('x')
    expect(stats.keys).toContain('y')
  })

  test('cacheStats prunes expired entries', () => {
    cacheSet('short', 'val', 'emails', 1) // 1ms TTL
    cacheSet('long', 'val', 'contacts') // 30min TTL
    const start = Date.now()
    while (Date.now() - start < 5) { /* busy wait */ }
    const stats = cacheStats()
    expect(stats.size).toBe(1)
    expect(stats.keys).toContain('long')
  })
})

// ─── Cache TTL Config Tests ─────────────────────────────────

describe('CACHE_TTL', () => {
  test('has correct TTL values', () => {
    expect(CACHE_TTL.emails).toBe(2 * 60_000)
    expect(CACHE_TTL.calendar).toBe(5 * 60_000)
    expect(CACHE_TTL.files).toBe(5 * 60_000)
    expect(CACHE_TTL.contacts).toBe(30 * 60_000)
    expect(CACHE_TTL.todo).toBe(3 * 60_000)
    expect(CACHE_TTL.onenote).toBe(10 * 60_000)
  })
})

// ─── Outlook Formatting Tests ───────────────────────────────

describe('formatEmailList', () => {
  test('handles empty list', () => {
    expect(formatEmailList([])).toBe('No emails found.')
  })

  test('formats emails with unread indicator', () => {
    const emails: M365Email[] = [
      {
        id: 'abc123def456',
        subject: 'Test Subject',
        from: 'sender@test.com',
        receivedDateTime: '2026-04-05T10:00:00Z',
        isRead: false,
        bodyPreview: 'This is the body preview text',
        importance: 'normal',
      },
      {
        id: 'xyz789ghi012',
        subject: 'Read Email',
        from: 'other@test.com',
        receivedDateTime: '2026-04-05T09:00:00Z',
        isRead: true,
        bodyPreview: 'Already read this one',
        importance: 'high',
      },
    ]
    const result = formatEmailList(emails)
    expect(result).toContain('--- Inbox ---')
    expect(result).toContain('*') // unread indicator
    expect(result).toContain('Test Subject')
    expect(result).toContain('sender@test.com')
    expect(result).toContain('1 unread')
  })
})

describe('formatEventList', () => {
  test('handles empty list', () => {
    expect(formatEventList([])).toBe('No events found.')
  })

  test('formats events with time and location', () => {
    const events: M365Event[] = [
      {
        id: 'evt1',
        subject: 'Team Standup',
        start: '2026-04-05T09:00:00Z',
        end: '2026-04-05T09:30:00Z',
        location: 'Room 1',
        organizer: 'boss@test.com',
        isAllDay: false,
        status: 'confirmed',
      },
    ]
    const result = formatEventList(events)
    expect(result).toContain('--- Calendar ---')
    expect(result).toContain('Team Standup')
    expect(result).toContain('Room 1')
  })
})

describe('formatContactList', () => {
  test('handles empty list', () => {
    expect(formatContactList([])).toBe('No contacts found.')
  })

  test('formats contacts with job title', () => {
    const contacts: M365Contact[] = [
      {
        id: 'c1',
        displayName: 'John Doe',
        emailAddresses: ['john@test.com'],
        phoneNumbers: ['+1234567890'],
        company: 'ACME',
        jobTitle: 'Engineer',
      },
    ]
    const result = formatContactList(contacts)
    expect(result).toContain('John Doe')
    expect(result).toContain('Engineer')
    expect(result).toContain('john@test.com')
  })
})

// ─── To Do Formatting Tests ────────────────────────────────

describe('formatTodoList', () => {
  test('handles empty list', () => {
    expect(formatTodoList([])).toBe('No tasks found.')
  })

  test('formats pending and completed tasks', () => {
    const tasks: M365TodoTask[] = [
      {
        id: 't1',
        title: 'Buy groceries',
        status: 'notStarted',
        importance: 'normal',
        dueDateTime: '2026-04-06T00:00:00Z',
        createdDateTime: '2026-04-05T00:00:00Z',
        listId: 'list1',
      },
      {
        id: 't2',
        title: 'Done task',
        status: 'completed',
        importance: 'normal',
        dueDateTime: null,
        createdDateTime: '2026-04-04T00:00:00Z',
        listId: 'list1',
      },
    ]
    const result = formatTodoList(tasks)
    expect(result).toContain('[ ] Buy groceries')
    expect(result).toContain('1 completed')
  })

  test('shows importance indicator for high priority', () => {
    const tasks: M365TodoTask[] = [
      {
        id: 't1',
        title: 'Urgent thing',
        status: 'notStarted',
        importance: 'high',
        dueDateTime: null,
        createdDateTime: '2026-04-05T00:00:00Z',
        listId: 'list1',
      },
    ]
    const result = formatTodoList(tasks)
    expect(result).toContain('!')
  })
})

describe('formatTodoLists', () => {
  test('handles empty list', () => {
    expect(formatTodoLists([])).toBe('No task lists found.')
  })

  test('formats lists with shared indicator', () => {
    const lists: M365TodoList[] = [
      { id: 'list-abc123', displayName: 'My Tasks', isOwner: true, isShared: false },
      { id: 'list-def456', displayName: 'Team Tasks', isOwner: false, isShared: true },
    ]
    const result = formatTodoLists(lists)
    expect(result).toContain('My Tasks')
    expect(result).toContain('Team Tasks')
    expect(result).toContain('(shared)')
  })
})

// ─── OneDrive Formatting Tests ──────────────────────────────

describe('formatFileList', () => {
  test('handles empty list', () => {
    expect(formatFileList([])).toBe('No files found.')
  })

  test('formats files and folders with icons', () => {
    const items: M365DriveItem[] = [
      {
        id: 'f1',
        name: 'Documents',
        size: 0,
        lastModifiedDateTime: '2026-04-05T10:00:00Z',
        isFolder: true,
        webUrl: 'https://...',
        path: '/Documents',
      },
      {
        id: 'f2',
        name: 'report.pdf',
        size: 1048576,
        lastModifiedDateTime: '2026-04-04T15:00:00Z',
        isFolder: false,
        webUrl: 'https://...',
        path: '/report.pdf',
      },
    ]
    const result = formatFileList(items)
    expect(result).toContain('[D] Documents')
    expect(result).toContain('[F] report.pdf')
    expect(result).toContain('1.0 MB')
  })
})

// ─── OneNote Formatting Tests ───────────────────────────────

describe('formatNotebookList', () => {
  test('handles empty list', () => {
    expect(formatNotebookList([])).toBe('No notebooks found.')
  })

  test('formats notebooks with shared indicator', () => {
    const notebooks: M365Notebook[] = [
      {
        id: 'nb1',
        displayName: 'Work Notes',
        createdDateTime: '2026-01-01T00:00:00Z',
        lastModifiedDateTime: '2026-04-05T10:00:00Z',
        isShared: true,
      },
    ]
    const result = formatNotebookList(notebooks)
    expect(result).toContain('Work Notes')
    expect(result).toContain('(shared)')
  })
})

describe('formatPageList', () => {
  test('handles empty list', () => {
    expect(formatPageList([])).toBe('No pages found.')
  })

  test('formats pages with dates', () => {
    const pages: M365OneNotePage[] = [
      {
        id: 'p1',
        title: 'Meeting Notes',
        createdDateTime: '2026-04-05T09:00:00Z',
        lastModifiedDateTime: '2026-04-05T10:00:00Z',
        contentUrl: 'https://...',
      },
    ]
    const result = formatPageList(pages)
    expect(result).toContain('Meeting Notes')
  })
})

// ─── Auth Formatting Tests ──────────────────────────────────

describe('formatM365Status', () => {
  test('formats connected status', () => {
    const info: M365ConnectionInfo = {
      status: 'connected',
      connectedAs: 'user@company.com',
      tenantId: 'tenant-123',
      authType: 'deviceCode',
    }
    const result = formatM365Status(info)
    expect(result).toContain('Connected')
    expect(result).toContain('user@company.com')
    expect(result).toContain('tenant-123')
  })

  test('formats disconnected status', () => {
    const info: M365ConnectionInfo = {
      status: 'disconnected',
      connectedAs: null,
      tenantId: null,
      authType: null,
    }
    const result = formatM365Status(info)
    expect(result).toContain('Disconnected')
    expect(result).toContain('/m365 login')
  })
})

// ─── Tool Safety Integration Test ───────────────────────────

describe('m365 tool safety', () => {
  // Import here to test integration
  const { assessToolRisk } = require('../src/tool-safety')

  test('read tools are classified as safe', () => {
    expect(assessToolRisk('m365_list_emails', {}).level).toBe('safe')
    expect(assessToolRisk('m365_read_email', {}).level).toBe('safe')
    expect(assessToolRisk('m365_list_events', {}).level).toBe('safe')
    expect(assessToolRisk('m365_list_todos', {}).level).toBe('safe')
    expect(assessToolRisk('m365_list_files', {}).level).toBe('safe')
    expect(assessToolRisk('m365_briefing', {}).level).toBe('safe')
  })

  test('write tools are classified as moderate', () => {
    expect(assessToolRisk('m365_send_email', { to: 'x@y.com' }).level).toBe('moderate')
    expect(assessToolRisk('m365_create_event', { subject: 'Meeting' }).level).toBe('moderate')
    expect(assessToolRisk('m365_create_todo', { title: 'Task' }).level).toBe('moderate')
    expect(assessToolRisk('m365_complete_todo', { taskId: '123' }).level).toBe('moderate')
  })
})

// ─── M365 Tools Schema Test ─────────────────────────────────

describe('M365_TOOLS schema', () => {
  const { M365_TOOLS } = require('../src/m365/tools')

  test('all tools have required fields', () => {
    for (const tool of M365_TOOLS) {
      expect(tool.name).toBeTruthy()
      expect(tool.name.startsWith('m365_')).toBe(true)
      expect(tool.description).toBeTruthy()
      expect(tool.input_schema).toBeTruthy()
      expect(tool.input_schema.type).toBe('object')
    }
  })

  test('has expected number of tools', () => {
    expect(M365_TOOLS.length).toBe(10)
  })

  test('tool names are unique', () => {
    const names = M365_TOOLS.map((t: { name: string }) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })
})
