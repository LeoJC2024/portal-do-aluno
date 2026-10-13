const { defineConfig } = require('cypress');
const path = require('path');
const fs = require('fs');
const express = require('express');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

// Os testes usam SEMPRE o .env.teste (banco de teste), nunca o .env de produção.
dotenv.config({ path: path.join(__dirname, '.env.teste') });

const PORTA_FRONT = Number(process.env.PORTA_FRONT_TESTE || 5501);
// servidor de teste (npm run servidor:teste) usa a PORT do .env.teste; a 3000 é do servidor normal
const PORTA_PRODUCAO = 3000;
const PORTA_API = Number(process.env.PORT);
let servidorFront = null;
let pool = null;
let ambienteApiConferido = null;

// serve a pasta ../frontend para os testes de tela
function iniciarServidorFront() {
  if (servidorFront) return;
  const app = express();
  app.use(express.static(path.join(__dirname, '..', 'frontend')));
  servidorFront = app.listen(PORTA_FRONT);
  servidorFront.on('error', () => { /* porta já em uso: assume que outro servidor-front está ativo */ });
}

function bancoDeTeste() {
  if (process.env.BANCO_DE_TESTE !== 'sim') {
    throw new Error('BANCO_DE_TESTE=sim não está definido no .env.teste. Por segurança, o Cypress não mexe no banco assim.');
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL ausente no .env.teste.');
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false }
    });
  }
  return pool;
}

// "host:porta/banco" de uma connection string, para comparar sem expor usuário e senha
function identificarBanco(url) {
  try {
    const u = new URL(url);
    return `${u.hostname.toLowerCase()}:${u.port || 5432}${u.pathname}|${decodeURIComponent(u.username)}`;
  } catch (_) {
    return null;
  }
}

// Trava dos testes de API: só roda contra o servidor e o banco de TESTE.
// Confere a URL da API, o banco do .env.teste (comparado com o do .env normal, sem exibir nenhum dos dois)
// e se o servidor de teste está no ar. Qualquer problema vira um erro com a explicação.
async function conferirAmbienteApi(apiUrl) {
  if (ambienteApiConferido) return ambienteApiConferido;
  const erro = (msg) => new Error(`TESTES DE API BLOQUEADOS: ${msg}`);

  if (!Number.isInteger(PORTA_API) || PORTA_API === PORTA_PRODUCAO) {
    throw erro(`a PORT do .env.teste precisa estar definida e ser diferente de ${PORTA_PRODUCAO} (porta do servidor normal). Use PORT=3001.`);
  }
  let url;
  try { url = new URL(apiUrl); } catch (_) { throw erro(`URL da API inválida: "${apiUrl}".`); }
  const portaUrl = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || portaUrl !== PORTA_API) {
    throw erro(`a URL da API é ${apiUrl}, mas o servidor de teste roda em http://localhost:${PORTA_API} (PORT do .env.teste). ` +
      'Não defina CYPRESS_API_URL apontando para outro servidor.');
  }

  bancoDeTeste(); // exige BANCO_DE_TESTE=sim e DATABASE_URL
  const arquivoProducao = path.join(__dirname, '.env');
  if (fs.existsSync(arquivoProducao)) {
    const producao = dotenv.parse(fs.readFileSync(arquivoProducao));
    if (producao.BANCO_DE_TESTE === 'sim') {
      throw erro('o .env normal tem BANCO_DE_TESTE=sim; essa marca é exclusiva do .env.teste.');
    }
    const idTeste = identificarBanco(process.env.DATABASE_URL);
    if (producao.DATABASE_URL && (producao.DATABASE_URL === process.env.DATABASE_URL ||
        (idTeste && idTeste === identificarBanco(producao.DATABASE_URL)))) {
      throw erro('o DATABASE_URL do .env.teste aponta para o mesmo banco do .env normal (produção).');
    }
    if (producao.PORT && Number(producao.PORT) === PORTA_API) {
      throw erro(`o .env normal também usa a porta ${PORTA_API}; o servidor de teste precisa de uma porta só dele.`);
    }
  }

  try {
    await fetch(apiUrl, { signal: AbortSignal.timeout(5000) });
  } catch (_) {
    throw erro(`nenhum servidor respondeu em ${apiUrl}. Suba o servidor de teste antes: npm run servidor:teste`);
  }
  ambienteApiConferido = true;
  return true;
}


// colunas e índices que o sistema atual exige no banco de teste
const COLUNAS_EXIGIDAS = {
  usuarios: ['polo', 'ativo', 'trocar_senha', 'codigo_tentativas', 'foto_url'],
  agendamentos: ['usuario_id', 'entrada_confirmada_em', 'entrada_confirmada_por'],
  auditoria: ['usuario'],
  vagas: ['horario_fim', 'curso', 'agendamento_inicio', 'agendamento_fim', 'criado_em', 'criado_por'],
  disciplinas: ['nome', 'ativa', 'criado_em', 'criado_por']
};
const INDICES_EXIGIDOS = ['uq_usuarios_matricula_ci', 'uq_usuarios_email_ci', 'uq_agendamento_ativo', 'uq_vagas_disciplina_data_hora_polo', 'uq_disciplinas_nome_ci'];

// faz uma requisição HTTP e devolve { status, body }
async function requisitar(r) {
  const resp = await fetch(r.url, {
    method: r.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(r.headers || {}) },
    body: r.body ? JSON.stringify(r.body) : undefined
  });
  let body = null;
  try { body = await resp.json(); } catch (_) { /* sem JSON */ }
  return { status: resp.status, body };
}

async function esquemaDesatualizado(db) {
  const faltando = [];
  const cols = await db.query(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [Object.keys(COLUNAS_EXIGIDAS)]
  );
  const existentes = new Set(cols.rows.map((r) => `${r.table_name}.${r.column_name}`));
  Object.entries(COLUNAS_EXIGIDAS).forEach(([tabela, lista]) => {
    lista.forEach((c) => { if (!existentes.has(`${tabela}.${c}`)) faltando.push(`${tabela}.${c}`); });
  });
  const idx = await db.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`);
  const indices = new Set(idx.rows.map((r) => r.indexname));
  INDICES_EXIGIDOS.forEach((i) => { if (!indices.has(i)) faltando.push(`índice ${i}`); });
  return faltando;
}

const SQL_LIMPEZA = `
  DELETE FROM agendamentos
   WHERE vaga_id IN (SELECT id FROM vagas WHERE disciplina LIKE 'CY-%')
      OR usuario_id IN (SELECT id FROM usuarios WHERE email LIKE 'cy-%@teste.local');
  DELETE FROM vagas WHERE disciplina LIKE 'CY-%';
  DELETE FROM disciplinas WHERE nome LIKE 'CY-%';
  DELETE FROM notas_alunos WHERE avaliacao LIKE 'CY-%';
  DELETE FROM usuarios WHERE email LIKE 'cy-%@teste.local';
`;

module.exports = defineConfig({
  e2e: {
    baseUrl: `http://localhost:${PORTA_FRONT}`,
    specPattern: 'cypress/e2e/**/*.cy.js',
    supportFile: 'cypress/support/e2e.js',
    video: false,
    // os testes de API não abrem página; tirar print na falha só esconde o erro verdadeiro
    screenshotOnRunFailure: false,
    defaultCommandTimeout: 8000,
    pageLoadTimeout: 60000,
    retries: { runMode: 1, openMode: 0 },
    // endereço do servidor de teste usado pelos testes de API (cypress/support/dados.js, via Cypress.expose).
    // Não é segredo; segredos (DATABASE_URL, JWT_SECRET) ficam só no Node, dentro das tasks.
    expose: { API_URL: `http://localhost:${PORTA_API}` },
    setupNodeEvents(on, config) {
      iniciarServidorFront();
      const apiUrl = config.expose.API_URL; // já considera um --expose API_URL=... vindo da linha de comando

      // cypress run: se a execução inclui testes de API, confere o ambiente antes de começar
      on('before:run', async (detalhes) => {
        const specs = (detalhes && detalhes.specs) || [];
        if (specs.some((s) => /(^|[\\/])e2e[\\/]api[\\/]/.test(s.relative || ''))) {
          await conferirAmbienteApi(apiUrl);
        }
      });

      on('task', {
        // chamada pelos testes de API (cypress/support/e2e.js) — cobre também o cypress open
        conferirAmbienteApi() {
          return conferirAmbienteApi(apiUrl);
        },
        // consulta/alteração direta no banco de TESTE
        async bd({ sql, params }) {
          const r = await bancoDeTeste().query(sql, params || []);
          return r.rows;
        },
        // igual ao bd, mas devolve o erro em vez de falhar (para testar bloqueios do banco)
        async bdTentar({ sql, params }) {
          try {
            await bancoDeTeste().query(sql, params || []);
            return { erro: null };
          } catch (e) {
            return { erro: e.message };
          }
        },
        // apaga dados criados pelos testes e recria os usuários-semente
        async prepararBanco() {
          const db = bancoDeTeste();
          const faltando = await esquemaDesatualizado(db);
          if (faltando.length) {
            throw new Error(`O BANCO DE TESTE ESTÁ DESATUALIZADO. Faltam: ${faltando.join(', ')}. ` +
              'Rode banco/corrigir_banco_teste.sql no SQL Editor do projeto Supabase de TESTE e repita.');
          }
          await db.query(SQL_LIMPEZA);
          const seed = fs.readFileSync(path.join(__dirname, 'banco', 'seed_teste.sql'), 'utf8');
          await db.query(seed);
          const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM usuarios WHERE matricula LIKE 'TESTE\\_%'`);
          if (rows[0].n < 7) throw new Error('Usuários-semente não encontrados. Rode banco/schema_banco_teste.sql no banco de teste.');
          return null;
        },
        async limparTestes() {
          await bancoDeTeste().query(SQL_LIMPEZA);
          return null;
        },
        // várias requisições ao mesmo tempo (teste de concorrência)
        async paralelo(requisicoes) {
          return Promise.all(requisicoes.map(requisitar));
        },
        // abre uma transação no banco de teste, roda os comandos (que travam as linhas alteradas),
        // dispara a requisição e só faz COMMIT depois de "esperaMs". Reproduz a corrida entre uma
        // checagem feita fora da transação do servidor e o bloqueio FOR UPDATE dentro dela.
        async requisicaoDuranteTransacao({ comandos, requisicao, esperaMs = 3000 }) {
          const client = await bancoDeTeste().connect();
          try {
            await client.query('BEGIN');
            for (const c of comandos) await client.query(c.sql, c.params || []);
            const resposta = requisitar(requisicao);
            resposta.catch(() => {}); // a falha (se houver) aparece no await abaixo
            await new Promise((ok) => setTimeout(ok, esperaMs));
            await client.query('COMMIT');
            return await resposta;
          } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            throw e;
          } finally {
            client.release();
          }
        },
        // token assinado com o JWT_SECRET de teste (expirado ou de usuário inexistente)
        gerarToken({ payload, opcoes }) {
          return jwt.sign(payload, process.env.JWT_SECRET, opcoes || { expiresIn: '1h' });
        }
      });
    }
  }
});
