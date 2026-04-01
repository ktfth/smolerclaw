# Arquitetura smolerclaw

> Micro assistente de IA no terminal, feito para Windows.
> Um binario, zero configuracao, TUI completa.

---

## Visao Geral

smolerclaw e um assistente de IA de terminal que combina o Claude da Anthropic com integracao profunda no Windows. A arquitetura segue um modelo em camadas com modulos desacoplados comunicando-se via event bus.

```
┌─────────────────────────────────────────────────────┐
│                     TUI Layer                        │
│  tui.ts · cli.ts · ansi.ts · markdown.ts            │
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
│  email · briefing · morning · pitwall               │
├─────────────────────────────────────────────────────┤
│              Services Layer (Smart)                  │
│  decision-engine · agency-engine · docs-engine      │
│  dependency-graph                                   │
├─────────────────────────────────────────────────────┤
│            Core Infrastructure Layer                 │
│  event-bus · logger · vault · session · config      │
│  memory (RAG) · platform · undo                     │
├─────────────────────────────────────────────────────┤
│           Windows Integration Layer                  │
│  windows.ts · windows-agent.ts · clipboard.ts       │
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
    └── On /refresh → spawn `claude -p 'Fresh!'`
                       → re-read credentials
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

### Por que RAG Local (TF-IDF + BM25)?

Busca semantica sem depender de APIs externas. Indexa memos, materiais, decisoes e sessoes. Indexacao incremental via hashes SHA-256. Roda 100% offline, sem custo, com latencia minima.

---

## Modulos por Camada

### TUI Layer
| Modulo | LOC | Responsabilidade |
|--------|-----|------------------|
| `tui.ts` | ~2,000 | Interface terminal, rendering, input handling |
| `cli.ts` | 137 | Parse de argumentos, help, versao |
| `ansi.ts` | 243 | Sequencias ANSI, cores, formatacao |
| `markdown.ts` | 148 | Rendering markdown no terminal |

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

*Gerado em: 2026-03-31*
*smolerclaw v1.3.6*
