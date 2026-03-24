import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

export interface CliArgs {
  help: boolean
  version: boolean
  model?: string
  session?: string
  maxTokens?: number
  noTools: boolean
  print: boolean
  prompt?: string
}

/**
 * Parse CLI arguments. Zero dependencies.
 */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    help: false,
    version: false,
    noTools: false,
    print: false,
  }

  const positional: string[] = []
  let i = 0

  while (i < argv.length) {
    const arg = argv[i]

    switch (arg) {
      case '-h':
      case '--help':
        args.help = true
        break

      case '-v':
      case '--version':
        args.version = true
        break

      case '-m':
      case '--model':
        args.model = argv[++i]
        if (!args.model) die('--model requires a value')
        break

      case '-s':
      case '--session':
        args.session = argv[++i]
        if (!args.session) die('--session requires a value')
        break

      case '--max-tokens':
        const n = Number(argv[++i])
        if (!n || n <= 0) die('--max-tokens requires a positive number')
        args.maxTokens = n
        break

      case '--no-tools':
        args.noTools = true
        break

      case '-p':
      case '--print':
        args.print = true
        break

      default:
        if (arg.startsWith('-')) {
          die(`Unknown option: ${arg}. Try --help`)
        }
        positional.push(arg)
    }
    i++
  }

  if (positional.length > 0) {
    args.prompt = positional.join(' ')
  }

  return args
}

// BUILD_VERSION is injected at compile time via --define.
// Falls back to reading package.json at runtime (dev mode).
declare const BUILD_VERSION: string | undefined

export function getVersion(): string {
  if (typeof BUILD_VERSION !== 'undefined') return BUILD_VERSION
  try {
    const pkgPath = join(dirname(import.meta.dir), 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    return pkg.version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export function printHelp(): void {
  const version = getVersion()
  console.log(`smolerclaw v${version} — the micro AI assistant

Usage:
  smolerclaw [options] [prompt]

Options:
  -h, --help           Show this help
  -v, --version        Show version
  -m, --model <name>   Override model (e.g. claude-sonnet-4-20250514)
  -s, --session <name> Start with a specific session
  --max-tokens <n>     Override max tokens per response
  --no-tools           Disable tool use for this session
  -p, --print          Print response and exit (no TUI)

Examples:
  smolerclaw                        Interactive TUI mode
  smolerclaw "explain this error"   Launch TUI with initial prompt
  smolerclaw -p "what is 2+2"      Print answer and exit
  echo "review" | smolerclaw -p     Pipe input, print response
  smolerclaw -m claude-sonnet-4-20250514 -s work

Commands (inside TUI):
  /help     Show commands      /clear    Clear conversation
  /new      New session        /load     Load session
  /model    Show/set model     /persona  Switch mode
  /briefing Daily briefing     /news     News radar
  /task     Create task        /tasks    List tasks
  /open     Open Windows app   /calendar Outlook calendar
  /export   Export markdown    /exit     Quit`)
}

function die(msg: string): never {
  console.error(`smolerclaw: ${msg}`)
  process.exit(2)
}
