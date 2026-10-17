import { USUARIOS } from '../../support/dados';
import { criarVaga, criarUsuarioAtivo, agendar, inserirVagaNoBanco } from '../../support/apiHelpers';
import { dataSP, vagaEmHoras, vagaEmAndamento, vagaHojeTerminada } from '../../support/datas';

const unico = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

// Agendamento ATIVO cuja prova já TERMINOU (regra nova: vale o horário de término, não o de início) deixa
// de ser pendente. Se o aluno faltou (sem entrada confirmada pela portaria) a disciplina fica livre para
// outro horário; se a entrada foi confirmada, continua bloqueada. Prova em andamento continua PENDENTE.
describe('API: agendamento com a prova já passada', () => {
  const t = {};

  before(() => {
    cy.task('prepararBanco');
    cy.tokenDe(USUARIOS.coord).then((x) => { t.coord = x; });
  });

  const cancelar = (token, id) => cy.api('POST', '/api/cancelar-agendamento', { token, body: { agendamento_id: id } });
  const reagendar = (token, id, novaVagaId) =>
    cy.api('POST', '/api/reagendar', { token, body: { agendamento_id: id, nova_vaga_id: novaVagaId } });
  const meus = (token) => cy.api('GET', '/api/meus-agendamentos', { token }).then((r) => {
    expect(r.status, JSON.stringify(r.body)).to.eq(200);
    return r.body;
  });

  // aluno novo + vaga futura da disciplina (pela API) + vaga com a prova no passado (direto no banco de teste,
  // a API não deixa criar) e um agendamento ATIVO do aluno nela
  function cenario({ data = dataSP(-1), inicio = '08:00', fim = '10:00', entrada = false } = {}) {
    const disciplina = `CY-passada-${unico()}`;
    return criarUsuarioAtivo(t.coord).then((aluno) =>
      criarVaga(t.coord, { disciplina, data: dataSP(10) }).then((futura) =>
        inserirVagaNoBanco({ disciplina, data, inicio, fim }).then((idPassada) =>
          cy.bd(
            `INSERT INTO agendamentos (vaga_id, usuario_id, aluno_nome, data_agendada, horario_agendado, status,
                                       entrada_confirmada_em, entrada_confirmada_por)
             VALUES ($1, $2, $3, $4, $5, 'ATIVO', ${entrada ? `NOW() - INTERVAL '1 hour', 'CY Portaria'` : 'NULL, NULL'})
             RETURNING id`,
            [idPassada, aluno.id, aluno.nome, data, inicio]
          ).then((rows) => ({ aluno, futura, idPassada, agPassado: rows[0].id, disciplina }))
        )
      )
    );
  }

  const registroIntacto = (id, entrada) =>
    cy.bd('SELECT status, entrada_confirmada_em IS NOT NULL AS entrou FROM agendamentos WHERE id = $1', [id])
      .then((rows) => expect(rows[0]).to.deep.eq({ status: 'ATIVO', entrou: entrada }));

  it('prova passada sem entrada: aparece como ENCERRADA e a disciplina fica livre para outro horário', () => {
    cenario().then(({ aluno, futura, agPassado }) => {
      meus(aluno.token).then((lista) => {
        expect(lista.find((a) => a.id === agPassado)).to.include({ situacao: 'ENCERRADA', entrada_confirmada: false });
      });

      agendar(aluno.token, futura.id).then((r) => {
        expect(r.status, JSON.stringify(r.body)).to.eq(200);
        const novo = r.body.agendamento.id;
        meus(aluno.token).then((lista) => {
          expect(lista.find((a) => a.id === novo)).to.include({ situacao: 'PENDENTE', vaga_id: futura.id });
          expect(lista.find((a) => a.id === agPassado)).to.include({ situacao: 'ENCERRADA' });
        });
      });

      // soft delete: o registro antigo não é apagado nem alterado
      registroIntacto(agPassado, false);
    });
  });

  it('prova passada sem entrada: cancelar e reagendar continuam bloqueados com mensagem clara', () => {
    cenario().then(({ aluno, futura, agPassado, disciplina }) => {
      cancelar(aluno.token, agPassado).then((r) => {
        expect(r.status, JSON.stringify(r.body)).to.eq(400);
        expect(r.body.mensagem).to.contain('Ação Bloqueada').and.contain('já começou ou já passou');
      });
      reagendar(aluno.token, agPassado, futura.id).then((r) => {
        expect(r.status, JSON.stringify(r.body)).to.eq(400);
        expect(r.body.mensagem).to.contain('Ação Bloqueada').and.contain('já começou ou já passou');
      });
      registroIntacto(agPassado, false);
      cy.bd(`SELECT COUNT(*)::int AS n FROM agendamentos WHERE vaga_id = $1`, [futura.id]).then((rows) => expect(rows[0].n).to.eq(0));
      cy.bd(`SELECT acao FROM auditoria WHERE descricao LIKE $1 ORDER BY id`, [`%${disciplina}%pelo aluno ${aluno.nome}`]).then((rows) => {
        expect(rows.map((x) => x.acao)).to.deep.eq(['CANCELAMENTO_BLOQUEADO', 'REAGENDAMENTO_BLOQUEADO']);
      });
    });
  });

  it('prova passada com entrada confirmada: aparece como REALIZADA e a disciplina continua bloqueada', () => {
    cenario({ entrada: true }).then(({ aluno, futura, agPassado }) => {
      meus(aluno.token).then((lista) => {
        expect(lista.find((a) => a.id === agPassado)).to.include({ situacao: 'REALIZADA', entrada_confirmada: true });
      });
      agendar(aluno.token, futura.id).then((r) => {
        expect(r.status, JSON.stringify(r.body)).to.eq(409);
        expect(r.body.mensagem).to.contain('já tem um agendamento ativo');
      });
      cancelar(aluno.token, agPassado).then((r) => {
        expect(r.status).to.eq(400);
        expect(r.body.mensagem).to.contain('entrada');
      });
      reagendar(aluno.token, agPassado, futura.id).then((r) => {
        expect(r.status).to.eq(400);
        expect(r.body.mensagem).to.contain('entrada');
      });
      registroIntacto(agPassado, true);
    });
  });

  // Antes este teste usava uma prova que tinha COMEÇADO há 2h (critério antigo: o início). Com a regra nova
  // o que conta é o término: a prova abaixo terminou hoje, há 5 minutos (fuso de São Paulo)
  it('prova de HOJE que já TERMINOU sem entrada: ENCERRADA e libera outro horário da disciplina', function () {
    const v = vagaHojeTerminada();
    if (!v) this.skip(); // antes das 00:10 não existe prova de hoje já terminada
    cenario(v).then(({ aluno, futura, agPassado }) => {
      meus(aluno.token).then((lista) => expect(lista.find((a) => a.id === agPassado)).to.include({ situacao: 'ENCERRADA' }));
      agendar(aluno.token, futura.id).its('status').should('eq', 200);
      registroIntacto(agPassado, false);
    });
  });

  it('prova de HOJE em andamento (começou, não terminou) sem entrada: continua PENDENTE e trava a disciplina', function () {
    const v = vagaEmAndamento();
    if (!v) this.skip(); // perto da meia-noite não há folga para uma prova em andamento no mesmo dia
    cenario(v).then(({ aluno, futura, agPassado }) => {
      meus(aluno.token).then((lista) => expect(lista.find((a) => a.id === agPassado)).to.include({ situacao: 'PENDENTE', entrada_confirmada: false }));
      agendar(aluno.token, futura.id).then((r) => {
        expect(r.status, JSON.stringify(r.body)).to.eq(409);
        expect(r.body.mensagem).to.contain('já tem um agendamento ativo');
      });
      // os bloqueios por "já começou" continuam como estavam
      cancelar(aluno.token, agPassado).then((r) => {
        expect(r.status, JSON.stringify(r.body)).to.eq(400);
        expect(r.body.mensagem).to.contain('já começou ou já passou');
      });
      reagendar(aluno.token, agPassado, futura.id).then((r) => {
        expect(r.status, JSON.stringify(r.body)).to.eq(400);
        expect(r.body.mensagem).to.contain('já começou ou já passou');
      });
      registroIntacto(agPassado, false);
    });
  });

  it('prova de HOJE em andamento com entrada confirmada: REALIZADA e a disciplina continua bloqueada', function () {
    const v = vagaEmAndamento();
    if (!v) this.skip();
    cenario({ ...v, entrada: true }).then(({ aluno, futura, agPassado }) => {
      meus(aluno.token).then((lista) => expect(lista.find((a) => a.id === agPassado)).to.include({ situacao: 'REALIZADA', entrada_confirmada: true }));
      agendar(aluno.token, futura.id).its('status').should('eq', 409);
    });
  });

  it('entrada confirmada ANTES do início: continua PENDENTE (com entrada_confirmada) e a disciplina fica bloqueada', () => {
    const { data, inicio, fim } = vagaEmHoras(2);
    cenario({ data, inicio, fim, entrada: true }).then(({ aluno, futura, agPassado }) => {
      meus(aluno.token).then((lista) => expect(lista.find((a) => a.id === agPassado)).to.include({ situacao: 'PENDENTE', entrada_confirmada: true }));
      agendar(aluno.token, futura.id).its('status').should('eq', 409);
      cancelar(aluno.token, agPassado).then((r) => {
        expect(r.status).to.eq(400);
        expect(r.body.mensagem).to.contain('entrada');
      });
      reagendar(aluno.token, agPassado, futura.id).then((r) => {
        expect(r.status).to.eq(400);
        expect(r.body.mensagem).to.contain('entrada');
      });
      registroIntacto(agPassado, true);
    });
  });

  it('prova futura continua igual: PENDENTE e bloqueia outro horário da mesma disciplina', () => {
    const disciplina = `CY-futura-${unico()}`;
    criarUsuarioAtivo(t.coord).then((aluno) => {
      criarVaga(t.coord, { disciplina, data: dataSP(10) }).then((v1) => {
        criarVaga(t.coord, { disciplina, data: dataSP(11) }).then((v2) => {
          agendar(aluno.token, v1.id).then((r) => {
            expect(r.status, JSON.stringify(r.body)).to.eq(200);
            const id = r.body.agendamento.id;
            meus(aluno.token).then((lista) => expect(lista.find((a) => a.id === id)).to.include({ situacao: 'PENDENTE', entrada_confirmada: false }));
            agendar(aluno.token, v2.id).then((d) => {
              expect(d.status).to.eq(409);
              expect(d.body.mensagem).to.contain('já tem um agendamento ativo');
            });
          });
        });
      });
    });
  });

  it('prova de hoje que ainda não começou é PENDENTE', () => {
    const { data, inicio, fim } = vagaEmHoras(2);
    cenario({ data, inicio, fim }).then(({ aluno, futura, agPassado }) => {
      meus(aluno.token).then((lista) => expect(lista.find((a) => a.id === agPassado)).to.include({ situacao: 'PENDENTE' }));
      agendar(aluno.token, futura.id).its('status').should('eq', 409);
    });
  });
});
