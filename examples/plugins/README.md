# Exemplos de Plugins — smolerclaw

Tres exemplos de plugins, do mais simples ao mais completo.

## 1. JSON Plugin (`hello-world.json`)

O mais simples possivel. Define um comando shell com placeholders.

```json
{
  "name": "hello_world",
  "description": "Say hello",
  "input_schema": { ... },
  "command": "echo Hello, {{input.name}}!"
}
```

**Instalar:** copie para `~/.config/smolerclaw/plugins/` (Linux/Mac) ou `%APPDATA%/smolerclaw/plugins/` (Windows).

**Limitacoes:** so executa shell commands, sem estado, sem eventos.

---

## 2. Script Plugin (`hello-script.ts`)

Plugin TypeScript com lifecycle hooks e logica pura (sem shell).

**Demonstra:**
- `tools[]` — definicao de ferramentas com schema tipado
- `onLoad(ctx)` — inicializacao (recebe `ctx.notify` e `ctx.dataDir`)
- `onUnload()` — cleanup no shutdown
- `onToolCall(name, input)` — logica customizada em vez de shell

**Instalar:** copie para o diretorio de plugins.

---

## 3. Stateful Plugin (`counter.ts`)

Plugin completo com estado persistente e subscricao de eventos.

**Demonstra:**
- **Estado persistente** — salva/restaura de `ctx.dataDir/counter.json`
- **Multiplas tools** — increment, value, reset
- **Event subscriptions** — reage a `file:saved` incrementando o contador
- **Lifecycle** — `onLoad` restaura estado, `onUnload` persiste

**Instalar:** copie para o diretorio de plugins.

---

## Como instalar

```bash
# Copiar um plugin de exemplo
cp examples/plugins/hello-world.json ~/.config/smolerclaw/plugins/

# Ou no Windows (PowerShell)
Copy-Item examples\plugins\hello-world.json $env:APPDATA\smolerclaw\plugins\

# Reiniciar smolerclaw e verificar
/plugins
```

## Como instalar do GitHub

```
/plugin install owner/repo
```

O repositorio deve conter um dos seguintes entry points:
- `plugin.json` (JSON plugin)
- `plugin.ts` ou `index.ts` (script plugin)
- `package.json` com campo `"smolerclaw": "path/to/entry.ts"`

## Referencia de tipos

```typescript
interface ScriptPluginDefinition {
  name: string
  description: string
  version: string
  tools?: Anthropic.Tool[]
  onLoad?: (ctx: PluginContext) => void | Promise<void>
  onUnload?: () => void | Promise<void>
  onToolCall?: (toolName: string, input: Record<string, unknown>) => Promise<string>
  events?: { [eventName: string]: (payload: any) => void }
}

interface PluginContext {
  notify: (message: string, level?: 'info' | 'warning' | 'error' | 'success') => void
  dataDir: string  // diretorio isolado para dados do plugin
}
```

## Eventos disponiveis

| Evento | Payload | Quando |
|--------|---------|--------|
| `context:changed` | `{ currentDir, previousDir, timestamp }` | Diretorio de trabalho muda |
| `file:saved` | `{ filePath, size, isTracked, timestamp }` | Arquivo escrito pelo vault |
| `status:update` | `{ source, message, level, timestamp }` | Status bar atualizada |
| `session:changed` | `{ currentSession, previousSession, timestamp }` | Sessao trocada |
| `telemetry:alert` | `{ alertType, message, value, timestamp }` | Custo/token excede limite |
| `task:completed` | `{ taskId, taskType, success, timestamp }` | Tarefa background finaliza |
