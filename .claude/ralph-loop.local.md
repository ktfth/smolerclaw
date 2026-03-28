---
active: true
iteration: 1
session_id: 
max_iterations: 72
completion_promise: null
started_at: "2026-03-28T01:49:13Z"
---

Atue como Arquiteto de Software. O objetivo é implementar uma mecânica de 'Blast Radius Analysis' no 'smolerclaw' para mapear impactos de refatoração em projetos TypeScript.

Escopo da Task:
1. Crie o módulo 'src/services/dependency-graph.ts':
   - Import Tracker: Uma função leve que faz o parse de imports/exports de arquivos .ts/.tsx em um diretório alvo, construindo um grafo de dependência interno.
   - Impact Calculator: Lógica para determinar dependências diretas e transitivas de um arquivo específico.

2. Crie as seguintes Tools em 'src/tools.ts':
   - 'analyze_blast_radius': Recebe o path de um arquivo alvo e retorna uma lista hierárquica de todos os módulos que quebrarão se a interface/contrato deste arquivo mudar.
   - 'plan_refactor': Usa o grafo de dependências para sugerir a ordem exata e segura (bottom-up ou top-down) de atualização de arquivos durante uma refatoração massiva.

Diretrizes:
- Evite instalar parsers de AST pesados. Tente resolver a extração de imports via Regex robusto ou usando utilitários nativos/leves compatíveis com Bun.
- A ferramenta deve ser capaz de ignorar 'node_modules' e focar estritamente no código da aplicação. --complete-promise NICE
