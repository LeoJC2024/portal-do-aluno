import { USUARIOS, CURSO_A, CURSO_B, JPEG_MINIMO_DATAURL, PNG_DATAURL_COMO_JPEG, API_URL, TESTAR_STORAGE } from '../../support/dados';
import { criarUsuario, criarUsuarioAtivo, criarVaga, agendar } from '../../support/apiHelpers';
import { dataSP } from '../../support/datas';

const unico = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const numeroDaMatricula = (m) => Number(m.replace(/^[A-Z]+/, ''));

describe('API: cadastro de usuários', () => {
  const t = {};

  before(() => {
    cy.task('prepararBanco');
    cy.tokenDe(USUARIOS.coord).then((x) => { t.coord = x; });
  });

  describe('matrícula e senha automáticas', () => {
    it('aluno recebe matrícula E + 5 dígitos e senha provisória aleatória (só guardada com hash)', () => {
      criarUsuario(t.coord).then((u) => {
        expect(u.matricula).to.match(/^E\d{5}$/);
        expect(u.senhaProvisoria).to.match(/^[A-HJ-NP-Za-km-z2-9]{10}$/);
        cy.bd('SELECT * FROM usuarios WHERE matricula = $1', [u.matricula]).then((rows) => {
          const linha = rows[0];
          expect(linha).to.include({ nome: u.nome, tipo: 'Aluno', curso: CURSO_A, ativo: true, trocar_senha: true });
          expect(linha.email).to.eq(u.email);
          expect(linha.senha).to.match(/^\$2[aby]\$/);
          expect(linha.senha).to.not.contain(u.senhaProvisoria);
          expect(linha.foto_url).to.be.null;
        });
      });
    });

    it('a sequência do aluno anda de 1 em 1', () => {
      criarUsuario(t.coord).then((a) => {
        criarUsuario(t.coord).then((b) => {
          expect(numeroDaMatricula(b.matricula)).to.eq(numeroDaMatricula(a.matricula) + 1);
        });
      });
    });

    it('coordenador recebe C + 5 dígitos; recepção do polo recebe AT + 5 dígitos', () => {
      criarUsuario(t.coord, { tipo: 'coordenador' }).then((c) => expect(c.matricula).to.match(/^C\d{5}$/));
      criarUsuario(t.coord, { tipo: 'Recepção do Polo', polo: 'Polo CY' }).then((r) => expect(r.matricula).to.match(/^AT\d{5}$/));
    });

    it('cada tipo tem a sua própria sequência', () => {
      criarUsuario(t.coord, { tipo: 'coordenador' }).then((c1) => {
        criarUsuario(t.coord).then(() => {
          criarUsuario(t.coord, { tipo: 'coordenador' }).then((c2) => {
            expect(numeroDaMatricula(c2.matricula)).to.eq(numeroDaMatricula(c1.matricula) + 1);
          });
        });
      });
    });

    it('cadastros simultâneos não repetem matrícula', () => {
      const n = unico();
      const url = `${API_URL}/api/cadastrar-usuario`;
      const requisicoes = [1, 2, 3, 4].map((i) => ({
        method: 'POST', url, headers: { Authorization: `Bearer ${t.coord}` },
        body: { nome: `Cy Paralelo ${n} ${i}`, email: `cy-${n}-${i}@teste.local`, curso: CURSO_A, tipo: 'Aluno' }
      }));
      cy.task('paralelo', requisicoes).then((respostas) => {
        respostas.forEach((r) => expect(r.status, JSON.stringify(r.body)).to.eq(200));
        const matriculas = respostas.map((r) => r.body.matricula);
        expect(new Set(matriculas).size).to.eq(4);
      });
    });

    it('a resposta não vaza hash de senha', () => {
      cy.api('POST', '/api/cadastrar-usuario', {
        token: t.coord, body: { nome: 'Cy Sem Vazamento', email: `cy-${unico()}@teste.local`, curso: CURSO_A, tipo: 'Aluno' }
      }).then((r) => {
        expect(r.status).to.eq(200);
        expect(r.body).to.not.have.property('senha');
        expect(JSON.stringify(r.body)).to.not.match(/\$2[aby]\$/);
      });
    });
  });

  describe('validações', () => {
    const corpo = (extra = {}) => ({ nome: 'Cy Valida', email: `cy-${unico()}@teste.local`, curso: CURSO_A, tipo: 'Aluno', ...extra });
    const cadastrar = (c) => cy.api('POST', '/api/cadastrar-usuario', { token: t.coord, body: c });

    ['nome', 'email', 'curso', 'tipo'].forEach((campo) => {
      it(`sem "${campo}": 400`, () => {
        const c = corpo();
        delete c[campo];
        cadastrar(c).then((r) => {
          expect(r.status).to.eq(400);
          expect(r.body.mensagem).to.contain(campo === 'curso' ? 'curso' : 'Preencha');
        });
      });
    });

    it('coordenador e recepção não precisam de curso; só o aluno precisa', () => {
      cadastrar(corpo({ tipo: 'coordenador', curso: undefined })).its('status').should('eq', 200);
      cadastrar(corpo({ tipo: 'Recepção do Polo', curso: undefined, polo: 'Polo CY' })).its('status').should('eq', 200);
      cadastrar(corpo({ curso: '' })).then((r) => {
        expect(r.status).to.eq(400);
        expect(r.body.mensagem).to.contain('curso do aluno');
      });
    });

    it('e-mail inválido: 400', () => {
      ['semarroba', 'a@b', 'a b@c.com', '@x.com'].forEach((email) => {
        cadastrar(corpo({ email })).then((r) => {
          expect(r.status, email).to.eq(400);
          expect(r.body.mensagem).to.contain('E-mail inválido');
        });
      });
    });

    it('tipo desconhecido ou AUDIT não podem ser cadastrados', () => {
      ['AUDIT', 'admin', 'aluno', 'COORDENADOR'].forEach((tipo) => {
        cadastrar(corpo({ tipo })).then((r) => {
          expect(r.status, tipo).to.eq(400);
          expect(r.body.mensagem).to.contain('Tipo de perfil inválido');
        });
      });
    });

    it('e-mail repetido: 400 e só um usuário existe', () => {
      const email = `cy-${unico()}@teste.local`;
      cadastrar(corpo({ email })).its('status').should('eq', 200);
      cadastrar(corpo({ email })).then((r) => {
        expect(r.status).to.eq(400);
        expect(r.body.mensagem.toLowerCase()).to.contain('e-mail');
      });
      cy.bd('SELECT COUNT(*)::int AS n FROM usuarios WHERE email = $1', [email]).then((rows) => expect(rows[0].n).to.eq(1));
    });

    it('nome com HTML é guardado como texto e devolvido como JSON (o front é que escapa)', () => {
      const nome = '<img src=x onerror=alert(1)>';
      const email = `cy-${unico()}@teste.local`;
      cadastrar(corpo({ nome, email })).its('status').should('eq', 200);
      cy.api('GET', `/api/usuarios?busca=${encodeURIComponent('img src=x')}`, { token: t.coord }).then((r) => {
        expect(r.headers['content-type']).to.contain('application/json');
        expect(r.body.some((u) => u.nome === nome)).to.eq(true);
      });
    });
  });

  describe('primeiro acesso com senha provisória', () => {
    it('a senha provisória NÃO permite entrar (403 + trocar_senha) e não devolve token', () => {
      criarUsuario(t.coord).then((u) => {
        cy.loginApi(u.matricula, u.senhaProvisoria).then((r) => {
          expect(r.status).to.eq(403);
          expect(r.body.trocar_senha).to.eq(true);
          expect(r.body).to.not.have.property('token');
        });
      });
    });

    it('senha provisória errada no primeiro acesso: 400 e conta a tentativa', () => {
      criarUsuario(t.coord).then((u) => {
        cy.api('POST', '/api/recuperar-senha', { body: { matricula: u.matricula, codigo: 'ErradaErrada', novaSenha: 'Nova@12345' } }).its('status').should('eq', 400);
        cy.bd('SELECT codigo_tentativas FROM usuarios WHERE matricula = $1', [u.matricula]).then((rows) => expect(rows[0].codigo_tentativas).to.eq(1));
      });
    });

    it('a nova senha não pode ser igual à provisória', () => {
      criarUsuario(t.coord).then((u) => {
        cy.api('POST', '/api/recuperar-senha', { body: { matricula: u.matricula, codigo: u.senhaProvisoria, novaSenha: u.senhaProvisoria } }).then((r) => {
          expect(r.status).to.eq(400);
          expect(r.body.mensagem).to.contain('diferente');
        });
      });
    });

    it('define a nova senha com a provisória; depois entra e a provisória deixa de valer', () => {
      criarUsuario(t.coord).then((u) => {
        cy.api('POST', '/api/recuperar-senha', { body: { matricula: u.matricula, codigo: u.senhaProvisoria, novaSenha: 'MinhaSenha@77' } }).then((r) => {
          expect(r.status, JSON.stringify(r.body)).to.eq(200);
        });
        cy.bd('SELECT trocar_senha FROM usuarios WHERE matricula = $1', [u.matricula]).then((rows) => expect(rows[0].trocar_senha).to.eq(false));
        cy.loginApi(u.matricula, 'MinhaSenha@77').then((r) => {
          expect(r.status).to.eq(200);
          expect(r.body.perfil).to.eq('aluno');
          expect(r.body.matricula).to.eq(u.matricula);
        });
        cy.loginApi(u.matricula, u.senhaProvisoria).its('status').should('eq', 401);
        // a provisória não funciona como "código" uma segunda vez
        cy.api('POST', '/api/recuperar-senha', { body: { matricula: u.matricula, codigo: u.senhaProvisoria, novaSenha: 'Outra@12345' } }).its('status').should('eq', 400);
      });
    });

    it('depois de 5 erros bloqueia o primeiro acesso até pedir novo código', () => {
      criarUsuario(t.coord).then((u) => {
        for (let i = 0; i < 5; i += 1) {
          cy.api('POST', '/api/recuperar-senha', { body: { matricula: u.matricula, codigo: 'ErradaErrada', novaSenha: 'Nova@12345' } }).its('status').should('eq', 400);
        }
        cy.api('POST', '/api/recuperar-senha', { body: { matricula: u.matricula, codigo: u.senhaProvisoria, novaSenha: 'Nova@12345' } }).then((r) => {
          expect(r.status).to.eq(400);
          expect(r.body.mensagem).to.contain('Muitas tentativas');
        });
        cy.api('POST', '/api/solicitar-codigo', { body: { matricula: u.matricula } }).its('status').should('eq', 200);
        cy.api('POST', '/api/recuperar-senha', { body: { matricula: u.matricula, codigo: u.senhaProvisoria, novaSenha: 'Nova@12345' } }).its('status').should('eq', 200);
      });
    });
  });

  describe('foto do aluno', () => {
    const cadastrarComFoto = (extra) => {
      const email = `cy-${unico()}@teste.local`;
      return cy.api('POST', '/api/cadastrar-usuario', {
        token: t.coord, body: { nome: 'Cy Foto', email, curso: CURSO_A, tipo: 'Aluno', ...extra }
      }).then((r) => ({ r, email }));
    };
    const naoCriou = (email) =>
      cy.bd('SELECT COUNT(*)::int AS n FROM usuarios WHERE email = $1', [email]).then((rows) => expect(rows[0].n, 'usuário não pode ter sido criado').to.eq(0));

    it('foto para quem não é aluno: 400', () => {
      const email = `cy-${unico()}@teste.local`;
      cy.api('POST', '/api/cadastrar-usuario', {
        token: t.coord, body: { nome: 'Cy Coord Foto', email, curso: CURSO_A, tipo: 'coordenador', foto: JPEG_MINIMO_DATAURL }
      }).then((r) => {
        expect(r.status).to.eq(400);
        expect(r.body.mensagem).to.contain('apenas para alunos');
      });
      naoCriou(email);
    });

    it('texto que não é imagem: 400 e nada é criado', () => {
      cadastrarComFoto({ foto: 'isto-nao-e-imagem' }).then(({ r, email }) => {
        expect(r.status).to.eq(400);
        expect(r.body.mensagem).to.contain('Foto inválida');
        naoCriou(email);
      });
    });

    it('arquivo que diz ser JPEG mas é PNG: 400', () => {
      cadastrarComFoto({ foto: PNG_DATAURL_COMO_JPEG }).then(({ r, email }) => {
        expect(r.status).to.eq(400);
        expect(r.body.mensagem).to.contain('não é uma imagem válida');
        naoCriou(email);
      });
    });

    it('imagem acima de 600 KB: 400', () => {
      const grande = `data:image/jpeg;base64,/9j/${'A'.repeat(1000000)}`;
      cadastrarComFoto({ foto: grande }).then(({ r, email }) => {
        expect(r.status).to.eq(400);
        expect(r.body.mensagem).to.contain('600 KB');
        naoCriou(email);
      });
    });

    it('imagem válida: salva no Storage (se configurado) ou recusa sem criar o usuário', () => {
      cadastrarComFoto({ foto: JPEG_MINIMO_DATAURL }).then(({ r, email }) => {
        if (TESTAR_STORAGE) {
          expect(r.status, JSON.stringify(r.body)).to.eq(200);
          cy.bd('SELECT foto_url FROM usuarios WHERE email = $1', [email]).then((rows) => {
            expect(rows[0].foto_url).to.match(/^https?:\/\/.+\/storage\/v1\/object\/public\/.+\.jpg$/);
          });
        } else {
          expect(r.status).to.eq(500);
          expect(r.body.mensagem).to.contain('não configurado');
          naoCriou(email);
        }
      });
    });

    it('atualizar-foto: validações', () => {
      criarUsuarioAtivo(t.coord).then((aluno) => {
        cy.api('POST', '/api/atualizar-foto', { token: t.coord, body: { id: aluno.id } }).its('status').should('eq', 400);
        cy.api('POST', '/api/atualizar-foto', { token: t.coord, body: { foto: JPEG_MINIMO_DATAURL } }).its('status').should('eq', 400);
        cy.api('POST', '/api/atualizar-foto', { token: t.coord, body: { id: 999999999, foto: JPEG_MINIMO_DATAURL } }).its('status').should('eq', 404);
        cy.api('POST', '/api/atualizar-foto', { token: t.coord, body: { id: aluno.id, foto: 'lixo' } }).then((r) => {
          expect(r.status).to.eq(400);
          expect(r.body.mensagem).to.contain('Foto inválida');
        });
      });
      criarUsuarioAtivo(t.coord, { tipo: 'coordenador' }).then((coord) => {
        cy.api('POST', '/api/atualizar-foto', { token: t.coord, body: { id: coord.id, foto: JPEG_MINIMO_DATAURL } }).then((r) => {
          expect(r.status).to.eq(400);
          expect(r.body.mensagem).to.contain('apenas para alunos');
        });
      });
    });
  });
});

describe('API: lista de usuários e cursos', () => {
  const t = {};

  before(() => {
    cy.task('prepararBanco');
    cy.tokenDe(USUARIOS.coord).then((x) => { t.coord = x; });
  });

  it('lista os campos esperados e coloca ativos antes dos excluídos', () => {
    criarUsuarioAtivo(t.coord).then((u) => {
      cy.api('POST', '/api/alterar-status-usuario', { token: t.coord, body: { id: u.id, ativo: false } }).its('status').should('eq', 200);
      cy.api('GET', '/api/usuarios', { token: t.coord }).then((r) => {
        expect(r.status).to.eq(200);
        const primeiroExcluido = r.body.findIndex((x) => x.ativo === false);
        const ultimoAtivo = r.body.map((x) => x.ativo).lastIndexOf(true);
        expect(primeiroExcluido).to.be.greaterThan(ultimoAtivo);
        const linha = r.body.find((x) => x.matricula === u.matricula);
        expect(linha).to.include.keys('id', 'nome', 'matricula', 'curso', 'tipo', 'email', 'ativo', 'foto_url');
        expect(linha.ativo).to.eq(false);
      });
    });
  });

  it('busca por nome e por matrícula (parcial, sem diferenciar maiúsculas)', () => {
    criarUsuarioAtivo(t.coord).then((u) => {
      const parteDoNome = u.nome.split(' ').pop();
      cy.api('GET', `/api/usuarios?busca=${parteDoNome}`, { token: t.coord }).then((r) => {
        expect(r.body.map((x) => x.matricula)).to.deep.eq([u.matricula]);
      });
      cy.api('GET', `/api/usuarios?busca=${u.matricula.toLowerCase()}`, { token: t.coord }).then((r) => {
        expect(r.body.map((x) => x.matricula)).to.include(u.matricula);
      });
    });
  });

  it('curingas e injeção na busca não devolvem a tabela inteira', () => {
    ['%', '%%', "' OR '1'='1", "'; DROP TABLE usuarios; --"].forEach((busca) => {
      cy.api('GET', `/api/usuarios?busca=${encodeURIComponent(busca)}`, { token: t.coord }).then((r) => {
        expect(r.status, busca).to.eq(200);
        expect(r.body, busca).to.have.length(0);
      });
    });
    cy.api('GET', '/api/usuarios', { token: t.coord }).its('body.length').should('be.greaterThan', 5);
  });

  it('/api/cursos lista os cursos dos alunos e os das vagas, sem repetir', () => {
    criarVaga(t.coord, { curso: 'CY Curso Só Da Vaga' });
    cy.api('GET', '/api/cursos', { token: t.coord }).then((r) => {
      expect(r.status).to.eq(200);
      expect(r.body).to.include.members([CURSO_A, CURSO_B, 'CY Curso Só Da Vaga']);
      expect(new Set(r.body).size).to.eq(r.body.length);
    });
  });
});

describe('API: exclusão lógica e reativação de usuários', () => {
  const t = {};

  before(() => {
    cy.task('prepararBanco');
    cy.tokenDe(USUARIOS.coord).then((x) => { t.coord = x; });
    cy.tokenDe(USUARIOS.recepcao).then((x) => { t.recepcao = x; });
    cy.tokenDe(USUARIOS.alunoA1).then((x) => { t.a1 = x; });
  });

  const alterar = (id, ativo) => cy.api('POST', '/api/alterar-status-usuario', { token: t.coord, body: { id, ativo } });

  it('excluir: bloqueia login, derruba o token, cancela agendamentos e libera a vaga', () => {
    criarVaga(t.coord, { limite_vagas: 3 }).then((vaga) => {
      criarUsuarioAtivo(t.coord).then((aluno) => {
        agendar(aluno.token, vaga.id).its('status').should('eq', 200);

        alterar(aluno.id, false).then((r) => {
          expect(r.status, JSON.stringify(r.body)).to.eq(200);
          expect(r.body.mensagem).to.contain('1 agendamento(s)');
        });

        cy.loginApi(aluno.matricula, aluno.senha).then((r) => {
          expect(r.status).to.eq(403);
          expect(r.body.mensagem).to.contain('desativada');
        });
        cy.api('GET', '/api/meus-agendamentos', { token: aluno.token }).then((r) => {
          expect(r.status).to.eq(401);
          expect(r.body.mensagem).to.contain('desativada');
        });

        cy.bd('SELECT ativo FROM usuarios WHERE id = $1', [aluno.id]).then((rows) => expect(rows[0].ativo).to.eq(false));
        cy.bd('SELECT status FROM agendamentos WHERE usuario_id = $1', [aluno.id]).then((rows) => {
          expect(rows.map((x) => x.status)).to.deep.eq(['INATIVO']);
        });
        cy.api('GET', '/api/vagas', { token: t.a1 }).then((r) => {
          expect(r.body.find((v) => v.id === vaga.id).vagas_restantes).to.eq(3);
        });
        cy.api('GET', '/api/auditoria', { token: t.coord }).then((r) => {
          expect(r.body.logs.some((l) => l.acao === 'SOFT_DELETE' && l.descricao.includes(aluno.matricula) && l.usuario === USUARIOS.coord.nome)).to.eq(true);
        });
      });
    });
  });

  it('o histórico continua no banco (não apaga a linha)', () => {
    criarUsuarioAtivo(t.coord).then((aluno) => {
      alterar(aluno.id, false).its('status').should('eq', 200);
      cy.bd('SELECT COUNT(*)::int AS n FROM usuarios WHERE id = $1', [aluno.id]).then((rows) => expect(rows[0].n).to.eq(1));
    });
  });

  it('excluir duas vezes: 409; usuário inexistente: 404; id inválido: 400', () => {
    criarUsuarioAtivo(t.coord).then((aluno) => {
      alterar(aluno.id, false).its('status').should('eq', 200);
      alterar(aluno.id, false).then((r) => {
        expect(r.status).to.eq(409);
        expect(r.body.mensagem).to.contain('já está excluído');
      });
    });
    alterar(999999999, false).its('status').should('eq', 404);
    alterar('abc', false).its('status').should('eq', 400);
    cy.api('POST', '/api/alterar-status-usuario', { token: t.coord, body: {} }).its('status').should('eq', 400);
  });

  it('o coordenador não pode excluir a própria conta', () => {
    cy.bd('SELECT id FROM usuarios WHERE matricula = $1', [USUARIOS.coord.matricula]).then((rows) => {
      alterar(rows[0].id, false).then((r) => {
        expect(r.status).to.eq(400);
        expect(r.body.mensagem).to.contain('própria conta');
      });
    });
    cy.loginApi(USUARIOS.coord.matricula, USUARIOS.coord.senha).its('status').should('eq', 200);
  });

  it('aluno excluído some da consulta da portaria', () => {
    criarUsuarioAtivo(t.coord).then((aluno) => {
      cy.api('GET', `/api/portaria/consultar?busca=${aluno.matricula}`, { token: t.recepcao }).its('body.encontrado').should('eq', true);
      alterar(aluno.id, false).its('status').should('eq', 200);
      cy.api('GET', `/api/portaria/consultar?busca=${aluno.matricula}`, { token: t.recepcao }).its('body.encontrado').should('eq', false);
    });
  });

  it('reativar: volta a entrar com a mesma senha; reativar de novo: 409', () => {
    criarUsuarioAtivo(t.coord).then((aluno) => {
      alterar(aluno.id, false).its('status').should('eq', 200);
      alterar(aluno.id, true).then((r) => {
        expect(r.status).to.eq(200);
        expect(r.body.mensagem).to.contain('reativado');
      });
      cy.loginApi(aluno.matricula, aluno.senha).its('status').should('eq', 200);
      alterar(aluno.id, true).then((r) => {
        expect(r.status).to.eq(409);
        expect(r.body.mensagem).to.contain('já está ativo');
      });
      cy.api('GET', '/api/auditoria', { token: t.coord }).then((r) => {
        expect(r.body.logs.some((l) => l.acao === 'REATIVACAO_USUARIO' && l.descricao.includes(aluno.matricula))).to.eq(true);
      });
    });
  });

  it('a matrícula/e-mail de um excluído continua reservada (não dá para recadastrar o mesmo e-mail)', () => {
    criarUsuarioAtivo(t.coord).then((aluno) => {
      alterar(aluno.id, false).its('status').should('eq', 200);
      cy.api('POST', '/api/cadastrar-usuario', { token: t.coord, body: { nome: 'Outro', email: aluno.email, curso: CURSO_A, tipo: 'Aluno' } }).then((r) => {
        expect(r.status).to.eq(400);
        expect(r.body.mensagem).to.contain('reative');
      });
    });
  });
});

describe('API: polo da recepção', () => {
  const t = {};

  before(() => {
    cy.task('prepararBanco');
    cy.tokenDe(USUARIOS.coord).then((x) => { t.coord = x; });
  });

  const cadastrar = (extra) => {
    const email = `cy-${unico()}@teste.local`;
    return cy.api('POST', '/api/cadastrar-usuario', {
      token: t.coord, body: { nome: 'Cy Recepcao', email, curso: CURSO_A, tipo: 'Recepção do Polo', ...extra }
    }).then((r) => ({ r, email }));
  };

  it('recepção sem polo: 400 e nada é criado', () => {
    cadastrar({}).then(({ r, email }) => {
      expect(r.status).to.eq(400);
      expect(r.body.mensagem).to.contain('Informe o polo');
      cy.bd('SELECT COUNT(*)::int AS n FROM usuarios WHERE email = $1', [email]).then((rows) => expect(rows[0].n).to.eq(0));
    });
  });

  it('polo em branco ou grande demais: 400', () => {
    cadastrar({ polo: '   ' }).its('r.status').should('eq', 400);
    cadastrar({ polo: 'x'.repeat(101) }).its('r.status').should('eq', 400);
  });

  it('recepção com polo: grava, aparece na lista e no perfil do próprio usuário', () => {
    cadastrar({ polo: 'Polo CY Recepcao' }).then(({ r, email }) => {
      expect(r.status, JSON.stringify(r.body)).to.eq(200);
      cy.bd('SELECT polo, tipo FROM usuarios WHERE email = $1', [email]).then((rows) => {
        expect(rows[0]).to.deep.eq({ polo: 'Polo CY Recepcao', tipo: 'Recepção do Polo' });
      });
      cy.api('GET', `/api/usuarios?busca=${r.body.matricula}`, { token: t.coord }).its('body.0.polo').should('eq', 'Polo CY Recepcao');
    });
  });

  it('o polo é usado de verdade: a recepção cadastrada só enxerga o próprio polo', () => {
    criarUsuarioAtivo(t.coord, { tipo: 'Recepção do Polo', polo: 'Polo CY Recepcao' }).then((rec) => {
      cy.api('GET', '/api/perfil', { token: rec.token }).its('body.polo').should('eq', 'Polo CY Recepcao');
      criarVaga(t.coord, { polo: 'Polo CY Outro', data: dataSP(6) }).then((v) => {
        criarUsuarioAtivo(t.coord).then((aluno) => {
          cy.api('POST', '/api/agendar', { token: aluno.token, body: { vaga_id: v.id } }).its('status').should('eq', 200);
          cy.api('GET', `/api/portaria/por-data?data=${dataSP(6)}&busca=${aluno.matricula}`, { token: rec.token }).its('body.total').should('eq', 0);
        });
      });
    });
  });

  it('aluno e coordenador: o polo enviado é ignorado', () => {
    ['Aluno', 'coordenador'].forEach((tipo) => {
      cadastrar({ tipo, polo: 'Polo CY' }).then(({ r, email }) => {
        expect(r.status).to.eq(200);
        cy.bd('SELECT polo FROM usuarios WHERE email = $1', [email]).then((rows) => expect(rows[0].polo).to.be.null);
      });
    });
  });

  describe('atualizar polo de uma recepção existente', () => {
    const atualizar = (corpo) => cy.api('POST', '/api/atualizar-polo', { token: t.coord, body: corpo });

    it('troca o polo e registra ATUALIZACAO_POLO', () => {
      criarUsuarioAtivo(t.coord, { tipo: 'Recepção do Polo', polo: 'Polo CY A' }).then((rec) => {
        atualizar({ id: rec.id, polo: 'Polo CY B' }).then((r) => {
          expect(r.status, JSON.stringify(r.body)).to.eq(200);
        });
        cy.bd('SELECT polo FROM usuarios WHERE id = $1', [rec.id]).then((rows) => expect(rows[0].polo).to.eq('Polo CY B'));
        cy.api('GET', '/api/auditoria', { token: t.coord }).then((r) => {
          const log = r.body.logs.find((l) => l.acao === 'ATUALIZACAO_POLO' && l.descricao.includes(rec.matricula));
          expect(log.descricao).to.contain('Polo CY A').and.contain('Polo CY B');
          expect(log.usuario).to.eq(USUARIOS.coord.nome);
        });
      });
    });

    it('define o polo de uma recepção antiga que estava sem polo (via banco)', () => {
      criarUsuarioAtivo(t.coord, { tipo: 'Recepção do Polo', polo: 'Polo CY A' }).then((rec) => {
        cy.bd('UPDATE usuarios SET polo = NULL WHERE id = $1', [rec.id]);
        atualizar({ id: rec.id, polo: 'Polo CY C' }).its('status').should('eq', 200);
        cy.api('GET', '/api/perfil', { token: rec.token }).its('body.polo').should('eq', 'Polo CY C');
      });
    });

    it('validações: sem dados, polo vazio, aluno, inexistente e excluído', () => {
      atualizar({}).its('status').should('eq', 400);
      atualizar({ id: 1, polo: '  ' }).its('status').should('eq', 400);
      atualizar({ id: 999999999, polo: 'Polo X' }).its('status').should('eq', 404);
      criarUsuarioAtivo(t.coord).then((aluno) => {
        atualizar({ id: aluno.id, polo: 'Polo X' }).then((r) => {
          expect(r.status).to.eq(400);
          expect(r.body.mensagem).to.contain('apenas pela recepção');
        });
      });
      criarUsuarioAtivo(t.coord, { tipo: 'Recepção do Polo', polo: 'Polo CY A' }).then((rec) => {
        cy.api('POST', '/api/alterar-status-usuario', { token: t.coord, body: { id: rec.id, ativo: false } }).its('status').should('eq', 200);
        atualizar({ id: rec.id, polo: 'Polo X' }).its('status').should('eq', 404);
      });
    });
  });
});
