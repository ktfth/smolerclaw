# Arquitetura smolerclaw

> Micro assistente de IA no terminal, feito para Windows.
> Um binario, zero configuracao, TUI completa.

---

## Visao Geral

smolerclaw e um assistente de IA de terminal que combina o Claude da Anthropic com integracao profunda no Windows. A arquitetura segue um modelo em camadas com modulos desacoplados comunicando-se via event bus.

```
┌─────────────────────────────────────────────────────┐
│                   UI Layer (multi)                    │
│  TUI: tui.ts · cli.ts · ansi.ts · markdown.ts      │
│  Web: ui/web/ (Hono server)                         │
│  Desktop: ui/desktop/ (Electrobun)                  │
│  Shared: ui/shared/ (chat-service, types)           │
├─────────────────────────────────────────────────────┤
│                  Provider Layer                      │
│  claude.ts · openai-provider.ts · providers.ts       │
│  auth.ts · retry.ts · errors.ts · context-window.ts │
├─────────────────────────────────────────────────────┤
│                Tool Execution Layer                  │
│  tools/ (schemas, execute, file, search, command,   │
│          network, vault, memory, business, agency,  │
│          windows, security, helpers)                 │
│  tool-safety.ts · approval.ts                       │
├─────────────────────────────────────────────────────┤
│              Feature Modules Layer                   │
│  tasks · memos · materials · people · projects      │
│  news · finance · decisions · investigations        │
│  workflows · scheduler · monitor · pomodoro         │
│  email · briefing · morning · pitwall · macros      │
│  auto-refresh · finance-guard · plugin-system       │
├─────────────────────────────────────────────────────┤
│              Services Layer (Smart)                  │
│  decision-engine · agency-engine · docs-engine      │
│  dependency-graph                                   │
├─────────────────────────────────────────────────────┤
│            Core Infrastructure Layer                 │
│  event-bus · logger · vault · session · config      │
│  memory (RAG) · platform · undo · i18n              │
├─────────────────────────────────────────────────────┤
│           Windows Integration Layer                  │
│  windows.ts · windows-agent.ts · clipboard.ts       │
│  utils/windows-executor.ts                          │
└─────────────────────────────────────────────────────┘
```

---

## Fluxo de Dados

### Conversa Principal

```
User Input
    │
    ▼
  TUI (tui.ts)
    │ parse input, detect /commands
    ▼
  Command Handler (index.ts)
    │ dispatch to appropriate handler
    ├── /command → direct handler (tasks, memos, etc.)
    └── AI message → Provider
                        │
                        ▼
                  ClaudeProvider (claude.ts)
                        │ stream API call
                        │ with retry + auth refresh
                        ▼
                  Anthropic API
                        │ streaming response
                        ▼
                  Tool Loop (max 25 rounds)
                        │ tool_use blocks
                        ▼
                  Tool Safety (tool-safety.ts)
                        │ assess risk level
                        ▼
                  Approval (approval.ts)
                        │ check approval mode
                        ▼
                  executeTool (tools/execute.ts)
                        │ dispatch to module
                        ▼
                  Tool Result → back to API
```

### Autenticacao

```
~/.claude/.credentials.json
    │ OAuth token (Claude Code subscription)
    ▼
  auth.ts → resolveAuth()
    │ read + validate + check expiry
    ▼
  ClaudeProvider → new Anthropic({ apiKey: token })
    │
    ├── On 401 → retry.ts → onAuthExpired callback
    │                │ refreshAuth() → re-read credentials
    │                └── updateToken() → recreate client
    │
    ├── On /refresh → spawn `claude -p 'Fresh!'`
    │                  → re-read credentials
    │
    └── Auto-refresh (auto-refresh.ts)
         │ timer check a cada 60s
         ├── Token longe de expirar → noop
         ├── Token perto de expirar → re-read disk
         │   └── Token ja rotacionado → adota novo token
         └── Token nao mudou → spawn `claude -p 'Fresh!'`
              → re-read → updateToken()
```

### Persistencia

```
%LOCALAPPDATA%/smolerclaw/
├── sessions/*.json         Conversas (SessionManager)
├── sessions/archive/*.json Sessoes arquivadas
├── tasks.json              Tarefas (escrita atomica)
├── people.json             Pessoas + delegacoes
├── memos.json              Anotacoes
├── materials.json          Base de conhecimento
├── finance.json            Transacoes
├── decisions.json          Log de decisoes
├── investigations/*.json   Investigacoes
├── workflows.json          Automacoes
├── projects.json           Projetos
├── work-sessions.json      Sessoes de trabalho
├── opportunities.json      Pipeline
├── news-feeds.json         Fontes RSS custom
├── rag/rag-index.json      Indice de busca RAG
├── vault-checksums.json    Integridade SHA-256
└── .backup/                Repo git de backup

%APPDATA%/smolerclaw/ (ou ~/.config/smolerclaw/)
├── config.json             Configuracao do usuario
├── macros.json             Atalhos rapidos (macros)
└── plugins/                Diretorio de plugins
    ├── *.json              Plugins JSON (legado)
    ├── *.ts / *.js         Script plugins com lifecycle
    ├── disabled/           Plugins desabilitados
    └── installed/          Plugins clonados do GitHub
        └── owner--repo/    Repo clonado + .smolerclaw-install.json
```

Toda escrita usa `atomicWriteFile()` (tmp + rename) com checksums SHA-256 verificados na leitura.

---

## Decisoes Arquiteturais

### Por que Subscription-Only (sem API Key)?

smolerclaw foi projetado para rodar junto com Claude Code, aproveitando a assinatura Pro/Max do usuario. Isso elimina a necessidade de gerenciar API keys, reduz risco de vazamento de secrets, e simplifica o onboarding a zero configuracao.

### Por que Event Bus?

O event bus (`core/event-bus.ts`) desacopla modulos que precisam reagir a eventos sem dependencias diretas. Por exemplo, o decision engine observa eventos de tool usage sem o tool layer precisar saber que ele existe. Suporta emit/on/once/off com tipagem forte.

### Por que Vault Atomico?

Dados do usuario (tarefas, memos, financas) sao criticos. Escrita atomica (write tmp → rename) previne corrupcao em caso de crash ou queda de energia. Checksums SHA-256 detectam dados corrompidos na leitura, preservando o arquivo corrompido como `.corrupt.json` para recuperacao.

### Por que Multi-Provider?

Suporta Anthropic (principal, via subscription), OpenAI (via API key), e Ollama (local, sem key). Permite o usuario escolher o melhor modelo para cada situacao. Interface `LLMProvider` garante que novos providers podem ser adicionados facilmente.

### Por que Modulos Feature Split?

Cada dominio (tasks, people, memos, etc.) vive em seu proprio modulo com estado isolado. Isso permite:
- Testes independentes por dominio
- Lazy loading futuro
- Facil adicao de novos dominios
- Limites claros de responsabilidade

### Por que Auto-Refresh Proativo?

O token OAuth do Claude Code expira periodicamente. Sem auto-refresh, o usuario so descobre quando a proxima chamada falha com 401. O auto-refresh monitora a expiracao com timer (check a cada 60s, refresh 5min antes de expirar) e tenta re-ler o token do disco — se Claude Code ja rotacionou, basta adotar. Se nao, spawna `claude -p 'Fresh!'` para forcar a rotacao. Nenhuma interrupcao da conversa.

### Por que Finance Guard como Camada Separada?

O finance-guard opera como middleware entre comandos/tools e o modulo finance.ts. Separar a logica de verificacao (limites, duplicatas, gasto diario) da persistencia permite que regras de negocio evoluc para sem alterar o armazenamento. O ledger diario e separado da janela de duplicatas — duplicatas expiram em 5min, mas gastos do dia persistem ate meia-noite. Eventos de auditoria via event bus permitem que outros modulos reajam a atividade financeira.

### Por que Plugin System com Lifecycle?

O sistema original de plugins (JSON-only, shell templates) era limitado a ferramentas simples sem estado. O plugin system aprimorado adiciona: (1) script plugins com `onLoad`/`onUnload` para estado e recursos, (2) `onToolCall` para logica customizada em vez de shell, (3) subscricoes de eventos para reatividade, (4) enable/disable persistente, (5) install/uninstall via GitHub. A interface `PluginContext` fornece `notify()` e `dataDir` isolado por plugin. JSON plugins continuam funcionando sem mudanca.

### Por que RAG Local (TF-IDF + BM25)?

Busca semantica sem depender de APIs externas. Indexa memos, materiais, decisoes e sessoes. Indexacao incremental via hashes SHA-256. Roda 100% offline, sem custo, com latencia minima.

### Por que Macros Separado de Workflows?

Macros executam uma unica acao instantanea (abrir app, URL, arquivo, ou comando). Workflows sao rotinas de multiplos passos com controle de fluxo. A separacao mantem cada sistema simples: macros sao CRUD + execute, workflows tem steps, condicoes, e error handling. Macros vem com 16 atalhos padrao para produtividade imediata.

### Por que Multi-UI (TUI + Web + Desktop)?

A TUI e o modo principal, mas nem todo contexto de uso favorece o terminal. A interface web (Hono) permite acesso via navegador sem instalar nada extra. O modo desktop (Electrobun) oferece janela nativa para quem prefere app dedicado. O `chat-service` compartilhado em `ui/shared/` garante que a logica de conversa e reutilizada entre os tres modos sem duplicacao.

### Por que i18n com Fallback?

O sistema de traducao (`src/i18n/`) usa dicionarios tipados (PT-BR e EN). A funcao `t(key, params?)` busca no dicionario atual e faz fallback automatico para ingles se a chave nao existir. Isso permite traducao incremental — novas features podem ser adicionadas em ingles e traduzidas gradualmente. Parametros sao interpolados via `{{key}}` no template.

### Por que Windows Executor Centralizado?

Toda execucao de PowerShell no codebase passa por `utils/windows-executor.ts`. Isso garante flags obrigatorios (-NoProfile, -NonInteractive), timeout com kill de processo, encoding UTF-8, e logging centralizado. O executor tambem valida existencia de executaveis via `Get-Command` com fallback para App Paths registry, cobrindo apps como Chrome que nao estao no PATH.

---

## Modulos por Camada

### UI Layer
| Modulo | LOC | Responsabilidade |
|--------|-----|------------------|
| `tui.ts` | ~2,000 | Interface terminal, rendering, input handling |
| `cli.ts` | 166 | Parse de argumentos, help, versao, modos (tui/web/desktop) |
| `ansi.ts` | 243 | Sequencias ANSI, cores, formatacao |
| `markdown.ts` | 148 | Rendering markdown no terminal |
| `ui/web/` | ~200 | Servidor Hono para interface web |
| `ui/desktop/` | ~150 | App desktop via Electrobun |
| `ui/shared/` | ~300 | Chat service e tipos compartilhados entre modos |
| `modes/ui-mode.ts` | 87 | Orquestracao de modos web e desktop |
| `i18n/` | ~300 | Traducoes PT-BR/EN com fallback e interpolacao |

### Provider Layer
| Modulo | LOC | Responsabilidade |
|--------|-----|------------------|
| `claude.ts` | 267 | Provider Anthropic com streaming e tool loop |
| `openai-provider.ts` | 127 | Provider OpenAI/Ollama compativel |
| `auth.ts` | 76 | Leitura de credenciais OAuth |
| `retry.ts` | 108 | Retry com backoff exponencial |
| `context-window.ts` | 277 | Trimming, summarization, compressao |
| `errors.ts` | 78 | Mensagens de erro humanas |

### Tool Execution Layer
| Modulo | LOC | Responsabilidade |
|--------|-----|------------------|
| `tools/` | ~3,500 | 14 modulos: schemas, dispatch, implementacoes |
| `tool-safety.ts` | 237 | Classificacao de risco, secrets, rate limits |
| `approval.ts` | 80 | Fluxo de aprovacao por modo |

### Services Layer
| Modulo | LOC | Responsabilidade |
|--------|-----|------------------|
| `decision-engine.ts` | 795 | Analise de tradeoffs, correlacao de incidentes |
| `agency-engine.ts` | 826 | Planejamento com aprovacao humana |
| `docs-engine.ts` | 829 | Self-reflection, living manual |
| `dependency-graph.ts` | 491 | Blast radius, refactor planning |

### Cross-Cutting Modules
| Modulo | LOC | Responsabilidade |
|--------|-----|------------------|
| `auto-refresh.ts` | 280 | Monitoramento e renovacao automatica de token OAuth |
| `finance-guard.ts` | 240 | Verificacao de transacoes: limites, duplicatas, gasto diario |
| `plugin-system.ts` | 530 | Registry de plugins: JSON + script, lifecycle, GitHub install |
| `macros.ts` | 546 | Atalhos rapidos: CRUD, execucao, tags, 16 defaults |
| `utils/windows-executor.ts` | 679 | Executor centralizado PowerShell: timeouts, logs, App Paths |

### Core Infrastructure
| Modulo | LOC | Responsabilidade |
|--------|-----|------------------|
| `core/event-bus.ts` | 349 | Pub/sub tipado com error handling |
| `core/logger.ts` | 50 | Logger estruturado (stderr, niveis) |
| `vault.ts` | 593 | Escrita atomica, checksums, backup |
| `session.ts` | 233 | Gerenciamento de sessoes |
| `memory.ts` | 564 | RAG local (TF-IDF + BM25) |
| `config.ts` | 121 | Configuracao com validacao |

---

## Seguranca

### Camadas de Protecao

1. **Tool Safety** — Classifica todo tool call por risco (safe/moderate/dangerous)
2. **Secret Detection** — Bloqueia write/edit com API keys, tokens, passwords
3. **Protected Paths** — Bloqueia escrita em System32, /etc, .ssh, etc.
4. **Rate Limiting** — Limita write_file (100/min), run_command (50/min)
5. **PowerShell Guards** — Bloqueia desativar Defender, formatar disco, etc.
6. **SSRF Guard** — Previne fetch para IPs internos
7. **Path Traversal Guard** — Normaliza e valida caminhos
8. **Approval Modes** — auto / confirm-writes / confirm-all

### Dados Sensiveis

- OAuth token lido de disco, nunca logado ou persistido
- Nenhuma API key armazenada no codigo
- Escrita atomica previne corrupcao
- Checksums detectam adulteracao

---

*Atualizado em: 2026-04-02*
*smolerclaw v1.6.0*
