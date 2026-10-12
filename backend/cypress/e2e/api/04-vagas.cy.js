import { USUARIOS, CURSO_A, CURSO_B } from '../../support/dados';
import { criarVaga, criarUsuarioAtivo, inserirVagaNoBanco, registrarDisciplina } from '../../support/apiHelpers';
import { dataSP, hojeSP } from '../../support/datas';

const unico = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

describe('API: cadastro de vagas', () => {
  const t = {};

  before(() => {
    cy.task('prepararBanco');
    cy.tokenDe(USUARIOS.coord).then((x) => { t.coord = x; });
  });

  const base = (extra = {}) => ({
    polo: 'Polo CY', curso: CURSO_A, disciplina: `CY-invalida-${unico()}`, data: dataSP(10),
    horario_inicio: '08:00', horario_fim: '10:00', limite_vagas: 5, ...extra
  });
  const cadastrar = (corpo) => cy.api('POST', '/api/cadastrar-vaga', { token: t.coord, body: corpo });

  it('cria a vaga com curso, início e fim, devolve o id e grava no banco', () => {
    criarVaga(t.coord, { horario_inicio: '13:30', horario_fim: '15:45', limite_vagas: 12, polo: 'Polo X' }).then((v) => {
      expect(v.id).to.be.a('number');
      cy.bd(`SELECT polo, curso, disciplina, to_char(data_prova,'YYYY-MM-DD') AS data, horario::text AS inicio, horario_fim::text AS fim, limite_vagas FROM vagas WHERE id = $1`, [v.id]).then((rows) => {
        expect(rows[0]).to.deep.eq({ polo: 'Polo X', curso: CURSO_A, disciplina: v.disciplina, data: v.data, inicio: '13:30:00', fim: '15:45:00', limite_vagas: 12 });
      });
    });
  });

  it('registra ADICAO_VAGAS na auditoria com o nome de quem criou', () => {
    criarVaga(t.coord).then((v) => {
      cy.api('GET', '/api/auditoria', { token: t.coord }).then((r) => {
        const log = r.body.find((l) => l.acao === 'ADICAO_VAGAS' && l.descricao.includes(v.disciplina));
        expect(log, 'log da criação').to.exist;
        expect(log.usuario).to.eq(USUARIOS.coord.nome);
        expect(log.descricao).to.contain(CURSO_A).and.contain('08:00').and.contain('10:00');
        expect(log.ip).to.be.a('string');
      });
    });
  });

  [
    ['sem polo', { polo: '' }, 'Preencha todos os campos da vaga.'],
    ['sem curso', { curso: '' }, 'Preencha todos os campos da vaga.'],
    ['sem disciplina', { disciplina: '' }, 'Preencha todos os campos da vaga.'],
    ['sem data', { data: '' }, 'Preencha todos os campos da vaga.'],
    ['sem início', { horario_inicio: '' }, 'Preencha todos os campos da vaga.'],
    ['sem fim', { horario_fim: '' }, 'Preencha todos os campos da vaga.'],
    ['sem limite', { limite_vagas: undefined }, 'Preencha todos os campos da vaga.'],
    ['limite não numérico', { limite_vagas: 'abc' }, 'número inteiro'],
    ['limite 0', { limite_vagas: 0 }, 'entre 1 e 5000'],
    ['limite acima de 5000', { limite_vagas: 5001 }, 'entre 1 e 5000'],
    ['limite negativo', { limite_vagas: -3 }, 'entre 1 e 5000'],
    ['data em formato brasileiro', { data: '10/12/2030' }, 'formato inválido'],
    ['data impossível', { data: '2030-02-31' }, 'formato inválido'],
    ['mês impossível', { data: '2030-13-01' }, 'formato inválido'],
    ['hora sem zero à esquerda', { horario_inicio: '8:00' }, 'formato inválido'],
    ['hora com segundos', { horario_inicio: '08:00:00' }, 'formato inválido'],
    ['hora impossível', { horario_fim: '25:99' }, 'formato inválido'],
    ['fim igual ao início', { horario_inicio: '09:00', horario_fim: '09:00' }, 'depois do horário de início'],
    ['fim antes do início', { horario_inicio: '10:00', horario_fim: '09:00' }, 'depois do horário de início'],
    ['data no passado', { data: dataSP(-1) }, 'passado']
  ].forEach(([nome, alteracao, texto]) => {
    it(`recusa ${nome}`, () => {
      const corpo = base(alteracao);
      cadastrar(corpo).then((r) => {
        expect(r.status, JSON.stringify(r.body)).to.eq(400);
        expect(r.body.mensagem).to.contain(texto);
      });
      cy.bd('SELECT COUNT(*)::int AS n FROM vagas WHERE disciplina = $1', [corpo.disciplina]).then((rows) => {
        expect(rows[0].n, 'nada pode ter sido gravado').to.eq(0);
      });
    });
  });

  it('aceita limite escrito como texto e apara espaços dos campos', () => {
    const disciplina = `CY-espacos-${unico()}`;
    registrarDisciplina(t.coord, disciplina);
    cadastrar(base({ disciplina: `  ${disciplina}  `, polo: '  Polo Z  ', limite_vagas: '40' })).its('status').should('eq', 200);
    cy.bd('SELECT polo, disciplina, limite_vagas FROM vagas WHERE disciplina = $1', [disciplina]).then((rows) => {
      expect(rows).to.have.length(1);
      expect(rows[0]).to.include({ polo: 'Polo Z', limite_vagas: 40 });
    });
  });

  it('aceita prova marcada para hoje', () => {
    const disciplina = `CY-hoje-${unico()}`;
    registrarDisciplina(t.coord, disciplina);
    cadastrar(base({ data: dataSP(0), disciplina })).its('status').should('eq', 200);
  });
});

describe('API: quem enxerga cada vaga (curso, futuro, ordem)', () => {
  const t = {};
  const ids = {};

  before(() => {
    cy.task('prepararBanco');
    cy.tokenDe(USUARIOS.coord).then((x) => { t.coord = x; });
    cy.tokenDe(USUARIOS.alunoA1).then((x) => { t.a1 = x; });
    cy.tokenDe(USUARIOS.alunoB).then((x) => { t.b = x; });

    // cy.then: só roda depois que os tokens acima já foram obtidos (t.coord já tem valor)
    cy.then(() => {
      const n = unico();
      criarVaga(t.coord, { curso: CURSO_A, disciplina: `CY-cursoA-${n}`, data: dataSP(20), limite_vagas: 7 }).then((v) => { ids.a = v.id; ids.dadosA = v; });
      criarVaga(t.coord, { curso: CURSO_B, disciplina: `CY-cursoB-${n}` }).then((v) => { ids.b = v.id; });
      inserirVagaNoBanco({ curso: null, disciplina: `CY-antiga-${n}`, data: dataSP(8) }).then((id) => { ids.antiga = id; });
      inserirVagaNoBanco({ curso: `  ${CURSO_A.toLowerCase()}  `, disciplina: `CY-espaco-${n}`, data: dataSP(8) }).then((id) => { ids.espaco = id; });
      inserirVagaNoBanco({ curso: CURSO_A, disciplina: `CY-passada-${n}`, data: dataSP(-1) }).then((id) => { ids.passada = id; });
      criarVaga(t.coord, { curso: CURSO_A, disciplina: `CY-ordem2-${n}`, data: dataSP(15), horario_inicio: '09:00', horario_fim: '10:00' }).then((v) => { ids.ordem2 = v.id; });
    });
  });

  const idsVisiveis = (token) => cy.api('GET', '/api/vagas', { token }).then((r) => {
    expect(r.status).to.eq(200);
    return r.body.map((v) => v.id);
  });

  it('aluno do curso A vê vagas do A, as antigas (sem curso) e as com curso escrito diferente (caixa/espaços); não vê as do B nem as passadas', () => {
    idsVisiveis(t.a1).then((lista) => {
      expect(lista).to.include.members([ids.a, ids.antiga, ids.espaco]);
      expect(lista).to.not.include(ids.b);
      expect(lista).to.not.include(ids.passada);
    });
  });

  it('aluno do curso B vê só as do B e as antigas', () => {
    idsVisiveis(t.b).then((lista) => {
      expect(lista).to.include.members([ids.b, ids.antiga]);
      expect(lista).to.not.include(ids.a);
      expect(lista).to.not.include(ids.espaco);
      expect(lista).to.not.include(ids.passada);
    });
  });

  it('o coordenador vê todas as futuras, de qualquer curso', () => {
    idsVisiveis(t.coord).then((lista) => {
      expect(lista).to.include.members([ids.a, ids.b, ids.antiga, ids.espaco, ids.ordem2]);
      expect(lista).to.not.include(ids.passada);
    });
  });

  it('aluno sem curso cadastrado só vê as vagas antigas (sem curso)', () => {
    criarUsuarioAtivo(t.coord).then((u) => {
      cy.bd('UPDATE usuarios SET curso = NULL WHERE id = $1', [u.id]);
      idsVisiveis(u.token).then((lista) => {
        expect(lista).to.include(ids.antiga);
        [ids.a, ids.b, ids.espaco].forEach((vid) => expect(lista).to.not.include(vid));
      });
    });
  });

  it('cada vaga traz data, faixa de horário, polo, curso e vagas restantes', () => {
    cy.api('GET', '/api/vagas', { token: t.a1 }).then((r) => {
      const v = r.body.find((x) => x.id === ids.a);
      expect(v).to.deep.include({
        polo: 'Polo CY', curso: CURSO_A, disciplina: ids.dadosA.disciplina, data_prova: dataSP(20),
        horario: '08:00:00', horario_fim: '10:00:00', limite_vagas: 7, vagas_restantes: 7
      });
    });
  });

  it('vem ordenado por data e horário', () => {
    cy.api('GET', '/api/vagas', { token: t.a1 }).then((r) => {
      const lista = r.body.map((v) => v.id);
      expect(lista.indexOf(ids.ordem2)).to.be.lessThan(lista.indexOf(ids.a)); // dia 15 antes do dia 20
    });
  });
});

describe('API: período de agendamento (cadastro)', () => {
  const t = {};

  before(() => {
    cy.task('prepararBanco');
    cy.tokenDe(USUARIOS.coord).then((x) => { t.coord = x; });
  });

  const corpo = (extra = {}) => ({
    polo: 'Polo CY', curso: CURSO_A, disciplina: `CY-periodo-${unico()}`, data: dataSP(10),
    horario_inicio: '08:00', horario_fim: '10:00', limite_vagas: 5,
    agendamento_inicio: dataSP(2), agendamento_fim: dataSP(5), ...extra
  });
  const cadastrar = (c) => cy.api('POST', '/api/cadastrar-vaga', { token: t.coord, body: c });

  it('grava o período e o registra na auditoria', () => {
    const c = corpo();
    registrarDisciplina(t.coord, c.disciplina);
    cadastrar(c).then((r) => {
      expect(r.status, JSON.stringify(r.body)).to.eq(200);
      cy.bd(`SELECT to_char(agendamento_inicio,'YYYY-MM-DD') AS ini, to_char(agendamento_fim,'YYYY-MM-DD') AS fim FROM vagas WHERE id = $1`, [r.body.id]).then((rows) => {
        expect(rows[0]).to.deep.eq({ ini: c.agendamento_inicio, fim: c.agendamento_fim });
      });
    });
    cy.api('GET', '/api/auditoria', { token: t.coord }).then((r) => {
      const log = r.body.find((l) => l.acao === 'ADICAO_VAGAS' && l.descricao.includes(c.disciplina));
      expect(log.descricao).to.contain(`agendamento de ${c.agendamento_inicio} a ${c.agendamento_fim}`);
    });
  });

  it('sem período (os dois vazios) a vaga fica sempre aberta', () => {
    const c = corpo({ agendamento_inicio: undefined, agendamento_fim: undefined });
    registrarDisciplina(t.coord, c.disciplina);
    cadastrar(c).then((r) => {
      expect(r.status).to.eq(200);
      cy.bd('SELECT agendamento_inicio, agendamento_fim FROM vagas WHERE id = $1', [r.body.id]).then((rows) => {
        expect(rows[0]).to.deep.eq({ agendamento_inicio: null, agendamento_fim: null });
      });
    });
  });

  it('o último dia do período pode ser a própria data da prova e o início pode ser hoje', () => {
    const c = corpo({ agendamento_inicio: hojeSP(), agendamento_fim: dataSP(10) });
    registrarDisciplina(t.coord, c.disciplina);
    cadastrar(c).its('status').should('eq', 200);
  });

  [
    ['só o início, sem o fim', { agendamento_fim: '' }, 'Informe o início e o fim'],
    ['só o fim, sem o início', { agendamento_inicio: '' }, 'Informe o início e o fim'],
    ['data impossível no início', { agendamento_inicio: '2030-02-31' }, 'inválidas'],
    ['data em formato brasileiro no fim', { agendamento_fim: '05/12/2030' }, 'inválidas'],
    ['fim antes do início', { agendamento_inicio: dataSP(6), agendamento_fim: dataSP(3) }, 'igual ou depois do início'],
    ['fim depois da data da prova', { agendamento_fim: dataSP(12) }, 'até a data da prova'],
    ['fim no passado', { agendamento_inicio: dataSP(-3), agendamento_fim: dataSP(-1) }, 'passado']
  ].forEach(([nome, alteracao, texto]) => {
    it(`recusa ${nome}`, () => {
      const c = corpo(alteracao);
      cadastrar(c).then((r) => {
        expect(r.status, JSON.stringify(r.body)).to.eq(400);
        expect(r.body.mensagem).to.contain(texto);
      });
      cy.bd('SELECT COUNT(*)::int AS n FROM vagas WHERE disciplina = $1', [c.disciplina]).then((rows) => expect(rows[0].n).to.eq(0));
    });
  });
});

describe('API: período de agendamento (quem vê o quê)', () => {
  const t = {};
  const v = {};

  before(() => {
    cy.task('prepararBanco');
    cy.tokenDe(USUARIOS.coord).then((x) => { t.coord = x; });
    cy.tokenDe(USUARIOS.alunoA1).then((x) => { t.a1 = x; });
    cy.then(() => {
      criarVaga(t.coord, { agendamento_inicio: hojeSP(), agendamento_fim: dataSP(5) }).then((x) => { v.aberta = x.id; });
      criarVaga(t.coord, { agendamento_inicio: dataSP(3), agendamento_fim: dataSP(6) }).then((x) => { v.futura = x.id; });
      criarVaga(t.coord).then((x) => { v.semPeriodo = x.id; });
      inserirVagaNoBanco({ disciplina: `CY-encerrada-${unico()}`, data: dataSP(10), agInicio: dataSP(-6), agFim: dataSP(-1) }).then((id) => { v.encerrada = id; });
    });
  });

  const lista = (token) => cy.api('GET', '/api/vagas', { token }).then((r) => r.body);

  it('o aluno vê as abertas, as que vão abrir (marcadas como fechadas) e as sem período; não vê as encerradas', () => {
    lista(t.a1).then((vagas) => {
      const por = (id) => vagas.find((x) => x.id === id);
      expect(por(v.aberta).agendamento_aberto).to.eq(true);
      expect(por(v.semPeriodo).agendamento_aberto).to.eq(true);
      expect(por(v.futura).agendamento_aberto).to.eq(false);
      expect(por(v.futura).agendamento_inicio).to.eq(dataSP(3));
      expect(por(v.encerrada), 'vaga com período encerrado').to.be.undefined;
    });
  });

  it('o coordenador vê todas, inclusive a encerrada', () => {
    lista(t.coord).then((vagas) => {
      [v.aberta, v.futura, v.semPeriodo, v.encerrada].forEach((id) => expect(vagas.some((x) => x.id === id), `vaga ${id}`).to.eq(true));
      expect(vagas.find((x) => x.id === v.encerrada).agendamento_aberto).to.eq(false);
    });
  });
});
