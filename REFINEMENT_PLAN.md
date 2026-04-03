# Plano de Refinamento Production-Grade

> **Status**: Fases 1-4 concluidas. Fase 6 (UX) parcialmente implementada.
> **Ultima atualizacao**: 2026-04-02

## Implementacoes Concluidas (2026-03-29)

### Modulo `src/input/` - Ergonomia de Interacao

Novos modulos implementados com 145 testes (todos passando):

| Modulo | LOC | Testes | Descricao |
|--------|-----|--------|-----------|
| `fuzzy.ts` | 180 | 44 | Fuzzy matching para comandos e busca |
| `history-search.ts` | 140 | 28 | Ctrl+R reverse search (bash/zsh style) |
| `command-palette.ts` | 400 | 32 | Ctrl+P command palette (VS Code style) |
| `vim-mode.ts` | 380 | 41 | Vim modal editing (hjkl, w, b, d, c, y, p) |
| `index.ts` | 65 | - | Re-exports organizados |

**Recursos implementados**:
- Fuzzy matching com bonus para word boundaries, consecutivos, inicio
- Highlighting de caracteres matched
- History search com navegacao Ctrl+R / Ctrl+S
- Prompt bash-style: `(reverse-i-search)'query': result`
- Command palette com categorias, keywords, recent items boost
- Vim motions: h, l, w, b, e, 0, $, ^
- Vim operators: d (delete), c (change), y (yank), p (paste)
- Vim counts: 3w = 3 words, dd = delete line
- Mode indicator: `-- NORMAL --`, `-- INSERT --`

---

## Auto-Avaliacao do Estado Atual

### Metricas Coletadas

| Metrica | Valor Atual | Target Production |
|---------|-------------|-------------------|
| Cobertura Funcoes | 78.26% | 85%+ |
| Cobertura Linhas | 77.80% | 80%+ |
| Testes | 315 passando | - |
| LOC Total (src/) | ~22,400 | - |
| LOC Testes | ~2,600 | 20%+ do src |

### Pontos Fortes Identificados

1. **Arquitetura Modular**: 60 modulos bem separados
2. **Event Bus Recente**: Comunicacao event-driven implementada
3. **Sistema de Vault**: Escrita atomica com checksums
4. **Validacao de Seguranca**: SSRF guard, path traversal guard, tool safety
5. **Multi-provider**: Anthropic, OpenAI, Ollama suportados
6. **Cobertura Razoavel**: 78% funcoes, 77% linhas

### Gaps Criticos para Production

1. **Modulos Grandes**: `tools.ts` (2,828 LOC), `index.ts` (2,211 LOC)
2. **Cobertura Baixa em Modulos Criticos**:
   - `context.ts`: 2.75% linhas
   - `context-window.ts`: 14.04% linhas
   - `briefing.ts`: 18.14% linhas
   - `windows-agent.ts`: 23.78% linhas
   - `core/event-bus.ts`: 28.78% linhas
3. **Documentacao Arquitetural**: Inexistente
4. **E2E Tests**: Nenhum visivel

---

## Plano de Melhorias por Prioridade

### FASE 1: Estabilizacao Critica (P0) — CONCLUIDA

#### 1.1 Split do `tools.ts` (2,828 LOC) — CONCLUIDO (v1.4.0)

Split realizado em 14 modulos em `src/tools/`:
`index.ts`, `schemas.ts`, `file-tools.ts`, `search-tools.ts`, `command-tools.ts`, `network-tools.ts`, `vault-tools.ts`, `memory-tools.ts`, `windows-tools.ts`, `business-tools.ts`, `agency-tools.ts`, `execute.ts`, `security.ts`, `helpers.ts`

#### 1.2 Testes para Modulos Criticos — CONCLUIDO (v1.4.0)

190 novos testes adicionados para context-window, event-bus e windows-agent.
66 novos testes para auto-refresh, finance-guard e plugin-system.
Total: 865+ testes.

#### 1.3 Correcao de Error Handling Silencioso — CONCLUIDO (v1.4.0)

12 catch blocks silenciosos migrados para logger estruturado (`src/core/logger.ts`).

---

### FASE 2: Refatoracao Estrutural (P1) — CONCLUIDA

#### 2.1 Split do `index.ts` (2,211 LOC) — CONCLUIDO (v1.4.0)

Split realizado conforme proposto:
- `src/init/providers.ts` — setup Claude/OpenAI/Ollama
- `src/init/modules.ts` — init de todos os modulos
- `src/init/session.ts` — session management
- `src/modes/print-mode.ts` — modo nao-interativo
- `src/modes/interactive.ts` — TUI interativa
- `src/modes/ui-mode.ts` — modos web e desktop (adicionado v1.6.0)
- `src/commands/handlers.ts` — handlers de comandos TUI

#### 2.2 Logging Estruturado — CONCLUIDO (v1.4.0)

Implementado em `src/core/logger.ts` com niveis debug/info/warn/error, controlado por `LOG_LEVEL`.

#### 2.3 Metricas de Uso

**Status**: Pendente. Telemetria opcional ainda nao implementada.

---

### FASE 3: Seguranca e Robustez (P1) — CONCLUIDA

#### 3.1 Expandir Tool Safety Assessment — CONCLUIDO (v1.4.0)

Implementado em `src/tools/security.ts` (237 LOC):
- Deteccao de secrets em tool calls (15 patterns: API keys, tokens, passwords)
- Protecao de paths do sistema (System32, /etc, .ssh, etc.) em write/edit
- Rate limiting por ferramenta (write_file 100/min, run_command 50/min)

#### 3.2 Audit Log para Operacoes Sensiveis

**Status**: Parcialmente implementado. Finance-guard tem audit trail via event bus. Audit log generico para todas as tools ainda pendente.

---

### FASE 4: Documentacao (P2) — CONCLUIDA

#### 4.1 Documentacao Arquitetural — CONCLUIDO (v1.4.0)

`docs/ARCHITECTURE.md` criado e mantido atualizado com:
- Diagrama de camadas em ASCII
- Fluxo de dados (conversa, autenticacao, persistencia)
- Decisoes arquiteturais documentadas
- Modulos por camada com LOC e responsabilidade
- Atualizado para v1.6.0 (inclui macros, i18n, multi-UI)

#### 4.2 JSDoc em Funcoes Publicas

**Status**: Parcialmente implementado. Modulos novos (macros, i18n, windows-executor) tem JSDoc. Modulos legados ainda pendentes.

---

### FASE 5: Performance (P2)

#### 5.1 Profiling do RAG/Memory

- Benchmark indexacao de 100, 1000, 10000 documentos
- Medir tempo de query com diferentes tamanhos
- Otimizar TF-IDF se necessario

#### 5.2 Lazy Loading de Modulos

```typescript
// Carregar modulos pesados apenas quando necessarios
const loadPitwall = () => import('./pitwall')
const loadDecisionEngine = () => import('./services/decision-engine')
```

#### 5.3 Cache de Contexto

- Cache do `gatherContext()` por 10s
- Invalidar em mudanca de diretorio

---

## Checklist de Validacao Pre-Release

### Build & Deploy

- [x] `bun run typecheck` passa sem erros
- [ ] `bun test` todos os testes passam
- [ ] Cobertura >= 80% linhas
- [ ] Build single-binary funciona
- [x] Instalador Windows funciona

### Seguranca

- [x] Nenhum secret hardcoded (grep por API_KEY, password, token)
- [x] Tool safety cobre todos os patterns perigosos (15 patterns)
- [ ] Audit log generico funcionando
- [x] SSRF guard testado com URLs maliciosas

### Funcionalidade

- [x] Fluxo de conversa basico funciona
- [x] Todas as ferramentas respondem corretamente
- [x] Vault backup/restore funciona
- [x] Multi-provider (Anthropic, OpenAI, Ollama) funciona
- [x] Macros: CRUD + execucao + tags
- [x] i18n: PT-BR + EN com fallback
- [x] Multi-UI: TUI + Web + Desktop

### Documentacao

- [x] README atualizado com versao (v1.6.0)
- [x] ARCHITECTURE.md criado e atualizado
- [x] CHANGELOG atualizado (v1.4.0 - v1.6.0)
- [x] USAGE.md atualizado com macros, scheduler, UI, i18n

---

## Historico de Implementacao

```
Concluido: FASE 1 (Split tools.ts, testes criticos, error handling) — v1.4.0
Concluido: FASE 2 (Split index.ts, logging estruturado) — v1.4.0
Concluido: FASE 3 (Tool safety, secrets, rate limiting) — v1.4.0
Concluido: FASE 4 (Documentacao arquitetural) — v1.4.0
Concluido: i18n + Multi-UI (web/desktop) — v1.5.0/v1.6.0
Concluido: Macros system — v1.6.0+
```

---

## Proximos Passos

1. **Metricas de uso** (Fase 2.3) — telemetria opcional
2. **Audit log generico** (Fase 3.2) — trail para todas as tools
3. **JSDoc completo** (Fase 4.2) — modulos legados
4. **Performance profiling** (Fase 5) — RAG, lazy loading, cache
5. **Cobertura 80%+** — testes adicionais em modulos com baixa cobertura

---

---

## FASE 6: Ergonomia de Interacao - UX na Ponta dos Dedos (P0)

> **Filosofia**: A interface deve responder como extensao do corpo - movimentos inatos,
> memoria muscular, zero fricao cognitiva. O usuario nao "usa" a ferramenta, ele "flui" com ela.

### Estado Atual da UX

| Aspecto | Implementado | Gap |
|---------|--------------|-----|
| Readline-style | Sim | Basico, sem motions |
| Tab completion | Sim | Literal, sem fuzzy |
| History (up/down) | Sim | Sem Ctrl+R search |
| Pickers (sessions/news) | Sim | Navegacao basica |
| Vim motions | Nao | Ausente |
| Command palette | Nao | Ausente |
| Fuzzy search | Nao | Ausente |
| Chords (Ctrl+K x) | Nao | Ausente |

### 6.1 Vim Motions - Movimentos Inatos

**Por que Vim?**: Usuarios power-user tem vim gravado na medula espinhal.
Hjkl, w, b, 0, $, dd sao reflexos, nao pensamentos.

```typescript
// src/input/vim-mode.ts
interface VimState {
  mode: 'normal' | 'insert' | 'visual'
  register: string
  count: number
  operator: string | null
}

// Motions (movimentos)
const MOTIONS = {
  'h': moveLeft,
  'l': moveRight,
  'w': wordForward,
  'b': wordBackward,
  'e': wordEnd,
  '0': lineStart,
  '$': lineEnd,
  'gg': bufferStart,
  'G': bufferEnd,
}

// Operators (acoes)
const OPERATORS = {
  'd': delete,
  'c': change,
  'y': yank,
}

// Combos: d + w = delete word, c + $ = change to end
```

**Keybindings Vim Mode**:

| Key | Normal Mode | Insert Mode |
|-----|-------------|-------------|
| `Esc` | - | Volta para Normal |
| `i` | Entra Insert | - |
| `a` | Insert apos cursor | - |
| `A` | Insert fim da linha | - |
| `h/j/k/l` | Movimento | - |
| `w/b` | Palavra frente/tras | - |
| `0/$` | Inicio/fim linha | - |
| `dd` | Deleta linha | - |
| `cc` | Muda linha | - |
| `yy` | Copia linha | - |
| `p` | Cola | - |
| `u` | Undo | - |
| `.` | Repete ultima acao | - |
| `/` | Busca (comando) | - |

**Toggle**: `Ctrl+[` alterna vim mode on/off

### 6.2 Fuzzy Finder - Busca por Intencao

**Por que Fuzzy?**: O cerebro pensa em fragmentos, nao strings exatas.
"sss" deve encontrar "sessions", "mdl hku" deve encontrar "/model haiku".

```typescript
// src/input/fuzzy.ts
interface FuzzyMatch {
  item: string
  score: number
  indices: number[]  // Posicoes dos caracteres matched
}

function fuzzyScore(query: string, target: string): FuzzyMatch | null {
  // Algoritmo:
  // 1. Cada char do query deve existir no target (em ordem)
  // 2. Score maior para matches consecutivos
  // 3. Score maior para match no inicio de palavras
  // 4. Score maior para match no inicio do target
}

// Highlighting: mostrar chars matched em cor diferente
// "sss" em "sessions" -> [s]e[s][s]ions
```

**Onde aplicar fuzzy**:
1. **Tab completion de comandos**: `/mdl` encontra `/model`
2. **Session picker**: digitar "ontem" filtra sessoes de ontem
3. **Command palette**: qualquer substring funciona
4. **History search**: Ctrl+R com fuzzy

### 6.3 Command Palette - Ctrl+P

**Por que?**: VS Code treinou milhoes de devs. Ctrl+P e reflexo.

```typescript
// src/tui/command-palette.ts
interface PaletteItem {
  id: string
  label: string
  description?: string
  shortcut?: string
  action: () => void | Promise<void>
  category: 'command' | 'session' | 'file' | 'recent'
}

const PALETTE_ITEMS: PaletteItem[] = [
  { id: 'model-haiku', label: 'Model: Haiku', shortcut: '/model haiku', ... },
  { id: 'model-sonnet', label: 'Model: Sonnet', shortcut: '/model sonnet', ... },
  { id: 'new-session', label: 'New Session', shortcut: '/new', ... },
  { id: 'load-session', label: 'Load Session...', shortcut: '/sessions', ... },
  // ... todos os comandos
]
```

**Comportamento**:
1. `Ctrl+P` abre palette overlay
2. Digitar filtra com fuzzy
3. `Enter` executa item selecionado
4. `Esc` fecha
5. `↑/↓` ou `Ctrl+N/P` navega
6. Items recentes aparecem primeiro

**Visual**:
```
┌─────────────────────────────────────┐
│ > mdl                               │
├─────────────────────────────────────┤
│ ◆ Model: Haiku         /model haiku │
│   Model: Sonnet       /model sonnet │
│   Model: Opus           /model opus │
├─────────────────────────────────────┤
│   Recent: Load session "trabalho"   │
│   Recent: /commit fix typo          │
└─────────────────────────────────────┘
```

### 6.4 Ctrl+R - Reverse History Search

**Por que?**: bash/zsh users tem isso na medula. E a forma mais rapida
de encontrar um comando anterior.

```typescript
// src/input/history-search.ts
interface HistorySearchState {
  active: boolean
  query: string
  matches: string[]
  currentIndex: number
}

// Comportamento:
// Ctrl+R → abre modo busca
// Digitar → filtra historico (fuzzy)
// Ctrl+R novamente → proximo match
// Enter → aceita e executa
// Esc → cancela
// Ctrl+G → cancela (bash style)
```

**Visual**:
```
(reverse-i-search)`commit': /commit -m "fix authentication bug"
```

### 6.5 Chords - Ctrl+K x

**Por que?**: Permite namespaces de atalhos sem conflito.
VS Code usa Ctrl+K extensivamente.

```typescript
// src/input/chords.ts
const CHORDS: Record<string, Record<string, () => void>> = {
  'ctrl+k': {
    'ctrl+s': saveSession,
    'ctrl+l': clearAndKeepHistory,
    'ctrl+c': copyLastResponse,
    'ctrl+d': toggleDashboard,
    'ctrl+v': toggleVimMode,
    'ctrl+p': togglePersona,
    '1': () => setModel('haiku'),
    '2': () => setModel('sonnet'),
    '3': () => setModel('opus'),
  },
}

// Estado: aguardando segundo key por 1.5s
// Indicador visual: "Ctrl+K - " na status bar
```

### 6.6 Gestos de Navegacao Rapida

**Scroll com momentum** (como touchpad):

| Gesto | Acao |
|-------|------|
| `Ctrl+U` | Scroll meia pagina cima |
| `Ctrl+D` | Scroll meia pagina baixo |
| `Ctrl+B` | Scroll pagina inteira cima |
| `Ctrl+F` | Scroll pagina inteira baixo |
| `gg` (vim) | Topo do historico |
| `G` (vim) | Final do historico |

**Jump marks** (bookmarks dentro da sessao):

| Key | Acao |
|-----|------|
| `m + letra` | Define mark |
| `' + letra` | Pula para mark |
| `''` | Pula para posicao anterior |

### 6.7 Feedback Haptico Visual

**Principio**: Toda acao deve ter feedback imediato e satisfatorio.

```typescript
// Flash sutil em acoes bem-sucedidas
function flashSuccess(element: string) {
  // Verde breve (100ms) no elemento
}

// Shake sutil em erros
function shakeError(element: string) {
  // Vermelho + micro-deslocamento
}

// Pulse em loading
function pulseLoading(element: string) {
  // Opacidade pulsante
}
```

**Indicadores contextuais**:
- Cursor muda de forma baseado no modo (insert vs normal)
- Status bar pisca sutil em mudanca de estado
- Notificacao toast para acoes background

### 6.8 Muscle Memory Accelerators

**Auto-suggestions inline** (like fish shell):

```
> /mod█
       el haiku   ← sugestao em cinza, Tab aceita
```

**Abbreviations** (expansao automatica):

```typescript
const ABBREVIATIONS = {
  'mh': '/model haiku',
  'ms': '/model sonnet',
  'mo': '/model opus',
  'ns': '/new',
  'ss': '/sessions',
  'cl': '/clear',
}
// Digitar "mh " expande automaticamente
```

**Smart defaults baseado em contexto**:
- Apos erro de build: sugerir `/retry`
- Apos muitas mensagens: sugerir `/clear`
- Fim do dia: sugerir `/briefing`

---

## Implementacao Priorizada - UX

### Sprint 1: Fundacao (Ctrl+R + Fuzzy)

1. **Implementar fuzzy matcher** (`src/input/fuzzy.ts`)
2. **Ctrl+R history search** com fuzzy
3. **Fuzzy tab completion** para comandos

### Sprint 2: Power User (Vim + Palette)

1. **Vim mode basico** (hjkl, w, b, i, Esc)
2. **Command palette** (Ctrl+P)
3. **Chords** (Ctrl+K x)

### Sprint 3: Polish (Feedback + Accelerators)

1. **Flash/shake feedback visual**
2. **Inline suggestions** (fish-style)
3. **Abbreviations**
4. **Jump marks**

---

## Metricas de Sucesso UX

| Metrica | Baseline | Target |
|---------|----------|--------|
| Keystrokes por comando | ~12 | < 5 |
| Tempo para trocar modelo | ~3s | < 1s |
| Tempo para encontrar sessao | ~10s | < 3s |
| Comandos descobertos organicamente | 10% | 50% |
| Usuarios usando atalhos | 20% | 70% |

---

*Plano gerado em: 2026-03-29 | Atualizado em: 2026-04-02*
*Baseado em analise automatica do codebase e principios de ergonomia*
