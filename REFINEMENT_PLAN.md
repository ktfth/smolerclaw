# Plano de Refinamento Production-Grade

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

### FASE 1: Estabilizacao Critica (P0)

#### 1.1 Split do `tools.ts` (2,828 LOC)

**Problema**: Arquivo muito grande dificulta manutencao e testes.

**Solucao**: Extrair em estrutura modular:

```
src/tools/
├── index.ts          # Registry e dispatch (reexporta tudo)
├── schemas.ts        # Definicoes TOOLS[]
├── file-tools.ts     # read_file, write_file, edit_file
├── search-tools.ts   # search_files, find_files, list_directory
├── command-tools.ts  # run_command
├── vault-tools.ts    # vault_status, backup, restore
├── memory-tools.ts   # recall_memory, memory_status
├── windows-tools.ts  # Windows-specific tools
├── business-tools.ts # tasks, memos, people, projects
└── execute.ts        # executeTool() dispatch function
```

**Estimativa**: ~40 edits

#### 1.2 Testes para Modulos Criticos

**Modulos com cobertura < 30%**:

| Modulo | Cobertura | Acoes |
|--------|-----------|-------|
| `context.ts` | 2.75% | Adicionar testes unitarios |
| `context-window.ts` | 14.04% | Testar trimming/summarization |
| `windows-agent.ts` | 23.78% | Testar PowerShell safety |
| `event-bus.ts` | 28.78% | Testar emit/on/once/errors |

**Testes Necessarios**: ~150 novos testes

#### 1.3 Correcao de Error Handling Silencioso

**Problema**: Varios `catch { /* ignore */ }` sem logging.

**Locais identificados**:
- `context.ts:64` - JSON parse silencioso
- `context.ts:84,96,110,122` - git commands silenciosos
- `skills.ts:27` - readFileSync silencioso
- Varios outros

**Solucao**: Adicionar logging estruturado:
```typescript
catch (err) {
  logger.debug('Operation failed', { error: err, context: 'git_log' })
}
```

---

### FASE 2: Refatoracao Estrutural (P1)

#### 2.1 Split do `index.ts` (2,211 LOC)

**Estrutura proposta**:

```
src/
├── index.ts           # Entry point minimo (~100 LOC)
├── cli/
│   ├── index.ts       # parseArgs, printHelp, getVersion
│   └── commands.ts    # Handlers de comandos TUI
├── modes/
│   ├── print-mode.ts  # runPrintMode()
│   └── interactive.ts # runInteractive()
└── init/
    ├── providers.ts   # Setup Claude/OpenAI/Ollama
    ├── modules.ts     # Init de todos os modulos
    └── session.ts     # Session management
```

#### 2.2 Logging Estruturado

**Implementar logger com niveis**:

```typescript
// src/core/logger.ts
export const logger = {
  debug: (msg: string, ctx?: object) => { ... },
  info: (msg: string, ctx?: object) => { ... },
  warn: (msg: string, ctx?: object) => { ... },
  error: (msg: string, ctx?: object) => { ... },
}
```

**Beneficios**:
- Troubleshooting em producao
- Metricas de uso
- Deteccao de anomalias

#### 2.3 Metricas de Uso

**Adicionar telemetria opcional**:

```typescript
interface UsageMetrics {
  session_duration_ms: number
  tools_used: Record<string, number>
  errors_by_type: Record<string, number>
  tokens_consumed: number
  model: string
}
```

---

### FASE 3: Seguranca e Robustez (P1)

#### 3.1 Expandir Tool Safety Assessment

**Atual**: `tool-safety.ts` tem apenas 107 LOC com patterns basicos.

**Melhorias**:

1. **Deteccao de Secrets em Comandos**:
```typescript
const SECRET_PATTERNS = [
  /ANTHROPIC_API_KEY=/i,
  /AWS_SECRET_ACCESS_KEY=/i,
  /password\s*=\s*["'][^"']+["']/i,
]
```

2. **Validacao de Paths**:
```typescript
// Prevenir escrita em diretorios sensiveis
const PROTECTED_PATHS = [
  '/etc/',
  '/usr/bin/',
  'C:\\Windows\\System32',
  '%APPDATA%\\..\\',
]
```

3. **Rate Limiting por Tool**:
```typescript
const RATE_LIMITS: Record<string, { max: number, windowMs: number }> = {
  'write_file': { max: 100, windowMs: 60000 },
  'run_command': { max: 50, windowMs: 60000 },
}
```

#### 3.2 Audit Log para Operacoes Sensiveis

```typescript
interface AuditEntry {
  timestamp: number
  tool: string
  input: Record<string, unknown>
  risk_level: RiskLevel
  approved: boolean
  result: 'success' | 'error' | 'rejected'
}
```

---

### FASE 4: Documentacao (P2)

#### 4.1 Documentacao Arquitetural

Criar `docs/ARCHITECTURE.md`:

```markdown
# Arquitetura smolerclaw

## Camadas

1. TUI Layer - Interface terminal
2. Tool Execution Layer - Dispatch de ferramentas
3. Provider Layer - Claude/OpenAI/Ollama
4. Feature Modules - Dominios de negocio
5. Core Infrastructure - Event bus, vault, session

## Fluxo de Dados

[diagrama ASCII]

## Decisoes Arquiteturais

- Por que Event Bus?
- Por que Vault atomico?
- Por que multi-provider?
```

#### 4.2 JSDoc em Funcoes Publicas

**Modulos prioritarios**:
- `claude.ts` - API principal
- `tools.ts` - Registry de ferramentas
- `event-bus.ts` - Sistema de eventos
- `vault.ts` - Persistencia

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

- [ ] `bun run typecheck` passa sem erros
- [ ] `bun test` todos os testes passam
- [ ] Cobertura >= 80% linhas
- [ ] Build single-binary funciona
- [ ] Instalador Windows funciona

### Seguranca

- [ ] Nenhum secret hardcoded (grep por API_KEY, password, token)
- [ ] Tool safety cobre todos os patterns perigosos
- [ ] Audit log funcionando
- [ ] SSRF guard testado com URLs maliciosas

### Funcionalidade

- [ ] Fluxo de conversa basico funciona
- [ ] Todas as ferramentas respondem corretamente
- [ ] Vault backup/restore funciona
- [ ] Multi-provider (Anthropic, OpenAI, Ollama) funciona

### Documentacao

- [ ] README atualizado com versao
- [ ] ARCHITECTURE.md criado
- [ ] CHANGELOG atualizado

---

## Ordem de Implementacao Sugerida

```
Semana 1: FASE 1.1 + 1.2 (Split tools.ts + testes criticos)
Semana 2: FASE 1.3 + 3.1 (Error handling + security)
Semana 3: FASE 2.1 + 2.2 (Split index.ts + logging)
Semana 4: FASE 4 + validacao final
```

---

## Proximos Passos Imediatos

1. **Criar branch**: `feature/production-refinement`
2. **Iniciar split de tools.ts**: Extrair schemas primeiro
3. **Adicionar testes para event-bus.ts**: Cobertura atual 28%
4. **Implementar logger estruturado**: Base para demais melhorias

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

*Plano gerado em: 2026-03-29*
*Baseado em analise automatica do codebase e principios de ergonomia*
