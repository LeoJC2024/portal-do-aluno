// Lote B de melhorias: cada bloco reproduz um problema encontrado e confere a correção.
// (o item 1 é o schema do banco de teste e o item 6 é de tela: front/09-lote-b-login.cy.js)
import { USUARIOS, API_URL } from '../../support/dados';
import { criarVaga, criarUsuario, criarUsuarioAtivo, agendar, registrarDisciplina } from '../../support/apiHelpers';
import { dataSP, hojeSP, vagaEmHoras } from '../../support/datas';

const unico = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

describe('API: lote B de melhorias', () => {
  const t = {};

  before(() => {
    cy.task('prepararBanco');
    cy.tokenDe(USUARIOS.coord).then((x) => { t.coord = x; });
    cy.tokenDe(USUARIOS.recepcao).then((x) => { t.recepcao = x; });
  });

  const cadastrar = (body) => cy.api('POST', '/api/cadastrar-usuario', { token: t.coord, body });
  const corpoUsuario = (extra = {}) => ({ nome: 'Cy Lote B', email: `cy-${unico()}@teste.local`, curso: 'CY Curso A', tipo: 'Aluno', ...extra });
  const contarEmail = (email) =>
    cy.bd('SELECT COUNT(*)::int AS n FROM usuarios WHERE LOWER(email) = LOWER($1)', [email]).then((rows) => rows[0].n);

  // ---------------------------------------------------------------------------
  describe('2. e-mail duplicado com maiúsculas', () => {
    let apagarDepois = [];

    afterEach(() => {
      // linhas inseridas direto no banco que a limpeza padrão (e-mail cy-%@teste.local, minúsculo) não pega
      if (apagarDepois.length) cy.bd('DELETE FROM usuarios WHERE id = ANY($1)', [apagarDepois]);
      apagarDepois = [];
    });

    it('o e-mail é gravado em minúsculas', () => {
      const n = unico();
      cadastrar(corpoUsuario({ email: `CY-${n}@Teste.LOCAL` })).its('status').should('eq', 200);
      cy.bd('SELECT email FROM usuarios WHERE LOWER(email) = $1', [`cy-${n}@teste.local`])
        .then((rows) => {
          expect(rows, 'usuário cadastrado').to.have.length(1);
          expect(rows[0].email).to.eq(`cy-${n}@teste.local`);
        });
    });

    it('o mesmo e-mail com outra grafia é recusado (400) e só um usuário existe', () => {
      const n = unico();
      cadastrar(corpoUsuario({ email: `cy-${n}@teste.local` })).its('status').should('eq', 200);
      cadastrar(corpoUsuario({ email: `CY-${n}@TESTE.local` })).then((r) => {
        expect(r.status, JSON.stringify(r.body)).to.eq(400);
        expect(r.body.mensagem).to.contain('e-mail');
        expect(r.body.mensagem).to.contain('reative');
      });
      contarEmail(`cy-${n}@teste.local`).should('eq', 1);
    });

    it('cadastro antigo gravado com maiúsculas também bloqueia o mesmo e-mail (índice LOWER(email))', () => {
      const n = unico();
      cy.bd(`INSERT INTO usuarios (nome, matricula, curso, tipo, senha, email)
             VALUES ('Cy Legado Maiusculo', $1, 'CY Curso A', 'Aluno', 'x', $2) RETURNING id`, [`CYLEG${n}`, `CY-${n}@TESTE.LOCAL`])
        .then((rows) => { apagarDepois.push(rows[0].id); });
      cadastrar(corpoUsuario({ email: `cy-${n}@teste.local` })).then((r) => {
        expect(r.status, JSON.stringify(r.body)).to.eq(400);
        expect(r.body.mensagem).to.contain('e-mail');
      });
      contarEmail(`cy-${n}@teste.local`).should('eq', 1);
    });

    it('duplicidade que não é de e-mail (matrícula) tem mensagem própria', () => {
      // matrícula em minúsculas não entra na sequência E00000..., mas colide no índice LOWER(matricula)
      cy.bd(`SELECT COALESCE(MAX(CAST(SUBSTRING(matricula FROM '[0-9]{5}$') AS integer)), -1) + 1 AS prox
               FROM usuarios WHERE matricula ~ '^E[0-9]{5}$'`).then((rows) => {
        const proxima = `e${String(rows[0].prox).padStart(5, '0')}`;
        cy.bd(`INSERT INTO usuarios (nome, matricula, curso, tipo, senha, email)
               VALUES ('Cy Colisao Matricula', $1, 'CY Curso A', 'Aluno', 'x', $2) RETURNING id`, [proxima, `cy-${unico()}@teste.local`])
          .then((ins) => { apagarDepois.push(ins[0].id); });
      });
      const email = `cy-${unico()}@teste.local`;
      cadastrar(corpoUsuario({ email })).then((r) => {
        expect(r.status, JSON.stringify(r.body)).to.eq(409);
        expect(r.body.mensagem).to.contain('matrícula');
        expect(r.body.mensagem).to.not.contain('e-mail');
      });
      contarEmail(email).should('eq', 0);
    });
  });

  // ---------------------------------------------------------------------------
  describe('3. vaga para hoje com horário já passado', () => {
    it('hoje às 00:00: 400 e nenhuma vaga criada', () => {
      const disciplina = `CY-passado-${unico()}`;
      registrarDisciplina(t.coord, disciplina);
      cy.api('POST', '/api/cadastrar-vaga', {
        token: t.coord,
        body: { polo: 'Polo CY', curso: 'CY Curso A', disciplina, data: hojeSP(), horario_inicio: '00:00', horario_fim: '00:30', limite_vagas: 5 }
      }).then((r) => {
        expect(r.status, JSON.stringify(r.body)).to.eq(400);
        expect(r.body.mensagem).to.contain('já passou');
      });
      cy.bd('SELECT COUNT(*)::int AS n FROM vagas WHERE disciplina = $1', [disciplina]).then((rows) => expect(rows[0].n).to.eq(0));
    });

    it('hoje com horário ainda por vir: cadastra normalmente', () => {
      const { data, inicio, fim } = vagaEmHoras(2);
      criarVaga(t.coord, { data, horario_inicio: inicio, horario_fim: fim }).its('id').should('be.a', 'number');
    });
  });

  // ---------------------------------------------------------------------------
  describe('4. reagendar: regra das 24h refeita depois do FOR UPDATE', () => {
    it('agendamento alterado para < 24h enquanto o pedido espera o bloqueio: 400 e nada muda', () => {
      const disciplina = `CY-corrida24h-${unico()}`;
      criarVaga(t.coord, { disciplina }).then((v1) => {
        criarVaga(t.coord, { disciplina, horario_inicio: '14:00', horario_fim: '15:00' }).then((v2) => {
          criarUsuarioAtivo(t.coord).then((aluno) => {
            agendar(aluno.token, v1.id).then((r) => {
              const ag = r.body.agendamento.id;
              const { data, inicio } = vagaEmHoras(2);
              // a transação do teste muda o agendamento para daqui a 2h e segura a linha por 3s:
              // a checagem fora da transação do servidor ainda vê a data antiga (> 24h)
              cy.task('requisicaoDuranteTransacao', {
                comandos: [{ sql: 'UPDATE agendamentos SET data_agendada = $2, horario_agendado = $3 WHERE id = $1', params: [ag, data, inicio] }],
                requisicao: {
                  method: 'POST', url: `${API_URL}/api/reagendar`,
                  headers: { Authorization: `Bearer ${aluno.token}` },
                  body: { agendamento_id: ag, nova_vaga_id: v2.id }
                },
                esperaMs: 3000
              }).then((resp) => {
                expect(resp.status, JSON.stringify(resp.body)).to.eq(400);
                expect(resp.body.mensagem).to.contain('24 horas');
              });
              cy.bd('SELECT status FROM agendamentos WHERE id = $1', [ag]).then((rows) => expect(rows[0].status).to.eq('ATIVO'));
              cy.bd(`SELECT COUNT(*)::int AS n FROM agendamentos WHERE vaga_id = $1 AND status = 'ATIVO'`, [v2.id])
                .then((rows) => expect(rows[0].n, 'nenhum agendamento novo').to.eq(0));
              cy.bd(`SELECT COUNT(*)::int AS n FROM auditoria WHERE acao = 'REAGENDAMENTO_BLOQUEADO' AND descricao LIKE $1`,
                [`%${disciplina} pelo aluno ${aluno.nome}%`])
                .then((rows) => expect(rows[0].n, 'log de reagendamento bloqueado').to.eq(1));
            });
          });
        });
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe('5. nova senha com mais de 72 bytes', () => {
    const definir = (u, novaSenha) =>
      cy.api('POST', '/api/recuperar-senha', { body: { matricula: u.matricula, codigo: u.senhaProvisoria, novaSenha } });

    it('73 caracteres ou 37 letras acentuadas (74 bytes): 400; 72 bytes passa; mínimo de 8 continua', () => {
      criarUsuario(t.coord).then((u) => {
        definir(u, 'A'.repeat(73)).then((r) => {
          expect(r.status, JSON.stringify(r.body)).to.eq(400);
          expect(r.body.mensagem).to.contain('no máximo 72');
        });
        definir(u, 'é'.repeat(37)).then((r) => {
          expect(r.status, JSON.stringify(r.body)).to.eq(400);
          expect(r.body.mensagem).to.contain('no máximo 72');
        });
        definir(u, 'Curta@1').then((r) => {
          expect(r.status).to.eq(400);
          expect(r.body.mensagem).to.contain('pelo menos 8');
        });
        const limite = `Ab1@${'x'.repeat(68)}`; // 72 bytes
        definir(u, limite).its('status').should('eq', 200);
        cy.loginApi(u.matricula, limite).its('status').should('eq', 200);
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe('7. listagens com LIMIT', () => {
    const prefixo = `CY-lim-${unico()}-`;

    after(() => {
      cy.bd('DELETE FROM agendamentos WHERE vaga_id IN (SELECT id FROM vagas WHERE disciplina LIKE $1)', [`${prefixo}%`]);
      cy.bd('DELETE FROM vagas WHERE disciplina LIKE $1', [`${prefixo}%`]);
    });

    it('/api/vagas (coordenador) devolve no máximo 1000 vagas', () => {
      cy.bd(`INSERT INTO vagas (polo, curso, disciplina, data_prova, horario, horario_fim, limite_vagas)
             SELECT 'Polo CY', 'CY Curso Limite', $1 || g, $2, '08:00', '10:00', 5 FROM generate_series(1, 1001) g`,
        [`${prefixo}v`, dataSP(20)]);
      cy.api('GET', '/api/vagas', { token: t.coord }).then((r) => {
        expect(r.status).to.eq(200);
        expect(r.body).to.have.length(1000);
      });
    });

    it('/api/portaria/por-data devolve no máximo 1000 alunos', () => {
      const data = dataSP(200);
      cy.bd(`INSERT INTO vagas (polo, curso, disciplina, data_prova, horario, horario_fim, limite_vagas)
             VALUES ('Polo CY', 'CY Curso Limite', $1, $2, '08:00', '10:00', 5000) RETURNING id`, [`${prefixo}portaria`, data])
        .then((rows) => {
          cy.bd(`INSERT INTO agendamentos (vaga_id, aluno_nome, data_agendada, horario_agendado, status)
                 SELECT $1, 'CY Limite ' || g, $2, '08:00', 'ATIVO' FROM generate_series(1, 1001) g`, [rows[0].id, data]);
        });
      cy.api('GET', `/api/portaria/por-data?data=${data}`, { token: t.recepcao }).then((r) => {
        expect(r.status, JSON.stringify(r.body).slice(0, 300)).to.eq(200);
        expect(r.body.alunos).to.have.length(1000);
      });
    });
  });
});
