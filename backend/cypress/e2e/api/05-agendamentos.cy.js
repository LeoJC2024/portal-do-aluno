import { USUARIOS, API_URL } from '../../support/dados';
import { criarVaga, agendar, inserirVagaNoBanco, vagasRestantes, logsDeAuditoria } from '../../support/apiHelpers';
import { dataSP, hojeSP, vagaEmHoras } from '../../support/datas';

const unico = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

describe('API: agendamento de provas', () => {
  const t = {};

  before(() => {
    cy.task('prepararBanco');
    cy.tokenDe(USUARIOS.coord).then((x) => { t.coord = x; });
    cy.tokenDe(USUARIOS.alunoA1).then((x) => { t.a1 = x; });
    cy.tokenDe(USUARIOS.alunoA2).then((x) => { t.a2 = x; });
    cy.tokenDe(USUARIOS.alunoB).then((x) => { t.b = x; });
  });

  const cancelar = (token, id) => cy.api('POST', '/api/cancelar-agendamento', { token, body: { agendamento_id: id } });

  describe('agendar', () => {
    it('agenda, aparece em "meus agendamentos", consome uma vaga e vai para a auditoria', () => {
      criarVaga(t.coord, { limite_vagas: 4, horario_inicio: '14:00', horario_fim: '16:30' }).then((v) => {
        agendar(t.a1, v.id).then((r) => {
          expect(r.status, JSON.stringify(r.body)).to.eq(200);
          expect(r.body.sucesso).to.eq(true);
          expect(r.body.agendamento).to.include({ vaga_id: v.id, data_agendada: v.data, horario_agendado: '14:00:00' });
        });
        cy.api('GET', '/api/meus-agendamentos', { token: t.a1 }).then((r) => {
          const ag = r.body.find((a) => a.vaga_id === v.id);
          expect(ag).to.deep.include({ disciplina: v.disciplina, polo: 'Polo CY', horario_fim: '16:30:00', data_agendada: v.data });
        });
        vagasRestantes(t.a1, v.id).should('eq', 3);
        logsDeAuditoria(t.coord).then((logs) => {
          const log = logs.find((l) => l.acao === 'AGENDAMENTO_REALIZADO' && l.descricao.includes(v.disciplina));
          expect(log, 'log do agendamento').to.exist;
          expect(log.usuario).to.eq(USUARIOS.alunoA1.nome);
        });
      });
    });

    it('um aluno não vê os agendamentos do outro', () => {
      criarVaga(t.coord).then((v) => {
        agendar(t.a1, v.id).its('status').should('eq', 200);
        cy.api('GET', '/api/meus-agendamentos', { token: t.a2 }).then((r) => {
          expect(r.body.some((a) => a.vaga_id === v.id)).to.eq(false);
        });
      });
    });

    it('a mesma vaga duas vezes: 409', () => {
      criarVaga(t.coord).then((v) => {
        agendar(t.a1, v.id).its('status').should('eq', 200);
        agendar(t.a1, v.id).then((r) => {
          expect(r.status).to.eq(409);
          expect(r.body.mensagem).to.contain('já tem um agendamento ativo');
        });
        cy.bd(`SELECT COUNT(*)::int AS n FROM agendamentos WHERE vaga_id = $1 AND status = 'ATIVO'`, [v.id]).then((rows) => expect(rows[0].n).to.eq(1));
      });
    });

    it('outra vaga da MESMA avaliação (disciplina): 409', () => {
      const disciplina = `CY-mesma-${unico()}`;
      criarVaga(t.coord, { disciplina, data: dataSP(10) }).then((v1) => {
        criarVaga(t.coord, { disciplina, data: dataSP(11) }).then((v2) => {
          agendar(t.a1, v1.id).its('status').should('eq', 200);
          agendar(t.a1, v2.id).then((r) => {
            expect(r.status).to.eq(409);
            expect(r.body.mensagem).to.contain('já tem um agendamento ativo');
          });
        });
      });
    });

    it('respeita o limite de vagas: a última vaga vai para quem chegou primeiro', () => {
      criarVaga(t.coord, { limite_vagas: 1 }).then((v) => {
        agendar(t.a1, v.id).its('status').should('eq', 200);
        agendar(t.a2, v.id).then((r) => {
          expect(r.status).to.eq(409);
          expect(r.body.mensagem).to.contain('Não há mais vagas');
        });
        vagasRestantes(t.a1, v.id).should('eq', 0);
      });
    });

    it('aluno de outro curso não agenda (403) e nada é gravado', () => {
      criarVaga(t.coord).then((v) => {
        agendar(t.b, v.id).then((r) => {
          expect(r.status).to.eq(403);
          expect(r.body.mensagem).to.contain('não é do seu curso');
        });
        cy.bd('SELECT COUNT(*)::int AS n FROM agendamentos WHERE vaga_id = $1', [v.id]).then((rows) => expect(rows[0].n).to.eq(0));
      });
    });

    it('vaga antiga (sem curso) pode ser agendada por qualquer curso', () => {
      inserirVagaNoBanco({ curso: null, disciplina: `CY-antiga-${unico()}`, data: dataSP(9) }).then((id) => {
        agendar(t.a1, id).its('status').should('eq', 200);
        agendar(t.b, id).its('status').should('eq', 200);
      });
    });

    it('prova que já passou: 400', () => {
      inserirVagaNoBanco({ disciplina: `CY-passada-${unico()}`, data: dataSP(-1) }).then((id) => {
        agendar(t.a1, id).then((r) => {
          expect(r.status).to.eq(400);
          expect(r.body.mensagem).to.contain('já ocorreu');
        });
      });
    });

    it('vaga inválida: 400; inexistente: 404', () => {
      cy.api('POST', '/api/agendar', { token: t.a1, body: {} }).its('status').should('eq', 400);
      cy.api('POST', '/api/agendar', { token: t.a1, body: { vaga_id: 'abc' } }).its('status').should('eq', 400);
      agendar(t.a1, 999999999).its('status').should('eq', 404);
    });

    it('a data e o horário vêm da vaga, não do que o aluno mandar', () => {
      criarVaga(t.coord, { horario_inicio: '07:15', horario_fim: '09:00' }).then((v) => {
        cy.api('POST', '/api/agendar', {
          token: t.a1, body: { vaga_id: v.id, data_agendada: '1999-01-01', horario_agendado: '23:59', aluno_nome: 'Outro Nome', usuario_id: 1 }
        }).then((r) => {
          expect(r.status).to.eq(200);
          expect(r.body.agendamento).to.include({ data_agendada: v.data, horario_agendado: '07:15:00' });
        });
        cy.bd('SELECT aluno_nome, usuario_id FROM agendamentos WHERE vaga_id = $1', [v.id]).then((rows) => {
          expect(rows[0].aluno_nome).to.eq(USUARIOS.alunoA1.nome);
        });
      });
    });
  });

  describe('concorrência', () => {
    const url = () => `${API_URL}/api/agendar`;
    const chamada = (token, vagaId) => ({ method: 'POST', url: url(), headers: { Authorization: `Bearer ${token}` }, body: { vaga_id: vagaId } });

    it('duas pessoas disputando a última vaga ao mesmo tempo: só uma consegue', () => {
      criarVaga(t.coord, { limite_vagas: 1 }).then((v) => {
        cy.task('paralelo', [chamada(t.a1, v.id), chamada(t.a2, v.id)]).then((rs) => {
          expect(rs.map((r) => r.status).sort(), JSON.stringify(rs)).to.deep.eq([200, 409]);
        });
        cy.bd(`SELECT COUNT(*)::int AS n FROM agendamentos WHERE vaga_id = $1 AND status = 'ATIVO'`, [v.id]).then((rows) => expect(rows[0].n).to.eq(1));
      });
    });

    it('clique duplo do mesmo aluno: só um agendamento é criado', () => {
      criarVaga(t.coord, { limite_vagas: 10 }).then((v) => {
        cy.task('paralelo', [chamada(t.a1, v.id), chamada(t.a1, v.id), chamada(t.a1, v.id)]).then((rs) => {
          expect(rs.filter((r) => r.status === 200)).to.have.length(1);
          rs.filter((r) => r.status !== 200).forEach((r) => expect(r.status).to.eq(409));
        });
        cy.bd(`SELECT COUNT(*)::int AS n FROM agendamentos WHERE vaga_id = $1 AND status = 'ATIVO'`, [v.id]).then((rows) => expect(rows[0].n).to.eq(1));
      });
    });
  });

  describe('cancelamento', () => {
    it('com mais de 24h de antecedência: cancela, libera a vaga e dá para agendar de novo', () => {
      criarVaga(t.coord, { limite_vagas: 2, data: dataSP(10) }).then((v) => {
        agendar(t.a1, v.id).then((r) => {
          const id = r.body.agendamento.id;
          vagasRestantes(t.a1, v.id).should('eq', 1);

          cancelar(t.a1, id).then((c) => {
            expect(c.status, JSON.stringify(c.body)).to.eq(200);
            expect(c.body.mensagem).to.contain('cancelado');
          });
          cy.bd('SELECT status FROM agendamentos WHERE id = $1', [id]).then((rows) => expect(rows[0].status).to.eq('INATIVO'));
          cy.api('GET', '/api/meus-agendamentos', { token: t.a1 }).then((m) => expect(m.body.some((a) => a.id === id)).to.eq(false));
          vagasRestantes(t.a1, v.id).should('eq', 2);
          logsDeAuditoria(t.coord).then((logs) => {
            expect(logs.some((l) => l.acao === 'CANCELAMENTO_REALIZADO' && l.usuario === USUARIOS.alunoA1.nome)).to.eq(true);
          });

          agendar(t.a1, v.id).its('status').should('eq', 200);
        });
      });
    });

    it('com menos de 24h: bloqueia, mantém o agendamento e registra CANCELAMENTO_BLOQUEADO', () => {
      const { data, inicio, fim } = vagaEmHoras(2);
      criarVaga(t.coord, { data, horario_inicio: inicio, horario_fim: fim }).then((v) => {
        agendar(t.a1, v.id).then((r) => {
          expect(r.status, JSON.stringify(r.body)).to.eq(200);
          const id = r.body.agendamento.id;

          cancelar(t.a1, id).then((c) => {
            expect(c.status).to.eq(400);
            expect(c.body.mensagem).to.contain('Ação Bloqueada');
          });
          cancelar(t.a1, id).its('status').should('eq', 400); // continua bloqueado
          cy.bd('SELECT status FROM agendamentos WHERE id = $1', [id]).then((rows) => expect(rows[0].status).to.eq('ATIVO'));
          logsDeAuditoria(t.coord).then((logs) => {
            const log = logs.find((l) => l.acao === 'CANCELAMENTO_BLOQUEADO' && l.descricao.includes(v.disciplina));
            expect(log, 'log do bloqueio').to.exist;
            expect(log.usuario).to.eq(USUARIOS.alunoA1.nome);
          });
        });
      });
    });

    it('um aluno não consegue cancelar o agendamento de outro (404)', () => {
      criarVaga(t.coord).then((v) => {
        agendar(t.a1, v.id).then((r) => {
          const id = r.body.agendamento.id;
          cancelar(t.a2, id).its('status').should('eq', 404);
          cy.bd('SELECT status FROM agendamentos WHERE id = $1', [id]).then((rows) => expect(rows[0].status).to.eq('ATIVO'));
        });
      });
    });

    it('id inválido: 400; inexistente: 404; cancelar duas vezes: 404 na segunda', () => {
      cy.api('POST', '/api/cancelar-agendamento', { token: t.a1, body: {} }).its('status').should('eq', 400);
      cancelar(t.a1, 'abc').its('status').should('eq', 400);
      cancelar(t.a1, 999999999).its('status').should('eq', 404);

      criarVaga(t.coord).then((v) => {
        agendar(t.a1, v.id).then((r) => {
          const id = r.body.agendamento.id;
          cancelar(t.a1, id).its('status').should('eq', 200);
          cancelar(t.a1, id).its('status').should('eq', 404);
        });
      });
    });
  });
});

describe('API: agendar dentro do período', () => {
  const t = {};

  before(() => {
    cy.task('prepararBanco');
    cy.tokenDe(USUARIOS.coord).then((x) => { t.coord = x; });
    cy.tokenDe(USUARIOS.alunoA1).then((x) => { t.a1 = x; });
  });

  it('antes do início do período: 400 com a data de abertura e nada é gravado', () => {
    criarVaga(t.coord, { agendamento_inicio: dataSP(3), agendamento_fim: dataSP(6) }).then((v) => {
      agendar(t.a1, v.id).then((r) => {
        expect(r.status).to.eq(400);
        expect(r.body.mensagem).to.contain(`abre em ${dataSP(3).split('-').reverse().join('/')}`);
      });
      cy.bd('SELECT COUNT(*)::int AS n FROM agendamentos WHERE vaga_id = $1', [v.id]).then((rows) => expect(rows[0].n).to.eq(0));
    });
  });

  it('dentro do período: agenda normalmente', () => {
    criarVaga(t.coord, { agendamento_inicio: hojeSP(), agendamento_fim: dataSP(5) }).then((v) => {
      agendar(t.a1, v.id).its('status').should('eq', 200);
    });
  });

  it('no último dia do período ainda dá para agendar', () => {
    criarVaga(t.coord, { agendamento_inicio: hojeSP(), agendamento_fim: hojeSP() }).then((v) => {
      agendar(t.a1, v.id).its('status').should('eq', 200);
    });
  });

  it('depois do fim do período: 400 "encerrado"', () => {
    inserirVagaNoBanco({ disciplina: `CY-encerrada-${Date.now()}`, data: dataSP(10), agInicio: dataSP(-6), agFim: dataSP(-1) }).then((id) => {
      agendar(t.a1, id).then((r) => {
        expect(r.status).to.eq(400);
        expect(r.body.mensagem).to.contain('encerrado');
      });
    });
  });

  it('vaga sem período (antiga) continua sempre aberta', () => {
    criarVaga(t.coord).then((v) => {
      agendar(t.a1, v.id).its('status').should('eq', 200);
    });
  });

  it('o período não impede cancelar um agendamento já feito', () => {
    criarVaga(t.coord, { agendamento_inicio: hojeSP(), agendamento_fim: dataSP(5), data: dataSP(10) }).then((v) => {
      agendar(t.a1, v.id).then((r) => {
        cy.api('POST', '/api/cancelar-agendamento', { token: t.a1, body: { agendamento_id: r.body.agendamento.id } }).its('status').should('eq', 200);
      });
    });
  });
});

describe('API: reagendamento', () => {
  const t = {};

  before(() => {
    cy.task('prepararBanco');
    cy.tokenDe(USUARIOS.coord).then((x) => { t.coord = x; });
    cy.tokenDe(USUARIOS.alunoA1).then((x) => { t.a1 = x; });
    cy.tokenDe(USUARIOS.alunoA2).then((x) => { t.a2 = x; });
  });

  const reagendar = (token, agendamentoId, novaVagaId) =>
    cy.api('POST', '/api/reagendar', { token, body: { agendamento_id: agendamentoId, nova_vaga_id: novaVagaId } });

  // duas vagas da MESMA avaliação (disciplina), em dias diferentes
  const duasVagas = (extra1 = {}, extra2 = {}) => {
    const disciplina = `CY-reag-${unico()}`;
    return criarVaga(t.coord, { disciplina, data: dataSP(10), ...extra1 }).then((v1) =>
      criarVaga(t.coord, { disciplina, data: dataSP(11), horario_inicio: '14:00', horario_fim: '16:00', ...extra2 }).then((v2) => ({ v1, v2 })));
  };
  const agendadoEm = (token, vaga) => agendar(token, vaga.id).then((r) => {
    expect(r.status, JSON.stringify(r.body)).to.eq(200);
    return r.body.agendamento.id;
  });

  it('troca o horário: o antigo vira INATIVO, o novo fica ATIVO e as vagas se ajustam', () => {
    duasVagas({ limite_vagas: 3 }, { limite_vagas: 3 }).then(({ v1, v2 }) => {
      agendadoEm(t.a1, v1).then((agId) => {
        reagendar(t.a1, agId, v2.id).then((r) => {
          expect(r.status, JSON.stringify(r.body)).to.eq(200);
          expect(r.body.agendamento).to.include({ vaga_id: v2.id, data_agendada: v2.data, horario_agendado: '14:00:00' });
        });
        cy.bd('SELECT id, vaga_id, status FROM agendamentos WHERE usuario_id = (SELECT id FROM usuarios WHERE matricula = $1) AND vaga_id IN ($2, $3) ORDER BY id',
          [USUARIOS.alunoA1.matricula, v1.id, v2.id]).then((rows) => {
          expect(rows.map((x) => [x.vaga_id, x.status])).to.deep.eq([[v1.id, 'INATIVO'], [v2.id, 'ATIVO']]);
        });
        cy.api('GET', '/api/meus-agendamentos', { token: t.a1 }).then((m) => {
          const meus = m.body.filter((a) => a.disciplina === v1.disciplina);
          expect(meus.map((a) => a.vaga_id)).to.deep.eq([v2.id]);
        });
        vagasRestantes(t.a1, v1.id).should('eq', 3);
        vagasRestantes(t.a1, v2.id).should('eq', 2);
        logsDeAuditoria(t.coord).then((logs) => {
          const log = logs.find((l) => l.acao === 'REAGENDAMENTO_REALIZADO' && l.descricao.includes(v1.disciplina));
          expect(log, 'log do reagendamento').to.exist;
          expect(log.usuario).to.eq(USUARIOS.alunoA1.nome);
        });
      });
    });
  });

  it('dá para reagendar de volta para o horário antigo e cancelar o novo', () => {
    duasVagas().then(({ v1, v2 }) => {
      agendadoEm(t.a1, v1).then((ag1) => {
        reagendar(t.a1, ag1, v2.id).then((r) => {
          const ag2 = r.body.agendamento.id;
          reagendar(t.a1, ag2, v1.id).then((r2) => {
            expect(r2.status, JSON.stringify(r2.body)).to.eq(200);
            cy.api('POST', '/api/cancelar-agendamento', { token: t.a1, body: { agendamento_id: r2.body.agendamento.id } }).its('status').should('eq', 200);
          });
        });
      });
    });
  });

  it('com menos de 24h para a prova atual: bloqueia, registra e mantém o agendamento', () => {
    const { data, inicio, fim } = vagaEmHoras(2);
    duasVagas({ data, horario_inicio: inicio, horario_fim: fim }).then(({ v1, v2 }) => {
      agendadoEm(t.a1, v1).then((agId) => {
        reagendar(t.a1, agId, v2.id).then((r) => {
          expect(r.status).to.eq(400);
          expect(r.body.mensagem).to.contain('Ação Bloqueada');
        });
        cy.bd('SELECT status FROM agendamentos WHERE id = $1', [agId]).then((rows) => expect(rows[0].status).to.eq('ATIVO'));
        vagasRestantes(t.a1, v2.id).should('eq', 5);
        logsDeAuditoria(t.coord).then((logs) => {
          expect(logs.some((l) => l.acao === 'REAGENDAMENTO_BLOQUEADO' && l.descricao.includes(v1.disciplina))).to.eq(true);
        });
      });
    });
  });

  it('mesma vaga: 400; outra avaliação: 400', () => {
    duasVagas().then(({ v1 }) => {
      criarVaga(t.coord, { disciplina: `CY-outra-${unico()}` }).then((outra) => {
        agendadoEm(t.a1, v1).then((agId) => {
          reagendar(t.a1, agId, v1.id).then((r) => {
            expect(r.status).to.eq(400);
            expect(r.body.mensagem).to.contain('diferente');
          });
          reagendar(t.a1, agId, outra.id).then((r) => {
            expect(r.status).to.eq(400);
            expect(r.body.mensagem).to.contain('mesma avaliação');
          });
          cy.bd('SELECT status FROM agendamentos WHERE id = $1', [agId]).then((rows) => expect(rows[0].status).to.eq('ATIVO'));
        });
      });
    });
  });

  it('novo horário lotado: 409 e o agendamento antigo continua valendo', () => {
    duasVagas({}, { limite_vagas: 1 }).then(({ v1, v2 }) => {
      agendadoEm(t.a2, v2).then(() => {
        agendadoEm(t.a1, v1).then((agId) => {
          reagendar(t.a1, agId, v2.id).then((r) => {
            expect(r.status).to.eq(409);
            expect(r.body.mensagem).to.contain('Não há mais vagas');
          });
          cy.bd('SELECT status FROM agendamentos WHERE id = $1', [agId]).then((rows) => expect(rows[0].status).to.eq('ATIVO'));
        });
      });
    });
  });

  it('as mesmas regras do agendamento valem no novo horário (curso, período, prova já realizada)', () => {
    duasVagas().then(({ v1 }) => {
      agendadoEm(t.a1, v1).then((agId) => {
        criarVaga(t.coord, { disciplina: v1.disciplina, data: dataSP(12), curso: 'CY Curso B' }).then((vB) => {
          reagendar(t.a1, agId, vB.id).its('status').should('eq', 403);
        });
        // outro dia: no mesmo polo, data e horário da vB seria agenda duplicada (409)
        criarVaga(t.coord, { disciplina: v1.disciplina, data: dataSP(13), agendamento_inicio: dataSP(3), agendamento_fim: dataSP(6) }).then((vFutura) => {
          reagendar(t.a1, agId, vFutura.id).then((r) => {
            expect(r.status).to.eq(400);
            expect(r.body.mensagem).to.contain('abre em');
          });
        });
        inserirVagaNoBanco({ disciplina: v1.disciplina, data: dataSP(-1) }).then((idPassada) => {
          reagendar(t.a1, agId, idPassada).then((r) => {
            expect(r.status).to.eq(400);
            expect(r.body.mensagem).to.contain('já ocorreu');
          });
        });
        reagendar(t.a1, agId, 999999999).its('status').should('eq', 404);
        cy.bd('SELECT status FROM agendamentos WHERE id = $1', [agId]).then((rows) => expect(rows[0].status).to.eq('ATIVO'));
      });
    });
  });

  it('agendamento de outro aluno, inexistente, já cancelado ou ids inválidos', () => {
    duasVagas().then(({ v1, v2 }) => {
      agendadoEm(t.a1, v1).then((agId) => {
        reagendar(t.a2, agId, v2.id).its('status').should('eq', 404); // não é dele
        reagendar(t.a1, 999999999, v2.id).its('status').should('eq', 404);
        cy.api('POST', '/api/reagendar', { token: t.a1, body: {} }).its('status').should('eq', 400);
        cy.api('POST', '/api/reagendar', { token: t.a1, body: { agendamento_id: 'abc', nova_vaga_id: v2.id } }).its('status').should('eq', 400);
        cy.api('POST', '/api/cancelar-agendamento', { token: t.a1, body: { agendamento_id: agId } }).its('status').should('eq', 200);
        reagendar(t.a1, agId, v2.id).its('status').should('eq', 404); // já cancelado
      });
    });
  });

  it('dois reagendamentos ao mesmo tempo do mesmo agendamento: só um vale', () => {
    const disciplina = `CY-reag-${unico()}`;
    criarVaga(t.coord, { disciplina, data: dataSP(10) }).then((v1) => {
      criarVaga(t.coord, { disciplina, data: dataSP(11) }).then((v2) => {
        criarVaga(t.coord, { disciplina, data: dataSP(12) }).then((v3) => {
          agendadoEm(t.a1, v1).then((agId) => {
            const chamada = (novaVagaId) => ({
              method: 'POST', url: `${API_URL}/api/reagendar`, headers: { Authorization: `Bearer ${t.a1}` },
              body: { agendamento_id: agId, nova_vaga_id: novaVagaId }
            });
            cy.task('paralelo', [chamada(v2.id), chamada(v3.id)]).then((rs) => {
              expect(rs.map((r) => r.status).sort(), JSON.stringify(rs)).to.deep.eq([200, 404]);
            });
            cy.bd(`SELECT COUNT(*)::int AS n FROM agendamentos a JOIN vagas v ON v.id = a.vaga_id
                    WHERE v.disciplina = $1 AND a.status = 'ATIVO'`, [disciplina]).then((rows) => expect(rows[0].n).to.eq(1));
          });
        });
      });
    });
  });
});
