import { USUARIOS, CURSO_A, API_URL } from '../../support/dados';
import { criarVaga, registrarDisciplina, inserirVagaNoBanco, agendar } from '../../support/apiHelpers';
import { dataSP } from '../../support/datas';

const unico = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

describe('API: cadastro de disciplinas', () => {
  const t = {};

  before(() => {
    cy.task('prepararBanco');
    cy.tokenDe(USUARIOS.coord).then((x) => { t.coord = x; });
    cy.tokenDe(USUARIOS.alunoA1).then((x) => { t.a1 = x; });
  });

  const listar = (consulta = '') => cy.api('GET', `/api/disciplinas${consulta}`, { token: t.coord });
  const criar = (nome) => cy.api('POST', '/api/disciplinas', { token: t.coord, body: { nome } });
  const alterar = (id, ativa) => cy.api('POST', '/api/alterar-status-disciplina', { token: t.coord, body: { id, ativa } });
  const idDe = (nome) => listar().then((r) => r.body.find((d) => d.nome === nome).id);

  it('já vêm as disciplinas A, B e C, ativas', () => {
    listar().then((r) => {
      expect(r.status).to.eq(200);
      ['A', 'B', 'C'].forEach((nome) => {
        const d = r.body.find((x) => x.nome === nome);
        expect(d, `disciplina ${nome}`).to.exist;
        expect(d.ativa).to.eq(true);
      });
    });
  });

  it('cria uma disciplina, mostra na lista (com quem criou) e registra na auditoria', () => {
    const nome = `CY-Disc ${unico()}`;
    criar(nome).then((r) => {
      expect(r.status, JSON.stringify(r.body)).to.eq(200);
      expect(r.body.id).to.be.a('number');
    });
    listar().then((r) => {
      const d = r.body.find((x) => x.nome === nome);
      expect(d).to.deep.include({ ativa: true, criado_por: USUARIOS.coord.nome });
      expect(d.criado_em).to.be.a('string');
    });
    cy.api('GET', '/api/auditoria', { token: t.coord }).then((r) => {
      expect(r.body.logs.some((l) => l.acao === 'CADASTRO_DISCIPLINA' && l.descricao.includes(nome))).to.eq(true);
    });
  });

  it('apara espaços e junta espaços repetidos no meio do nome', () => {
    const n = unico();
    criar(`   CY-Dois    Espacos ${n}  `).its('status').should('eq', 200);
    listar().then((r) => expect(r.body.some((d) => d.nome === `CY-Dois Espacos ${n}`)).to.eq(true));
  });

  it('não aceita nome repetido (sem diferenciar maiúsculas nem espaços): 409', () => {
    const nome = `CY-Repetida ${unico()}`;
    criar(nome).its('status').should('eq', 200);
    [nome.toLowerCase(), `  ${nome.toUpperCase()}  `].forEach((variacao) => {
      criar(variacao).then((r) => {
        expect(r.status, variacao).to.eq(409);
        expect(r.body.mensagem).to.contain('já está cadastrada');
      });
    });
  });

  it('nome vazio ou com mais de 100 caracteres: 400', () => {
    criar('').its('status').should('eq', 400);
    criar('   ').its('status').should('eq', 400);
    criar('x'.repeat(101)).its('status').should('eq', 400);
    cy.api('POST', '/api/disciplinas', { token: t.coord, body: {} }).its('status').should('eq', 400);
  });

  it('lista com as ativas primeiro e filtro ?ativas=1', () => {
    const nome = `CY-Inativa ${unico()}`;
    criar(nome);
    idDe(nome).then((id) => alterar(id, false).its('status').should('eq', 200));
    listar().then((r) => {
      const primeiraInativa = r.body.findIndex((d) => d.ativa === false);
      const ultimaAtiva = r.body.map((d) => d.ativa).lastIndexOf(true);
      expect(primeiraInativa).to.be.greaterThan(ultimaAtiva);
    });
    listar('?ativas=1').then((r) => {
      expect(r.body.every((d) => d.ativa === true)).to.eq(true);
      expect(r.body.some((d) => d.nome === nome)).to.eq(false);
    });
  });

  it('inativar: informa quantas vagas futuras seguem valendo e as vagas e agendamentos continuam funcionando', () => {
    criarVaga(t.coord).then((v) => {
      agendar(t.a1, v.id).its('status').should('eq', 200);
      idDe(v.disciplina).then((id) => {
        alterar(id, false).then((r) => {
          expect(r.status, JSON.stringify(r.body)).to.eq(200);
          expect(r.body.vagas_futuras).to.eq(1);
          expect(r.body.mensagem).to.contain('1 vaga(s) futura(s)');
        });
      });
      cy.api('GET', '/api/meus-agendamentos', { token: t.a1 }).then((m) => {
        expect(m.body.some((a) => a.vaga_id === v.id)).to.eq(true);
      });
      cy.api('GET', '/api/vagas', { token: t.a1 }).then((r) => expect(r.body.some((x) => x.id === v.id)).to.eq(true));
    });
  });

  it('disciplina inativa não aceita novas vagas; ao reativar volta a aceitar', () => {
    const nome = `CY-Pausa ${unico()}`;
    const corpo = { polo: 'Polo CY', curso: CURSO_A, disciplina: nome, data: dataSP(10), horario_inicio: '08:00', horario_fim: '10:00', limite_vagas: 5 };
    criar(nome);
    idDe(nome).then((id) => {
      alterar(id, false).its('status').should('eq', 200);
      cy.api('POST', '/api/cadastrar-vaga', { token: t.coord, body: corpo }).then((r) => {
        expect(r.status).to.eq(400);
        expect(r.body.mensagem).to.contain('inativa');
      });
      alterar(id, true).then((r) => {
        expect(r.status).to.eq(200);
        expect(r.body.mensagem).to.contain('reativada');
      });
      cy.api('POST', '/api/cadastrar-vaga', { token: t.coord, body: corpo }).its('status').should('eq', 200);
    });
  });

  it('inativar e reativar vão para a auditoria', () => {
    const nome = `CY-Aud ${unico()}`;
    criar(nome);
    idDe(nome).then((id) => {
      alterar(id, false);
      alterar(id, true);
    });
    cy.api('GET', '/api/auditoria', { token: t.coord }).then((r) => {
      expect(r.body.logs.some((l) => l.acao === 'INATIVACAO_DISCIPLINA' && l.descricao.includes(nome))).to.eq(true);
      expect(r.body.logs.some((l) => l.acao === 'REATIVACAO_DISCIPLINA' && l.descricao.includes(nome))).to.eq(true);
    });
  });

  it('status: repetir a mesma ação é 409; inexistente 404; inválido 400', () => {
    const nome = `CY-Status ${unico()}`;
    criar(nome);
    idDe(nome).then((id) => {
      alterar(id, true).then((r) => {
        expect(r.status).to.eq(409);
        expect(r.body.mensagem).to.contain('já está ativa');
      });
      alterar(id, false).its('status').should('eq', 200);
      alterar(id, false).then((r) => {
        expect(r.status).to.eq(409);
        expect(r.body.mensagem).to.contain('já está inativa');
      });
    });
    alterar(999999999, false).its('status').should('eq', 404);
    alterar('abc', false).its('status').should('eq', 400);
    cy.api('POST', '/api/alterar-status-disciplina', { token: t.coord, body: {} }).its('status').should('eq', 400);
  });

  it('nada é apagado: a disciplina inativada continua na tabela', () => {
    const nome = `CY-Guardada ${unico()}`;
    criar(nome);
    idDe(nome).then((id) => alterar(id, false));
    cy.bd('SELECT ativa FROM disciplinas WHERE nome = $1', [nome]).then((rows) => {
      expect(rows).to.have.length(1);
      expect(rows[0].ativa).to.eq(false);
    });
  });
});

describe('API: vaga só com disciplina cadastrada', () => {
  const t = {};

  before(() => {
    cy.task('prepararBanco');
    cy.tokenDe(USUARIOS.coord).then((x) => { t.coord = x; });
  });

  const corpo = (disciplina) => ({
    polo: 'Polo CY', curso: CURSO_A, disciplina, data: dataSP(10), horario_inicio: '08:00', horario_fim: '10:00', limite_vagas: 5
  });

  it('disciplina que não está no cadastro: 400 e nada é gravado', () => {
    const nome = `CY-NaoExiste ${unico()}`;
    cy.api('POST', '/api/cadastrar-vaga', { token: t.coord, body: corpo(nome) }).then((r) => {
      expect(r.status).to.eq(400);
      expect(r.body.mensagem).to.contain('não cadastrada');
    });
    cy.bd('SELECT COUNT(*)::int AS n FROM vagas WHERE disciplina = $1', [nome]).then((rows) => expect(rows[0].n).to.eq(0));
  });

  it('as disciplinas iniciais A, B e C funcionam', () => {
    ['A', 'B', 'C'].forEach((nome, i) => {
      cy.api('POST', '/api/cadastrar-vaga', { token: t.coord, body: { ...corpo(nome), polo: `Polo CY Disc ${unico()}${i}` } }).its('status').should('eq', 200);
    });
  });

  it('grava o nome oficial da disciplina, mesmo que venha com outra caixa ou espaços', () => {
    const oficial = `CY-Oficial ${unico()}`;
    registrarDisciplina(t.coord, oficial);
    cy.api('POST', '/api/cadastrar-vaga', { token: t.coord, body: corpo(`  ${oficial.toLowerCase()}  `) }).then((r) => {
      expect(r.status, JSON.stringify(r.body)).to.eq(200);
      cy.bd('SELECT disciplina FROM vagas WHERE id = $1', [r.body.id]).then((rows) => expect(rows[0].disciplina).to.eq(oficial));
    });
  });
});

describe('API: não permitir agenda duplicada', () => {
  const t = {};
  const n = unico();
  const disciplina = `CY-Dup ${n}`;

  before(() => {
    cy.task('prepararBanco');
    cy.tokenDe(USUARIOS.coord).then((x) => { t.coord = x; });
    cy.then(() => registrarDisciplina(t.coord, disciplina));
  });

  const corpo = (extra = {}) => ({
    polo: 'Polo CY Dup', curso: CURSO_A, disciplina, data: dataSP(10), horario_inicio: '08:00', horario_fim: '10:00', limite_vagas: 5, ...extra
  });
  const cadastrar = (c) => cy.api('POST', '/api/cadastrar-vaga', { token: t.coord, body: c });
  const total = (polo) => cy.bd('SELECT COUNT(*)::int AS n FROM vagas WHERE disciplina = $1 AND polo = $2', [disciplina, polo]).then((rows) => rows[0].n);

  it('mesma disciplina, polo, data e horário de início: o segundo é recusado (409)', () => {
    const polo = `Polo CY Dup A ${n}`;
    cadastrar(corpo({ polo })).its('status').should('eq', 200);
    cadastrar(corpo({ polo })).then((r) => {
      expect(r.status, JSON.stringify(r.body)).to.eq(409);
      expect(r.body.mensagem).to.eq('Já existe uma vaga desta disciplina para este curso, neste polo, na mesma data e horário.');
    });
    total(polo).should('eq', 1);
  });

  it('o horário de fim diferente não evita a duplicidade; a caixa da disciplina também não', () => {
    const polo = `Polo CY Dup B ${n}`;
    cadastrar(corpo({ polo })).its('status').should('eq', 200);
    cadastrar(corpo({ polo, horario_fim: '11:30' })).its('status').should('eq', 409);
    cadastrar(corpo({ polo, disciplina: disciplina.toLowerCase() })).its('status').should('eq', 409);
  });

  // mudou com a correção "mesma prova para cursos diferentes" (testes exploratórios da coordenação):
  // antes o outro curso era recusado; agora cada curso pode ter a sua vaga, e só repete o mesmo curso
  it('outro curso no mesmo polo, data e horário é permitido; o mesmo curso de novo não', () => {
    const polo = `Polo CY Dup C ${n}`;
    cadastrar(corpo({ polo })).its('status').should('eq', 200);
    cadastrar(corpo({ polo, curso: 'CY Curso B' })).its('status').should('eq', 200);
    cadastrar(corpo({ polo, curso: 'CY Curso B' })).its('status').should('eq', 409);
    total(polo).should('eq', 2);
  });

  it('mudando o horário de início, a data ou o polo, é permitido', () => {
    const polo = `Polo CY Dup D ${n}`;
    cadastrar(corpo({ polo })).its('status').should('eq', 200);
    cadastrar(corpo({ polo, horario_inicio: '14:00', horario_fim: '16:00' })).its('status').should('eq', 200);
    cadastrar(corpo({ polo, data: dataSP(11) })).its('status').should('eq', 200);
    cadastrar(corpo({ polo: `${polo} outro` })).its('status').should('eq', 200);
  });

  it('duas criações ao mesmo tempo: só uma passa', () => {
    const polo = `Polo CY Dup E ${n}`;
    const chamada = { method: 'POST', url: `${API_URL}/api/cadastrar-vaga`, headers: { Authorization: `Bearer ${t.coord}` }, body: corpo({ polo }) };
    cy.task('paralelo', [chamada, chamada, chamada]).then((rs) => {
      expect(rs.filter((r) => r.status === 200), JSON.stringify(rs)).to.have.length(1);
      rs.filter((r) => r.status !== 200).forEach((r) => expect(r.status).to.eq(409));
    });
    total(polo).should('eq', 1);
  });

  it('o banco também recusa a duplicata (proteção extra, mesmo fora do servidor)', () => {
    const polo = `Polo CY Dup F ${n}`;
    cadastrar(corpo({ polo })).its('status').should('eq', 200);
    cy.task('bdTentar', {
      sql: `INSERT INTO vagas (polo, curso, disciplina, data_prova, horario, limite_vagas) VALUES ($1, $2, $3, $4, '08:00', 5)`,
      params: [polo, CURSO_A, disciplina, dataSP(10)]
    }).then((r) => expect(r.erro, 'precisa rodar a migracao_parte_e.sql no banco de teste').to.contain('uq_vagas_polo_disciplina_curso_data_hora'));
  });
});

describe('API: lista de vagas para o gestor', () => {
  const t = {};

  before(() => {
    cy.task('prepararBanco');
    cy.tokenDe(USUARIOS.coord).then((x) => { t.coord = x; });
    cy.tokenDe(USUARIOS.alunoA1).then((x) => { t.a1 = x; });
  });

  const lista = () => cy.api('GET', '/api/vagas-gestao', { token: t.coord }).then((r) => {
    expect(r.status).to.eq(200);
    return r.body;
  });

  it('traz a vaga com ocupação, data/hora do cadastro e quem cadastrou', () => {
    criarVaga(t.coord, { limite_vagas: 3, horario_inicio: '09:00', horario_fim: '11:00' }).then((v) => {
      agendar(t.a1, v.id).its('status').should('eq', 200);
      lista().then((vagas) => {
        const x = vagas.find((o) => o.id === v.id);
        expect(x).to.deep.include({
          polo: 'Polo CY', curso: CURSO_A, disciplina: v.disciplina, data_prova: v.data,
          horario: '09:00:00', horario_fim: '11:00:00', limite_vagas: 3, ocupadas: 1, futura: true, criado_por: USUARIOS.coord.nome
        });
        expect(Math.abs(Date.now() - new Date(x.criado_em).getTime()), 'criado_em recente').to.be.lessThan(120000);
      });
    });
  });

  it('as vagas mais novas vêm primeiro', () => {
    criarVaga(t.coord).then((v1) => {
      criarVaga(t.coord).then((v2) => {
        lista().then((vagas) => {
          const ids = vagas.map((x) => x.id);
          expect(ids.indexOf(v2.id)).to.be.lessThan(ids.indexOf(v1.id));
        });
      });
    });
  });

  it('inclui as vagas passadas (marcadas como não futuras) e as de agendamento encerrado', () => {
    inserirVagaNoBanco({ disciplina: `CY-passada-${unico()}`, data: dataSP(-2) }).then((idPassada) => {
      inserirVagaNoBanco({ disciplina: `CY-encerrada-${unico()}`, data: dataSP(10), agInicio: dataSP(-6), agFim: dataSP(-1) }).then((idEncerrada) => {
        lista().then((vagas) => {
          expect(vagas.find((x) => x.id === idPassada).futura).to.eq(false);
          expect(vagas.find((x) => x.id === idEncerrada).futura).to.eq(true);
          expect(vagas.find((x) => x.id === idEncerrada).agendamento_fim).to.eq(dataSP(-1));
        });
      });
    });
  });

  it('vaga antiga sem data de cadastro aparece com criado_em nulo e no fim da lista', () => {
    inserirVagaNoBanco({ disciplina: `CY-antiga-${unico()}`, data: dataSP(10) }).then((id) => {
      cy.bd('UPDATE vagas SET criado_em = NULL, criado_por = NULL WHERE id = $1', [id]);
      lista().then((vagas) => {
        const x = vagas.find((o) => o.id === id);
        expect(x.criado_em).to.be.null;
        expect(x.criado_por).to.be.null;
        const comData = vagas.filter((o) => o.criado_em !== null).length;
        expect(vagas.findIndex((o) => o.id === id)).to.be.at.least(comData);
      });
    });
  });

  it('cancelar um agendamento reduz a ocupação', () => {
    criarVaga(t.coord, { limite_vagas: 4 }).then((v) => {
      agendar(t.a1, v.id).then((r) => {
        lista().then((vagas) => expect(vagas.find((x) => x.id === v.id).ocupadas).to.eq(1));
        cy.api('POST', '/api/cancelar-agendamento', { token: t.a1, body: { agendamento_id: r.body.agendamento.id } }).its('status').should('eq', 200);
        lista().then((vagas) => expect(vagas.find((x) => x.id === v.id).ocupadas).to.eq(0));
      });
    });
  });

  it('aluno não acessa (403)', () => {
    cy.api('GET', '/api/vagas-gestao', { token: t.a1 }).its('status').should('eq', 403);
  });
});
