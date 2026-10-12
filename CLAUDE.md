# CLAUDE.md — Portal do Aluno UNIFAA

Regras permanentes para trabalhar neste projeto.

## Projeto

- Portal do Aluno UNIFAA (agendamento de provas).
- Estrutura: a pasta `Portal do Aluno` tem as subpastas `backend/` e `frontend/`.
- **Backend:** `backend/server.js` (Node/Express, PostgreSQL no Supabase).
- **Frontend:** HTML + Tailwind + JS puro em `frontend/` (sem React).
- **Testes:** Cypress em `backend/cypress/`.

## Banco de dados

- **NUNCA** rodar nada contra o banco de produção. Testes e experimentos só com `.env.teste` / `npm run servidor:teste` e o banco de teste (`BANCO_DE_TESTE=sim`).
- **NUNCA** alterar o banco diretamente. Toda mudança de banco vira um arquivo SQL novo (`migracao_parte_X.sql`), que o usuário roda manualmente no Supabase.
- O mesmo ajuste deve ser refletido em `backend/banco/schema_banco_teste.sql`.

## Escopo das mudanças

- Não mexer em telas, textos ou regras que não foram pedidos. Se encontrar algo estranho fora do pedido, apenas avisar.
- Não enfraquecer nem apagar testes para fazê-los passar. Se um teste antigo quebrar por causa de uma mudança pedida, ajustar o teste e explicar o motivo.

## Regras de negócio e segurança a manter

- RBAC por perfil lido do banco.
- Auditoria imutável.
- Soft delete (`ativo` / `INATIVO`).
- Fuso horário `America/Sao_Paulo`.
- Regra de 24h para cancelar/reagendar.
- `escapeHtml` em todo texto vindo do servidor.

## Depois de cada tarefa

1. Rodar, dentro de `backend/`:
   - `npm run cy:telas`
   - `npm run cy:api`
2. Mostrar o resultado (quantos testes passaram/falharam).

## Comunicação

- Responder sempre em português.
- Listar no final os arquivos alterados.
