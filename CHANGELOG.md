# Changelog

Todas as mudancas notaveis do smolerclaw estao documentadas neste arquivo.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/),
e o versionamento segue [Semantic Versioning](https://semver.org/lang/pt-BR/).

---

## [Unreleased]

### Added
- **Auto-refresh de token OAuth** (`src/auto-refresh.ts`) — monitora expiracao do token e renova automaticamente antes de expirar, spawna `claude` para rotacao real quando re-leitura nao e suficiente
- **Finance Guard** (`src/finance-guard.ts`) — camada de verificacao para operacoes financeiras com validacao de valor, deteccao de duplicatas, alertas de gasto diario, e trilha de auditoria via event bus
- **Plugin System aprimorado** (`src/plugin-system.ts`) — suporte a plugins JSON (legado) e TypeScript/JavaScript com lifecycle hooks (`onLoad`/`onUnload`), subscricoes de eventos, `onToolCall`, enable/disable persistente, e registro com versionamento
- **Instalacao de plugins do GitHub** — `/plugin install owner/repo` clona repositorio, descobre entry point (plugin.json, plugin.ts, index.ts, ou campo `smolerclaw` no package.json), e registra automaticamente
- Comando `/auto-refresh` para visualizar status do auto-refresh de token
- Comandos `/plugin install`, `/plugin uninstall`, `/plugin installed`, `/plugin info`, `/plugin enable`, `/plugin disable`
- Ledger diario separado no finance-guard para tracking de gastos que persiste o dia todo (independente da janela de duplicatas)
- 66 novos testes para auto-refresh, finance-guard e plugin-system (total: 865 testes)
- Logger estruturado (`src/core/logger.ts`) com niveis debug/info/warn/error, controlado por `LOG_LEVEL`
- Deteccao de secrets em tool calls (15 patterns: API keys, tokens, passwords)
- Protecao de paths do sistema (System32, /etc, .ssh, etc.) em write/edit
- Rate limiting por ferramenta (write_file 100/min, run_command 50/min)
- Documentacao arquitetural (`docs/ARCHITECTURE.md`)
- 190 novos testes para context-window, event-bus e windows-agent

### Changed
- `initSession()` agora e async para suportar inicializacao do plugin system aprimorado
- Comandos `/entrada` e `/saida` agora passam por verificacao do finance-guard antes de persistir
- Tool `record_transaction` agora valida via finance-guard e retorna avisos ao modelo
- `/plugins` agora usa registry do plugin system aprimorado (suporta JSON + script)
- `src/tools.ts` (3.369 LOC) dividido em 14 modulos em `src/tools/`
- `src/index.ts` (2.419 LOC) dividido em `src/init/`, `src/modes/`, `src/commands/`
- Parametro `apiKey` renomeado para `token` em ClaudeProvider (reflete uso de subscription)
- `updateApiKey()` renomeado para `updateToken()`
- 12 catch blocks silenciosos agora logam via logger estruturado

### Removed
- Todas as referencias a `ANTHROPIC_API_KEY` na documentacao e instalador
- Suporte a API key removido do Quick Start (README e install.ps1)

### Fixed
- Mensagem de erro em `errors.ts` ja referencia "subscription token" corretamente

---

## [1.3.6] - 2026-03-31

### Changed
- Autenticacao simplificada: subscription-only, sem fallback para API key
- README e USAGE.md atualizados para refletir auth por subscription

---

## [1.3.5] - 2026-03-31

### Added
- Scheduler integrado com Windows Task Scheduler
- Dashboard de boas-vindas com noticias, tarefas e calendario
- Toast notifications no Windows para lembretes
- Filtro por categoria ao listar noticias

---

## [1.3.4] - 2026-03-30

### Added
- Logo do projeto (smolerclaw.png)

---

## [1.3.3] - 2026-03-30

### Added
- Protocolo de Alta Agencia e Planejamento Previo (agency-engine)
- 46 testes para modulos criticos (context, context-window, event-bus, windows-agent)

---

## [1.3.2] - 2026-03-29

### Fixed
- Correcao de rendering na TUI

---

## [1.3.1] - 2026-03-29

### Added
- Event Bus (`src/core/event-bus.ts`) para comunicacao desacoplada entre modulos
- Engine de decisao estocastica (`src/services/decision-engine.ts`)
- Ciclo de aprendizado continuo (`src/services/docs-engine.ts`)
- Melhoria na engine do Windows (OCR, screen context, PowerShell)
- TUI com dicas contextuais
- Contexto enriquecido para o modelo (git, projeto, ambiente)

### Changed
- Refinamento da interface TUI
- Melhoria geral na qualidade do codigo

---

## [1.3.0] - 2026-03-28

### Changed
- Melhorias significativas de performance
- Otimizacoes de contexto e streaming

---

## [1.2.3] - 2026-03-27

### Fixed
- Correcao na selecao de sessoes

---

## [1.2.2] - 2026-03-27

### Changed
- Atualizacao do package.json

---

## [1.2.1] - 2026-03-27

### Fixed
- Correcao de versao no binario

---

## [1.2.0] - 2026-03-27

### Added
- Gestao de projetos (`/projeto`, `/projetos`, `/sessao`, `/relatorio`)
- Pipeline de oportunidades (`/oportunidades`)
- Sessoes de trabalho com timer
- Relatorios de progresso (git + sessoes + tarefas)

---

## [1.1.0] - 2026-03-27

### Changed
- Melhorias internas na arquitetura

---

## [1.0.5] - 2026-03-25

### Added
- Materiais persistentes (base de conhecimento com categorias e tags)

---

## [1.0.4] - 2026-03-25

### Added
- Noticias de seguranca/cyber como categoria

---

## [1.0.3] - 2026-03-24

### Removed
- Suporte a API key removido do codigo (subscription-only desde esta versao)

### Fixed
- Correcao de parsing de horarios
- Correcao em acoes do sistema

---

## [1.0.2] - 2026-03-24

### Changed
- Documentacao atualizada (README, USAGE)

---

## [1.0.1] - 2026-03-24

### Changed
- Documentacao inicial completa

---

## [0.1.1] - 2026-03-24

### Added
- Commit inicial do smolerclaw
- Assistente de negocios com integracao Windows e radar de noticias
- Sistema de tarefas e lembretes com toast notifications
- Gerenciamento de pessoas (equipe, familia, contatos)
- Comandos bilingues (Portugues + Ingles)
- Sistema de memos persistente
- Briefing matinal automatico
- Rascunho de email com integracao Outlook
- Timer Pomodoro com notificacoes
- Controle financeiro (entradas/saidas)
- Log de decisoes com contexto
- Workflows automatizados (multi-step)
- Monitor de processos Windows
- Instalador PowerShell (`install.ps1`)
- Skills e personas (default, business)
- Safety guards para PowerShell
- Escrita atomica com checksums SHA-256
- Multi-provider (Anthropic, OpenAI, Ollama)

---

[Unreleased]: https://github.com/ktfth/smolerclaw/compare/v1.3.6...HEAD
[1.3.6]: https://github.com/ktfth/smolerclaw/compare/v1.3.5...v1.3.6
[1.3.5]: https://github.com/ktfth/smolerclaw/compare/v1.3.4...v1.3.5
[1.3.4]: https://github.com/ktfth/smolerclaw/compare/v1.3.3...v1.3.4
[1.3.3]: https://github.com/ktfth/smolerclaw/compare/v1.3.2...v1.3.3
[1.3.2]: https://github.com/ktfth/smolerclaw/compare/v1.3.1...v1.3.2
[1.3.1]: https://github.com/ktfth/smolerclaw/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/ktfth/smolerclaw/compare/v1.2.3...v1.3.0
[1.2.3]: https://github.com/ktfth/smolerclaw/compare/v1.2.2...v1.2.3
[1.2.2]: https://github.com/ktfth/smolerclaw/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/ktfth/smolerclaw/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/ktfth/smolerclaw/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/ktfth/smolerclaw/compare/v1.0.5...v1.1.0
[1.0.5]: https://github.com/ktfth/smolerclaw/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/ktfth/smolerclaw/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/ktfth/smolerclaw/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/ktfth/smolerclaw/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/ktfth/smolerclaw/compare/v0.1.1...v1.0.1
[0.1.1]: https://github.com/ktfth/smolerclaw/releases/tag/v0.1.1
