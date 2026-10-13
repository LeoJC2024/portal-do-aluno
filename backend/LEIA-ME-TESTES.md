# Testes automáticos com Cypress

Duas camadas, para cobrir tudo sem arriscar os dados reais:

| Camada | Pasta | Precisa de | O que testa |
|---|---|---|---|
| **Telas** | `cypress/e2e/front` | só do Cypress + internet (CDNs) | Cada tela no navegador, com o servidor **simulado** (`cy.intercept`) |
| **API** | `cypress/e2e/api` | servidor em modo de teste + **banco de teste** | Regras reais: permissões, matrícula automática, senha provisória, agendamento, 24h, concorrência, auditoria, segurança |

## Onde cada arquivo vai (pasta `backend`)

```
portal-backend/
├── frontend/                (já existe: HTMLs, js/, css/)
└── backend/
    ├── server.js            ← substitua pelo novo
    ├── cypress.config.js    ← NOVO
    ├── servidor-front.js    ← NOVO (opcional)
    ├── .env.teste           ← você cria a partir de env.teste.exemplo
    ├── banco/               ← NOVO (schema_banco_teste.sql e seed_teste.sql)
    └── cypress/
        ├── support/         ← e2e.js, comandos.js, dados.js, datas.js, apiHelpers.js, telas.js
        └── e2e/
            ├── front/       ← 7 arquivos
            └── api/         ← 8 arquivos
```
(Pode apagar o `cypress/e2e/spec.cy.js` de exemplo. O `cypress/support/e2e.js` novo substitui o padrão.)

## Banco de teste (só para a camada API)

Use um **projeto Supabase separado** (o plano gratuito permite 2) ou um Postgres local. **Nunca o de produção:** os testes criam e apagam dados.

1. No SQL Editor do projeto de teste, rode `banco/schema_banco_teste.sql`.
2. Copie `env.teste.exemplo` para `.env.teste` e preencha `DATABASE_URL`, `JWT_SECRET`... O `BANCO_DE_TESTE=sim` é a trava de segurança: sem ele, nem o servidor em modo de teste nem o Cypress mexem no banco.
3. Os usuários dos testes (`TESTE_COORD`, `TESTE_ALUNO_A1`...) são criados sozinhos a cada execução.

## Como rodar

Telas (não precisa de servidor nem de banco):
```
npm run cy:telas
```

API (duas janelas do terminal):
```
npm run servidor:teste     # janela 1: servidor usando .env.teste (porta 3001), e-mail desligado
npm run cy:api             # janela 2
```

O servidor de teste usa a `PORT` do `.env.teste` (3001), então pode ficar ligado junto com o servidor normal (`npm start`, porta 3000). O Cypress de API lê essa mesma porta e se recusa a rodar (mensagem "TESTES DE API BLOQUEADOS") se a porta for a 3000, se a URL não for a do servidor de teste, se o banco do `.env.teste` for o mesmo do `.env` normal ou se o servidor de teste não estiver no ar.

Tudo de uma vez: `npm run cy:tudo` (com o servidor de teste rodando). Para ver passo a passo no navegador: `npm run cy:abrir`.

## O que o "modo de teste" muda no servidor

Só liga com `--modo-teste` + `BANCO_DE_TESTE=sim`: não envia e-mails; devolve a senha provisória e o código de recuperação na resposta (para o teste poder usá-los); desliga o limite de tentativas de login. **Nunca use em produção.**

## O que NÃO é coberto automaticamente

- Envio real de e-mail (Gmail) e o texto do e-mail.
- Limite de tentativas de login/recuperação (rate limit): está desligado no modo de teste. Teste à mão no servidor normal.
- Upload real de foto no Supabase Storage: só roda se você configurar um bucket no projeto de teste e definir `TESTAR_STORAGE=sim`.
- Aparência visual (cores, alinhamento).

## Se algo falhar

- "Swal is not defined": sem internet (as telas carregam SweetAlert, Tailwind e Font Awesome por CDN).
- "Usuários-semente não encontrados": falta rodar `schema_banco_teste.sql` no banco de teste.
- Erro de CORS/403 no teste "CORS": coloque `http://localhost:5501` em `ALLOWED_ORIGINS` do `.env.teste`.
- Muitos testes de API dão 401: o `JWT_SECRET` do `.env.teste` precisa ser o mesmo do servidor de teste (use o mesmo arquivo).
- `.env.teste` nunca vai para o Git.
