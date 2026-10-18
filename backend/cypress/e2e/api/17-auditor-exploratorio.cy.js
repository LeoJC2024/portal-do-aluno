import { USUARIOS } from '../../support/dados';
import { criarUsuario, criarUsuarioAtivo, inserirVagaNoBanco } from '../../support/apiHelpers';
import { vagaEmAndamento, vagaHojeNoFuturo } from '../../support/datas';

const unico = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

// Correções encontradas no teste exploratório do perfil AUDITOR:
// A1 SOFT_DELETE continua gravado como SOFT_DELETE (a tela é que mostra como inativação);
// A3 login recusado (conta desativada / troca de senha pendente) gera registro, só com a senha correta;
// A4 CONFIRMACAO_ENTRADA traz matrícula, disciplina e data/hora da prova
describe('API: auditoria (correções do teste exploratório do AUDITOR)', () => {
  const t = {};

  before(() => {
    cy.task('prepararBanco');
    cy.tokenDe(USUARIOS.coord).then((x) => { t.coord = x; });
    cy.tokenDe(USUARIOS.audit).then((x) => { t.audit = x; });
    cy.tokenDe(USUARIOS.recepcao).then((x) => { t.recepcao = x; });
  });

  const excluir = (id) => cy.api('POST', '/api/alterar-status-usuario', { token: t.coord, body: { id, ativo: false } })
    .its('status').should('eq', 200);

  // registros de login recusado gravados para uma matrícula
  const recusados = (matricula) =>
    cy.bd(
      `SELECT acao, descricao, usuario, ip FROM auditoria
        WHERE acao LIKE 'LOGIN_RECUSADO%' AND descricao LIKE $1 ORDER BY id`,
      [`%${matricula}%`]
    );

  const buscaAuditor = (query) =>
    cy.api('GET', `/api/admin/auditoria-completa?${new URLSearchParams(query)}`, { token: t.audit });

  // a descrição nunca leva a senha digitada, o hash gravado nem algo com cara de hash bcrypt ou JWT
  function semSegredos(descricao, senha, matricula) {
    return cy.bd('SELECT senha FROM usuarios WHERE matricula = $1', [matricula]).then((rows) => {
      expect(descricao).to.not.contain(senha);
      if (rows[0].senha) expect(descricao).to.not.contain(rows[0].senha);
      expect(descricao).to.not.match(/\$2[aby]\$/);
      expect(descricao).to.not.match(/eyJ[\w-]+\./);
    });
  }

  describe('A1: exclusão de usuário', () => {
    it('continua gravada com a ação SOFT_DELETE (o que está gravado não muda)', () => {
      criarUsuarioAtivo(t.coord).then((aluno) => {
        excluir(aluno.id);
        cy.bd(`SELECT acao FROM auditoria WHERE acao = 'SOFT_DELETE' AND descricao LIKE $1`, [`%${aluno.matricula}%`])
          .then((rows) => expect(rows.length, 'registro SOFT_DELETE').to.be.at.least(1));
      });
    });
  });

  describe('A3: login de conta desativada', () => {
    it('com a senha correta: resposta igual à de antes e registra LOGIN_RECUSADO_CONTA_INATIVA (sem senha/hash)', () => {
      criarUsuarioAtivo(t.coord).then((aluno) => {
        excluir(aluno.id);
        cy.loginApi(aluno.matricula, aluno.senha).then((r) => {
          expect(r.status).to.eq(403);
          expect(r.body).to.deep.eq({ sucesso: false, mensagem: 'Esta conta foi desativada. Procure a coordenação.' });
        });
        recusados(aluno.matricula).then((rows) => {
          expect(rows).to.have.length(1);
          expect(rows[0].acao).to.eq('LOGIN_RECUSADO_CONTA_INATIVA');
          expect(rows[0].descricao).to.eq(`Login recusado para ${aluno.nome} (${aluno.matricula}): conta desativada`);
          expect(rows[0].usuario).to.eq(aluno.matricula);
          expect(rows[0].ip).to.be.a('string').and.not.be.empty;
          semSegredos(rows[0].descricao, aluno.senha, aluno.matricula);
        });
      });
    });

    it('com a senha errada: continua 401/LOGIN_FALHA e NÃO registra login recusado', () => {
      criarUsuarioAtivo(t.coord).then((aluno) => {
        excluir(aluno.id);
        cy.loginApi(aluno.matricula, 'SenhaErrada@1').then((r) => {
          expect(r.status).to.eq(401);
          expect(r.body).to.deep.eq({ sucesso: false, mensagem: 'Matrícula ou senha incorretas.' });
        });
        recusados(aluno.matricula).should('have.length', 0);
        cy.bd(`SELECT COUNT(*)::int AS n FROM auditoria WHERE acao = 'LOGIN_FALHA' AND descricao LIKE $1`, [`%${aluno.matricula}%`])
          .its('0.n').should('eq', 1);
      });
    });

    it('o auditor acha o registro filtrando pela ação nova e pela matrícula', () => {
      criarUsuarioAtivo(t.coord).then((aluno) => {
        excluir(aluno.id);
        cy.loginApi(aluno.matricula, aluno.senha).its('status').should('eq', 403);
        buscaAuditor({ acao: 'LOGIN_RECUSADO_CONTA_INATIVA', busca: aluno.matricula }).then((r) => {
          expect(r.status, JSON.stringify(r.body)).to.eq(200);
          expect(r.body.logs).to.have.length(1);
          expect(r.body.logs[0].acao).to.eq('LOGIN_RECUSADO_CONTA_INATIVA');
        });
      });
    });
  });

  describe('A3: login no primeiro acesso (troca de senha pendente)', () => {
    it('com a senha provisória correta: resposta igual à de antes e registra LOGIN_RECUSADO_TROCA_SENHA (sem senha/hash)', () => {
      criarUsuario(t.coord).then((u) => {
        cy.loginApi(u.matricula, u.senhaProvisoria).then((r) => {
          expect(r.status).to.eq(403);
          expect(r.body).to.deep.eq({
            sucesso: false,
            trocar_senha: true,
            mensagem: 'Primeiro acesso: é necessário definir uma nova senha. Use a opção "Esqueci minha senha", informe a senha provisória e escolha a sua nova senha.'
          });
        });
        recusados(u.matricula).then((rows) => {
          expect(rows).to.have.length(1);
          expect(rows[0].acao).to.eq('LOGIN_RECUSADO_TROCA_SENHA');
          expect(rows[0].descricao).to.eq(`Login recusado para ${u.nome} (${u.matricula}): primeiro acesso, troca de senha pendente`);
          expect(rows[0].usuario).to.eq(u.matricula);
          expect(rows[0].ip).to.be.a('string').and.not.be.empty;
          semSegredos(rows[0].descricao, u.senhaProvisoria, u.matricula);
        });
        buscaAuditor({ acao: 'LOGIN_RECUSADO_TROCA_SENHA', busca: u.matricula }).its('body.logs').should('have.length', 1);
      });
    });

    it('com a senha errada: continua 401 e NÃO registra login recusado', () => {
      criarUsuario(t.coord).then((u) => {
        cy.loginApi(u.matricula, 'SenhaErrada@1').then((r) => {
          expect(r.status).to.eq(401);
          expect(r.body).to.deep.eq({ sucesso: false, mensagem: 'Matrícula ou senha incorretas.' });
        });
        recusados(u.matricula).should('have.length', 0);
      });
    });
  });

  it('A3: matrícula inexistente não gera registro de login recusado', () => {
    const inexistente = `NAOEXISTE_${unico()}`;
    cy.loginApi(inexistente, 'Qualquer@1').its('status').should('eq', 401);
    recusados(inexistente).should('have.length', 0);
  });

  it('A3: login com sucesso continua sem registro de login recusado', () => {
    criarUsuarioAtivo(t.coord).then((aluno) => {
      cy.loginApi(aluno.matricula, aluno.senha).its('status').should('eq', 200);
      recusados(aluno.matricula).should('have.length', 0);
    });
  });

  describe('A4: confirmação de entrada', () => {
    it('grava matrícula, disciplina e data/hora da prova; a busca pela matrícula com a ação acha o registro', function () {
      const v = vagaEmAndamento() || vagaHojeNoFuturo();
      if (!v) this.skip(); // perto da meia-noite não há horário de prova de hoje com folga
      const disciplina = `CY-p17-${unico()}`;
      criarUsuarioAtivo(t.coord).then((aluno) => {
        inserirVagaNoBanco({ disciplina, data: v.data, inicio: v.inicio, fim: v.fim, polo: 'Polo CY P17' }).then((vagaId) =>
          cy.bd(
            `INSERT INTO agendamentos (vaga_id, usuario_id, aluno_nome, data_agendada, horario_agendado, status)
             VALUES ($1, $2, $3, $4, $5, 'ATIVO') RETURNING id`,
            [vagaId, aluno.id, aluno.nome, v.data, v.inicio]
          )
        ).then((rows) => {
          const ticket = rows[0].id;
          cy.api('POST', '/api/portaria/confirmar-entrada', { token: t.recepcao, body: { ticket_id: ticket } })
            .its('status').should('eq', 200);

          const esperado = `Portaria confirmou entrada do aluno ${aluno.nome} (${aluno.matricula}) ` +
            `na prova de ${disciplina} (${v.data} ${v.inicio}) (Ticket #${ticket})`;
          buscaAuditor({ acao: 'CONFIRMACAO_ENTRADA', busca: aluno.matricula }).then((r) => {
            expect(r.status, JSON.stringify(r.body)).to.eq(200);
            expect(r.body.logs).to.have.length(1);
            expect(r.body.logs[0]).to.include({ acao: 'CONFIRMACAO_ENTRADA', descricao: esperado, usuario: USUARIOS.recepcao.nome });
          });
          // a disciplina também serve de busca
          buscaAuditor({ acao: 'CONFIRMACAO_ENTRADA', busca: disciplina }).its('body.logs').should('have.length', 1);
        });
      });
    });
  });
});
