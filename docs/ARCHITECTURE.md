# Arquitetura smolerclaw

> Micro assistente de IA e motor determinístico de gestão pessoal para Windows.
> CLI headless, servidor MCP (stdio), TUI e interface Web compartilhando o mesmo catálogo.

---

## Visão Geral

O smolerclaw separa claramente **raciocínio (agente/LLM)** de **execução de ferramentas (motor determinístico)**:

- **Modo Engine / Harness (`tools`, `run`, `workflow`, `mcp`)**: não usa LLM nem credenciais de API. Executa tools e workflows sob validação de JSON Schema, política estática, limites de tempo/taxa e auditoria em JSONL.
- **Modo Chat Embutido (TUI, Web, Print)**: conecta um provider (`ClaudeProvider`, `OpenAIAgentsProvider`, `Codex`, `Ollama`) ao mesmo dispatcher validado de tools, adicionando primitivas de workstation (`read_file`, `write_file`, `edit_file`, `run_command`, `fetch_url`).

```
┌─────────────────────────────────────────────────────────┐
│                Entrypoints / Surfaces                   │
│  Engine CLI: modes/engine-mode.ts (tools/run/workflow)  │
│  MCP Server: mcp/server.ts (stdio JSON-RPC)             │
│  TUI / Print: tui.ts · cli.ts · modes/interactive.ts    │
│  Web UI: ui/web/ (Hono) · ui/shared/ (chat-service)     │
├─────────────────────────────────────────────────────────┤
│              Deterministic Engine Layer                 │
│  engine/engine.ts     (lookup → validate → policy →     │
│                        rate-limit → dry-run → timeout → │
│                        execute → audit)                 │
│  engine/bootstrap.ts  (runtime + dispose + dataDir)     │
│  engine/policy.ts     (static policy + workflow steps)  │
│  engine/validate.ts   (Ajv schema cache)                │
│  engine/audit.ts      (JSONL per day, SHA-256 hash)     │
│  engine/canonical.ts  (deterministic JSON + SHA-256)    │
├─────────────────────────────────────────────────────────┤
│                  Provider Layer (Chat)                  │
│  claude.ts · openai-agents-provider.ts · codex-provider │
│  openai-provider.ts · auth.ts · retry.ts · context-win  │
├─────────────────────────────────────────────────────────┤
│                Tool Catalog & Execution                 │
│  core/result.ts       (ToolResult, bindTools, hints)    │
│  tools/domain/        (tasks, scheduler, people, notes, │
│                        finance, projects, comms, vault) │
│  tools/integrations.ts (M365 + Google Workspace)        │
│  tools/read-only.ts   (readOnly, sends, destructive,    │
│                        openWorld derived from catalog)  │
│  tool-safety.ts · approval.ts · plugin-system.ts        │
├─────────────────────────────────────────────────────────┤
│          Core Infrastructure & Persistence              │
│  core/store.ts (smolerclaw.db, WAL) · vault.ts (git)    │
│  config.ts (SMOLERCLAW_DATA_DIR / CONFIG_DIR)           │
│  workflows.ts · scheduler.ts · event-bus.ts · i18n/     │
├─────────────────────────────────────────────────────────┤
│               Windows Integration Layer                 │
│  utils/windows-executor.ts · utils/resolve-bin.ts       │
│  windows.ts · windows-agent.ts · clipboard.ts           │
└─────────────────────────────────────────────────────────┘
```

---

## Fluxo de Dados

### Pipeline Determinístico (CLI / MCP / Scheduler)

```
Caller (CLI / MCP / Scheduled Workflow)
    │
    ▼
bootstrapEngine({ dataDir, dryRun, timeoutMs, caller, runId })
    │ loadConfig(env) → initI18n → registerToolCatalog → initCoreModules
    ▼
engine.invoke(tool, rawInput)
    ├── 1. Catalog Lookup      → unknown (exit 2)
    ├── 2. JSON Schema (Ajv)   → invalid (exit 2)
    ├── 3. Static Policy       → denied  (exit 3)
    ├── 4. Rate Limit Check    → denied  (exit 3)
    ├── 5. Dry-Run Gate        → dry-run (exit 0, sem efeitos colaterais)
    ├── 6. Execute (+ timeout) → ok (exit 0) | tool error (exit 1)
    └── 7. Audit Sink          → <dataDir>/audit/engine-YYYY-MM-DD.jsonl
                                 (runId, caller, inputHash SHA-256, decision, risk, ok, durationMs)
```

Workflows (`smolerclaw workflow <name>`) passam cada step por `decideWorkflowStep()` sob a mesma `EnginePolicy`, respeitam `--dry-run` e `SMOLERCLAW_READONLY=1`, e gravam cada step no mesmo `AuditSink`.

### Autenticação

Só o chat embutido usa credenciais; o motor, a CLI e o MCP rodam sem nenhuma.

```
ANTHROPIC_API_KEY (Console Anthropic)
    ▼
  auth.ts → resolveAuthForProvider('anthropic')
    ▼
  ClaudeProvider → new Anthropic({ apiKey })
```

O token OAuth da assinatura do Claude Code não é lido: ele é emitido para o Claude Code, não para clientes de terceiros. Quem quer usar a assinatura roda o smolerclaw como servidor MCP dentro do Claude Code (`claude mcp add smolerclaw -- smolerclaw mcp`).

### Persistência e Isolamento

Por padrão, os dados vivem em `%LOCALAPPDATA%/smolerclaw/` (Windows) ou `~/.local/share/smolerclaw/` (Unix), e a configuração em `%APPDATA%/smolerclaw/`. Para execuções isoladas em harnesses, testes ou sandboxes, passe `--data-dir <dir>` ou `SMOLERCLAW_DATA_DIR=<dir>` (sem tocar no `config.json` real do usuário).

```
<dataDir>/
├── smolerclaw.db           SQLite compartilhado (WAL): notas, tarefas, manifesto do Obsidian
├── audit/engine-*.jsonl    Trilha de auditoria append-only (1 arquivo/dia UTC)
├── logs/workflow_*.log     Logs de workflows agendados
├── scripts/*.ps1           Scripts gerados para o Windows Task Scheduler
├── sessions/*.json         Conversas (SessionManager)
├── people.json             Pessoas + delegações
├── finance.json            Transações
├── decisions.json          Log de decisões
├── workflows.json          Automações
├── scheduler.json          Jobs agendados (com policyEnv fixado)
├── projects.json           Projetos e sessões de trabalho
├── vault-checksums.json    Integridade SHA-256
└── .backup/                Repo git de backup (inclui snapshots JSON de notas e tarefas)
```

---

## Segurança e Governança

1. **Separação de catálogo** — Primitivas de workstation (`read_file`, `write_file`, `edit_file`, `run_command`, `fetch_url`) ficam restritas ao chat embutido e nunca entram em `engineCatalog()` nem no MCP. Plugins exigem opt-in via `SMOLERCLAW_PLUGINS`.
2. **Validação de entrada única** — Todo tool call (engine, MCP e chat) é validado contra o JSON Schema via Ajv (`InputValidator`).
3. **Política estática e determinística** — `dangerous` é sempre bloqueado; `SMOLERCLAW_READONLY=1` bloqueia mutações em tools e workflows; `m365_send_email` e `gws_send_email` exigem `SMOLERCLAW_ALLOW_SEND=1` no engine e consentimento interativo no chat.
4. **Proteção contra injeção** — Binários `m365`/`gws` resolvem via `resolve-bin.ts` recusando shims `.cmd`/`.bat` (BatBadBut); PowerShell passa por `windows-executor.ts` com escape de aspas e guards; scheduler não possui ação de comando cru e fixa `policyEnv` na criação do job.
5. **Auditoria sem vazamento** — `AuditRecord` grava apenas `inputHash` (SHA-256 do JSON canônico), `runId`, `caller`, decisão e duração — nunca argumentos brutos.
6. **Integridade de dados** — Escrita atômica (`atomicWriteFile`), checksums SHA-256 e transações SQLite em `smolerclaw.db`.
7. **Vários processos, um banco** — TUI, servidor MCP e `run` abrem o mesmo `smolerclaw.db` sem cache em memória. WAL deixa leituras correrem junto com uma escrita, `busy_timeout` faz a segunda escrita esperar, e as mudanças de estado são condicionais (`UPDATE … WHERE done = 0`, `… WHERE notified = 0`). Assim um lembrete dispara num processo só, e concluir duas vezes a mesma tarefa não sobrescreve nada. O sync do Obsidian roda sob o lock de escrita (`BEGIN IMMEDIATE`). Os demais domínios em JSON (pessoas, finanças, projetos…) ainda carregam uma vez e regravam o arquivo inteiro, então neles o último processo a gravar vence.
