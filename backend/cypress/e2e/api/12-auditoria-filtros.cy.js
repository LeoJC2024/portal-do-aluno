import { USUARIOS } from '../../support/dados';

// A auditoria é imutável (não dá para apagar o que o teste insere). Por isso os registros deste arquivo:
// - usam datas de 2001, que ficam no FIM da ordenação e não empurram os logs recentes que outros testes procuram;
// - levam na descrição uma marca única desta execução, usada na busca para isolar só o que foi inserido aqui.
// (uma marca não pode conter a outra, senão a busca de uma traria os registros da outra)
const execucao = `CYAUD${Date.now()}${Math.floor(Math.random() * 1000)}`;
const marca = `${execucao}F`;
const marcaPag = `${execucao}P`;
const TOTAL_PAG = 120;

// data_hora é gravada em UTC. Em março de 2001 São Paulo estava em UTC-3 (sem horário de verão).
const REGISTROS = [
  { chave: 'falha', acao: 'LOGIN_FALHA', usuario: null, ip: '10.77.0.1', utc: '2001-03-05 12:00:00' },       // SP 05/03 09:00
  { chave: 'vaga1', acao: 'ADICAO_VAGAS', usuario: 'Cy Auditor', ip: '10.77.0.2', utc: '2001-03-09 15:00:00' }, // SP 09/03 12:00
  { chave: 'vaga2', acao: 'ADICAO_VAGAS', usuario: 'Cy Auditor', ip: '192.168.5.5', utc: '2001-03-10 02:30:00' }, // SP 09/03 23:30
  { chave: 'exclusao', acao: 'SOFT_DELETE', usuario: 'Cy Auditor', ip: '192.168.5.6', utc: '2001-03-10 03:30:00' }, // SP 10/03 00:30
  { chave: 'nota', acao: 'LANÇAMENTO_NOTA', usuario: 'Cy Outro', ip: '::ffff:10.77.0.9', utc: '2001-03-20 12:00:00' } // SP 20/03 09:00
];

const ROTA_COORD = '/api/auditoria';
const ROTA_AUDIT = '/api/admin/auditoria-completa';

const consulta = (params) => new URLSearchParams(params).toString();
const chaves = (logs) => logs.map((l) => l.descricao.split(' ')[1]).sort();

describe('API: auditoria com filtros e paginação', () => {
  const t = {};
  const ids = {};

  before(() => {
    cy.task('prepararBanco');
    cy.tokenDe(USUARIOS.coord).then((x) => { t.coord = x; });
    cy.tokenDe(USUARIOS.audit).then((x) => { t.audit = x; });
    cy.tokenDe(USUARIOS.recepcao).then((x) => { t.recepcao = x; });
    cy.tokenDe(USUARIOS.alunoA1).then((x) => { t.aluno = x; });

    REGISTROS.forEach((r) => {
      cy.bd(
        'INSERT INTO auditoria (acao, descricao, usuario, ip, data_hora) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [r.acao, `${marca} ${r.chave}`, r.usuario, r.ip, r.utc]
      ).then((rows) => { ids[r.chave] = rows[0].id; });
    });

    // 120 registros para a paginação, um por minuto em janeiro de 2001 (n = 1 é o mais antigo)
    cy.bd(
      `INSERT INTO auditoria (acao, descricao, usuario, ip, data_hora)
       SELECT 'ADICAO_VAGAS', $1 || ' n' || n, 'Cy Paginacao', '10.88.0.1', TIMESTAMP '2001-01-15 12:00:00' + n * INTERVAL '1 minute'
         FROM generate_series(1, $2::int) AS n`,
      [marcaPag, TOTAL_PAG]
    );
  });

  // ---------------------------------------------------------------- formato e padrão
  [[ROTA_COORD, 'coord'], [ROTA_AUDIT, 'audit']].forEach(([rota, perfil]) => {
    it(`${rota}: sem parâmetros devolve a página 1 com 50 por página, total e total de páginas`, () => {
      cy.api('GET', rota, { token: t[perfil] }).then((r) => {
        expect(r.status, JSON.stringify(r.body)).to.eq(200);
        expect(r.body.sucesso).to.eq(true);
        expect(r.body.pagina).to.eq(1);
        expect(r.body.limite).to.eq(50);
        expect(r.body.total).to.be.a('number').and.be.at.least(REGISTROS.length + TOTAL_PAG);
        expect(r.body.totalPaginas).to.eq(Math.ceil(r.body.total / 50));
        expect(r.body.logs).to.have.length(50);
        expect(r.body.logs[0]).to.have.all.keys('id', 'acao', 'descricao', 'usuario', 'ip', 'data_hora');
      });
    });
  });

  // ---------------------------------------------------------------- filtros
  it('busca: encontra pela descrição e isola só os registros deste teste', () => {
    cy.api('GET', `${ROTA_COORD}?${consulta({ busca: marca })}`, { token: t.coord }).then((r) => {
      expect(r.status).to.eq(200);
      expect(r.body.total).to.eq(REGISTROS.length);
      expect(chaves(r.body.logs)).to.deep.eq(['exclusao', 'falha', 'nota', 'vaga1', 'vaga2']);
    });
  });

  it('busca: também acha pelo usuário, pelo IP e pelo id exato do log', () => {
    cy.api('GET', `${ROTA_COORD}?${consulta({ busca: 'Cy Outro' })}`, { token: t.coord }).then((r) => {
      expect(r.body.logs.some((l) => l.id === ids.nota)).to.eq(true);
    });
    cy.api('GET', `${ROTA_COORD}?${consulta({ busca: '192.168.5.6', acao: 'SOFT_DELETE' })}`, { token: t.coord }).then((r) => {
      expect(r.body.logs.some((l) => l.id === ids.exclusao)).to.eq(true);
    });
    // o id também pode aparecer como parte de outros textos; os demais filtros deixam só registros iguais a este
    const soVaga1 = { acao: 'ADICAO_VAGAS', ip: '10.77.0.2', data_inicio: '2001-03-09', data_fim: '2001-03-09' };
    cy.api('GET', `${ROTA_COORD}?${consulta({ busca: String(ids.vaga1), ...soVaga1 })}`, { token: t.coord }).then((r) => {
      expect(r.status).to.eq(200);
      expect(r.body.logs.some((l) => l.id === ids.vaga1)).to.eq(true);
    });
  });

  it('período: as datas são dias do fuso de São Paulo (inclui o dia inicial e o final inteiros)', () => {
    // 10/03 em São Paulo: só a exclusão (00:30). A vaga2 é 02:30 UTC de 10/03, mas 23:30 de 09/03 em SP
    cy.api('GET', `${ROTA_COORD}?${consulta({ busca: marca, data_inicio: '2001-03-10', data_fim: '2001-03-10' })}`, { token: t.coord }).then((r) => {
      expect(r.status).to.eq(200);
      expect(chaves(r.body.logs)).to.deep.eq(['exclusao']);
      expect(r.body.total).to.eq(1);
    });
    cy.api('GET', `${ROTA_COORD}?${consulta({ busca: marca, data_fim: '2001-03-09' })}`, { token: t.coord }).then((r) => {
      expect(chaves(r.body.logs)).to.deep.eq(['falha', 'vaga1', 'vaga2']);
    });
    cy.api('GET', `${ROTA_COORD}?${consulta({ busca: marca, data_inicio: '2001-03-10' })}`, { token: t.coord }).then((r) => {
      expect(chaves(r.body.logs)).to.deep.eq(['exclusao', 'nota']);
    });
  });

  it('IP: filtra por parte do endereço (inclusive no formato ::ffff:)', () => {
    cy.api('GET', `${ROTA_COORD}?${consulta({ busca: marca, ip: '10.77.0' })}`, { token: t.coord }).then((r) => {
      expect(r.status).to.eq(200);
      expect(chaves(r.body.logs)).to.deep.eq(['falha', 'nota', 'vaga1']);
    });
    cy.api('GET', `${ROTA_COORD}?${consulta({ busca: marca, ip: '192.168.5.5' })}`, { token: t.coord }).then((r) => {
      expect(chaves(r.body.logs)).to.deep.eq(['vaga2']);
    });
  });

  it('tipo de ação: filtro exato (aceita minúsculas e acentos)', () => {
    cy.api('GET', `${ROTA_COORD}?${consulta({ busca: marca, acao: 'ADICAO_VAGAS' })}`, { token: t.coord }).then((r) => {
      expect(r.status).to.eq(200);
      expect(chaves(r.body.logs)).to.deep.eq(['vaga1', 'vaga2']);
      r.body.logs.forEach((l) => expect(l.acao).to.eq('ADICAO_VAGAS'));
    });
    cy.api('GET', `${ROTA_COORD}?${consulta({ busca: marca, acao: 'lançamento_nota' })}`, { token: t.coord }).then((r) => {
      expect(chaves(r.body.logs)).to.deep.eq(['nota']);
    });
    // "ADICAO" sozinho não é uma ação: o filtro de ação não é por parte do nome
    cy.api('GET', `${ROTA_COORD}?${consulta({ busca: marca, acao: 'ADICAO' })}`, { token: t.coord }).then((r) => {
      expect(r.body.total).to.eq(0);
      expect(r.body.logs).to.have.length(0);
    });
  });

  it('filtros combinados (período + IP + ação) se somam', () => {
    const params = { busca: marca, data_inicio: '2001-03-01', data_fim: '2001-03-09', ip: '192.168', acao: 'ADICAO_VAGAS' };
    cy.api('GET', `${ROTA_COORD}?${consulta(params)}`, { token: t.coord }).then((r) => {
      expect(r.status).to.eq(200);
      expect(chaves(r.body.logs)).to.deep.eq(['vaga2']);
      expect(r.body.total).to.eq(1);
      expect(r.body.totalPaginas).to.eq(1);
    });
  });

  it('o auditor usa os mesmos filtros, e os contadores do topo continuam sobre todos os registros', () => {
    cy.api('GET', ROTA_AUDIT, { token: t.audit }).then((semFiltro) => {
      cy.api('GET', `${ROTA_AUDIT}?${consulta({ busca: marca, acao: 'SOFT_DELETE' })}`, { token: t.audit }).then((r) => {
        expect(r.status).to.eq(200);
        expect(chaves(r.body.logs)).to.deep.eq(['exclusao']);
        expect(r.body.total).to.eq(1);
        expect(r.body.estatisticas).to.deep.eq(semFiltro.body.estatisticas);
        expect(r.body.estatisticas.totalTransacoes).to.eq(semFiltro.body.total);
      });
    });
  });

  it('filtro sem nenhum resultado: lista vazia, total 0 e 1 página', () => {
    cy.api('GET', `${ROTA_COORD}?${consulta({ busca: `${marca}-nao-existe` })}`, { token: t.coord }).then((r) => {
      expect(r.status).to.eq(200);
      expect(r.body).to.deep.include({ total: 0, totalPaginas: 1, pagina: 1 });
      expect(r.body.logs).to.have.length(0);
    });
  });

  // ---------------------------------------------------------------- paginação
  it('paginação: 120 registros viram 3 páginas de 50, 50 e 20, sem repetir nem pular nenhum', () => {
    const vistos = [];
    [1, 2, 3].forEach((page) => {
      cy.api('GET', `${ROTA_COORD}?${consulta({ busca: marcaPag, page })}`, { token: t.coord }).then((r) => {
        expect(r.status).to.eq(200);
        expect(r.body).to.deep.include({ pagina: page, limite: 50, total: TOTAL_PAG, totalPaginas: 3 });
        expect(r.body.logs).to.have.length(page < 3 ? 50 : 20);
        vistos.push(...r.body.logs.map((l) => Number(l.descricao.split(' n')[1])));
      });
    });
    cy.then(() => {
      // do mais novo (n = 120) para o mais antigo (n = 1)
      expect(vistos).to.deep.eq(Array.from({ length: TOTAL_PAG }, (_, i) => TOTAL_PAG - i));
    });
  });

  it('paginação: o limite escolhido muda o total de páginas', () => {
    cy.api('GET', `${ROTA_COORD}?${consulta({ busca: marcaPag, limite: 100 })}`, { token: t.coord }).then((r) => {
      expect(r.body).to.deep.include({ limite: 100, totalPaginas: 2 });
      expect(r.body.logs).to.have.length(100);
    });
    cy.api('GET', `${ROTA_AUDIT}?${consulta({ busca: marcaPag, limite: 7, page: 18 })}`, { token: t.audit }).then((r) => {
      expect(r.body).to.deep.include({ pagina: 18, limite: 7, total: TOTAL_PAG, totalPaginas: 18 });
      expect(r.body.logs).to.have.length(1); // 120 = 17 * 7 + 1
    });
  });

  it('paginação: página depois da última devolve lista vazia, mas com o total correto', () => {
    cy.api('GET', `${ROTA_COORD}?${consulta({ busca: marcaPag, page: 4 })}`, { token: t.coord }).then((r) => {
      expect(r.status).to.eq(200);
      expect(r.body).to.deep.include({ pagina: 4, total: TOTAL_PAG, totalPaginas: 3 });
      expect(r.body.logs).to.have.length(0);
    });
  });

  // ---------------------------------------------------------------- parâmetros inválidos
  const INVALIDOS = [
    ['página 0', 'page=0', 'página'],
    ['página negativa', 'page=-1', 'página'],
    ['página decimal', 'page=1.5', 'página'],
    ['página com letras', 'page=2abc', 'página'],
    ['página em notação científica', 'page=1e2', 'página'],
    ['página acima do INTEGER', 'page=2147483648', 'página'],
    ['página repetida', 'page=1&page=2', 'page'],
    ['limite 0', 'limite=0', 'limite'],
    ['limite acima do teto (100)', 'limite=101', 'limite'],
    ['limite gigante', 'limite=1000000', 'limite'],
    ['limite com letras', 'limite=abc', 'limite'],
    ['data inicial inexistente', 'data_inicio=2030-02-30', 'Data inicial'],
    ['data inicial no formato brasileiro', 'data_inicio=30/05/2030', 'Data inicial'],
    ['data inicial com ano 0000', 'data_inicio=0000-01-01', 'Data inicial'],
    ['data final inválida', 'data_fim=2030-13-01', 'Data final'],
    ['data com SQL', `data_fim=${encodeURIComponent("2030-01-01'; DROP TABLE auditoria;--")}`, 'data final'],
    ['data inicial depois da final', 'data_inicio=2030-05-02&data_fim=2030-05-01', 'depois da data final'],
    ['IP com caracteres proibidos', `ip=${encodeURIComponent("1' OR '1'='1")}`, 'IP'],
    ['IP longo demais', `ip=${'1'.repeat(46)}`, 'IP'],
    ['ação com espaço e SQL', `acao=${encodeURIComponent('X; DROP TABLE auditoria')}`, 'ação'],
    ['ação longa demais', `acao=${'A'.repeat(51)}`, 'ação'],
    ['busca longa demais', `busca=${'x'.repeat(101)}`, 'busca'],
    ['busca com caractere de controle', 'busca=a%00b', 'busca']
  ];

  [ROTA_COORD, ROTA_AUDIT].forEach((rota) => {
    INVALIDOS.forEach(([nome, qs, trecho]) => {
      it(`${rota}: ${nome} → 400 com mensagem`, () => {
        cy.api('GET', `${rota}?${qs}`, { token: rota === ROTA_AUDIT ? t.audit : t.coord }).then((r) => {
          expect(r.status, JSON.stringify(r.body)).to.eq(400);
          expect(r.body.sucesso).to.eq(false);
          expect(String(r.body.mensagem).toLowerCase()).to.contain(trecho.toLowerCase());
          expect(JSON.stringify(r.body)).to.not.match(/SELECT .* FROM|stack|at .*\.js:\d+/i);
        });
      });
    });
  });

  it('parâmetros vazios são ignorados (equivalem a não filtrar)', () => {
    cy.api('GET', `${ROTA_COORD}?page=&limite=&data_inicio=&data_fim=&ip=&acao=&busca=`, { token: t.coord }).then((r) => {
      expect(r.status).to.eq(200);
      expect(r.body).to.deep.include({ pagina: 1, limite: 50 });
    });
  });

  it('injeção de SQL na busca é tratada como texto (200, só registros com o texto literal, tabela intacta)', () => {
    const ataque = "' OR '1'='1";
    cy.bd('SELECT COUNT(*)::int AS n FROM auditoria').then((antes) => {
      // o teste de login (01) grava LOGIN_FALHA com este mesmo texto, então pode haver resultados;
      // o que não pode é vir registro sem o texto (seria a condição injetada virando verdadeira)
      cy.api('GET', `${ROTA_COORD}?${consulta({ busca: ataque })}`, { token: t.coord }).then((r) => {
        expect(r.status).to.eq(200);
        expect(r.body.total).to.be.lessThan(antes[0].n);
        r.body.logs.forEach((l) => expect(`${l.usuario} ${l.descricao} ${l.acao} ${l.ip}`).to.contain(ataque));
      });
      cy.api('GET', `${ROTA_COORD}?${consulta({ busca: '%' })}`, { token: t.coord }).then((r) => {
        expect(r.status).to.eq(200);
        r.body.logs.forEach((l) => expect(`${l.usuario} ${l.descricao} ${l.acao} ${l.ip}`).to.contain('%'));
      });
      cy.bd('SELECT COUNT(*)::int AS n FROM auditoria').then((depois) => expect(depois[0].n).to.be.at.least(antes[0].n));
    });
  });

  // ---------------------------------------------------------------- permissões
  it('sem token: 401 nas duas rotas, mesmo com filtros', () => {
    cy.api('GET', `${ROTA_COORD}?page=2&acao=SOFT_DELETE`).its('status').should('eq', 401);
    cy.api('GET', `${ROTA_AUDIT}?page=2&acao=SOFT_DELETE`).its('status').should('eq', 401);
  });

  it('aluno e recepção não acessam nenhuma das rotas (403), nem com filtros', () => {
    ['aluno', 'recepcao'].forEach((perfil) => {
      cy.api('GET', `${ROTA_COORD}?${consulta({ busca: marca })}`, { token: t[perfil] }).its('status').should('eq', 403);
      cy.api('GET', `${ROTA_AUDIT}?${consulta({ busca: marca })}`, { token: t[perfil] }).its('status').should('eq', 403);
    });
  });

  it('o coordenador não acessa a auditoria completa (403), nem com filtros', () => {
    cy.api('GET', `${ROTA_AUDIT}?${consulta({ busca: marca, page: 1 })}`, { token: t.coord }).then((r) => {
      expect(r.status).to.eq(403);
      expect(r.body).to.not.have.property('logs');
      expect(r.body).to.not.have.property('estatisticas');
    });
  });

  it('a permissão é conferida antes dos parâmetros: perfil sem acesso recebe 403, não 400', () => {
    cy.api('GET', `${ROTA_COORD}?page=0`, { token: t.aluno }).its('status').should('eq', 403);
    cy.api('GET', `${ROTA_AUDIT}?limite=999`, { token: t.coord }).its('status').should('eq', 403);
  });

  // ---------------------------------------------------------------- imutabilidade
  it('a auditoria continua imutável: o banco recusa UPDATE e DELETE dos registros filtrados', () => {
    cy.task('bdTentar', { sql: 'UPDATE auditoria SET descricao = $1 WHERE id = $2', params: ['adulterado', ids.exclusao] }).then((r) => {
      expect(r.erro).to.contain('imutável');
    });
    cy.task('bdTentar', { sql: 'DELETE FROM auditoria WHERE id = $1', params: [ids.exclusao] }).then((r) => {
      expect(r.erro).to.contain('imutável');
    });
    cy.bd('SELECT descricao FROM auditoria WHERE id = $1', [ids.exclusao]).then((rows) => {
      expect(rows[0].descricao).to.eq(`${marca} exclusao`);
    });
  });

  it('não existe rota para alterar ou apagar a auditoria', () => {
    ['PUT', 'PATCH', 'DELETE', 'POST'].forEach((metodo) => {
      cy.api(metodo, ROTA_COORD, { token: t.coord, body: {} }).its('status').should('eq', 404);
      cy.api(metodo, ROTA_AUDIT, { token: t.audit, body: {} }).its('status').should('eq', 404);
    });
  });
});
