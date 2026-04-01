/**
 * All TOOLS[] schema definitions.
 * The base TOOLS array contains core tools (read_file, write_file, edit_file, search_files,
 * find_files, list_directory, run_command, fetch_url).
 * Additional tool schemas are in their respective modules and registered at runtime.
 */
import type Anthropic from '@anthropic-ai/sdk'

// ─── Core Tool Definitions ────────────────────────────────────

export const TOOLS: Anthropic.Tool[] = [
  {
    name: 'read_file',
    description:
      'Read file contents. For large files, use offset/limit to read specific line ranges.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path (relative or absolute)' },
        offset: {
          type: 'number',
          description: 'Start reading from this line number (1-based). Optional.',
        },
        limit: {
          type: 'number',
          description: 'Max lines to read. Optional, defaults to 500.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create a new file or completely overwrite an existing file.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path to write' },
        content: { type: 'string', description: 'Full file content' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description:
      'Make a precise edit to a file. Finds old_text and replaces it with new_text. ' +
      'The old_text must match exactly (including whitespace). ' +
      'Use this instead of write_file when modifying existing files — it preserves the rest of the file.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path to edit' },
        old_text: {
          type: 'string',
          description: 'Exact text to find (must be unique in the file)',
        },
        new_text: { type: 'string', description: 'Replacement text' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
  },
  {
    name: 'search_files',
    description:
      'Search file contents using a regex pattern (like grep). ' +
      'Returns matching lines with file paths and line numbers.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: {
          type: 'string',
          description: 'Directory to search in. Defaults to cwd.',
        },
        include: {
          type: 'string',
          description: 'Glob pattern to filter files, e.g. "*.ts" or "*.py"',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'find_files',
    description:
      'Find files by name pattern (glob). Returns matching file paths.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern, e.g. "**/*.ts", "src/**/test*"',
        },
        path: { type: 'string', description: 'Base directory. Defaults to cwd.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and directories with type indicators and sizes.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Directory to list. Defaults to cwd.' },
      },
      required: [],
    },
  },
  {
    name: 'run_command',
    description:
      'Run a shell command. Use for: git operations, running tests, installing packages, ' +
      'building projects, or any CLI task. Commands run in the current working directory.',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        timeout: {
          type: 'number',
          description: 'Timeout in seconds. Default 30, max 120.',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'fetch_url',
    description:
      'Fetch the content of a URL. Use for: reading documentation, checking APIs, ' +
      'downloading config files, or verifying endpoints. Returns the response body as text. ' +
      'For HTML pages, returns a text-only extraction (no tags).',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
        method: {
          type: 'string',
          description: 'HTTP method. Default GET.',
          enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'],
        },
        headers: {
          type: 'object',
          description: 'Optional request headers as key-value pairs.',
        },
        body: {
          type: 'string',
          description: 'Optional request body (for POST/PUT/PATCH).',
        },
      },
      required: ['url'],
    },
  },
]
