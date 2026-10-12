import { USUARIOS } from '../../support/dados';

const decodificarPayload = (token) =>
  JSON.parse(Cypress.Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());

describe('API: login', () => {
  before(() => cy.task('prepararBanco'));

  [
    ['coord', 'coordenador', 'coordenador'],
    ['recepcao', 'Recepção do Polo', 'recepção do polo'],
    ['audit', 'AUDIT', 'audit'],
    ['alunoA1', 'Aluno', 'aluno']
  ].forEach(([chave, tipo, perfil]) => {
    it(`login válido de ${tipo} devolve token, tipo e perfil`, () => {
      const u = USUARIOS[chave];
      cy.loginApi(u.matricula, u.senha).then((r) => {
        expect(r.status).to.eq(200);
        expect(r.body).to.include({ sucesso: true, nome: u.nome, tipo, perfil, matricula: u.matricula });
        expect(r.body.token).to.be.a('string');
        expect(r.body).to.not.have.property('senha');
        const payload = decodificarPayload(r.body.token);
        expect(payload).to.not.have.property('senha');
        expect(payload.exp).to.be.greaterThan(payload.iat);
      });
    });
  });

  it('senha errada: 401 com mensagem genérica', () => {
    cy.loginApi(USUARIOS.alunoA1.matricula, 'errada').then((r) => {
      expect(r.status).to.eq(401);
      expect(r.body).to.deep.include({ sucesso: false, mensagem: 'Matrícula ou senha incorretas.' });
      expect(r.body).to.not.have.property('token');
    });
  });

  it('matrícula inexistente responde igual a senha errada (não revela quais matrículas existem)', () => {
    cy.loginApi('NAO_EXISTE_999', 'qualquer').then((r) => {
      expect(r.status).to.eq(401);
      expect(r.body.mensagem).to.eq('Matrícula ou senha incorretas.');
    });
  });

  it('campos vazios: 400', () => {
    cy.api('POST', '/api/login', { body: {} }).its('status').should('eq', 400);
    cy.api('POST', '/api/login', { body: { matricula: 'X' } }).its('status').should('eq', 400);
    cy.api('POST', '/api/login', { body: { senha: 'X' } }).its('status').should('eq', 400);
  });

  it('tentativas de SQL injection não autenticam e não derrubam nada', () => {
    ["' OR '1'='1", "x'; DROP TABLE usuarios;--", "' OR 1=1 --"].forEach((ataque) => {
      cy.loginApi(ataque, ataque).its('status').should('eq', 401);
    });
    cy.loginApi(USUARIOS.coord.matricula, USUARIOS.coord.senha).its('status').should('eq', 200);
  });

  it('tipos estranhos no corpo não quebram o servidor', () => {
    cy.api('POST', '/api/login', { body: { matricula: 123, senha: ['a'] } }).its('status').should('be.oneOf', [400, 401]);
    cy.api('POST', '/api/login', { body: { matricula: { $ne: null }, senha: { $ne: null } } }).its('status').should('be.oneOf', [400, 401]);
  });

  it('senha antiga em texto puro é aceita uma vez e convertida para bcrypt', () => {
    const u = USUARIOS.legado;
    cy.bd('SELECT senha FROM usuarios WHERE matricula = $1', [u.matricula]).then((antes) => {
      expect(antes[0].senha).to.eq(u.senha); // semente em texto puro
    });
    cy.loginApi(u.matricula, u.senha).its('status').should('eq', 200);
    cy.bd('SELECT senha FROM usuarios WHERE matricula = $1', [u.matricula]).then((depois) => {
      expect(depois[0].senha).to.match(/^\$2[aby]\$/);
      expect(depois[0].senha).to.not.eq(u.senha);
    });
    cy.loginApi(u.matricula, u.senha).its('status').should('eq', 200); // continua funcionando com hash
    cy.loginApi(u.matricula, 'outra').its('status').should('eq', 401);
  });
});

// ------------------------------------------------------------------
// Matriz de permissões: cada rota x cada perfil
// ------------------------------------------------------------------
const ROTAS = [
  ['GET', '/api/vagas', ['aluno', 'coord']],
  ['GET', '/api/meus-agendamentos', ['aluno']],
  ['GET', '/api/resultados', ['aluno']],
  ['POST', '/api/agendar', ['aluno']],
  ['POST', '/api/cancelar-agendamento', ['aluno']],
  ['POST', '/api/reagendar', ['aluno']],
  ['GET', '/api/notas', ['coord']],
  ['POST', '/api/atualizar-nota', ['coord']],
  ['POST', '/api/cadastrar-vaga', ['coord']],
  ['POST', '/api/cadastrar-usuario', ['coord']],
  ['GET', '/api/usuarios', ['coord']],
  ['POST', '/api/alterar-status-usuario', ['coord']],
  ['POST', '/api/atualizar-foto', ['coord']],
  ['POST', '/api/atualizar-polo', ['coord']],
  ['GET', '/api/cursos', ['coord']],
  ['GET', '/api/disciplinas', ['coord']],
  ['POST', '/api/disciplinas', ['coord']],
  ['POST', '/api/alterar-status-disciplina', ['coord']],
  ['GET', '/api/vagas-gestao', ['coord']],
  ['GET', '/api/auditoria', ['coord', 'audit']],
  ['GET', '/api/admin/auditoria-completa', ['audit']],
  ['GET', '/api/portaria/consultar?busca=abc', ['recepcao']],
  ['GET', '/api/portaria/por-data?data=2030-01-01', ['recepcao']],
  ['POST', '/api/portaria/confirmar-entrada', ['recepcao']]
];

describe('API: autenticação obrigatória e permissões por perfil', () => {
  const tokens = {};

  before(() => {
    cy.task('prepararBanco');
    cy.tokenDe(USUARIOS.coord).then((t) => { tokens.coord = t; });
    cy.tokenDe(USUARIOS.recepcao).then((t) => { tokens.recepcao = t; });
    cy.tokenDe(USUARIOS.audit).then((t) => { tokens.audit = t; });
    cy.tokenDe(USUARIOS.alunoA1).then((t) => { tokens.aluno = t; });
  });

  ROTAS.forEach(([metodo, caminho, permitidos]) => {
    it(`${metodo} ${caminho} sem token: 401`, () => {
      cy.api(metodo, caminho, { body: metodo === 'POST' ? {} : undefined }).then((r) => {
        expect(r.status).to.eq(401);
      });
    });

    ['coord', 'recepcao', 'audit', 'aluno'].forEach((perfil) => {
      const deveFuncionar = permitidos.includes(perfil);
      it(`${metodo} ${caminho} como ${perfil}: ${deveFuncionar ? 'permitido' : '403'}`, () => {
        cy.api(metodo, caminho, { token: tokens[perfil], body: metodo === 'POST' ? {} : undefined }).then((r) => {
          if (deveFuncionar) {
            expect(r.status, JSON.stringify(r.body)).to.not.be.oneOf([401, 403]);
            expect(r.status).to.be.lessThan(500);
          } else {
            expect(r.status).to.eq(403);
          }
        });
      });
    });
  });

  it('token inválido e cabeçalho sem "Bearer" são recusados', () => {
    cy.api('GET', '/api/vagas', { token: 'lixo.lixo.lixo' }).its('status').should('eq', 401);
    cy.api('GET', '/api/vagas', { headers: { Authorization: tokens.aluno } }).its('status').should('eq', 401);
    cy.api('GET', '/api/vagas', { headers: { Authorization: 'Basic abc' } }).its('status').should('eq', 401);
  });

  it('a lista de usuários nunca devolve senha nem código de recuperação', () => {
    cy.api('GET', '/api/usuarios', { token: tokens.coord }).then((r) => {
      expect(r.status).to.eq(200);
      expect(r.body.length).to.be.greaterThan(0);
      r.body.forEach((u) => {
        expect(u).to.not.have.any.keys('senha', 'codigo_recuperacao', 'codigo_expiracao', 'trocar_senha');
      });
    });
  });
});

describe('API: perfil do usuário logado', () => {
  before(() => cy.task('prepararBanco'));

  it('sem token: 401', () => {
    cy.api('GET', '/api/perfil').its('status').should('eq', 401);
  });

  it('devolve só os dados do próprio usuário (nunca a senha)', () => {
    const u = USUARIOS.alunoA1;
    cy.tokenDe(u).then((token) => {
      cy.api('GET', '/api/perfil', { token }).then((r) => {
        expect(r.status).to.eq(200);
        expect(r.body).to.deep.eq({ nome: u.nome, matricula: u.matricula, curso: u.curso, tipo: 'Aluno', foto_url: null, polo: null });
      });
    });
  });

  ['coord', 'recepcao', 'audit'].forEach((chave) => {
    it(`funciona para ${chave}`, () => {
      cy.tokenDe(USUARIOS[chave]).then((token) => {
        cy.api('GET', '/api/perfil', { token }).then((r) => {
          expect(r.status).to.eq(200);
          expect(r.body.matricula).to.eq(USUARIOS[chave].matricula);
        });
      });
    });
  });
});

describe('API: matrícula sem diferenciar maiúsculas/minúsculas', () => {
  before(() => cy.task('prepararBanco'));

  it('login com a matrícula em minúsculas, misturada ou com espaços funciona e devolve a matrícula oficial', () => {
    const u = USUARIOS.alunoA1;
    [u.matricula.toLowerCase(), 'Teste_Aluno_a1', `  ${u.matricula.toLowerCase()}  `].forEach((digitada) => {
      cy.loginApi(digitada, u.senha).then((r) => {
        expect(r.status, `"${digitada}": ${JSON.stringify(r.body)}`).to.eq(200);
        expect(r.body.matricula).to.eq(u.matricula);
      });
    });
  });

  it('a senha continua diferenciando maiúsculas', () => {
    const u = USUARIOS.alunoA1;
    cy.loginApi(u.matricula.toLowerCase(), u.senha.toUpperCase()).its('status').should('eq', 401);
  });

  it('o token gerado por login em minúsculas funciona normalmente (notas pela matrícula oficial)', () => {
    const u = USUARIOS.alunoA1;
    cy.loginApi(u.matricula.toLowerCase(), u.senha).then((r) => {
      cy.api('GET', '/api/resultados', { token: r.body.token }).its('status').should('eq', 200);
      cy.api('GET', '/api/perfil', { token: r.body.token }).its('body.matricula').should('eq', u.matricula);
    });
  });

  it('o banco recusa duas matrículas que só diferem na caixa', () => {
    cy.task('bdTentar', {
      sql: `INSERT INTO usuarios (nome, matricula, tipo, senha) VALUES ('Duplicada', 'teste_coord', 'Aluno', 'x')`
    }).then((r) => {
      expect(r.erro, 'precisa rodar a migracao_parte_b.sql no banco de teste').to.contain('uq_usuarios_matricula_ci');
    });
  });
});
