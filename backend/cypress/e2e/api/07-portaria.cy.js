import { USUARIOS } from '../../support/dados';
import { criarVaga, criarUsuarioAtivo, agendar, logsDeAuditoria } from '../../support/apiHelpers';
import { dataSP, dataBr, hojeSP } from '../../support/datas';

describe('API: portaria (recepção)', () => {
  const t = {};
  let vaga;
  const data = dataSP(5);

  before(() => {
    cy.task('prepararBanco');
    cy.tokenDe(USUARIOS.coord).then((x) => { t.coord = x; });
    cy.tokenDe(USUARIOS.recepcao).then((x) => { t.recepcao = x; });
    // cy.then: só roda depois que o token do coordenador já foi obtido
    cy.then(() => {
      criarVaga(t.coord, { polo: 'Polo CY Portaria', data, limite_vagas: 60, horario_inicio: '08:00', horario_fim: '10:00' }).then((v) => { vaga = v; });
    });
  });

  // a recepção de teste volta a enxergar todos os polos depois de cada teste
  afterEach(() => cy.bd(`UPDATE usuarios SET polo = NULL WHERE matricula = $1`, [USUARIOS.recepcao.matricula]));

  const novoAgendado = () =>
    criarUsuarioAtivo(t.coord).then((u) =>
      agendar(u.token, vaga.id).then((r) => {
        expect(r.status, JSON.stringify(r.body)).to.eq(200);
        return { ...u, ticket: r.body.agendamento.id, parteDoNome: u.nome.split(' ').pop() };
      })
    );

  const consultar = (busca) => cy.api('GET', `/api/portaria/consultar?busca=${encodeURIComponent(busca)}`, { token: t.recepcao });
  const porData = (d, busca) =>
    cy.api('GET', `/api/portaria/por-data?data=${encodeURIComponent(d)}${busca !== undefined ? `&busca=${encodeURIComponent(busca)}` : ''}`, { token: t.recepcao });
  const confirmar = (ticket) => cy.api('POST', '/api/portaria/confirmar-entrada', { token: t.recepcao, body: { ticket_id: ticket } });
  // a entrada só pode ser confirmada no dia da prova: traz o agendamento para hoje
  const paraHoje = (ticket) => cy.bd('UPDATE agendamentos SET data_agendada = $2 WHERE id = $1', [ticket, hojeSP()]);

  describe('consulta por aluno', () => {
    it('busca pela matrícula e devolve aluno, foto, avaliação, data, horário e local', () => {
      novoAgendado().then((a) => {
        cy.bd(`UPDATE usuarios SET foto_url = 'https://example.com/foto.jpg' WHERE id = $1`, [a.id]);
        consultar(a.matricula).then((r) => {
          expect(r.status).to.eq(200);
          expect(r.body.encontrado).to.eq(true);
          expect(r.body.resultados).to.have.length(1);
          expect(r.body.resultados[0]).to.deep.include({
            usuario_id: a.id, aluno_nome: a.nome, matricula: a.matricula, curso: a.curso,
            foto_url: 'https://example.com/foto.jpg', ticket_id: a.ticket, disciplina: vaga.disciplina,
            data_agendada: data, horario_agendado: '08:00:00', horario_fim: '10:00:00', polo: 'Polo CY Portaria',
            entrada_confirmada_em: null
          });
        });
      });
    });

    it('busca por parte do nome (sem diferenciar maiúsculas)', () => {
      novoAgendado().then((a) => {
        consultar(a.parteDoNome).then((r) => {
          expect(r.body.resultados.map((x) => x.matricula)).to.deep.eq([a.matricula]);
        });
        consultar(a.matricula.toLowerCase()).its('body.resultados.0.matricula').should('eq', a.matricula);
      });
    });

    it('menos de 3 caracteres: 400', () => {
      ['', 'ab', ' a '].forEach((busca) => {
        consultar(busca).then((r) => {
          expect(r.status, `"${busca}"`).to.eq(400);
          expect(r.body.mensagem).to.contain('ao menos 3');
        });
      });
    });

    it('aluno sem agendamento aparece sem ticket', () => {
      criarUsuarioAtivo(t.coord).then((a) => {
        consultar(a.matricula).then((r) => {
          expect(r.body.encontrado).to.eq(true);
          expect(r.body.resultados[0]).to.deep.include({ matricula: a.matricula, ticket_id: null, disciplina: null });
        });
      });
    });

    it('aluno desconhecido: encontrado = false (200)', () => {
      consultar('NINGUEM_ASSIM_123').then((r) => {
        expect(r.status).to.eq(200);
        expect(r.body.encontrado).to.eq(false);
      });
    });

    it('curingas não devolvem todos os alunos', () => {
      ['%%%', '___', '%_%'].forEach((busca) => {
        consultar(busca).then((r) => {
          expect(r.status, busca).to.eq(200);
          expect(r.body.encontrado, busca).to.eq(false);
        });
      });
    });

    it('só procura alunos (coordenador/recepção não aparecem) e nunca devolve senha', () => {
      consultar('Teste Coordenador').its('body.encontrado').should('eq', false);
      consultar(USUARIOS.alunoA1.matricula).then((r) => {
        expect(JSON.stringify(r.body).toLowerCase()).to.not.contain('senha');
      });
    });

    it('aluno com vários resultados parecidos: no máximo 10', () => {
      consultar('Cy Teste').then((r) => {
        expect(r.status).to.eq(200);
        expect(r.body.resultados.length).to.be.at.most(10);
      });
    });
  });

  describe('consulta por data', () => {
    it('data inválida: 400 (formato errado, dia inexistente, vazia)', () => {
      ['', 'abc', '2030-02-31', '31/02/2030', '2030-13-01'].forEach((d) => {
        porData(d).then((r) => {
          expect(r.status, `"${d}"`).to.eq(400);
          expect(r.body.mensagem).to.contain('Data inválida');
        });
      });
    });

    it('lista os alunos da data com status "Aguardando", total e presentes', () => {
      novoAgendado().then((a) => {
        porData(data).then((r) => {
          expect(r.status).to.eq(200);
          expect(r.body.sucesso).to.eq(true);
          expect(r.body.total).to.eq(r.body.alunos.length);
          const linha = r.body.alunos.find((x) => x.matricula === a.matricula);
          expect(linha).to.deep.include({ ticket_id: a.ticket, aluno_nome: a.nome, disciplina: vaga.disciplina, status: 'Aguardando', entrada_confirmada_em: null });
          expect(linha).to.include.keys('foto_url', 'curso', 'horario_fim', 'data_agendada', 'polo');
        });
      });
    });

    it('aceita a data no formato DD/MM/AAAA', () => {
      novoAgendado().then((a) => {
        porData(dataBr(data)).then((r) => {
          expect(r.status).to.eq(200);
          expect(r.body.alunos.some((x) => x.matricula === a.matricula)).to.eq(true);
        });
      });
    });

    it('o filtro de nome/matrícula restringe a lista; filtro sem correspondência devolve vazio', () => {
      novoAgendado().then((a) => {
        porData(data, a.parteDoNome).then((r) => {
          expect(r.body.alunos.map((x) => x.matricula)).to.deep.eq([a.matricula]);
          expect(r.body.total).to.eq(1);
        });
        porData(data, 'ninguem-assim-xyz').its('body.total').should('eq', 0);
        porData(data, '%').its('body.total').should('eq', 0); // curinga não vale
      });
    });

    it('data sem provas: lista vazia', () => {
      porData(dataSP(400)).then((r) => {
        expect(r.status).to.eq(200);
        expect(r.body).to.deep.include({ total: 0, presentes: 0 });
        expect(r.body.alunos).to.deep.eq([]);
      });
    });

    it('não lista agendamentos cancelados', () => {
      novoAgendado().then((a) => {
        cy.api('POST', '/api/cancelar-agendamento', { token: a.token, body: { agendamento_id: a.ticket } }).its('status').should('eq', 200);
        porData(data).then((r) => {
          expect(r.body.alunos.some((x) => x.matricula === a.matricula)).to.eq(false);
        });
      });
    });
  });

  describe('confirmar entrada', () => {
    it('confirma, grava quem e quando, muda o status e registra na auditoria', () => {
      novoAgendado().then((a) => {
        paraHoje(a.ticket);
        confirmar(a.ticket).then((r) => {
          expect(r.status, JSON.stringify(r.body)).to.eq(200);
          expect(r.body.sucesso).to.eq(true);
        });
        cy.bd('SELECT entrada_confirmada_em IS NOT NULL AS confirmada, entrada_confirmada_por FROM agendamentos WHERE id = $1', [a.ticket]).then((rows) => {
          expect(rows[0]).to.deep.eq({ confirmada: true, entrada_confirmada_por: USUARIOS.recepcao.nome });
        });
        porData(hojeSP(), a.parteDoNome).then((r) => {
          expect(r.body.alunos[0].status).to.eq('Presente');
          expect(r.body.presentes).to.eq(1);
        });
        consultar(a.matricula).its('body.resultados.0.entrada_confirmada_em').should('not.be.null');
        logsDeAuditoria(t.coord).then((logs) => {
          const log = logs.find((l) => l.acao === 'CONFIRMACAO_ENTRADA' && l.descricao.includes(`(Ticket #${a.ticket})`));
          expect(log, 'log da portaria').to.exist;
          expect(log.usuario).to.eq(USUARIOS.recepcao.nome);
        });
      });
    });

    it('confirmar duas vezes: 409', () => {
      novoAgendado().then((a) => {
        paraHoje(a.ticket);
        confirmar(a.ticket).its('status').should('eq', 200);
        confirmar(a.ticket).then((r) => {
          expect(r.status).to.eq(409);
          expect(r.body.mensagem).to.contain('já foi confirmada');
        });
      });
    });

    it('ticket inválido: 400; inexistente: 404', () => {
      cy.api('POST', '/api/portaria/confirmar-entrada', { token: t.recepcao, body: {} }).its('status').should('eq', 400);
      confirmar('abc').its('status').should('eq', 400);
      confirmar(999999999).its('status').should('eq', 404);
    });

    it('agendamento cancelado não pode ser confirmado (404)', () => {
      novoAgendado().then((a) => {
        cy.api('POST', '/api/cancelar-agendamento', { token: a.token, body: { agendamento_id: a.ticket } }).its('status').should('eq', 200);
        confirmar(a.ticket).its('status').should('eq', 404);
      });
    });
  });

  describe('restrição por polo da recepção', () => {
    it('recepção de outro polo não vê o agendamento nem confirma entrada', () => {
      novoAgendado().then((a) => {
        cy.bd(`UPDATE usuarios SET polo = 'Outro Polo' WHERE matricula = $1`, [USUARIOS.recepcao.matricula]);

        consultar(a.matricula).then((r) => {
          expect(r.body.resultados[0].ticket_id, 'não pode enxergar o agendamento de outro polo').to.be.null;
        });
        porData(data, a.parteDoNome).its('body.total').should('eq', 0);
        confirmar(a.ticket).its('status').should('eq', 404);
        cy.bd('SELECT entrada_confirmada_em FROM agendamentos WHERE id = $1', [a.ticket]).then((rows) => expect(rows[0].entrada_confirmada_em).to.be.null);
      });
    });

    it('recepção do mesmo polo vê e confirma normalmente', () => {
      novoAgendado().then((a) => {
        cy.bd(`UPDATE usuarios SET polo = 'Polo CY Portaria' WHERE matricula = $1`, [USUARIOS.recepcao.matricula]);

        consultar(a.matricula).its('body.resultados.0.ticket_id').should('eq', a.ticket);
        porData(data, a.parteDoNome).its('body.total').should('eq', 1);
        paraHoje(a.ticket);
        confirmar(a.ticket).its('status').should('eq', 200);
      });
    });
  });
});
