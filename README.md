# smolerclaw

A micro AI assistant built on top of Claude, designed for Windows.
One binary, zero config, full TUI.

---

## Quick Start

```bash
# 1. Set your key (or use Claude Code subscription — auto-detected)
set ANTHROPIC_API_KEY=sk-ant-...

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

## TUI Commands

```
/help          All commands          /clear         Clear conversation
/task 18h buy bread                  /tasks         List pending
/briefing      Morning summary       /news          Headlines
/open excel    Launch app            /calendar      Outlook events
/investigar    List investigations   /memo #tag     Save a note
/email         Draft email           /pomodoro      Focus timer
/model sonnet  Switch model          /export        Save to markdown
```

## Auth

Three ways, in priority order:

1. `ANTHROPIC_API_KEY` env var
2. Claude Code subscription (auto-detected from `~/.claude/.credentials.json`)
3. `apiKey` in `~/.config/smolerclaw/config.json`

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
# 1. Configure sua chave (ou use assinatura Claude Code — detectada automaticamente)
set ANTHROPIC_API_KEY=sk-ant-...

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

## Comandos na TUI

```
/ajuda         Todos os comandos     /limpar        Limpar conversa
/tarefa 18h comprar pao              /tarefas       Listar pendentes
/resumo        Briefing matinal      /noticias      Manchetes
/abrir excel   Abrir app             /calendario    Eventos Outlook
/investigar    Listar investigacoes  /memo #tag     Salvar anotacao
/email         Rascunho de email     /foco          Timer Pomodoro
/modelo sonnet Trocar modelo         /exportar      Salvar em markdown
```

## Autenticacao

Tres formas, em ordem de prioridade:

1. Variavel de ambiente `ANTHROPIC_API_KEY`
2. Assinatura Claude Code (detectada automaticamente de `~/.claude/.credentials.json`)
3. `apiKey` em `~/.config/smolerclaw/config.json`

## Requisitos

- **Windows 10/11**
- **Bun** runtime (`irm bun.sh/install.ps1 | iex`)

## Licenca

MIT
