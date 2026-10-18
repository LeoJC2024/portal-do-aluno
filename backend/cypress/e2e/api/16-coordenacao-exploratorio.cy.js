import { USUARIOS, CURSO_A, CURSO_B, API_URL } from '../../support/dados';
import { criarUsuario, criarUsuarioAtivo, criarVaga, agendar, inserirVagaNoBanco, registrarDisciplina, vagasRestantes } from '../../support/apiHelpers';
import { dataSP, hojeSP, vagaEmAndamento, vagaHojeNoFuturo, vagaHojeTerminada } from '../../support/datas';

const unico = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const POLO = 'Polo CY P16';

// Correções encontradas nos testes exploratórios da COORDENAÇÃO:
// 1 excluir aluno com entrada confirmada; 2 mesma prova para cursos diferentes; 3 nota Aprovado/Reprovado;
// 4 prova em andamento na lista de vagas; 6 curso com espaços
describe('API: coordenação (correções dos testes exploratórios)', () => {
  const t = {};

  before(() => {
    cy.task('prepararBanco');
    cy.tokenDe(USUARIOS.coord).then((x) => { t.coord = x; });
    cy.tokenDe(USUARIOS.recepcao).then((x) => { t.recepcao = x; });
    cy.tokenDe(USUARIOS.alunoA1).then((x) => { t.a1 = x; });
    cy.tokenDe(USUARIOS.alunoB).then((x) => { t.b = x; });
  });

  const alterarStatus = (id, ativo) => cy.api('POST', '/api/alterar-status-usuario', { token: t.coord, body: { id, ativo } });
  const porData = (d) => cy.api('GET', `/api/portaria/por-data?data=${encodeURIComponent(d)}`, { token: t.recepcao });
  const statusDe = (agId) => cy.bd('SELECT status FROM agendamentos WHERE id = $1', [agId]).then((rows) => rows[0].status);
  const logSoftDelete = (matricula) =>
    cy.bd(`SELECT descricao FROM auditoria WHERE acao = 'SOFT_DELETE' AND descricao LIKE $1 ORDER BY id DESC LIMIT 1`, [`%${matricula}%`])
      .then((rows) => rows[0] && rows[0].descricao);

  // agendamento ATIVO direto no banco de teste (a API não deixa agendar prova que já começou ou passou)
  function agendamentoEm(aluno, { data, inicio, fim, entrada = false, disciplina = `CY-p16-${unico()}` }) {
    return inserirVagaNoBanco({ disciplina, data, inicio, fim, polo: POLO }).then((vagaId) =>
      cy.bd(
        `INSERT INTO agendamentos (vaga_id, usuario_id, aluno_nome, data_agendada, horario_agendado, status,
                                   entrada_confirmada_em, entrada_confirmada_por)
         VALUES ($1, $2, $3, $4, $5, 'ATIVO', ${entrada ? `NOW(), 'CY Portaria'` : 'NULL, NULL'}) RETURNING id`,
        [vagaId, aluno.id, aluno.nome, data, inicio]
      ).then((rows) => rows[0].id)
    );
  }

  // ------------------------------------------------------------------
  describe('1: excluir aluno com entrada confirmada', () => {
    it('cancela só as futuras sem entrada; a entrada confirmada continua na lista do dia; a passada fica no histórico', function () {
      const hoje = vagaHojeNoFuturo();
      if (!hoje) this.skip(); // a partir das 23:50 não há prova de hoje ainda por começar
      const discHoje = `CY-p16-hoje-${unico()}`;
      const ids = {};

      criarUsuarioAtivo(t.coord).then((aluno) => {
        // prova de hoje com a entrada confirmada pela portaria (pela API, como na vida real)
        registrarDisciplina(t.coord, discHoje);
        agendamentoEm(aluno, { ...hoje, disciplina: discHoje }).then((id) => { ids.hoje = id; });
        cy.then(() => cy.api('POST', '/api/portaria/confirmar-entrada', { token: t.recepcao, body: { ticket_id: ids.hoje } }))
          .its('status').should('eq', 200);
        // duas provas futuras sem entrada (pela API) e uma prova passada sem entrada
        criarVaga(t.coord, { limite_vagas: 2 }).then((v) => { ids.vaga1 = v.id; agendar(aluno.token, v.id).then((r) => { ids.f1 = r.body.agendamento.id; }); });
        criarVaga(t.coord, { limite_vagas: 2 }).then((v) => { ids.vaga2 = v.id; agendar(aluno.token, v.id).then((r) => { ids.f2 = r.body.agendamento.id; }); });
        agendamentoEm(aluno, { data: dataSP(-2), inicio: '08:00', fim: '10:00' }).then((id) => { ids.passada = id; });

        // lista do dia antes da exclusão
        const antes = {};
        porData(hojeSP()).then((r) => {
          antes.total = r.body.total;
          antes.presentes = r.body.presentes;
          expect(r.body.alunos.find((a) => a.ticket_id === ids.hoje)).to.include({ status: 'Presente' });
        });

        alterarStatus(aluno.id, false).then((r) => {
          expect(r.status, JSON.stringify(r.body)).to.eq(200);
          expect(r.body.mensagem).to.eq('Usuário excluído. 2 agendamento(s) futuro(s) cancelado(s); 1 com entrada confirmada foi mantido.');
        });

        cy.then(() => {
          statusDe(ids.f1).should('eq', 'INATIVO');
          statusDe(ids.f2).should('eq', 'INATIVO');
          statusDe(ids.hoje).should('eq', 'ATIVO');
          statusDe(ids.passada).should('eq', 'ATIVO');
          // as vagas das futuras voltam
          vagasRestantes(t.a1, ids.vaga1).should('eq', 2);
          vagasRestantes(t.a1, ids.vaga2).should('eq', 2);
        });

        // a presença do aluno excluído continua na lista do dia: total e presentes não caem
        porData(hojeSP()).then((r) => {
          expect(r.body.total).to.eq(antes.total);
          expect(r.body.presentes).to.eq(antes.presentes);
          expect(r.body.alunos.find((a) => a.ticket_id === ids.hoje)).to.include({ status: 'Presente', aluno_nome: aluno.nome });
        });

        logSoftDelete(aluno.matricula).should('eq',
          `Usuário excluído: ${aluno.nome} (${aluno.matricula}, Aluno); 2 agendamento(s) futuro(s) cancelado(s); 1 com entrada confirmada foi mantido`);

        // reativar não restaura nada; e o aluno não consegue agendar de novo a prova em que já entrou
        alterarStatus(aluno.id, true).its('status').should('eq', 200);
        cy.then(() => {
          statusDe(ids.f1).should('eq', 'INATIVO');
          statusDe(ids.hoje).should('eq', 'ATIVO');
        });
        criarVaga(t.coord, { disciplina: discHoje, data: dataSP(5) }).then((v) => {
          agendar(aluno.token, v.id).then((r) => {
            expect(r.status, JSON.stringify(r.body)).to.eq(409);
            expect(r.body.mensagem).to.contain('já tem um agendamento ativo');
          });
        });
      });
    });

    it('prova em andamento sem entrada é cancelada; futura com entrada confirmada é mantida', function () {
      const andamento = vagaEmAndamento();
      if (!andamento) this.skip(); // perto da meia-noite não há prova de hoje em andamento com folga
      criarUsuarioAtivo(t.coord).then((aluno) => {
        agendamentoEm(aluno, andamento).then((idAndamento) => {
          agendamentoEm(aluno, { data: dataSP(3), inicio: '08:00', fim: '10:00', entrada: true }).then((idEntrada) => {
            alterarStatus(aluno.id, false).then((r) => {
              expect(r.status).to.eq(200);
              expect(r.body.mensagem).to.eq('Usuário excluído. 1 agendamento(s) futuro(s) cancelado(s); 1 com entrada confirmada foi mantido.');
            });
            statusDe(idAndamento).should('eq', 'INATIVO');
            statusDe(idEntrada).should('eq', 'ATIVO');
          });
        });
      });
    });

    it('prova de hoje já terminada sem entrada fica no histórico (não é cancelada)', function () {
      const terminada = vagaHojeTerminada();
      if (!terminada) this.skip(); // antes das 00:10 não existe prova de hoje já terminada
      criarUsuarioAtivo(t.coord).then((aluno) => {
        agendamentoEm(aluno, terminada).then((id) => {
          alterarStatus(aluno.id, false).its('body.mensagem')
            .should('eq', 'Usuário excluído. 0 agendamento(s) futuro(s) cancelado(s); 0 com entrada confirmada foram mantidos.');
          statusDe(id).should('eq', 'ATIVO');
        });
      });
    });

    it('vários com entrada confirmada: a mensagem fica no plural', () => {
      criarUsuarioAtivo(t.coord).then((aluno) => {
        agendamentoEm(aluno, { data: dataSP(3), inicio: '08:00', fim: '10:00', entrada: true });
        agendamentoEm(aluno, { data: dataSP(-3), inicio: '08:00', fim: '10:00', entrada: true });
        alterarStatus(aluno.id, false).its('body.mensagem')
          .should('eq', 'Usuário excluído. 0 agendamento(s) futuro(s) cancelado(s); 2 com entrada confirmada foram mantidos.');
      });
    });

    it('recepção, coordenador e auditor: a mensagem e a auditoria não citam agendamentos', () => {
      const n = unico();
      const casos = [];
      criarUsuario(t.coord, { tipo: 'Recepção do Polo', polo: 'Polo Resende', curso: '' }).then((u) => casos.push(u.matricula));
      criarUsuario(t.coord, { tipo: 'coordenador', curso: '' }).then((u) => casos.push(u.matricula));
      // auditor não é cadastrado pela tela: entra direto no banco de teste
      cy.bd(
        `INSERT INTO usuarios (nome, matricula, curso, tipo, senha, email, ativo, trocar_senha)
         VALUES ($1, $2, 'CY Curso A', 'AUDIT', 'x', $3, true, false) RETURNING matricula`,
        [`Cy Auditor ${n}`, `CYAUD${n}`, `cy-aud-${n}@teste.local`]
      ).then((rows) => casos.push(rows[0].matricula));

      cy.then(() => {
        casos.forEach((matricula) => {
          cy.bd('SELECT id FROM usuarios WHERE matricula = $1', [matricula]).then((rows) => {
            alterarStatus(rows[0].id, false).then((r) => {
              expect(r.status, JSON.stringify(r.body)).to.eq(200);
              expect(r.body.mensagem).to.eq('Usuário excluído.');
            });
            logSoftDelete(matricula).then((descricao) => {
              expect(descricao).to.contain(matricula);
              expect(descricao).to.not.contain('agendamento');
            });
          });
        });
      });
    });
  });

  // ------------------------------------------------------------------
  describe('2: mesma prova para cursos diferentes', () => {
    const REPETIDA = 'Já existe uma vaga desta disciplina para este curso, neste polo, na mesma data e horário.';
    const corpoVaga = (disciplina, extra = {}) => ({
      polo: 'Polo CY Cursos', curso: CURSO_A, disciplina, data: dataSP(12), horario_inicio: '09:00', horario_fim: '11:00', limite_vagas: 3, ...extra
    });
    const cadastrar = (c) => cy.api('POST', '/api/cadastrar-vaga', { token: t.coord, body: c });

    it('Curso A e Curso B no mesmo polo, disciplina, data e horário: as duas passam, cada uma com o seu limite', () => {
      const disciplina = `CY-Compartilhada ${unico()}`;
      registrarDisciplina(t.coord, disciplina);
      cadastrar(corpoVaga(disciplina, { limite_vagas: 2 })).then((ra) => {
        expect(ra.status, JSON.stringify(ra.body)).to.eq(200);
        cadastrar(corpoVaga(disciplina, { curso: CURSO_B, limite_vagas: 5 })).then((rb) => {
          expect(rb.status, JSON.stringify(rb.body)).to.eq(200);
          const idA = ra.body.id;
          const idB = rb.body.id;

          // cada aluno só vê a vaga do próprio curso, com o limite dela
          cy.api('GET', '/api/vagas', { token: t.a1 }).then((r) => {
            expect(r.body.find((v) => v.id === idA)).to.include({ limite_vagas: 2, vagas_restantes: 2 });
            expect(r.body.some((v) => v.id === idB)).to.eq(false);
          });
          cy.api('GET', '/api/vagas', { token: t.b }).then((r) => {
            expect(r.body.find((v) => v.id === idB)).to.include({ limite_vagas: 5, vagas_restantes: 5 });
            expect(r.body.some((v) => v.id === idA)).to.eq(false);
          });

          // cada um agenda a do seu curso; a do outro curso é recusada
          agendar(t.a1, idB).its('status').should('eq', 403);
          agendar(t.a1, idA).its('status').should('eq', 200);
          agendar(t.b, idB).its('status').should('eq', 200);
          vagasRestantes(t.a1, idA).should('eq', 1);
          vagasRestantes(t.b, idB).should('eq', 4);
        });
      });
    });

    it('o mesmo curso de novo é recusado, mesmo com outras maiúsculas/minúsculas e espaços nas pontas', () => {
      const disciplina = `CY-Repetida ${unico()}`;
      const polo = `Polo CY Caixa ${unico()}`;
      registrarDisciplina(t.coord, disciplina);
      cadastrar(corpoVaga(disciplina, { polo })).its('status').should('eq', 200);
      [
        { polo: polo.toLowerCase() },
        { polo: `  ${polo.toUpperCase()}  ` },
        { curso: '  cy curso a ' },
        { curso: 'CY   CURSO   A' },
        { disciplina: `  ${disciplina.toUpperCase()} ` },
        { polo: polo.toLowerCase(), curso: 'cy curso a', disciplina: disciplina.toLowerCase(), horario_fim: '12:00' }
      ].forEach((variacao) => {
        cadastrar(corpoVaga(disciplina, { polo, ...variacao })).then((r) => {
          expect(r.status, JSON.stringify(variacao)).to.eq(409);
          expect(r.body.mensagem).to.eq(REPETIDA);
        });
      });
      cy.bd('SELECT COUNT(*)::int AS n FROM vagas WHERE LOWER(disciplina) = LOWER($1)', [disciplina]).its('0.n').should('eq', 1);
    });

    it('cadastros iguais ao mesmo tempo (com variação de caixa no polo): só um passa (advisory lock)', () => {
      const disciplina = `CY-Concorrente ${unico()}`;
      const polo = `Polo CY Conc ${unico()}`;
      registrarDisciplina(t.coord, disciplina).then(() => {
        const chamada = (extra) => ({
          method: 'POST', url: `${API_URL}/api/cadastrar-vaga`, headers: { Authorization: `Bearer ${t.coord}` },
          body: corpoVaga(disciplina, { polo, ...extra })
        });
        cy.task('paralelo', [chamada({}), chamada({ polo: polo.toLowerCase() }), chamada({ polo: polo.toUpperCase(), curso: 'cy curso a' }), chamada({})])
          .then((rs) => {
            expect(rs.filter((r) => r.status === 200), JSON.stringify(rs)).to.have.length(1);
            rs.filter((r) => r.status !== 200).forEach((r) => {
              expect(r.status).to.eq(409);
              expect(r.body.mensagem).to.eq(REPETIDA);
            });
          });
        cy.bd('SELECT COUNT(*)::int AS n FROM vagas WHERE LOWER(disciplina) = LOWER($1)', [disciplina]).its('0.n').should('eq', 1);
      });
    });

    it('o índice do banco aceita outro curso e recusa o mesmo curso (proteção extra, fora do servidor)', () => {
      const disciplina = `CY-Indice ${unico()}`;
      const inserir = (curso) => cy.task('bdTentar', {
        sql: `INSERT INTO vagas (polo, curso, disciplina, data_prova, horario, limite_vagas) VALUES ('Polo CY Idx', $1, $2, $3, '08:00', 5)`,
        params: [curso, disciplina, dataSP(10)]
      });
      inserir(CURSO_A).its('erro').should('be.null');
      inserir(CURSO_B).its('erro').should('be.null');
      inserir(' cy curso a ').then((r) => expect(r.erro, 'precisa rodar a migracao_parte_e.sql no banco de teste').to.contain('uq_vagas_polo_disciplina_curso_data_hora'));
    });
  });

  // ------------------------------------------------------------------
  describe('3: nota Aprovado / Reprovado / Sem nota', () => {
    const notas = {};
    // as notas entram direto no banco de teste, como nos testes de notas existentes (06-notas.cy.js)
    const inserirNota = (usuario, avaliacao, nota) =>
      cy.bd(
        `INSERT INTO notas_alunos (nome_aluno, matricula, avaliacao, polo, nota) VALUES ($1, $2, $3, 'Polo CY', $4) RETURNING id`,
        [usuario.nome, usuario.matricula, avaliacao, nota]
      ).then((rows) => rows[0].id);

    before(() => {
      inserirNota(USUARIOS.alunoA1, 'CY-P16 Nota 5', 5).then((id) => { notas.n5 = id; });
      inserirNota(USUARIOS.alunoA1, 'CY-P16 Nota 7', 7).then((id) => { notas.n7 = id; });
      inserirNota(USUARIOS.alunoA1, 'CY-P16 Nota 6', 6).then((id) => { notas.n6 = id; });
      inserirNota(USUARIOS.alunoA1, 'CY-P16 Nota 5.99', 5.99).then((id) => { notas.n599 = id; });
      inserirNota(USUARIOS.alunoA1, 'CY-P16 Sem nota', null).then((id) => { notas.sem = id; });
    });

    const esperado = {
      'CY-P16 Nota 5': 'Reprovado', 'CY-P16 Nota 7': 'Aprovado', 'CY-P16 Nota 6': 'Aprovado',
      'CY-P16 Nota 5.99': 'Reprovado', 'CY-P16 Sem nota': 'Sem nota'
    };

    it('o aluno recebe o resultado calculado pelo servidor (nota mínima 6)', () => {
      cy.api('GET', '/api/resultados', { token: t.a1 }).then((r) => {
        expect(r.status).to.eq(200);
        Object.entries(esperado).forEach(([avaliacao, resultado]) => {
          expect(r.body.find((n) => n.avaliacao === avaliacao), avaliacao).to.include({ resultado });
        });
      });
    });

    it('a coordenação recebe o mesmo resultado na lista de notas', () => {
      cy.api('GET', '/api/notas', { token: t.coord }).then((r) => {
        expect(r.status).to.eq(200);
        Object.entries(esperado).forEach(([avaliacao, resultado]) => {
          expect(r.body.find((n) => n.avaliacao === avaliacao), avaliacao).to.include({ resultado });
        });
      });
    });

    it('mudar a nota muda o resultado', () => {
      const atualizar = (nota) => cy.api('POST', '/api/atualizar-nota', { token: t.coord, body: { id: notas.n5, nota } });
      const resultado = () => cy.api('GET', '/api/notas', { token: t.coord }).then((r) => r.body.find((n) => n.id === notas.n5).resultado);
      atualizar(7).its('status').should('eq', 200);
      resultado().should('eq', 'Aprovado');
      atualizar(5).its('status').should('eq', 200);
      resultado().should('eq', 'Reprovado');
    });

    describe('validação da nota na rota de atualizar', () => {
      const atualizar = (nota) => cy.api('POST', '/api/atualizar-nota', { token: t.coord, body: { id: notas.n7, nota } });
      const notaNoBanco = () => cy.bd('SELECT nota::float AS nota FROM notas_alunos WHERE id = $1', [notas.n7]).its('0.nota');

      [0, 10, 6, 7.5, 7.25, 9.99, 0.01].forEach((valor) => {
        it(`aceita ${valor}`, () => {
          atualizar(valor).its('status').should('eq', 200);
          notaNoBanco().should('eq', valor);
        });
      });

      [
        ['texto', 'abc'], ['número como texto', '7.5'], ['vírgula', '7,5'], ['notação científica', '1e1'],
        ['hexadecimal', '0x5'], ['array', [7]], ['objeto', { valor: 7 }], ['booleano', true],
        ['acima de 10', 10.5], ['abaixo de 0', -1], ['3 casas decimais', 7.125], ['número minúsculo', 1e-7],
        ['vazio', ''], ['nulo', null]
      ].forEach(([nome, valor]) => {
        it(`recusa ${nome} com 400 e mensagem clara, sem mudar a nota`, () => {
          atualizar(8).its('status').should('eq', 200);
          atualizar(valor).then((r) => {
            expect(r.status, JSON.stringify(valor)).to.eq(400);
            expect(r.body.mensagem).to.eq('Informe uma nota numérica entre 0 e 10, com até 2 casas decimais (ex.: 7.5). Texto, vírgula e outros formatos não são aceitos.');
          });
          notaNoBanco().should('eq', 8);
        });
      });
    });
  });

  // ------------------------------------------------------------------
  describe('4: prova em andamento na lista de vagas da coordenação', () => {
    const lista = () => cy.api('GET', '/api/vagas-gestao', { token: t.coord }).its('body');

    it('prova que começou e não terminou continua "futura" (não é "realizada")', function () {
      const v = vagaEmAndamento();
      if (!v) this.skip();
      inserirVagaNoBanco({ disciplina: `CY-andamento-${unico()}`, data: v.data, inicio: v.inicio, fim: v.fim }).then((id) => {
        lista().then((vagas) => expect(vagas.find((x) => x.id === id).futura).to.eq(true));
      });
    });

    it('vaga de hoje 00:00–23:59 continua "futura" durante o dia', function () {
      const agora = new Date().toLocaleTimeString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 5);
      if (agora >= '23:58') this.skip();
      inserirVagaNoBanco({ disciplina: `CY-dia-todo-${unico()}`, data: hojeSP(), inicio: '00:00', fim: '23:59' }).then((id) => {
        lista().then((vagas) => expect(vagas.find((x) => x.id === id).futura).to.eq(true));
      });
    });

    it('prova que já terminou não é "futura"', function () {
      const v = vagaHojeTerminada();
      if (!v) this.skip();
      inserirVagaNoBanco({ disciplina: `CY-terminou-${unico()}`, data: v.data, inicio: v.inicio, fim: v.fim }).then((id) => {
        lista().then((vagas) => expect(vagas.find((x) => x.id === id).futura).to.eq(false));
      });
    });

    it('vaga antiga sem horário de fim: o término vale o início', function () {
      const v = vagaEmAndamento(); // começou há 1h
      if (!v) this.skip();
      inserirVagaNoBanco({ disciplina: `CY-sem-fim-${unico()}`, data: v.data, inicio: v.inicio, fim: null }).then((id) => {
        lista().then((vagas) => expect(vagas.find((x) => x.id === id).futura).to.eq(false));
      });
    });
  });

  // ------------------------------------------------------------------
  describe('6: curso com espaços', () => {
    it('no cadastro de usuário, espaços e caixa diferentes não criam um curso separado', () => {
      criarUsuario(t.coord, { curso: '  cy   curso a ' }).then((u) => {
        cy.bd('SELECT curso FROM usuarios WHERE matricula = $1', [u.matricula]).its('0.curso').should('eq', CURSO_A);
      });
    });

    it('curso novo é gravado sem espaços nas pontas e sem espaços repetidos', () => {
      const n = unico();
      criarUsuario(t.coord, { curso: `  CY   Turma   ${n}  ` }).then((u) => {
        cy.bd('SELECT curso FROM usuarios WHERE matricula = $1', [u.matricula]).its('0.curso').should('eq', `CY Turma ${n}`);
      });
      cy.api('GET', '/api/cursos', { token: t.coord }).then((r) => {
        expect(r.body).to.include(`CY Turma ${n}`);
        expect(r.body.filter((c) => c.toLowerCase().replace(/\s+/g, ' ').trim() === `cy turma ${n}`)).to.have.length(1);
      });
    });

    it('no cadastro de vaga, o curso também é normalizado e o aluno do curso vê a vaga', () => {
      criarVaga(t.coord, { curso: ' cy  curso a  ' }).then((v) => {
        cy.bd('SELECT curso FROM vagas WHERE id = $1', [v.id]).its('0.curso').should('eq', CURSO_A);
        cy.api('GET', '/api/vagas', { token: t.a1 }).then((r) => expect(r.body.some((x) => x.id === v.id)).to.eq(true));
      });
    });
  });
});
