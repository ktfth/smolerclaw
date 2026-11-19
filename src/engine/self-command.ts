/**
 * Resolve how to re-invoke this smolerclaw installation from outside the
 * process (e.g. a Windows scheduled task). Derived from the running process,
 * never hardcoded: a compiled binary is its own entry point, while a script
 * run under bun/node needs the runtime plus the entry file.
 */
export function selfCommand(
  proc: { execPath: string; argv: readonly string[] } = process,
): string[] {
  const entry = proc.argv[1]
  if (entry && /\.(ts|js|mjs)$/i.test(entry)) return [proc.execPath, entry]
  return [proc.execPath]
}
