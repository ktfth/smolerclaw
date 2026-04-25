<p align="center">
  <img src="smolerclaw.png" alt="smolerclaw logo" width="200" />
</p>

# smolerclaw

A micro AI assistant for Windows with Claude Code and Codex support.
One binary, zero config, full TUI.

---

## Quick Start

```bash
# 1. Authenticate with one of the supported local CLIs:
#    - Claude Code (auto-detected from ~/.claude/.credentials.json)
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
- **Daily briefing** — calendar, tasks, news, follow-ups in one summary
- **Investigate issues** — structured evidence collection, findings, reports
- **Run workflows** — multi-step automated routines
- **Monitor processes** — watch Windows processes, notify on changes
- **Track finances** — income/expense logging with monthly summaries
- **Log decisions** — record context and rationale for important choices
- **Pomodoro timer** — focus sessions with toast notifications
- **Local RAG memory** — TF-IDF + BM25 search across memos, materials, decisions, and sessions
- **Project management** — track projects, work sessions, generate progress reports
- **Opportunity pipeline** — register and filter demands by tech stack and priority
- **PowerShell scripting** — execute .ps1 scripts with safety guards (blocks Defender/System32/destructive ops)
- **Clipboard OCR** — read text or extract text from images via Windows.Media.Ocr
- **Screen awareness** — map foreground window and all visible windows
- **Session refresh** — validate/renew supported local auth without leaving the TUI
- **Auto-refresh** — proactive OAuth token monitoring and renewal before expiration
- **Finance verification** — amount limits, duplicate detection, daily spending alerts
- **Plugin system** — install plugins from GitHub with `/plugin install owner/repo`, supports JSON and TypeScript plugins with lifecycle hooks
- **Macros** — quick program launchers (`/macro vscode`, `/macro chrome`), create custom macros for apps, URLs, files, and commands
- **Web UI** — browser-based interface via `smolerclaw ui` (Hono server)
- **Desktop app** — native desktop window via `smolerclaw desktop` (Electrobun)
- **i18n** — full Portuguese and English interface, auto-detected or set with `/lang`
- **Scheduler** — recurring jobs via Windows Task Scheduler (`/schedule`, `/jobs`)

## Modes

```bash
smolerclaw                  # Interactive TUI (default)
smolerclaw ui               # Web UI at http://localhost:3847
smolerclaw desktop          # Desktop app (Electrobun)
smolerclaw ui --port 8080   # Custom port
smolerclaw -p "question"    # Print mode (non-interactive)
```

## TUI Commands

```
/help          All commands          /clear         Clear conversation
/task 18h buy bread                  /tasks         List pending
/briefing      Morning summary       /news          Headlines
/open excel    Launch app            /calendar      Outlook events
/investigar    List investigations   /memo #tag     Save a note
/email         Draft email           /pomodoro      Focus timer
/model sonnet  Switch model          /login codex   Login + switch provider
/review        Cross-review          /export        Save to markdown
/indexar       Build RAG index       /memoria <q>   Search local memory
/projeto auto  Set active project    /projetos      List all projects
/sessao start  Start work timer      /sessao stop   Stop work timer
/relatorio     Progress report       /oportunidades List opportunities
/clipboard     Read clipboard/OCR    /tela          Screen context
/ps1 <script>  Run PowerShell        /refresh       Renew auth token
/auto-refresh  Token refresh status  /plugins       List plugins
/plugin install owner/repo           /plugin info   Plugin details
/entrada 500 cat  Record income      /saida 50 cat  Record expense
/macro vscode  Run macro             /macro list    List all macros
/schedule      Manage scheduled jobs /jobs          List jobs
```

## Auth

Claude Code subscription (auto-detected from `~/.claude/.credentials.json`) or Codex CLI login (auto-detected from `~/.codex/auth.json`). Interactive startup can ask whether the session should use Claude or Codex. OpenAI models now run through the OpenAI Agents SDK and can use `OPENAI_API_KEY` or a Codex-provided API key when available. Claude tokens are automatically renewed via auto-refresh. Use `/login <claude|codex>` to re-authenticate and switch provider, `/refresh` for manual validation/renewal, or `/auto-refresh` to check Claude auto-refresh status.

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
# 1. Autentique um dos CLIs suportados:
#    - Claude Code (credenciais em ~/.claude/.credentials.json)
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
- **Resumo matinal** — calendario, tarefas, noticias, follow-ups em um so resumo
- **Investigar problemas** — coleta estruturada de evidencias, conclusoes, relatorios
- **Executar workflows** — rotinas automatizadas de multiplos passos
- **Monitorar processos** — vigiar processos do Windows, notificar mudancas
- **Controle financeiro** — registro de entradas/saidas com resumo mensal
- **Registrar decisoes** — guardar contexto e justificativa de escolhas importantes
- **Timer Pomodoro** — sessoes de foco com notificacoes toast
- **Memoria RAG local** — busca TF-IDF + BM25 em memos, materiais, decisoes e sessoes
- **Gestao de projetos** — rastrear projetos, sessoes de trabalho, gerar relatorios de progresso
- **Pipeline de oportunidades** — registrar e filtrar demandas por tech stack e prioridade
- **Scripts PowerShell** — executar .ps1 com safety guards (bloqueia Defender/System32/ops destrutivas)
- **OCR de clipboard** — ler texto ou extrair texto de imagens via Windows.Media.Ocr
- **Consciencia de tela** — mapear janela em foco e todas as janelas visiveis
- **Renovacao de sessao** — validar/renovar autenticacao local suportada sem sair da TUI
- **Auto-refresh** — monitoramento proativo de token OAuth com renovacao automatica antes da expiracao
- **Verificacao financeira** — limites de valor, deteccao de duplicatas, alertas de gasto diario
- **Sistema de plugins** — instalar plugins do GitHub com `/plugin install owner/repo`, suporte a plugins JSON e TypeScript com lifecycle hooks
- **Macros** — atalhos rapidos para programas (`/macro vscode`, `/macro chrome`), crie macros customizados para apps, URLs, arquivos e comandos
- **Interface Web** — interface no navegador via `smolerclaw ui` (servidor Hono)
- **App Desktop** — janela nativa via `smolerclaw desktop` (Electrobun)
- **i18n** — interface em Portugues e Ingles, detectado automaticamente ou via `/idioma`
- **Agendador** — jobs recorrentes via Agendador de Tarefas do Windows (`/schedule`, `/jobs`)

## Modos

```bash
smolerclaw                  # TUI interativa (padrao)
smolerclaw ui               # Interface Web em http://localhost:3847
smolerclaw desktop          # App Desktop (Electrobun)
smolerclaw ui --port 8080   # Porta customizada
smolerclaw -p "pergunta"    # Modo print (nao-interativo)
```

## Comandos na TUI

```
/ajuda         Todos os comandos     /limpar        Limpar conversa
/tarefa 18h comprar pao              /tarefas       Listar pendentes
/resumo        Briefing matinal      /noticias      Manchetes
/abrir excel   Abrir app             /calendario    Eventos Outlook
/investigar    Listar investigacoes  /memo #tag     Salvar anotacao
/email         Rascunho de email     /foco          Timer Pomodoro
/modelo sonnet Trocar modelo         /login codex   Login + troca provider
/review        Revisao cruzada       /exportar      Salvar em markdown
/indexar       Construir indice RAG  /memoria <q>   Buscar na memoria
/projeto auto  Definir projeto ativo /projetos      Listar projetos
/sessao start  Iniciar timer         /sessao stop   Parar timer
/relatorio     Relatorio progresso   /oportunidades Listar oportunidades
/area          Ler clipboard/OCR     /tela          Contexto de tela
/ps1 <script>  Executar PowerShell   /refresh       Renovar token auth
/auto-refresh  Status auto-refresh   /plugins       Listar plugins
/plugin install owner/repo           /plugin info   Detalhes plugin
/entrada 500 cat  Registrar entrada  /saida 50 cat  Registrar saida
/macro vscode  Executar macro        /macro list    Listar macros
/schedule      Gerenciar agendamentos /jobs          Listar jobs
```

## Autenticacao

Assinatura Claude Code (detectada automaticamente de `~/.claude/.credentials.json`) ou login do Codex CLI (detectado automaticamente de `~/.codex/auth.json`). Na abertura interativa, o app pode perguntar se a sessao deve usar Claude ou Codex. Modelos OpenAI agora usam o OpenAI Agents SDK e podem reutilizar `OPENAI_API_KEY` ou uma chave provida pelo login do Codex quando disponivel. O token do Claude e renovado automaticamente via auto-refresh. Use `/login <claude|codex>` para autenticar e trocar o provider, `/refresh` para validacao/renovacao manual ou `/auto-refresh` para ver o status do Claude.

## Requisitos

- **Windows 10/11**
- **Bun** runtime (`irm bun.sh/install.ps1 | iex`)

## Licenca

MIT
