import { USUARIOS, CURSO_A } from '../../support/dados';
import { criarVaga, criarUsuario, criarUsuarioAtivo, agendar } from '../../support/apiHelpers';
import { vagaEmHoras } from '../../support/datas';

const base64url = (obj) =>
  Cypress.Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

describe('API: trilha de auditoria', () => {
  const t = {};

  before(() => {
    cy.task('prepararBanco');
    cy.tokenDe(USUARIOS.coord).then((x) => { t.coord = x; });
    cy.tokenDe(USUARIOS.audit).then((x) => { t.audit = x; });
    cy.tokenDe(USUARIOS.alunoA1).then((x) => { t.a1 = x; });
  });

  it('o coordenador lê no máximo 50 logs, do mais novo para o mais antigo', () => {
    criarVaga(t.coord);
    cy.api('GET', '/api/auditoria', { token: t.coord }).then((r) => {
      expect(r.status).to.eq(200);
      expect(r.body.logs.length).to.be.within(1, 50);
      expect(r.body.logs[0]).to.include.keys('id', 'acao', 'descricao', 'ip', 'data_hora', 'usuario');
      const tempos = r.body.logs.map((l) => new Date(l.data_hora).getTime());
      tempos.slice(1).forEach((tempo, i) => expect(tempo).to.be.at.most(tempos[i]));
    });
  });

  it('cada ação grava quem fez (nome) e o IP', () => {
    criarVaga(t.coord).then((v) => {
      cy.api('GET', '/api/auditoria', { token: t.coord }).then((r) => {
        const log = r.body.logs.find((l) => l.acao === 'ADICAO_VAGAS' && l.descricao.includes(v.disciplina));
        expect(log.usuario).to.eq(USUARIOS.coord.nome);
        expect(log.ip).to.be.a('string').and.not.be.empty;
      });
    });
  });

  it('login com senha errada vira LOGIN_FALHA (sem usuário, com a matrícula tentada)', () => {
    const tentada = `TENTATIVA_${Date.now()}`;
    cy.loginApi(tentada, 'x').its('status').should('eq', 401);
    cy.api('GET', '/api/auditoria', { token: t.coord }).then((r) => {
      const log = r.body.logs.find((l) => l.acao === 'LOGIN_FALHA' && l.descricao.includes(tentada));
      expect(log, 'log da falha de login').to.exist;
      expect(log.usuario).to.be.null;
    });
  });

  it('o perfil AUDIT lê as estatísticas e até 50 logs por página; o coordenador não acessa essa rota', () => {
    cy.api('GET', '/api/admin/auditoria-completa', { token: t.audit }).then((r) => {
      expect(r.status).to.eq(200);
      expect(r.body.sucesso).to.eq(true);
      ['totalTransacoes', 'registrosInativos', 'violacoes24h'].forEach((k) => expect(r.body.estatisticas[k]).to.be.a('number'));
      expect(r.body.logs.length).to.be.at.most(50);
    });
    cy.api('GET', '/api/admin/auditoria-completa', { token: t.coord }).its('status').should('eq', 403);
  });

  it('"violações 24h" sobe quando um cancelamento é bloqueado', () => {
    cy.api('GET', '/api/admin/auditoria-completa', { token: t.audit }).then((antes) => {
      const { data, inicio, fim } = vagaEmHoras(2);
      criarVaga(t.coord, { data, horario_inicio: inicio, horario_fim: fim }).then((v) => {
        agendar(t.a1, v.id).then((r) => {
          cy.api('POST', '/api/cancelar-agendamento', { token: t.a1, body: { agendamento_id: r.body.agendamento.id } }).its('status').should('eq', 400);
          cy.api('GET', '/api/admin/auditoria-completa', { token: t.audit }).then((depois) => {
            expect(depois.body.estatisticas.violacoes24h).to.be.at.least(antes.body.estatisticas.violacoes24h + 1);
            expect(depois.body.estatisticas.totalTransacoes).to.be.greaterThan(antes.body.estatisticas.totalTransacoes);
          });
        });
      });
    });
  });

  it('"registros inativos" conta agendamentos cancelados', () => {
    cy.api('GET', '/api/admin/auditoria-completa', { token: t.audit }).then((antes) => {
      criarVaga(t.coord).then((v) => {
        agendar(t.a1, v.id).then((r) => {
          cy.api('POST', '/api/cancelar-agendamento', { token: t.a1, body: { agendamento_id: r.body.agendamento.id } }).its('status').should('eq', 200);
          cy.api('GET', '/api/admin/auditoria-completa', { token: t.audit }).then((depois) => {
            expect(depois.body.estatisticas.registrosInativos).to.eq(antes.body.estatisticas.registrosInativos + 1);
          });
        });
      });
    });
  });

  it('a tabela é imutável: o banco recusa UPDATE e DELETE', () => {
    cy.task('bdTentar', { sql: `UPDATE auditoria SET descricao = 'adulterado' WHERE id = (SELECT MIN(id) FROM auditoria)` }).then((r) => {
      expect(r.erro).to.contain('imutável');
    });
    cy.task('bdTentar', { sql: 'DELETE FROM auditoria WHERE id = (SELECT MIN(id) FROM auditoria)' }).then((r) => {
      expect(r.erro).to.contain('imutável');
    });
  });
});

describe('API: tokens e identidade', () => {
  const t = {};
  const ids = {};

  before(() => {
    cy.task('prepararBanco');
    cy.tokenDe(USUARIOS.coord).then((x) => { t.coord = x; });
    cy.tokenDe(USUARIOS.alunoA1).then((x) => { t.a1 = x; });
    cy.bd('SELECT matricula, id FROM usuarios WHERE matricula IN ($1, $2)', [USUARIOS.coord.matricula, USUARIOS.alunoA1.matricula]).then((rows) => {
      rows.forEach((r) => { ids[r.matricula] = r.id; });
    });
  });

  it('token com o corpo (payload) adulterado é recusado', () => {
    const [cab, , assinatura] = t.a1.split('.');
    const forjado = `${cab}.${base64url({ id: ids[USUARIOS.alunoA1.matricula], perfil: 'coordenador', tipo: 'coordenador' })}.${assinatura}`;
    cy.api('GET', '/api/cursos', { token: forjado }).its('status').should('eq', 401);
  });

  it('token sem assinatura (alg "none") é recusado', () => {
    const semAssinatura = `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url({ id: ids[USUARIOS.coord.matricula], perfil: 'coordenador' })}.`;
    cy.api('GET', '/api/cursos', { token: semAssinatura }).its('status').should('eq', 401);
  });

  it('token com assinatura trocada é recusado', () => {
    const partes = t.coord.split('.');
    cy.api('GET', '/api/cursos', { token: `${partes[0]}.${partes[1]}.${'A'.repeat(43)}` }).its('status').should('eq', 401);
  });

  it('token expirado é recusado', () => {
    cy.task('gerarToken', { payload: { id: ids[USUARIOS.coord.matricula], perfil: 'coordenador' }, opcoes: { expiresIn: -60 } }).then((expirado) => {
      cy.api('GET', '/api/cursos', { token: expirado }).then((r) => {
        expect(r.status).to.eq(401);
        expect(r.body.mensagem).to.contain('inválida ou expirada');
      });
    });
  });

  it('token válido de usuário que não existe mais é recusado', () => {
    cy.task('gerarToken', { payload: { id: 999999999, perfil: 'coordenador' } }).then((token) => {
      cy.api('GET', '/api/cursos', { token }).then((r) => {
        expect(r.status).to.eq(401);
        expect(r.body.mensagem).to.contain('desativada ou inexistente');
      });
    });
  });

  it('o perfil vem do banco: token assinado "como coordenador" para um aluno não dá poderes', () => {
    cy.task('gerarToken', { payload: { id: ids[USUARIOS.alunoA1.matricula], perfil: 'coordenador', tipo: 'coordenador' } }).then((token) => {
      cy.api('GET', '/api/cursos', { token }).its('status').should('eq', 403);
      cy.api('GET', '/api/meus-agendamentos', { token }).its('status').should('eq', 200); // continua sendo aluno
    });
  });

  it('mudar o tipo do usuário no banco vale já na próxima chamada (sem novo login)', () => {
    criarUsuarioAtivo(t.coord).then((u) => {
      cy.api('GET', '/api/usuarios', { token: u.token }).its('status').should('eq', 403);
      cy.bd(`UPDATE usuarios SET tipo = 'coordenador' WHERE id = $1`, [u.id]);
      cy.api('GET', '/api/usuarios', { token: u.token }).its('status').should('eq', 200);
    });
  });
});

describe('API: proteções gerais do servidor', () => {
  const t = {};

  before(() => {
    cy.task('prepararBanco');
    cy.tokenDe(USUARIOS.coord).then((x) => { t.coord = x; });
  });

  it('cabeçalhos de segurança (helmet) presentes e sem "x-powered-by"', () => {
    cy.api('GET', '/api/vagas').then((r) => {
      expect(r.headers['x-content-type-options']).to.eq('nosniff');
      expect(r.headers).to.not.have.property('x-powered-by');
    });
  });

  it('CORS: origem desconhecida é recusada; a origem do front de teste é aceita', () => {
    cy.api('GET', '/api/vagas', { headers: { Origin: 'http://site-malicioso.example' } }).then((r) => {
      expect(r.status).to.eq(403);
      expect(r.body.mensagem).to.contain('Origem não permitida');
    });
    const origemFront = Cypress.config('baseUrl');
    cy.api('GET', '/api/vagas', { headers: { Origin: origemFront } }).then((r) => {
      expect(r.status, `adicione ${origemFront} em ALLOWED_ORIGINS do .env.teste`).to.eq(401);
      expect(r.headers['access-control-allow-origin']).to.eq(origemFront);
    });
  });

  it('JSON malformado: 400 (e não 500)', () => {
    cy.api('POST', '/api/login', { headers: { 'Content-Type': 'application/json' }, body: '{"matricula": ' }).then((r) => {
      expect(r.status).to.eq(400);
      expect(r.body.mensagem).to.eq('JSON inválido.');
    });
  });

  it('corpo acima de 100 KB nas rotas comuns: 413', () => {
    cy.api('POST', '/api/login', { body: { matricula: 'x'.repeat(150000), senha: 'y' } }).its('status').should('eq', 413);
  });

  it('rota inexistente devolve 404 em JSON', () => {
    cy.api('GET', '/api/nao-existe').then((r) => {
      expect(r.status).to.eq(404);
      expect(r.body).to.deep.include({ sucesso: false });
    });
  });

  it('injeção de SQL nos filtros não vaza dados nem derruba nada', () => {
    const ataque = "' OR '1'='1";
    cy.api('GET', `/api/usuarios?busca=${encodeURIComponent(ataque)}`, { token: t.coord }).then((r) => {
      expect(r.status).to.eq(200);
      expect(r.body).to.have.length(0);
    });
    cy.tokenDe(USUARIOS.recepcao).then((rec) => {
      cy.api('GET', `/api/portaria/consultar?busca=${encodeURIComponent(ataque)}`, { token: rec }).then((r) => {
        expect(r.status).to.eq(200);
        expect(r.body.encontrado).to.eq(false);
      });
      cy.api('GET', `/api/portaria/por-data?data=${encodeURIComponent("2030-01-01'; DROP TABLE usuarios;--")}`, { token: rec }).its('status').should('eq', 400);
    });
    cy.bd('SELECT COUNT(*)::int AS n FROM usuarios').then((rows) => expect(rows[0].n).to.be.greaterThan(5));
  });

  it('nenhuma resposta de erro expõe detalhes internos (stack, SQL)', () => {
    ['/api/vagas', '/api/usuarios?busca=%00'].forEach((caminho) => {
      cy.api('GET', caminho, { token: t.coord }).then((r) => {
        const texto = JSON.stringify({ ...r.body, detalhe: undefined }); // 'detalhe' só existe no modo de teste
        expect(texto).to.not.match(/at .*\.js:\d+|SELECT .* FROM|pg_catalog|stack/i);
      });
    });
    cy.api('POST', '/api/agendar', { token: t.coord, body: { vaga_id: 1 } }).then((r) => {
      expect(JSON.stringify({ ...r.body, detalhe: undefined })).to.not.match(/at .*\.js:\d+|SELECT .* FROM|stack/i);
    });
  });
});
