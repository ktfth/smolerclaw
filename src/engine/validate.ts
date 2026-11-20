import Ajv, { type ValidateFunction } from 'ajv'

export interface ValidationResult {
  valid: boolean
  errors: string[]
}

export interface ToolSchema {
  name: string
  input_schema: unknown
}

/**
 * Validates tool inputs against each tool's declared JSON schema.
 * Validators are compiled once per tool name and cached.
 * `strict: false` tolerates the descriptive keywords used in tool schemas.
 */
export class InputValidator {
  private readonly ajv = new Ajv({ strict: false, allErrors: true })
  private readonly cache = new Map<string, { schema: unknown; fn: ValidateFunction }>()

  /** False when the tool's schema cannot be compiled; callers must fail closed. */
  canValidate(tool: ToolSchema): boolean {
    return this.compile(tool) !== null
  }

  validate(tool: ToolSchema, input: unknown): ValidationResult {
    const check = this.compile(tool)
    if (!check) return { valid: false, errors: ['input schema could not be compiled'] }
    if (check(input)) return { valid: true, errors: [] }
    const errors = (check.errors ?? []).map((e) => {
      const where = e.instancePath || '(input)'
      return `${where} ${e.message ?? 'is invalid'}`
    })
    return { valid: false, errors }
  }

  private compile(tool: ToolSchema): ValidateFunction | null {
    const cached = this.cache.get(tool.name)
    if (cached && cached.schema === tool.input_schema) return cached.fn
    try {
      const fn = this.ajv.compile(tool.input_schema as object)
      this.cache.set(tool.name, { schema: tool.input_schema, fn })
      return fn
    } catch {
      return null
    }
  }
}
