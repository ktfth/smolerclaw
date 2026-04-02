<p align="center">
  <img src="smolerclaw.png" alt="smolerclaw logo" width="200" />
</p>

# smolerclaw

A micro AI assistant built on top of Claude, designed for Windows.
One binary, zero config, full TUI.

---

## Quick Start

```bash
# 1. Have Claude Code installed with a Pro/Max subscription
#    (credentials auto-detected from ~/.claude/.credentials.json)

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
- **Session refresh** — renew Claude Code auth token without leaving the TUI
- **Auto-refresh** — proactive OAuth token monitoring and renewal before expiration
- **Finance verification** — amount limits, duplicate detection, daily spending alerts
- **Plugin system** — install plugins from GitHub with `/plugin install owner/repo`, supports JSON and TypeScript plugins with lifecycle hooks

## TUI Commands

```
/help          All commands          /clear         Clear conversation
/task 18h buy bread                  /tasks         List pending
/briefing      Morning summary       /news          Headlines
/open excel    Launch app            /calendar      Outlook events
/investigar    List investigations   /memo #tag     Save a note
/email         Draft email           /pomodoro      Focus timer
/model sonnet  Switch model          /export        Save to markdown
/indexar       Build RAG index       /memoria <q>   Search local memory
/projeto auto  Set active project    /projetos      List all projects
/sessao start  Start work timer      /sessao stop   Stop work timer
/relatorio     Progress report       /oportunidades List opportunities
/clipboard     Read clipboard/OCR    /tela          Screen context
/ps1 <script>  Run PowerShell        /refresh       Renew auth token
/auto-refresh  Token refresh status  /plugins       List plugins
/plugin install owner/repo           /plugin info   Plugin details
/entrada 500 cat  Record income      /saida 50 cat  Record expense
```

## Auth

Claude Code subscription (auto-detected from `~/.claude/.credentials.json`). Token is automatically renewed via auto-refresh. Use `/refresh` for manual renewal or `/auto-refresh` to check status.

## Requirements

- **Windows 10/11**
- **Bun** runtime (`irm bun.sh/install.ps1 | iex`)

## License

MIT

---

# smolerclaw (PT-BR)

Um micro assistente de IA construido em cima do Claude, feito para Windows.
Um binario, zero configuracao, TUI completa.

---

## Inicio Rapido

```bash
# 1. Tenha o Claude Code instalado com assinatura Pro/Max
#    (credenciais detectadas automaticamente de ~/.claude/.credentials.json)

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
- **Renovacao de sessao** — renovar token de autenticacao Claude Code sem sair da TUI
- **Auto-refresh** — monitoramento proativo de token OAuth com renovacao automatica antes da expiracao
- **Verificacao financeira** — limites de valor, deteccao de duplicatas, alertas de gasto diario
- **Sistema de plugins** — instalar plugins do GitHub com `/plugin install owner/repo`, suporte a plugins JSON e TypeScript com lifecycle hooks

## Comandos na TUI

```
/ajuda         Todos os comandos     /limpar        Limpar conversa
/tarefa 18h comprar pao              /tarefas       Listar pendentes
/resumo        Briefing matinal      /noticias      Manchetes
/abrir excel   Abrir app             /calendario    Eventos Outlook
/investigar    Listar investigacoes  /memo #tag     Salvar anotacao
/email         Rascunho de email     /foco          Timer Pomodoro
/modelo sonnet Trocar modelo         /exportar      Salvar em markdown
/indexar       Construir indice RAG  /memoria <q>   Buscar na memoria
/projeto auto  Definir projeto ativo /projetos      Listar projetos
/sessao start  Iniciar timer         /sessao stop   Parar timer
/relatorio     Relatorio progresso   /oportunidades Listar oportunidades
/area          Ler clipboard/OCR     /tela          Contexto de tela
/ps1 <script>  Executar PowerShell   /refresh       Renovar token auth
/auto-refresh  Status auto-refresh   /plugins       Listar plugins
/plugin install owner/repo           /plugin info   Detalhes plugin
/entrada 500 cat  Registrar entrada  /saida 50 cat  Registrar saida
```

## Autenticacao

Assinatura Claude Code (detectada automaticamente de `~/.claude/.credentials.json`). O token e renovado automaticamente via auto-refresh. Use `/refresh` para renovacao manual ou `/auto-refresh` para ver o status.

## Requisitos

- **Windows 10/11**
- **Bun** runtime (`irm bun.sh/install.ps1 | iex`)

## Licenca

MIT
