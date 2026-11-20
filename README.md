<p align="center">
  <img src="smolerclaw.png" alt="smolerclaw logo" width="200" />
</p>

# smolerclaw

A micro AI assistant for Windows with Claude Code and Codex support.
One binary, zero config, full TUI.

---

## Quick Start

```bash
# 1. Built-in chat only (the engine, CLI and MCP need no credentials):
#    - Claude: export ANTHROPIC_API_KEY (Anthropic Console key)
#    - Codex CLI (auto-detected from ~/.codex/auth.json)
#    - On interactive startup, smolerclaw can prompt you to pick Claude or Codex for the session

# 2. Run
bun run start
```

That's it. No setup wizards, no config files, no Docker.

## Install as a system-wide command

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

Then from anywhere:

```
smolerclaw
```

## What it does

smolerclaw is a terminal AI assistant that lives on your Windows machine. It can:

- **Read, write, and edit files** in your project
- **Run commands** and analyze output
- **Open Windows apps** — Excel, Outlook, VS Code, browser, etc.
- **Manage tasks & reminders** — with Windows Task Scheduler integration (reminders work even when smolerclaw is closed)
- **Track people & delegations** — team, family, contacts
- **Take notes** — searchable memo system with tags
- **Draft emails** — opens directly in Outlook
- **Daily briefing** — calendar, tasks, follow-ups, projects in one summary
- **Run workflows** — multi-step automated routines
- **Monitor processes** — watch Windows processes, notify on changes
- **Track finances** — income/expense logging with monthly summaries
- **Log decisions** — record context and rationale for important choices
- **Pomodoro timer** — focus sessions with toast notifications
- **Project management** — track projects, work sessions, generate progress reports
- **PowerShell scripting** — execute .ps1 scripts with safety guards (blocks Defender/System32/destructive ops)
- **Clipboard OCR** — read text or extract text from images via Windows.Media.Ocr
- **Screen awareness** — map foreground window and all visible windows
- **Session refresh** — validate/renew supported local auth without leaving the TUI
- **Finance verification** — amount limits, duplicate detection, daily spending alerts
- **Plugin system** — install plugins from GitHub with `/plugin install owner/repo`, supports JSON and TypeScript plugins with lifecycle hooks
- **Macros** — quick program launchers (`/macro vscode`, `/macro chrome`), create custom macros for apps, URLs, files, and commands
- **Web UI** — browser-based interface via `smolerclaw ui` (Hono server)
- **i18n** — full Portuguese and English interface, auto-detected or set with `/lang`
- **Scheduler** — recurring jobs via Windows Task Scheduler (`/schedule`, `/jobs`)

## Modes

```bash
smolerclaw                  # Interactive TUI (default)
smolerclaw ui               # Web UI at http://localhost:3847
smolerclaw ui --port 8080   # Custom port
smolerclaw -p "question"    # Print mode (non-interactive)
```

## Deterministic engine

The engine runs tools without any model in the loop and needs no credentials. Every call goes through the same fixed pipeline: catalog lookup → JSON-schema validation → static policy → execution → audit.

```bash
smolerclaw tools [--json] [--data-dir <dir>]                       # List the tool catalog
smolerclaw run create_task '{"title":"Pay rent"}'                  # Invoke one tool directly
echo '{"query":"rent"}' | smolerclaw run search_notes -            # Input from stdin
smolerclaw run create_task '{"title":"Test"}' --dry-run --json     # Validate + policy check only
smolerclaw run list_tasks --json                                   # Structured result
smolerclaw workflow iniciar-dia [--dry-run] [--json]               # Run a saved workflow under policy
smolerclaw mcp [--data-dir <dir>]                                  # Serve tools over MCP (stdio)
```

- **Catalog:** the personal-management core — tasks, scheduler, people, notes, finance and decisions, projects, email drafts, notifications, calendar, vault, Microsoft 365 and Google Workspace. Notes (memos, links and reference material) and tasks live in one SQLite store, `smolerclaw.db`, which the TUI, the MCP server and `run` can share at the same time: nothing is cached in memory, so one process never overwrites what another wrote. On first start the old `memos.json`, `bookmarks.json`, `materials.json` and `tasks.json` are imported once and renamed to `*.migrated.json`, and an older `notes.db` is copied over and kept as `notes.migrated.db`. Plugins run arbitrary commands, so the engine exposes one only when it is named in `SMOLERCLAW_PLUGINS=a,b`. File, shell and HTTP primitives stay in the built-in chat: an external agent such as Claude Code brings its own.
- **Results:** every tool reports success or failure structurally, never by parsing its text. `--json` adds a `data` field with the records, and MCP returns the same records as `structuredContent.data`. Tools expose MCP annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`) and the same flags in `smolerclaw tools --json`.
- **Exit codes:** `0` ok, `1` tool error, `2` invalid input or unknown tool, `3` denied by policy.
- **Policy & Harness controls:** dangerous operations are always denied. `SMOLERCLAW_READONLY=1` denies anything that is not a verified read (including mutating workflow steps). `SMOLERCLAW_ALLOW=a,b` and `SMOLERCLAW_DENY=a,b` restrict the catalog. Tools that send email immediately (`m365_send_email`, `gws_send_email`) are denied unless `SMOLERCLAW_ALLOW_SEND=1`; `draft_email` stays available. Use `--data-dir <dir>` or `SMOLERCLAW_DATA_DIR=<dir>` for isolated sandbox/harness runs, `--dry-run` / `SMOLERCLAW_DRY_RUN=1` to validate without side effects, and `--timeout <ms>` / `SMOLERCLAW_TIMEOUT_MS=<ms>` to bound tool execution (default 60s). Every tool input is validated against its schema, in the chat loop too.
- **Audit:** one JSONL file per day under `<dataDir>/audit/`. Records include `runId` (`SMOLERCLAW_RUN_ID`), `caller` (`cli` / `mcp`), and a SHA-256 of the canonical input, never the raw input.
- **Scheduled workflows:** jobs with the `workflow` action run `smolerclaw workflow <name>` headless under the engine's policy and audit pipeline, appending output to `<dataDir>/logs/`. The policy variables in effect when the job is created are pinned into the job, so the scheduled run never inherits a looser environment. There is no raw-command action.

### Use with Claude Code

Claude Code becomes the agent and smolerclaw supplies the tools:

```bash
claude mcp add smolerclaw -- smolerclaw mcp
```

Combine with `SMOLERCLAW_READONLY=1` for unattended runs that must not change anything.

### Obsidian mirror

Point `SMOLERCLAW_OBSIDIAN_VAULT` (or `obsidianVault` in `config.json`) at an Obsidian vault and smolerclaw keeps a `smolerclaw/` folder inside it. Nothing outside that folder is read or written.

```
smolerclaw/
  Painel.md        pending tasks, recent notes, today's activity
  Tarefas.md       tick [x] to complete; a new "- [ ] ..." line becomes a task
  Notas/           one file per note (memo/, link/, referência/<category>/)
  Diário/<date>.md what the engine did: tool, outcome — never the input
  Inbox/           a file dropped here becomes a note
```

SQLite stays the source of truth. Every successful write refreshes the mirror; `obsidian_sync` (`smolerclaw run obsidian_sync`) pulls your edits back first: edited notes, Inbox files, ticked or new tasks. A file you edited is never overwritten. When both sides changed, the database wins and your version is kept as `<note>.conflito.md`. Deleting a file never deletes data; set `deletar: true` in its frontmatter instead. Moving or renaming files is fine: notes are tracked by the `id` in their frontmatter. `obsidian_status` lists pending edits, Inbox files and conflicts.

How your edits come back is a mode, `off` by default. Change it by asking ("sincroniza sempre", "me pergunta antes") or with `obsidian_mode`; it is stored in the vault, so the TUI and the MCP server share it, and `SMOLERCLAW_OBSIDIAN_PULL=off|ask|auto` overrides it.

| Mode | Before every note or task call |
|---|---|
| `off` | nothing; edits wait for `obsidian_sync` |
| `ask` | unsynced edits are appended to the result once, so the agent asks you whether to sync |
| `auto` | edits are pulled first and the sync is written to the journal |

The check is cheap: a file is read only when its modification time changed.

## TUI Commands

```
/help          All commands          /clear         Clear conversation
/task 18h buy bread                  /tasks         List pending
/briefing      Morning summary       /calendar      Outlook events
/open excel    Launch app            /memo #tag     Save a note
/email         Draft email           /pomodoro      Focus timer
/model sonnet  Switch model          /login codex   Login + switch provider
/review        Cross-review          /export        Save to markdown
/projeto auto  Set active project    /projetos      List all projects
/sessao start  Start work timer      /sessao stop   Stop work timer
/relatorio     Progress report       /oportunidades List opportunities
/clipboard     Read clipboard/OCR    /tela          Screen context
/ps1 <script>  Run PowerShell        /refresh       Re-read credentials
/plugins       List plugins
/plugin install owner/repo           /plugin info   Plugin details
/entrada 500 cat  Record income      /saida 50 cat  Record expense
/macro vscode  Run macro             /macro list    List all macros
/schedule      Manage scheduled jobs /jobs          List jobs
```

## Auth

Only the built-in chat needs credentials. Claude models use `ANTHROPIC_API_KEY` from the Anthropic Console; the Claude Code subscription token is not read, because it is issued to Claude Code, not to third-party clients. To use your subscription, run smolerclaw as an MCP server inside Claude Code instead. Codex uses its CLI login (`~/.codex/auth.json`). OpenAI models run through the OpenAI Agents SDK with `OPENAI_API_KEY` or a Codex-provided API key. Use `/login <claude|codex>` to switch provider and `/refresh` to re-read credentials.

## Requirements

- **Windows 10/11**
- **Bun** runtime (`irm bun.sh/install.ps1 | iex`)

## License

MIT

---

# smolerclaw (PT-BR)

Um micro assistente de IA para Windows com suporte a Claude Code e Codex.
Um binario, zero configuracao, TUI completa.

---

## Inicio Rapido

```bash
# 1. Só para o chat embutido (motor, CLI e MCP não precisam de credenciais):
#    - Claude: exporte ANTHROPIC_API_KEY (chave da Console Anthropic)
#    - Codex CLI (credenciais em ~/.codex/auth.json)
#    - Na abertura interativa, o smolerclaw pode perguntar se a sessao vai usar Claude ou Codex

# 2. Rode
bun run start
```

So isso. Sem wizards, sem arquivos de config, sem Docker.

## Instalar como comando do sistema

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

Depois, de qualquer lugar:

```
smolerclaw
```

## O que faz

smolerclaw e um assistente de IA no terminal que vive na sua maquina Windows. Ele pode:

- **Ler, escrever e editar arquivos** no seu projeto
- **Executar comandos** e analisar saida
- **Abrir apps do Windows** — Excel, Outlook, VS Code, navegador, etc.
- **Gerenciar tarefas e lembretes** — integrado com o Agendador de Tarefas do Windows (lembretes funcionam mesmo com o smolerclaw fechado)
- **Rastrear pessoas e delegacoes** — equipe, familia, contatos
- **Fazer anotacoes** — sistema de memos com busca e tags
- **Rascunhar emails** — abre direto no Outlook
- **Resumo matinal** — calendário, tarefas, follow-ups e projetos em um só resumo
- **Executar workflows** — rotinas automatizadas de multiplos passos
- **Monitorar processos** — vigiar processos do Windows, notificar mudancas
- **Controle financeiro** — registro de entradas/saidas com resumo mensal
- **Registrar decisoes** — guardar contexto e justificativa de escolhas importantes
- **Timer Pomodoro** — sessoes de foco com notificacoes toast
- **Gestao de projetos** — rastrear projetos, sessoes de trabalho, gerar relatorios de progresso
- **Scripts PowerShell** — executar .ps1 com safety guards (bloqueia Defender/System32/ops destrutivas)
- **OCR de clipboard** — ler texto ou extrair texto de imagens via Windows.Media.Ocr
- **Consciencia de tela** — mapear janela em foco e todas as janelas visiveis
- **Renovacao de sessao** — validar/renovar autenticacao local suportada sem sair da TUI
- **Verificacao financeira** — limites de valor, deteccao de duplicatas, alertas de gasto diario
- **Sistema de plugins** — instalar plugins do GitHub com `/plugin install owner/repo`, suporte a plugins JSON e TypeScript com lifecycle hooks
- **Macros** — atalhos rapidos para programas (`/macro vscode`, `/macro chrome`), crie macros customizados para apps, URLs, arquivos e comandos
- **Interface Web** — interface no navegador via `smolerclaw ui` (servidor Hono)
- **i18n** — interface em Portugues e Ingles, detectado automaticamente ou via `/idioma`
- **Agendador** — jobs recorrentes via Agendador de Tarefas do Windows (`/schedule`, `/jobs`)

## Modos

```bash
smolerclaw                  # TUI interativa (padrao)
smolerclaw ui               # Interface Web em http://localhost:3847
smolerclaw ui --port 8080   # Porta customizada
smolerclaw -p "pergunta"    # Modo print (nao-interativo)
```

## Motor determinístico

O motor executa tools sem nenhum modelo no circuito e não precisa de credenciais. Toda chamada passa pelo mesmo pipeline fixo: busca no catálogo → validação por JSON Schema → política estática → execução → auditoria.

```bash
smolerclaw tools [--json] [--data-dir <dir>]                       # Lista o catálogo de tools
smolerclaw run create_task '{"title":"Pagar aluguel"}'             # Invoca um tool direto
echo '{"query":"aluguel"}' | smolerclaw run search_notes -         # Entrada via stdin
smolerclaw run create_task '{"title":"Teste"}' --dry-run --json    # Valida + política sem executar
smolerclaw run list_tasks --json                                   # Resultado estruturado
smolerclaw workflow iniciar-dia [--dry-run] [--json]               # Roda um workflow sob política
smolerclaw mcp [--data-dir <dir>]                                  # Serve os tools via MCP (stdio)
```

- **Catálogo:** o núcleo de gestão pessoal — tarefas, agendador, pessoas, notas, finanças e decisões, projetos, rascunho de email, notificações, calendário, vault, Microsoft 365 e Google Workspace. Notas (memos, links e materiais de referência) e tarefas ficam num único store SQLite, `smolerclaw.db`, que a TUI, o servidor MCP e o `run` podem usar ao mesmo tempo: nada fica em cache na memória, então um processo nunca sobrescreve o que outro gravou. Na primeira execução os antigos `memos.json`, `bookmarks.json`, `materials.json` e `tasks.json` são importados uma vez e renomeados para `*.migrated.json`, e um `notes.db` antigo é copiado e guardado como `notes.migrated.db`. Plugins executam comandos arbitrários, então o motor só expõe os que estiverem em `SMOLERCLAW_PLUGINS=a,b`. Arquivos, shell e HTTP ficam só no chat embutido: um agente externo como o Claude Code já traz os seus.
- **Resultados:** todo tool informa sucesso ou falha de forma estruturada, nunca pela leitura do texto. `--json` inclui o campo `data` com os registros, e o MCP devolve os mesmos registros em `structuredContent.data`. Os tools expõem anotações MCP (`readOnlyHint`, `destructiveHint`, `openWorldHint`) e os mesmos campos em `smolerclaw tools --json`.
- **Códigos de saída:** `0` ok, `1` erro do tool, `2` entrada inválida ou tool desconhecido, `3` negado pela política.
- **Política e controles de harness:** operações perigosas são sempre negadas. `SMOLERCLAW_READONLY=1` nega tudo que não for leitura verificada (incluindo steps mutáveis de workflows). `SMOLERCLAW_ALLOW=a,b` e `SMOLERCLAW_DENY=a,b` restringem o catálogo. Tools que enviam email na hora (`m365_send_email`, `gws_send_email`) são negados sem `SMOLERCLAW_ALLOW_SEND=1`; `draft_email` continua liberado. Use `--data-dir <dir>` ou `SMOLERCLAW_DATA_DIR=<dir>` para execuções isoladas em sandbox/harness, `--dry-run` / `SMOLERCLAW_DRY_RUN=1` para validar sem efeitos colaterais e `--timeout <ms>` / `SMOLERCLAW_TIMEOUT_MS=<ms>` para limitar o tempo por execução (padrão 60s). Toda entrada é validada contra o schema, inclusive no chat.
- **Auditoria:** um arquivo JSONL por dia em `<dataDir>/audit/`. Os registros incluem `runId` (`SMOLERCLAW_RUN_ID`), `caller` (`cli` / `mcp`) e o SHA-256 da entrada canônica, nunca a entrada bruta.
- **Workflows agendados:** jobs com ação `workflow` rodam `smolerclaw workflow <nome>` sem interface sob a política e auditoria do motor, gravando a saída em `<dataDir>/logs/`. As variáveis de política vigentes na criação ficam fixadas no job, então a execução agendada nunca herda um ambiente mais permissivo. Não existe ação de comando cru.

### Uso com o Claude Code

O Claude Code vira o agente e o smolerclaw fornece os tools:

```bash
claude mcp add smolerclaw -- smolerclaw mcp
```

Combine com `SMOLERCLAW_READONLY=1` para execuções desassistidas que não podem alterar nada.

### Espelho no Obsidian

Aponte `SMOLERCLAW_OBSIDIAN_VAULT` (ou `obsidianVault` no `config.json`) para um vault do Obsidian e o smolerclaw mantém uma pasta `smolerclaw/` dentro dele. Nada fora dessa pasta é lido ou escrito.

```
smolerclaw/
  Painel.md        tarefas pendentes, notas recentes, atividade do dia
  Tarefas.md       marque [x] para concluir; uma linha nova "- [ ] ..." vira tarefa
  Notas/           um arquivo por nota (memo/, link/, referência/<categoria>/)
  Diário/<data>.md o que o motor fez: tool e resultado — nunca o input
  Inbox/           arquivo colocado aqui vira nota
```

O SQLite continua sendo a fonte da verdade. Toda escrita bem-sucedida atualiza o espelho; `obsidian_sync` (`smolerclaw run obsidian_sync`) primeiro traz suas edições de volta: notas editadas, arquivos da Inbox, tarefas marcadas ou novas. Arquivo que você editou nunca é sobrescrito. Quando os dois lados mudaram, o banco vence e a sua versão fica como `<nota>.conflito.md`. Apagar um arquivo nunca apaga dados; use `deletar: true` no frontmatter. Mover ou renomear arquivos não tem problema: as notas são rastreadas pelo `id` do frontmatter. `obsidian_status` lista edições pendentes, Inbox e conflitos.

O retorno das suas edições é um modo, `off` por padrão. Troque pedindo ("sincroniza sempre", "me pergunta antes") ou com `obsidian_mode`; ele fica gravado no vault, então vale para a TUI e para o MCP, e `SMOLERCLAW_OBSIDIAN_PULL=off|ask|auto` tem prioridade.

| Modo | Antes de cada chamada de notas ou tarefas |
|---|---|
| `off` | nada; as edições esperam o `obsidian_sync` |
| `ask` | as edições não sincronizadas vão uma vez no resultado, para o agente te perguntar se sincroniza |
| `auto` | as edições são trazidas antes e o sync fica registrado no diário |

A verificação é barata: um arquivo só é lido quando a data de modificação mudou.

## Comandos na TUI

```
/ajuda         Todos os comandos     /limpar        Limpar conversa
/tarefa 18h comprar pao              /tarefas       Listar pendentes
/resumo        Briefing matinal      /calendario    Eventos Outlook
/abrir excel   Abrir app             /memo #tag     Salvar anotacao
/email         Rascunho de email     /foco          Timer Pomodoro
/modelo sonnet Trocar modelo         /login codex   Login + troca provider
/review        Revisao cruzada       /exportar      Salvar em markdown
/projeto auto  Definir projeto ativo /projetos      Listar projetos
/sessao start  Iniciar timer         /sessao stop   Parar timer
/relatorio     Relatorio progresso   /oportunidades Listar oportunidades
/area          Ler clipboard/OCR     /tela          Contexto de tela
/ps1 <script>  Executar PowerShell   /refresh       Reler credenciais
/plugins       Listar plugins
/plugin install owner/repo           /plugin info   Detalhes plugin
/entrada 500 cat  Registrar entrada  /saida 50 cat  Registrar saida
/macro vscode  Executar macro        /macro list    Listar macros
/schedule      Gerenciar agendamentos /jobs          Listar jobs
```

## Autenticacao

Só o chat embutido precisa de credenciais. Modelos Claude usam `ANTHROPIC_API_KEY` da Console Anthropic; o token da assinatura do Claude Code não é lido, porque é emitido para o Claude Code e não para clientes de terceiros. Para usar a assinatura, rode o smolerclaw como servidor MCP dentro do Claude Code. O Codex usa o login do CLI (`~/.codex/auth.json`). Modelos OpenAI usam o OpenAI Agents SDK com `OPENAI_API_KEY` ou a chave provida pelo Codex. Use `/login <claude|codex>` para trocar o provider e `/refresh` para reler as credenciais.

## Requisitos

- **Windows 10/11**
- **Bun** runtime (`irm bun.sh/install.ps1 | iex`)

## Licenca

MIT
