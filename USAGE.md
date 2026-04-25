# smolerclaw — Guia Completo de Uso

> Micro assistente de IA no terminal, feito para Windows.
> Um binario, zero config, TUI completa.

---

## Sumario

1. [Inicio Rapido](#inicio-rapido)
2. [Modos de Interface](#modos-de-interface)
3. [Autenticacao](#autenticacao)
4. [Modelos Disponiveis](#modelos-disponiveis)
5. [Comandos TUI](#comandos-tui)
6. [Ferramentas da IA (Tools)](#ferramentas-da-ia-tools)
7. [Atalhos de Teclado](#atalhos-de-teclado)
8. [Skills e Personas](#skills-e-personas)
9. [Internacionalizacao (i18n)](#internacionalizacao-i18n)
10. [Configuracao](#configuracao)

---

## Inicio Rapido

```bash
# Instalar Bun (se nao tiver)
irm bun.sh/install.ps1 | iex

# Clonar e rodar
git clone https://github.com/ktfth/smolerclaw
cd smolerclaw
bun install
bun run start

# Ou instalar como comando do sistema
powershell -ExecutionPolicy Bypass -File install.ps1
smolerclaw
```

### Argumentos CLI

| Flag | Descricao | Exemplo |
|------|-----------|---------|
| `-h, --help` | Mostrar ajuda | `smolerclaw --help` |
| `-v, --version` | Versao | `smolerclaw --version` |
| `-m, --model` | Definir modelo | `smolerclaw -m opus` |
| `-s, --session` | Carregar sessao | `smolerclaw -s meu-projeto` |
| `--max-tokens` | Limite de tokens | `smolerclaw --max-tokens 8192` |
| `--no-tools` | Desativar ferramentas | `smolerclaw --no-tools` |
| `-p, --print` | Modo nao-interativo | `echo "oi" | smolerclaw -p` |
| `ui` | Interface web (navegador) | `smolerclaw ui` |
| `desktop` | App desktop (Electrobun) | `smolerclaw desktop` |
| `--port` | Porta para UI web/desktop | `smolerclaw ui --port 8080` |

---

## Modos de Interface

smolerclaw oferece tres modos de interface:

| Modo | Comando | Descricao |
|------|---------|-----------|
| TUI | `smolerclaw` | Interface terminal interativa (padrao) |
| Web | `smolerclaw ui` | Interface no navegador via servidor Hono (default: `http://localhost:3847`) |
| Desktop | `smolerclaw desktop` | Janela nativa via Electrobun |

```bash
# Web UI na porta padrao
smolerclaw ui

# Web UI em porta customizada
smolerclaw ui --port 8080

# Desktop app
smolerclaw desktop
```

---

## Autenticacao

Usa Claude Code (detectado automaticamente de `~/.claude/.credentials.json`) ou Codex CLI (detectado automaticamente de `~/.codex/auth.json`). Na abertura da TUI, quando nao ha `--model` nem prompt inicial, o app pode perguntar se a sessao vai usar Claude ou Codex. Modelos `openai:*` usam OpenAI Agents SDK.

| Comando | Descricao |
|---------|-----------|
| `/auth` | Ver status da autenticacao atual (provider, tipo, expiracao) |
| `/login <claude|codex>` | Autenticar e trocar a sessao para Claude ou Codex |
| `/refresh` ou `/renovar` | Renovar/validar autenticacao do provider atual |
| `/review [claude|codex]` | Rodar revisao cruzada sob demanda com o provider oposto |

---

## Modelos Disponiveis

| Alias | Modelo | Tier | Contexto |
|-------|--------|------|----------|
| `haiku` | Claude Haiku 4.5 | Rapido | 200K |
| `sonnet` | Claude Sonnet 4 | Equilibrado | 200K |
| `sonnet-4.6` | Claude Sonnet 4.6 | Equilibrado | 200K |
| `opus` | Claude Opus 4 | Poderoso | 200K |
| `opus-4.6` | Claude Opus 4.6 | Poderoso | 200K |
| `codex` | Codex GPT-5.4 | Poderoso | 200K |
| `codex-mini` | Codex Mini Latest | Rapido | 200K |

Suporte multi-provider: `codex:gpt-5.4`, `openai:gpt-4o`, `ollama:llama3`

---

## Comandos TUI

### Sessao e Conversa

| Comando EN | Comando PT | Descricao | Exemplo |
|------------|------------|-----------|---------|
| `/help` | `/ajuda` | Mostrar todos os comandos | `/help` |
| `/clear` | `/limpar` | Limpar conversa atual | `/clear` |
| `/new <nome>` | `/novo <nome>` | Criar nova sessao | `/novo projeto-x` |
| `/load <nome>` | `/carregar <nome>` | Carregar sessao existente | `/load projeto-x` |
| `/sessions` | `/sessoes` | Listar sessoes salvas | `/sessoes` |
| `/delete <nome>` | `/deletar <nome>` | Deletar sessao | `/delete teste` |
| `/fork <nome>` | — | Duplicar sessao atual | `/fork backup` |
| `/export` | `/exportar` | Salvar conversa em markdown | `/export relatorio.md` |
| `/copy` | `/copiar` | Copiar ultima resposta | `/copy` |
| `/retry` | `/repetir` | Reenviar ultima mensagem | `/retry` |
| `/undo` | `/desfazer` | Desfazer ultima alteracao em arquivo | `/undo` |
| `/search <termo>` | `/buscar <termo>` | Buscar texto na conversa | `/buscar docker` |
| `/exit` | `/sair` | Sair do programa | `/exit` |

### Arquivo / Sessoes Arquivadas

| Comando EN | Comando PT | Descricao | Exemplo |
|------------|------------|-----------|---------|
| `/archive <nome>` | `/arquivar <nome>` | Arquivar sessao | `/archive velho` |
| `/archive all` | `/arquivar all` | Arquivar todas exceto atual | `/archive all` |
| `/archived` | `/arquivadas` | Listar sessoes arquivadas | `/archived` |
| `/unarchive <nome>` | `/restaurar <nome>` | Restaurar sessao arquivada | `/restaurar velho` |

### Modelo e Configuracao

| Comando EN | Comando PT | Descricao | Exemplo |
|------------|------------|-----------|---------|
| `/model` | `/modelo` | Ver modelo atual + listar disponiveis | `/model` |
| `/model <alias>` | `/modelo <alias>` | Trocar modelo | `/model sonnet` |
| `/login <prov>` | — | Login e troca para `claude` ou `codex` | `/login codex` |
| `/review [prov]` | `/revisar [prov]` | Revisao cruzada com Claude ou Codex | `/review` |
| `/persona <nome>` | `/modo <nome>` | Trocar persona/skill | `/modo business` |
| `/skills` | `/habilidades` | Listar skills disponiveis | `/skills` |
| `/lang <idioma>` | `/idioma <idioma>` | Definir idioma (pt, en, auto) | `/lang pt` |
| `/cost` | `/custo` | Ver uso de tokens e custo | `/cost` |
| `/budget <centavos>` | `/orcamento <centavos>` | Definir orcamento maximo | `/budget 100` |
| `/config` | — | Mostrar caminho do config | `/config` |
| `/plugins` | — | Listar plugins instalados | `/plugins` |

### Git

| Comando EN | Comando PT | Descricao | Exemplo |
|------------|------------|-----------|---------|
| `/commit` | `/commitar` | Commit com mensagem gerada pela IA | `/commit` |

### Briefing e Noticias

| Comando EN | Comando PT | Descricao | Exemplo |
|------------|------------|-----------|---------|
| `/briefing` | `/resumo` | Briefing diario completo | `/resumo` |
| `/news` | `/noticias` | Manchetes de todas as categorias | `/news` |
| `/news <cat>` | `/noticias <cat>` | Filtrar por categoria | `/news tech` |

Categorias de noticias: `business`, `tech`, `finance`, `brazil`, `world`, `security` (+ categorias custom)

### Gestao de Fontes de Noticias

| Comando EN | Comando PT | Descricao | Exemplo |
|------------|------------|-----------|---------|
| `/feeds` | `/fontes` | Listar todas as fontes (built-in + custom) | `/feeds` |
| `/addfeed <nome> <url> <cat>` | `/novafonte` | Adicionar fonte RSS custom | `/addfeed ArsTech https://feeds.arstechnica.com/arstechnica/index tech` |
| `/rmfeed <nome>` | `/rmfonte` | Remover fonte custom | `/rmfeed ArsTech` |
| `/disablefeed <nome>` | `/desativarfonte` | Desativar fonte built-in | `/disablefeed TechCrunch` |
| `/enablefeed <nome>` | `/ativarfonte` | Reativar fonte | `/enablefeed TechCrunch` |

### Integracoes Windows

| Comando EN | Comando PT | Descricao | Exemplo |
|------------|------------|-----------|---------|
| `/open <app>` | `/abrir <app>` | Abrir aplicativo | `/open excel` |
| `/openfile <path>` | `/abrirarquivo` | Abrir arquivo com app padrao | `/openfile relatorio.xlsx` |
| `/openurl <url>` | — | Abrir URL no navegador | `/openurl https://github.com` |
| `/apps` | `/programas` | Listar apps em execucao | `/apps` |
| `/sysinfo` | `/sistema` | Status do sistema (CPU, RAM, disco) | `/sysinfo` |
| `/calendar` | `/agenda` | Eventos do Outlook hoje | `/agenda` |

Apps disponiveis: `excel`, `word`, `powerpoint`, `outlook`, `onenote`, `teams`, `edge`, `chrome`, `firefox`, `calculator`, `notepad`, `terminal`, `explorer`, `vscode`, `cursor`, `paint`, `snip`, `settings`, `taskmanager`

### Tarefas e Lembretes

| Comando EN | Comando PT | Descricao | Exemplo |
|------------|------------|-----------|---------|
| `/task <hora> <descricao>` | `/tarefa` | Criar tarefa com lembrete | `/tarefa 18h comprar pao` |
| `/tasks` | `/tarefas` | Listar tarefas pendentes | `/tarefas` |
| `/done <id ou titulo>` | `/feito` | Marcar como concluida | `/feito comprar` |
| `/rmtask <id>` | `/rmtarefa` | Remover tarefa | `/rmtask abc123` |

Formatos de horario aceitos: `18h`, `18:30`, `em 30 minutos`, `em 2 horas`, `amanha 9h`

Lembretes geram **toast notifications do Windows** mesmo com o app fechado (via Task Scheduler).

### Pessoas e Delegacoes

| Comando EN | Comando PT | Descricao | Exemplo |
|------------|------------|-----------|---------|
| `/addperson <nome> <grupo>` | `/novapessoa` | Cadastrar pessoa | `/novapessoa Ana equipe dev` |
| `/people` | `/pessoas` | Listar todas as pessoas | `/pessoas` |
| `/team` | `/equipe` | Listar equipe | `/equipe` |
| `/family` | `/familia` | Listar familia | `/familia` |
| `/contacts` | `/contatos` | Listar contatos | `/contatos` |
| `/person <nome>` | `/pessoa` | Detalhes de alguem | `/pessoa Ana` |
| `/delegate <pessoa> <tarefa>` | `/delegar` | Delegar tarefa | `/delegar Ana revisar PR` |
| `/delegations` | `/delegacoes` | Listar delegacoes | `/delegacoes` |
| `/followups` | — | Follow-ups pendentes | `/followups` |
| `/dashboard` | `/painel` | Painel geral de pessoas | `/painel` |

Grupos: `equipe`, `familia`, `contato`

### Memos / Anotacoes

| Comando EN | Comando PT | Descricao | Exemplo |
|------------|------------|-----------|---------|
| `/memo <texto>` | `/anotar` | Salvar anotacao (use #tags) | `/memo senha wifi: abc123 #casa` |
| `/memos <busca>` | `/notas` | Buscar memos | `/notas docker` |
| `/memos #tag` | `/notas #tag` | Buscar por tag | `/notas #casa` |
| `/tags` | `/memotags` | Listar todas as tags | `/tags` |
| `/rmmemo <id>` | `/rmnota` | Remover memo | `/rmmemo abc123` |

### Materiais / Knowledge Base

| Comando EN | Comando PT | Descricao | Exemplo |
|------------|------------|-----------|---------|
| `/material <titulo> \| <conteudo>` | `/mat` | Salvar material | `/mat Guia Docker \| Use multi-stage builds...` |
| `/materials <busca>` | `/materiais` | Buscar materiais | `/materiais docker` |
| `/materials #tag` | `/materiais #tag` | Buscar por tag | `/materiais #deploy` |
| `/materials @cat` | `/materiais @cat` | Buscar por categoria | `/materiais @tecnico` |
| `/matcats` | `/categorias` | Listar categorias | `/categorias` |
| `/rmmat <id>` | `/rmmaterial` | Remover material | `/rmmat abc123` |

Categorias sugeridas: `procedimento`, `referencia`, `guia`, `template`, `contato`, `projeto`, `tecnico`, `geral`

### Memoria RAG (Busca Semantica Local)

| Comando EN | Comando PT | Descricao | Exemplo |
|------------|------------|-----------|---------|
| `/index` | `/indexar` | Construir/atualizar indice RAG | `/indexar` |
| `/reindex` | — | Reconstruir indice do zero | `/reindex` |
| `/memory <query>` | `/memoria <query>` | Buscar na memoria local | `/memoria PostgreSQL migracao` |
| `/memory` | `/memoria` | Ver status do indice | `/memoria` |

O RAG indexa memos, materiais, decisoes e sessoes usando TF-IDF + BM25. Indexacao incremental via hashes SHA-256.

### Financas

| Comando EN | Comando PT | Descricao | Exemplo |
|------------|------------|-----------|---------|
| `/income <valor> <cat> <desc>` | `/entrada` | Registrar entrada | `/entrada 5000 salario Pagamento mensal` |
| `/expense <valor> <cat> <desc>` | `/saida` | Registrar saida | `/saida 150 alimentacao Supermercado` |
| `/finance` | `/balanco` | Resumo mensal | `/balanco` |

### Decisoes

| Comando EN | Comando PT | Descricao | Exemplo |
|------------|------------|-----------|---------|
| `/decisions` | `/decisoes` | Listar decisoes recentes | `/decisoes` |
| `/decisions <busca>` | `/decisoes <busca>` | Buscar decisoes | `/decisoes banco dados` |

### Email

| Comando EN | Comando PT | Descricao | Exemplo |
|------------|------------|-----------|---------|
| `/email` | `/rascunho` | Abrir rascunho no Outlook | `/email joao@x.com assunto \| corpo do email` |

### Investigacoes

| Comando EN | Comando PT | Descricao | Exemplo |
|------------|------------|-----------|---------|
| `/investigate` | `/investigar` | Listar investigacoes | `/investigar` |
| `/investigate <busca>` | `/investigar <busca>` | Buscar por keyword | `/investigar memory leak` |

Tipos: `bug`, `feature`, `test`, `audit`, `incident`

### Consulta de Empresas Brasileiras (OSINT publico)

Lookup de fontes publicas oficiais para apoiar due diligence, cadastro de cliente/fornecedor
e pesquisa. Fontes: BrasilAPI (CNPJ, CEP) e Registro.br RDAP (dominios .br). Todas as
consultas sao cacheadas localmente por 24h.

| Comando EN | Comando PT | Descricao | Exemplo |
|------------|------------|-----------|---------|
| `/cnpj <cnpj>` | `/empresa <cnpj>` | Ficha da empresa (razao social, CNAE, socios, endereco) | `/cnpj 00.000.000/0001-91` |
| `/cnpj refresh <cnpj>` | `/empresa refresh <cnpj>` | Forca nova consulta (ignora cache) | `/cnpj refresh 00000000000191` |
| `/cep <cep>` | `/cep <cep>` | Endereco completo por CEP | `/cep 01311-000` |
| `/whois-br <dominio>` | `/dominio-br <dominio>` | RDAP/WHOIS publico de dominios .br | `/whois-br registro.br` |

### Monitor de Processos

| Comando EN | Comando PT | Descricao | Exemplo |
|------------|------------|-----------|---------|
| `/monitor <processo>` | `/vigiar <processo>` | Iniciar monitoramento | `/monitor nginx` |
| `/monitor stop <nome>` | `/vigiar stop <nome>` | Parar monitoramento | `/monitor stop nginx` |
| `/monitor list` | `/vigiar list` | Listar monitoramentos ativos | `/monitor list` |

### Pomodoro

| Comando EN | Comando PT | Descricao | Exemplo |
|------------|------------|-----------|---------|
| `/pomodoro <tarefa>` | `/foco <tarefa>` | Iniciar sessao (25min) | `/foco revisar codigo` |
| `/pomodoro status` | `/foco status` | Ver tempo restante | `/foco status` |
| `/pomodoro stop` | `/foco stop` | Parar timer | `/foco stop` |

### Workflows (Automacao)

| Comando EN | Comando PT | Descricao | Exemplo |
|------------|------------|-----------|---------|
| `/workflow list [tag]` | `/fluxo list [tag]` | Listar workflows (filtrar por tag) | `/workflow list trabalho` |
| `/workflow run <nome>` | `/fluxo run <nome>` | Executar workflow | `/workflow iniciar-dia` |
| `/workflow info <nome>` | `/fluxo info <nome>` | Ver detalhes de um workflow | `/workflow info dev` |
| `/workflow delete <nome>` | `/fluxo delete <nome>` | Remover workflow | `/workflow delete teste` |
| `/workflow enable <nome>` | `/fluxo ativar <nome>` | Ativar workflow | `/workflow enable dev` |
| `/workflow disable <nome>` | `/fluxo desativar <nome>` | Desativar workflow | `/workflow disable dev` |

Tipos de step: `open_app`, `open_url`, `run_command`, `wait`, `notify`, `if_app_running`, `log`

Controle de erros por step: `on_error: 'stop' | 'skip' | 'continue'`

### Macros (Atalhos Rapidos)

| Comando EN | Comando PT | Descricao | Exemplo |
|------------|------------|-----------|---------|
| `/macro` | `/atalho` | Listar macros disponiveis | `/macro` |
| `/macro <nome>` | `/atalho <nome>` | Executar macro | `/macro vscode` |
| `/macro info <nome>` | `/atalho detalhe <nome>` | Ver detalhes do macro | `/macro info chrome` |
| `/macro create <nome> <acao> <target>` | `/atalho criar` | Criar novo macro | `/macro create mysite open_url https://example.com` |
| `/macro delete <nome>` | `/atalho deletar <nome>` | Remover macro | `/macro delete mysite` |
| `/macro enable <nome>` | `/atalho ativar <nome>` | Ativar macro | `/macro enable chrome` |
| `/macro disable <nome>` | `/atalho desativar <nome>` | Desativar macro | `/macro disable chrome` |
| `/macro all` | `/atalho todos` | Listar todos (incluindo desativados) | `/macro all` |

Acoes disponiveis: `open_app`, `open_url`, `open_file`, `run_command`

Macros padrao incluem: `vscode`, `terminal`, `excel`, `word`, `outlook`, `teams`, `edge`, `chrome`, `explorer`, `calc`, `notepad`, `tarefas`, `settings`, `github`, `claude`, `chatgpt`

Exemplo de criacao:
```
/macro create docs open_file C:\Users\Docs "Pasta de documentos"
/macro create cleanup run_command "Remove-Item $env:TEMP\* -Force"
```

### Agendador (Scheduler)

| Comando EN | Comando PT | Descricao | Exemplo |
|------------|------------|-----------|---------|
| `/schedule` | `/agendar` | Listar jobs agendados | `/schedule list` |
| `/schedule <msg> <hora>` | `/agendar <msg> <hora>` | Agendar notificacao | `/agendar "Reuniao" 14:00` |
| `/schedule <msg> <hora> daily` | `/agendar <msg> <hora> diario` | Job recorrente diario | `/agendar "Standup" 09:00 daily` |
| `/schedule info <id>` | `/agendar info <id>` | Detalhes de um job | `/schedule info abc123` |
| `/schedule delete <id>` | `/agendar deletar <id>` | Remover job | `/schedule delete abc123` |
| `/schedule enable <id>` | `/agendar ativar <id>` | Ativar job | `/schedule enable abc123` |
| `/schedule disable <id>` | `/agendar desativar <id>` | Desativar job | `/schedule disable abc123` |
| `/schedule run <id>` | `/agendar run <id>` | Executar job agora | `/schedule run abc123` |
| `/schedules` | — | Listar todos os jobs | `/schedules` |

Tipos de agendamento: `once`, `daily`, `weekly`

### Gestao de Projetos

| Comando EN | Comando PT | Descricao | Exemplo |
|------------|------------|-----------|---------|
| `/project auto` | `/projeto auto` | Auto-detectar projeto do diretorio atual | `/projeto auto` |
| `/project <nome>` | `/projeto <nome>` | Definir/ver projeto ativo | `/projeto tinyclaw` |
| `/projects` | `/projetos` | Listar todos os projetos | `/projetos` |
| `/session start` | `/sessao start` | Iniciar timer de trabalho | `/sessao start` |
| `/session stop` | `/sessao stop` | Parar timer | `/sessao stop` |
| `/session` | `/sessao` | Ver sessao ativa | `/sessao` |
| `/report [periodo]` | `/relatorio [periodo]` | Gerar relatorio de progresso | `/relatorio week` |
| `/opportunities [status]` | `/oportunidades [status]` | Listar oportunidades | `/oportunidades nova` |

Periodos: `today`, `week`, `month`

### Windows Agent (Avancado)

| Comando EN | Comando PT | Descricao | Exemplo |
|------------|------------|-----------|---------|
| `/clipboard` | `/area` | Ler clipboard (texto ou OCR de imagem) | `/clipboard` |
| `/screen` | `/tela` | Analisar janelas em foco | `/tela` |
| `/ps1 <script>` | — | Executar PowerShell inline | `/ps1 Get-Process \| Select -First 5` |

Safety guards bloqueiam: desativar Defender, deletar System32, formatar volume, criar usuario, shutdown, execucao remota.

### Vault (Integridade e Backup)

| Comando EN | Comando PT | Descricao | Exemplo |
|------------|------------|-----------|---------|
| `/vault status` | — | Status de integridade dos dados | `/vault status` |
| `/vault backup` | — | Backup manual | `/vault backup` |
| `/vault sync` | — | Push backup para remote git | `/vault sync` |
| `/vault init` | — | Inicializar sistema de backup | `/vault init` |
| `/backup` | — | Atalho para backup rapido | `/backup` |

---

## Ferramentas da IA (Tools)

Essas ferramentas sao usadas **automaticamente pela IA** durante a conversa. Voce nao precisa chama-las diretamente.

### Arquivo e Codigo

| Tool | Descricao |
|------|-----------|
| `read_file` | Ler conteudo de arquivo (com offset/limit para arquivos grandes) |
| `write_file` | Criar ou sobrescrever arquivo |
| `edit_file` | Editar trecho especifico (find & replace exato) |
| `search_files` | Buscar conteudo com regex (como grep) |
| `find_files` | Encontrar arquivos por nome (glob pattern) |
| `list_directory` | Listar diretorio |
| `run_command` | Executar comando no shell |
| `fetch_url` | Buscar conteudo de URL |

### Windows

| Tool | Descricao |
|------|-----------|
| `open_application` | Abrir app do Windows por nome |
| `open_file_default` | Abrir arquivo com app padrao |
| `open_url_browser` | Abrir URL no navegador |
| `get_running_apps` | Listar apps em execucao (com memoria) |
| `get_system_info` | CPU, RAM, disco, uptime, bateria |
| `get_calendar_events` | Eventos Outlook do dia |
| `get_news` | Buscar noticias por categoria |
| `execute_powershell_script` | Executar script .ps1 com safety guards |
| `analyze_screen_context` | Janela em foco + todas as janelas visiveis |
| `read_clipboard_content` | Ler clipboard (texto ou OCR de imagem) |

### Tarefas e Pessoas

| Tool | Descricao |
|------|-----------|
| `create_task` | Criar tarefa com lembrete |
| `complete_task` | Marcar tarefa como concluida |
| `list_tasks` | Listar tarefas pendentes |
| `add_person` | Cadastrar pessoa |
| `find_person_info` | Buscar pessoa (perfil + interacoes + delegacoes) |
| `list_people` | Listar pessoas por grupo |
| `log_interaction` | Registrar interacao (conversa, reuniao, etc.) |
| `delegate_to_person` | Delegar tarefa com prazo |
| `update_delegation_status` | Atualizar status de delegacao |
| `get_people_dashboard` | Painel de pessoas |

### Conhecimento

| Tool | Descricao |
|------|-----------|
| `save_memo` | Salvar nota com #tags |
| `search_memos` | Buscar memos |
| `save_material` | Salvar material de referencia |
| `search_materials` | Buscar materiais |
| `list_materials` | Listar materiais |
| `update_material` | Atualizar material |
| `delete_material` | Remover material |
| `recall_memory` | Buscar na memoria RAG (top 3 mais relevantes) |
| `index_memory` | Atualizar indice RAG |
| `memory_status` | Status do indice |

### Financas e Decisoes

| Tool | Descricao |
|------|-----------|
| `record_transaction` | Registrar entrada ou saida |
| `financial_summary` | Resumo financeiro mensal |
| `log_decision` | Registrar decisao com contexto e justificativa |
| `search_decisions` | Buscar decisoes |

### Investigacoes

| Tool | Descricao |
|------|-----------|
| `open_investigation` | Iniciar investigacao (bug, feature, test, audit, incident) |
| `collect_evidence` | Coletar evidencia (arquivo, comando, log, diff, url, observacao) |
| `add_finding` | Registrar conclusao com severidade |
| `close_investigation` | Fechar com resumo e recomendacoes |
| `investigation_status` | Ver progresso |
| `investigation_report` | Gerar relatorio markdown completo |
| `list_investigations` | Listar investigacoes |

### Email

| Tool | Descricao |
|------|-----------|
| `draft_email` | Criar rascunho e abrir no Outlook |

### Noticias

| Tool | Descricao |
|------|-----------|
| `manage_news_feeds` | Adicionar/remover/ativar/desativar fontes RSS |

### Vault

| Tool | Descricao |
|------|-----------|
| `vault_status` | Integridade dos arquivos + status de backup |
| `vault_backup` | Executar backup manual |
| `sync_cloud_context` | Push para repositorio remoto |
| `vault_init_backup` | Inicializar sistema de backup |

### Projetos

| Tool | Descricao |
|------|-----------|
| `set_active_project` | Definir projeto ativo (ou "auto" para detectar) |
| `report_work_progress` | Gerar relatorio (git + sessoes + tarefas) |
| `manage_work_session` | Iniciar/parar timer de trabalho |
| `add_project` | Registrar novo projeto |
| `list_projects` | Listar projetos |
| `fetch_opportunities` | Listar oportunidades por status/tech |
| `add_opportunity` | Registrar nova oportunidade |
| `update_opportunity_status` | Atualizar status de oportunidade |

### Macros

| Tool | Descricao |
|------|-----------|
| `run_macro` | Executar macro por nome |
| `list_macros` | Listar macros disponiveis |
| `create_macro` | Criar novo macro |
| `delete_macro` | Remover macro |

### Sessoes

| Tool | Descricao |
|------|-----------|
| `archive_session` | Arquivar sessao |
| `unarchive_session` | Restaurar sessao |
| `list_archived_sessions` | Listar arquivadas |

---

## Atalhos de Teclado

| Tecla | Acao |
|-------|------|
| `Tab` | Autocomplete de comando + subcomando |
| `Enter` | Enviar mensagem |
| `\` (no final da linha) | Continuar em nova linha |
| `Ctrl+C` | Cancelar stream / sair |
| `Ctrl+D` | Sair |
| `Ctrl+L` | Redesenhar tela |
| `Seta Cima/Baixo` | Historico de input |
| `PgUp/PgDown` | Scroll das mensagens |

### Autocomplete

Pressione `Tab` para completar comandos e subcomandos:

- `/mo` + Tab → `/model `  + mostra opcoes: `haiku sonnet sonnet-4.6 opus opus-4.6`
- `/model so` + Tab → `/model sonnet `
- `/news t` + Tab → `/news tech `
- `/open vs` + Tab → `/open vscode `
- `/sessao s` + Tab → mostra: `start stop status`
- `/workflow ` + Tab → mostra: `list run info create delete enable disable`

---

## Skills e Personas

Skills definem o comportamento base da IA. Ficam na pasta `skills/`.

| Persona | Arquivo | Descricao |
|---------|---------|-----------|
| `default` | `skills/default.md` | Assistente versatil (codigo, pesquisa, escrita, qualquer topico) |
| `business` | `skills/business.md` | Assistente executivo (noticias, decisoes, delegacoes, briefings) |
| `agency` | `skills/agency.md` | Protocolo de alta agencia: planeja antes de executar, pede aprovacao |

Trocar: `/persona business` ou `/modo default`

---

## Internacionalizacao (i18n)

smolerclaw suporta Portugues (BR) e Ingles. O idioma e detectado automaticamente pelo sistema, mas pode ser configurado manualmente.

| Comando EN | Comando PT | Descricao | Exemplo |
|------------|------------|-----------|---------|
| `/lang <idioma>` | `/idioma <idioma>` | Definir idioma | `/lang pt` |

Valores aceitos: `pt`, `en`, `auto`

A interface (mensagens de erro, labels, prompts) e traduzida automaticamente. O sistema de traducao usa fallback para ingles quando uma chave nao existe no idioma atual.

---

## Configuracao

Arquivo: `~/.config/smolerclaw/config.json` (Windows: `%APPDATA%/smolerclaw/config.json`)

```json
{
  "model": "claude-haiku-4-5-20251001",
  "maxTokens": 4096,
  "maxHistory": 50,
  "systemPrompt": "",
  "skillsDir": "./skills",
  "toolApproval": "auto",
  "language": "auto",
  "maxSessionCost": 0
}
```

| Campo | Tipo | Descricao |
|-------|------|-----------|
| `model` | string | Modelo padrao (alias ou ID completo) |
| `maxTokens` | number | Limite de tokens por resposta (1-100000) |
| `maxHistory` | number | Mensagens mantidas no contexto (1-1000) |
| `systemPrompt` | string | Prompt extra alem da skill |
| `skillsDir` | string | Diretorio de skills |
| `toolApproval` | string | `auto`, `confirm-writes`, `confirm-all` |
| `language` | string | `auto`, `pt`, `en` |
| `maxSessionCost` | number | Orcamento em centavos (0 = ilimitado) |

### Dados persistidos

Local: `%LOCALAPPDATA%/smolerclaw/` (Windows) ou `~/.local/share/smolerclaw/` (Linux)

| Arquivo | Conteudo |
|---------|----------|
| `sessions/*.json` | Conversas salvas |
| `sessions/archive/*.json` | Sessoes arquivadas |
| `memos.json` | Anotacoes |
| `materials.json` | Base de conhecimento |
| `tasks.json` | Tarefas e lembretes |
| `people.json` | Pessoas e delegacoes |
| `finance.json` | Transacoes financeiras |
| `decisions.json` | Log de decisoes |
| `investigations/*.json` | Investigacoes |
| `workflows.json` | Automacoes |
| `projects.json` | Projetos registrados |
| `work-sessions.json` | Sessoes de trabalho |
| `opportunities.json` | Oportunidades |
| `news-feeds.json` | Fontes RSS customizadas |
| `macros.json` | Atalhos rapidos (macros) |
| `rag/rag-index.json` | Indice de busca semantica |
| `vault-checksums.json` | Checksums de integridade |
| `.backup/` | Repositorio git de backup |

---

## Seguranca

### Tool Approval

| Modo | Comportamento |
|------|--------------|
| `auto` | Todas as ferramentas executam sem perguntar |
| `confirm-writes` | Pede confirmacao para escrita de arquivos, comandos e PowerShell |
| `confirm-all` | Pede confirmacao para qualquer ferramenta nao read-only |

### PowerShell Safety Guards

Operacoes **sempre bloqueadas** (sem bypass):
- Desativar Windows Defender
- Deletar arquivos do System32/SysWOW64
- Formatar volume / limpar disco
- Desligar / reiniciar computador
- Criar usuario / modificar Administrators
- Execucao remota (IEX + DownloadString)
- Mudar ExecutionPolicy permanentemente

Operacoes **sinalizadas** (requerem confirmacao em `confirm-writes`):
- Acessar registro do Windows
- Manipular servicos / firewall
- Elevar privilegios (RunAs)
- Modificar programas de inicializacao

### Persistencia Segura

- **Escrita atomica** em todos os arquivos de dados (tmp + rename)
- **Checksums SHA-256** verificados na leitura
- **Backup git** automatico (a cada 30 minutos se ativado)
- **IDs com randomUUID** (sem Math.random)
- **Validacao de config** com ranges e tipos
- **Arquivos corrompidos** preservados como `.corrupt.json`

---

*Atualizado para smolerclaw v1.6.0*
