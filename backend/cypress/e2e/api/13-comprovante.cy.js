import { USUARIOS, CURSO_A } from '../../support/dados';
import { criarVaga, agendar } from '../../support/apiHelpers';
import { dataSP } from '../../support/datas';

const FUSO = 'America/Sao_Paulo';
const comprovante = (token, id) => cy.api('GET', `/api/agendamentos/${id}/comprovante`, { token });
const codigoDe = (id) => `AG-${String(id).padStart(6, '0')}`;

// "dd/mm/aaaa hh:mm:ss" no fuso de São Paulo (mesmo formato do servidor)
const emSP = (iso) => {
  const [d, h] = new Date(iso).toLocaleString('sv-SE', { timeZone: FUSO }).split(' ');
  return `${d.split('-').reverse().join('/')} ${h}`;
};

// quantos registros COMPROVANTE_EMITIDO existem para um agendamento (o código é único por id)
const logsDoComprovante = (id) =>
  cy.bd(
    `SELECT acao, descricao, usuario, ip FROM auditoria
      WHERE acao = 'COMPROVANTE_EMITIDO' AND descricao LIKE $1 ORDER BY id`,
    [`% ${codigoDe(id)} %`]
  );

describe('API: comprovante do agendamento', () => {
  const t = {};
  const ag = {}; // { id, vaga }

  before(() => {
    cy.task('prepararBanco');
    cy.tokenDe(USUARIOS.coord).then((x) => { t.coord = x; });
    cy.tokenDe(USUARIOS.recepcao).then((x) => { t.recepcao = x; });
    cy.tokenDe(USUARIOS.audit).then((x) => { t.audit = x; });
    cy.tokenDe(USUARIOS.alunoA1).then((x) => { t.a1 = x; });
    cy.tokenDe(USUARIOS.alunoA2).then((x) => { t.a2 = x; });
    cy.tokenDe(USUARIOS.alunoB).then((x) => { t.b = x; });

    cy.then(() => criarVaga(t.coord, { horario_inicio: '14:00', horario_fim: '16:30', data: dataSP(12) })).then((v) => {
      ag.vaga = v;
      agendar(t.a1, v.id).then((r) => {
        expect(r.status, JSON.stringify(r.body)).to.eq(200);
        ag.id = r.body.agendamento.id;
      });
    });
  });

  it('o aluno vê o comprovante do próprio agendamento com todos os campos', () => {
    const antes = Date.now();
    comprovante(t.a1, ag.id).then((r) => {
      expect(r.status, JSON.stringify(r.body)).to.eq(200);
      expect(r.body.sucesso).to.eq(true);
      const c = r.body.comprovante;
      expect(c).to.deep.include({
        codigo: codigoDe(ag.id),
        agendamento_id: ag.id,
        aluno_nome: USUARIOS.alunoA1.nome,
        matricula: USUARIOS.alunoA1.matricula,
        disciplina: ag.vaga.disciplina,
        curso: CURSO_A,
        polo: 'Polo CY',
        data_prova: ag.vaga.data,
        horario_inicio: '14:00',
        horario_fim: '16:30',
        situacao: 'ATIVO',
        fuso: FUSO
      });
      expect(c.codigo).to.match(/^AG-\d{6,}$/);

      // hora de emissão do servidor, em UTC (ISO) e no fuso de São Paulo
      const emitido = Date.parse(c.emitido_em);
      expect(emitido).to.be.within(antes - 5 * 60000, Date.now() + 5 * 60000);
      expect(c.emitido_em_local).to.match(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/);
      expect(c.emitido_em_local).to.eq(emSP(c.emitido_em));
    });
  });

  it('a hora de emissão vem do servidor: parâmetros enviados pelo cliente são ignorados', () => {
    cy.api('GET', `/api/agendamentos/${ag.id}/comprovante?emitido_em=2000-01-01T00:00:00Z&aluno_nome=Outro`, { token: t.a1 }).then((r) => {
      expect(r.status).to.eq(200);
      expect(r.body.comprovante.emitido_em.startsWith('2000')).to.eq(false);
      expect(r.body.comprovante.aluno_nome).to.eq(USUARIOS.alunoA1.nome);
    });
  });

  it('cada consulta grava exatamente um COMPROVANTE_EMITIDO na auditoria (quem, IP e id)', () => {
    logsDoComprovante(ag.id).then((antes) => {
      comprovante(t.a1, ag.id).its('status').should('eq', 200);
      logsDoComprovante(ag.id).then((depois) => {
        expect(depois.length).to.eq(antes.length + 1);
        const log = depois[depois.length - 1];
        expect(log.usuario).to.eq(USUARIOS.alunoA1.nome);
        expect(log.ip, 'IP registrado').to.be.a('string').and.not.be.empty;
        expect(log.descricao).to.contain(codigoDe(ag.id));
        expect(log.descricao).to.contain(`agendamento ${ag.id} `);
        expect(log.descricao).to.contain(USUARIOS.alunoA1.matricula);
      });
    });
  });

  it('o registro aparece no filtro da auditoria pela ação COMPROVANTE_EMITIDO', () => {
    comprovante(t.a1, ag.id).its('status').should('eq', 200);
    cy.api('GET', `/api/auditoria?acao=COMPROVANTE_EMITIDO&busca=${codigoDe(ag.id)}`, { token: t.coord }).then((r) => {
      expect(r.status).to.eq(200);
      expect(r.body.logs.length).to.be.at.least(1);
      r.body.logs.forEach((l) => expect(l.acao).to.eq('COMPROVANTE_EMITIDO'));
    });
  });

  describe('o aluno não vê o que não é dele', () => {
    let resposta404;

    before(() => {
      comprovante(t.a1, 2147483647).then((r) => { resposta404 = r; });
    });

    it('id inexistente: 404 com mensagem genérica', () => {
      expect(resposta404.status).to.eq(404);
      expect(resposta404.body).to.deep.equal({ sucesso: false, mensagem: 'Comprovante não encontrado.' });
    });

    it('id 0 (válido, mas inexistente): 404', () => {
      comprovante(t.a1, 0).then((r) => {
        expect(r.status).to.eq(404);
        expect(r.body).to.deep.equal(resposta404.body);
      });
    });

    it('aluno do mesmo curso (A2) recebe para o agendamento do A1 a MESMA resposta de um id inexistente', () => {
      comprovante(t.a2, ag.id).then((r) => {
        expect(r.status).to.eq(404);
        expect(r.body).to.deep.equal(resposta404.body);
        expect(JSON.stringify(r.body)).not.to.contain(USUARIOS.alunoA1.nome);
      });
    });

    it('aluno de outro curso (B) também recebe 404 para o agendamento do A1', () => {
      comprovante(t.b, ag.id).then((r) => {
        expect(r.status).to.eq(404);
        expect(r.body).to.deep.equal(resposta404.body);
      });
    });

    it('nenhuma dessas tentativas grava COMPROVANTE_EMITIDO', () => {
      logsDoComprovante(ag.id).then((antes) => {
        comprovante(t.a2, ag.id).its('status').should('eq', 404);
        comprovante(t.b, ag.id).its('status').should('eq', 404);
        comprovante(t.coord, ag.id).its('status').should('eq', 403);
        logsDoComprovante(ag.id).its('length').should('eq', antes.length);
      });
    });

    it('agendamento cancelado: 404 (o comprovante só vale para agendamento ATIVO)', () => {
      criarVaga(t.coord).then((v) => {
        agendar(t.a1, v.id).then((r) => {
          expect(r.status).to.eq(200);
          const id = r.body.agendamento.id;
          comprovante(t.a1, id).its('status').should('eq', 200);
          cy.api('POST', '/api/cancelar-agendamento', { token: t.a1, body: { agendamento_id: id } }).its('status').should('eq', 200);
          comprovante(t.a1, id).then((c) => {
            expect(c.status).to.eq(404);
            expect(c.body).to.deep.equal(resposta404.body);
          });
        });
      });
    });

    it('reagendamento: o id antigo deixa de ter comprovante e o novo id tem, com os dados do novo horário', () => {
      const disciplina = `CY-comp-${Date.now()}`;
      criarVaga(t.coord, { disciplina, data: dataSP(10) }).then((v1) => {
        criarVaga(t.coord, { disciplina, data: dataSP(11), horario_inicio: '19:00', horario_fim: '21:00', polo: 'Polo CY 2' }).then((v2) => {
          agendar(t.a1, v1.id).then((r1) => {
            const antigo = r1.body.agendamento.id;
            cy.api('POST', '/api/reagendar', { token: t.a1, body: { agendamento_id: antigo, nova_vaga_id: v2.id } }).then((r2) => {
              expect(r2.status, JSON.stringify(r2.body)).to.eq(200);
              const novo = r2.body.agendamento.id;
              comprovante(t.a1, antigo).its('status').should('eq', 404);
              comprovante(t.a1, novo).then((c) => {
                expect(c.status).to.eq(200);
                expect(c.body.comprovante).to.deep.include({
                  codigo: codigoDe(novo), data_prova: v2.data, horario_inicio: '19:00', horario_fim: '21:00', polo: 'Polo CY 2', situacao: 'ATIVO'
                });
              });
            });
          });
        });
      });
    });
  });

  describe('id inválido: 400', () => {
    ['-1', 'abc', '1.5', '1e2', '12abc', '99999999999', '%20'].forEach((id) => {
      it(`"${id}"`, () => {
        comprovante(t.a1, id).then((r) => {
          expect(r.status, JSON.stringify(r.body)).to.eq(400);
          expect(r.body).to.deep.equal({ sucesso: false, mensagem: 'Agendamento inválido.' });
        });
      });
    });
  });

  describe('outros perfis: 403 (permissão conferida antes da validação do id)', () => {
    ['coord', 'recepcao', 'audit'].forEach((perfil) => {
      it(`${perfil}: 403 com id válido e com id inválido`, () => {
        comprovante(t[perfil], ag.id).then((r) => {
          expect(r.status).to.eq(403);
          expect(r.body.mensagem).to.contain('não tem permissão');
          expect(JSON.stringify(r.body)).not.to.contain(USUARIOS.alunoA1.nome);
        });
        comprovante(t[perfil], 'abc').its('status').should('eq', 403);
      });
    });

    it('sem token: 401', () => {
      comprovante(null, ag.id).its('status').should('eq', 401);
    });
  });
});
