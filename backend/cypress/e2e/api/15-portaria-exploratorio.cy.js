import { USUARIOS } from '../../support/dados';
import { criarUsuarioAtivo, inserirVagaNoBanco } from '../../support/apiHelpers';
import { dataSP, hojeSP, vagaEmAndamento, vagaHojeNoFuturo, vagaHojeTerminada } from '../../support/datas';

const unico = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const POLO = 'Polo CY P15';

// Correções encontradas nos testes exploratórios da RECEPÇÃO:
// A2 entrada só até o término da prova; A1 consulta mostra todas as provas do dia; A5 data absurda em por-data;
// A6 ticket de outro polo recebe sempre a mesma resposta
describe('API: portaria (correções dos testes exploratórios)', () => {
  const t = {};

  before(() => {
    cy.task('prepararBanco');
    cy.tokenDe(USUARIOS.coord).then((x) => { t.coord = x; });
    cy.tokenDe(USUARIOS.recepcao).then((x) => { t.recepcao = x; });
  });

  // a recepção de teste volta a enxergar todos os polos depois de cada teste
  afterEach(() => cy.bd('UPDATE usuarios SET polo = NULL WHERE matricula = $1', [USUARIOS.recepcao.matricula]));

  const consultar = (busca) => cy.api('GET', `/api/portaria/consultar?busca=${encodeURIComponent(busca)}`, { token: t.recepcao });
  const porData = (d) => cy.api('GET', `/api/portaria/por-data?data=${encodeURIComponent(d)}`, { token: t.recepcao });
  const confirmar = (ticket) => cy.api('POST', '/api/portaria/confirmar-entrada', { token: t.recepcao, body: { ticket_id: ticket } });
  const poloDaRecepcao = (polo) => cy.bd('UPDATE usuarios SET polo = $2 WHERE matricula = $1', [USUARIOS.recepcao.matricula, polo]);

  // agendamento ATIVO direto no banco de teste (a API não deixa agendar prova de hoje que já começou)
  function agendamentoEm(aluno, { data, inicio, fim, polo = POLO, entrada = false }) {
    return inserirVagaNoBanco({ disciplina: `CY-p15-${unico()}`, data, inicio, fim, polo }).then((vagaId) =>
      cy.bd(
        `INSERT INTO agendamentos (vaga_id, usuario_id, aluno_nome, data_agendada, horario_agendado, status,
                                   entrada_confirmada_em, entrada_confirmada_por)
         VALUES ($1, $2, $3, $4, $5, 'ATIVO', ${entrada ? `NOW(), 'CY Portaria'` : 'NULL, NULL'}) RETURNING id`,
        [vagaId, aluno.id, aluno.nome, data, inicio]
      ).then((rows) => rows[0].id)
    );
  }

  const semEntrada = (ticket) =>
    cy.bd('SELECT entrada_confirmada_em FROM agendamentos WHERE id = $1', [ticket])
      .then((rows) => expect(rows[0].entrada_confirmada_em, 'nada gravado').to.be.null);

  describe('A2: confirmar entrada só até o término da prova', () => {
    it('depois do término: 400 com o horário de término e nada é gravado (nem na auditoria)', function () {
      const v = vagaHojeTerminada();
      if (!v) this.skip(); // antes das 00:10 não existe prova de hoje já terminada
      criarUsuarioAtivo(t.coord).then((aluno) => {
        agendamentoEm(aluno, v).then((ticket) => {
          confirmar(ticket).then((r) => {
            expect(r.status, JSON.stringify(r.body)).to.eq(400);
            expect(r.body.sucesso).to.eq(false);
            expect(r.body.mensagem).to.eq(`O horário desta prova já terminou às ${v.fim}. A entrada não pode mais ser confirmada.`);
          });
          semEntrada(ticket);
          cy.bd(`SELECT COUNT(*)::int AS n FROM auditoria WHERE acao = 'CONFIRMACAO_ENTRADA' AND descricao LIKE $1`, [`%(Ticket #${ticket})%`])
            .then((rows) => expect(rows[0].n).to.eq(0));
        });
      });
    });

    it('antes do início (aluno chegou cedo): 200', function () {
      const v = vagaHojeNoFuturo();
      if (!v) this.skip(); // a partir das 23:50 não há prova de hoje ainda por começar
      criarUsuarioAtivo(t.coord).then((aluno) => {
        agendamentoEm(aluno, v).then((ticket) => {
          confirmar(ticket).then((r) => {
            expect(r.status, JSON.stringify(r.body)).to.eq(200);
            expect(r.body.sucesso).to.eq(true);
          });
          cy.bd('SELECT entrada_confirmada_em IS NOT NULL AS ok FROM agendamentos WHERE id = $1', [ticket]).its('0.ok').should('eq', true);
        });
      });
    });

    it('durante a prova (começou e não terminou): 200 e registra na auditoria como antes', function () {
      const v = vagaEmAndamento();
      if (!v) this.skip();
      criarUsuarioAtivo(t.coord).then((aluno) => {
        agendamentoEm(aluno, v).then((ticket) => {
          confirmar(ticket).its('status').should('eq', 200);
          cy.bd(`SELECT acao, descricao, usuario FROM auditoria WHERE acao = 'CONFIRMACAO_ENTRADA' AND descricao LIKE $1`, [`%(Ticket #${ticket})%`])
            .then((rows) => {
              expect(rows).to.have.length(1);
              // texto novo: inclui matrícula, disciplina e data/hora da prova (17-auditor-exploratorio.cy.js, A4)
              cy.bd('SELECT disciplina FROM vagas v JOIN agendamentos a ON a.vaga_id = v.id WHERE a.id = $1', [ticket]).then((vg) => {
                expect(rows[0]).to.deep.eq({
                  acao: 'CONFIRMACAO_ENTRADA',
                  descricao: `Portaria confirmou entrada do aluno ${aluno.nome} (${aluno.matricula}) ` +
                    `na prova de ${vg[0].disciplina} (${v.data} ${v.inicio}) (Ticket #${ticket})`,
                  usuario: USUARIOS.recepcao.nome
                });
              });
            });
        });
      });
    });

    it('prova de outro dia continua com a mensagem do dia da prova', () => {
      criarUsuarioAtivo(t.coord).then((aluno) => {
        agendamentoEm(aluno, { data: dataSP(3), inicio: '08:00', fim: '10:00' }).then((ticket) => {
          confirmar(ticket).then((r) => {
            expect(r.status).to.eq(400);
            expect(r.body.mensagem).to.contain('no dia da prova');
          });
          semEntrada(ticket);
        });
      });
    });
  });

  describe('A1: consulta por matrícula com várias provas no dia', () => {
    it('devolve todas as provas do dia, em ordem de horário, com o momento de cada uma', function () {
      const terminada = vagaHojeTerminada();
      const andamento = vagaEmAndamento();
      const futura = vagaHojeNoFuturo();
      if (!terminada || !andamento || !futura) this.skip(); // perto da meia-noite não cabem as três no mesmo dia
      criarUsuarioAtivo(t.coord).then((aluno) => {
        const ids = {};
        // inseridas fora de ordem de propósito
        agendamentoEm(aluno, futura).then((id) => { ids.futura = id; });
        agendamentoEm(aluno, terminada).then((id) => { ids.terminada = id; });
        agendamentoEm(aluno, andamento).then((id) => { ids.andamento = id; });
        // prova de outro dia NÃO entra (só as do primeiro dia com prova)
        agendamentoEm(aluno, { data: dataSP(2), inicio: '08:00', fim: '10:00' });

        consultar(aluno.matricula).then((r) => {
          expect(r.status).to.eq(200);
          expect(r.body.encontrado).to.eq(true);
          const linhas = r.body.resultados;
          expect(linhas.map((x) => x.ticket_id)).to.deep.eq([ids.terminada, ids.andamento, ids.futura]);
          expect(linhas.map((x) => x.momento_prova)).to.deep.eq(['encerrada', 'em_andamento', 'futura']);
          linhas.forEach((x) => {
            expect(x).to.deep.include({ usuario_id: aluno.id, matricula: aluno.matricula, data_agendada: hojeSP() });
          });
        });
      });
    });

    it('sem prova hoje: mostra todas as provas do PRIMEIRO dia com prova', () => {
      criarUsuarioAtivo(t.coord).then((aluno) => {
        const ids = [];
        agendamentoEm(aluno, { data: dataSP(4), inicio: '14:00', fim: '15:00' }).then((id) => ids.push(id));
        agendamentoEm(aluno, { data: dataSP(4), inicio: '08:00', fim: '09:00' }).then((id) => ids.unshift(id));
        agendamentoEm(aluno, { data: dataSP(6), inicio: '08:00', fim: '09:00' });
        consultar(aluno.matricula).then((r) => {
          expect(r.body.resultados.map((x) => x.ticket_id)).to.deep.eq(ids);
          expect(r.body.resultados.map((x) => x.momento_prova)).to.deep.eq(['futura', 'futura']);
          expect(r.body.resultados.map((x) => x.data_agendada)).to.deep.eq([dataSP(4), dataSP(4)]);
        });
      });
    });

    it('uma só prova: continua uma linha só (comportamento de antes)', () => {
      criarUsuarioAtivo(t.coord).then((aluno) => {
        agendamentoEm(aluno, { data: dataSP(4), inicio: '08:00', fim: '09:00' }).then((ticket) => {
          consultar(aluno.matricula).then((r) => {
            expect(r.body.resultados).to.have.length(1);
            expect(r.body.resultados[0]).to.deep.include({ ticket_id: ticket, momento_prova: 'futura' });
          });
        });
      });
    });

    it('recepção de um polo só vê as provas do seu polo', () => {
      criarUsuarioAtivo(t.coord).then((aluno) => {
        agendamentoEm(aluno, { data: dataSP(4), inicio: '08:00', fim: '09:00' }).then((nossa) => {
          agendamentoEm(aluno, { data: dataSP(4), inicio: '10:00', fim: '11:00', polo: 'Outro Polo P15' });
          // a prova de outro polo, mais cedo e em outro dia, não muda qual é o "primeiro dia" deste polo
          agendamentoEm(aluno, { data: dataSP(2), inicio: '08:00', fim: '09:00', polo: 'Outro Polo P15' });
          poloDaRecepcao(POLO);
          consultar(aluno.matricula).then((r) => {
            expect(r.body.resultados.map((x) => x.ticket_id)).to.deep.eq([nossa]);
          });
        });
      });
    });
  });

  describe('A5: por-data com data fora do intervalo aceito', () => {
    it('0000-01-01 e datas antes de 1900: 400 com mensagem clara, sem detalhe do Postgres', () => {
      ['0000-01-01', '0001-01-01', '1899-12-31', '00/01/0000', '01/01/0000'].forEach((d) => {
        porData(d).then((r) => {
          expect(r.status, `"${d}": ${JSON.stringify(r.body)}`).to.eq(400);
          expect(r.body.sucesso).to.eq(false);
          expect(r.body.mensagem).to.contain('Data inválida').and.contain('01/01/1900');
          expect(r.body).to.not.have.property('detalhe');
        });
      });
    });

    it('datas válidas continuam funcionando (inclusive o limite 1900-01-01)', () => {
      ['1900-01-01', '01/01/1900', '9999-12-31', hojeSP()].forEach((d) => {
        porData(d).then((r) => {
          expect(r.status, `"${d}": ${JSON.stringify(r.body)}`).to.eq(200);
          expect(r.body.sucesso).to.eq(true);
        });
      });
    });
  });

  describe('A6: ticket de outro polo recebe sempre a mesma resposta', () => {
    it('confirmado ou não, de hoje ou de outro dia: o mesmo 404 de um ticket inexistente', () => {
      criarUsuarioAtivo(t.coord).then((aluno) => {
        const hoje = { data: hojeSP(), inicio: '00:00', fim: '23:59' };
        agendamentoEm(aluno, hoje).then((naoConfirmado) => {
          agendamentoEm(aluno, { ...hoje, entrada: true }).then((confirmado) => {
            agendamentoEm(aluno, { data: dataSP(3), inicio: '08:00', fim: '10:00' }).then((outroDia) => {
              poloDaRecepcao('Outro Polo P15');
              const respostas = [];
              [naoConfirmado, confirmado, outroDia, 999999999].forEach((ticket) => {
                confirmar(ticket).then((r) => respostas.push({ status: r.status, body: r.body }));
              });
              cy.wrap(respostas).should('have.length', 4).then(() => {
                respostas.forEach((r) => {
                  expect(r).to.deep.eq({ status: 404, body: { sucesso: false, mensagem: 'Agendamento ativo não encontrado para este polo.' } });
                });
              });
              semEntrada(naoConfirmado);
            });
          });
        });
      });
    });

    it('no próprio polo continua informando "já confirmada" (409)', () => {
      criarUsuarioAtivo(t.coord).then((aluno) => {
        agendamentoEm(aluno, { data: hojeSP(), inicio: '00:00', fim: '23:59', entrada: true }).then((ticket) => {
          poloDaRecepcao(POLO);
          confirmar(ticket).then((r) => {
            expect(r.status).to.eq(409);
            expect(r.body.mensagem).to.contain('já foi confirmada');
          });
        });
      });
    });
  });
});
