import { USUARIOS } from '../../support/dados';
import { logsDeAuditoria } from '../../support/apiHelpers';

describe('API: notas e resultados', () => {
  const t = {};
  const id = {};

  before(() => {
    cy.task('prepararBanco');
    cy.tokenDe(USUARIOS.coord).then((x) => { t.coord = x; });
    cy.tokenDe(USUARIOS.alunoA1).then((x) => { t.a1 = x; });
    cy.tokenDe(USUARIOS.alunoA2).then((x) => { t.a2 = x; });
    cy.tokenDe(USUARIOS.alunoB).then((x) => { t.b = x; });

    const inserir = (usuario, avaliacao, nota) =>
      cy.bd(
        `INSERT INTO notas_alunos (nome_aluno, matricula, avaliacao, polo, nota) VALUES ($1, $2, $3, 'Polo CY', $4) RETURNING id`,
        [usuario.nome, usuario.matricula, avaliacao, nota]
      ).then((rows) => rows[0].id);

    inserir(USUARIOS.alunoA1, 'CY-Prova A1', 7.5).then((n) => { id.a1 = n; });
    inserir(USUARIOS.alunoB, 'CY-Prova B', 4).then((n) => { id.b = n; });
  });

  const atualizar = (corpo) => cy.api('POST', '/api/atualizar-nota', { token: t.coord, body: corpo });
  const notaNoBanco = (nid) => cy.bd('SELECT nota::float AS nota FROM notas_alunos WHERE id = $1', [nid]).then((rows) => rows[0].nota);

  describe('resultados do aluno', () => {
    it('o aluno vê só as próprias notas (identificado pela matrícula do token)', () => {
      cy.api('GET', '/api/resultados', { token: t.a1 }).then((r) => {
        expect(r.status).to.eq(200);
        expect(r.body.length).to.be.greaterThan(0);
        r.body.forEach((n) => expect(n.matricula).to.eq(USUARIOS.alunoA1.matricula));
        expect(r.body.some((n) => n.avaliacao === 'CY-Prova A1')).to.eq(true);
        expect(r.body.some((n) => n.avaliacao === 'CY-Prova B')).to.eq(false);
      });
    });

    it('aluno sem notas recebe lista vazia; outro aluno só vê a sua', () => {
      cy.api('GET', '/api/resultados', { token: t.a2 }).its('body').should('deep.eq', []);
      cy.api('GET', '/api/resultados', { token: t.b }).then((r) => {
        expect(r.body.map((n) => n.avaliacao)).to.deep.eq(['CY-Prova B']);
      });
    });

    it('não dá para pedir as notas de outra pessoa por parâmetro', () => {
      cy.api('GET', `/api/resultados?aluno_nome=${encodeURIComponent(USUARIOS.alunoA1.nome)}&matricula=${USUARIOS.alunoA1.matricula}`, { token: t.b }).then((r) => {
        expect(r.body.every((n) => n.matricula === USUARIOS.alunoB.matricula)).to.eq(true);
      });
    });
  });

  describe('lançamento pelo coordenador', () => {
    it('lista todas as notas', () => {
      cy.api('GET', '/api/notas', { token: t.coord }).then((r) => {
        expect(r.status).to.eq(200);
        const avaliacoes = r.body.map((n) => n.avaliacao);
        expect(avaliacoes).to.include.members(['CY-Prova A1', 'CY-Prova B']);
      });
    });

    it('salva a nota, grava no banco, aparece para o aluno e vai para a auditoria', () => {
      atualizar({ id: id.a1, nota: 8.5 }).then((r) => {
        expect(r.status, JSON.stringify(r.body)).to.eq(200);
        expect(r.body.mensagem).to.contain('Nota salva');
      });
      notaNoBanco(id.a1).should('eq', 8.5);
      cy.api('GET', '/api/resultados', { token: t.a1 }).then((r) => {
        expect(Number(r.body.find((n) => n.avaliacao === 'CY-Prova A1').nota)).to.eq(8.5);
      });
      logsDeAuditoria(t.coord).then((logs) => {
        const log = logs.find((l) => l.acao === 'LANÇAMENTO_NOTA' && l.descricao.includes('CY-Prova A1'));
        expect(log, 'log do lançamento').to.exist;
        expect(log.descricao).to.contain('Nota 8.5').and.contain(USUARIOS.alunoA1.matricula);
        expect(log.usuario).to.eq(USUARIOS.coord.nome);
      });
    });

    it('aceita vírgula decimal, número como texto e os limites 0 e 10', () => {
      atualizar({ id: id.a1, nota: '7,5' }).its('status').should('eq', 200);
      notaNoBanco(id.a1).should('eq', 7.5);
      atualizar({ id: id.a1, nota: '9' }).its('status').should('eq', 200);
      notaNoBanco(id.a1).should('eq', 9);
      atualizar({ id: id.a1, nota: 0 }).its('status').should('eq', 200);
      notaNoBanco(id.a1).should('eq', 0);
      atualizar({ id: id.a1, nota: 10 }).its('status').should('eq', 200);
      notaNoBanco(id.a1).should('eq', 10);
    });

    [['-0.01', -0.01], ['10.01', 10.01], ['11', 11], ['texto', 'abc'], ['vazio', ''], ['nulo', null], ['ausente', undefined]].forEach(([nome, valor]) => {
      it(`recusa nota ${nome} e mantém a nota anterior`, () => {
        atualizar({ id: id.b, nota: 5 }).its('status').should('eq', 200);
        atualizar({ id: id.b, nota: valor }).then((r) => {
          expect(r.status).to.eq(400);
          expect(r.body.mensagem).to.contain('entre 0 e 10');
        });
        notaNoBanco(id.b).should('eq', 5);
      });
    });

    it('registro inválido: 400; inexistente: 404', () => {
      atualizar({ id: 'x', nota: 5 }).then((r) => {
        expect(r.status).to.eq(400);
        expect(r.body.mensagem).to.contain('Registro inválido');
      });
      atualizar({ nota: 5 }).its('status').should('eq', 400);
      atualizar({ id: 999999999, nota: 5 }).its('status').should('eq', 404);
    });

    it('aluno não consegue lançar nota (403)', () => {
      cy.api('POST', '/api/atualizar-nota', { token: t.a1, body: { id: id.a1, nota: 10 } }).its('status').should('eq', 403);
    });
  });
});
