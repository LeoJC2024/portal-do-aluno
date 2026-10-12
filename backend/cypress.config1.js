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
let servidorFront = null;
let pool = null;

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

const SQL_LIMPEZA = `
  DELETE FROM agendamentos
   WHERE vaga_id IN (SELECT id FROM vagas WHERE disciplina LIKE 'CY-%')
      OR usuario_id IN (SELECT id FROM usuarios WHERE email LIKE 'cy-%@teste.local');
  DELETE FROM vagas WHERE disciplina LIKE 'CY-%';
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
    setupNodeEvents(on) {
      iniciarServidorFront();

      on('task', {
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
          return Promise.all(requisicoes.map(async (r) => {
            const resp = await fetch(r.url, {
              method: r.method || 'GET',
              headers: { 'Content-Type': 'application/json', ...(r.headers || {}) },
              body: r.body ? JSON.stringify(r.body) : undefined
            });
            let body = null;
            try { body = await resp.json(); } catch (_) { /* sem JSON */ }
            return { status: resp.status, body };
          }));
        },
        // token assinado com o JWT_SECRET de teste (expirado ou de usuário inexistente)
        gerarToken({ payload, opcoes }) {
          return jwt.sign(payload, process.env.JWT_SECRET, opcoes || { expiresIn: '1h' });
        }
      });
    }
  }
});
