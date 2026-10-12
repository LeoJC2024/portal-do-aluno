import { USUARIOS } from '../../support/dados';
import { criarUsuarioAtivo } from '../../support/apiHelpers';

describe('API: recuperação de senha', () => {
  const t = {};
  let u; // usuário novo a cada teste

  before(() => {
    cy.task('prepararBanco');
    cy.tokenDe(USUARIOS.coord).then((x) => { t.coord = x; });
  });

  beforeEach(() => {
    criarUsuarioAtivo(t.coord).then((novo) => { u = novo; });
  });

  const solicitar = (matricula) => cy.api('POST', '/api/solicitar-codigo', { body: { matricula } });
  const recuperar = (matricula, codigo, novaSenha) => cy.api('POST', '/api/recuperar-senha', { body: { matricula, codigo, novaSenha } });

  it('matrícula ausente: 400', () => {
    cy.api('POST', '/api/solicitar-codigo', { body: {} }).its('status').should('eq', 400);
  });

  it('matrícula inexistente responde igual à existente (sem revelar) e sem código', () => {
    solicitar('NAO_EXISTE_999').then((desconhecida) => {
      expect(desconhecida.status).to.eq(200);
      expect(desconhecida.body).to.not.have.property('codigo_teste');
      solicitar(u.matricula).then((conhecida) => {
        expect(conhecida.status).to.eq(200);
        expect(conhecida.body.mensagem).to.eq(desconhecida.body.mensagem);
      });
    });
  });

  it('gera código de 6 dígitos, guarda só o hash e define validade futura', () => {
    solicitar(u.matricula).then((r) => {
      expect(r.body.codigo_teste).to.match(/^\d{6}$/);
      cy.bd('SELECT codigo_recuperacao, (codigo_expiracao > NOW()) AS valido, codigo_tentativas FROM usuarios WHERE matricula = $1', [u.matricula]).then((rows) => {
        expect(rows[0].codigo_recuperacao).to.not.eq(r.body.codigo_teste);
        expect(rows[0].codigo_recuperacao).to.have.length(64); // HMAC-SHA256 em hex
        expect(rows[0].valido).to.eq(true);
        expect(rows[0].codigo_tentativas).to.eq(0);
      });
    });
  });

  it('redefine a senha com o código correto: nova senha entra, antiga não, código é apagado', () => {
    solicitar(u.matricula).then((s) => {
      recuperar(u.matricula, s.body.codigo_teste, 'OutraSenha@99').then((r) => {
        expect(r.status, JSON.stringify(r.body)).to.eq(200);
        expect(r.body.sucesso).to.eq(true);
      });
    });
    cy.loginApi(u.matricula, 'OutraSenha@99').its('status').should('eq', 200);
    cy.loginApi(u.matricula, u.senha).its('status').should('eq', 401);
    cy.bd('SELECT codigo_recuperacao, codigo_expiracao FROM usuarios WHERE matricula = $1', [u.matricula]).then((rows) => {
      expect(rows[0].codigo_recuperacao).to.be.null;
      expect(rows[0].codigo_expiracao).to.be.null;
    });
  });

  it('o mesmo código não pode ser usado duas vezes', () => {
    solicitar(u.matricula).then((s) => {
      recuperar(u.matricula, s.body.codigo_teste, 'OutraSenha@99').its('status').should('eq', 200);
      recuperar(u.matricula, s.body.codigo_teste, 'MaisOutra@99').its('status').should('eq', 400);
    });
  });

  it('código errado: 400 e conta a tentativa', () => {
    solicitar(u.matricula);
    recuperar(u.matricula, '000000', 'OutraSenha@99').then((r) => {
      expect(r.status).to.eq(400);
      expect(r.body.mensagem).to.contain('inválidos ou expirados');
    });
    cy.bd('SELECT codigo_tentativas FROM usuarios WHERE matricula = $1', [u.matricula]).then((rows) => {
      expect(rows[0].codigo_tentativas).to.eq(1);
    });
    cy.loginApi(u.matricula, u.senha).its('status').should('eq', 200); // senha não mudou
  });

  it('depois de 5 erros bloqueia (mesmo com o código certo) até o código vencer e pedir outro', () => {
    solicitar(u.matricula).then((s) => {
      for (let i = 0; i < 5; i += 1) {
        recuperar(u.matricula, '111111', 'OutraSenha@99').its('status').should('eq', 400);
      }
      recuperar(u.matricula, s.body.codigo_teste, 'OutraSenha@99').then((r) => {
        expect(r.status).to.eq(400);
        expect(r.body.mensagem).to.contain('Muitas tentativas');
      });
      // o contador só volta a zero quando o código atual vence (simulado aqui)
      cy.bd(`UPDATE usuarios SET codigo_expiracao = NOW() - INTERVAL '1 minute' WHERE matricula = $1`, [u.matricula]);
      solicitar(u.matricula).then((novo) => {
        recuperar(u.matricula, novo.body.codigo_teste, 'OutraSenha@99').its('status').should('eq', 200);
      });
    });
  });

  it('código expirado é recusado', () => {
    solicitar(u.matricula).then((s) => {
      cy.bd(`UPDATE usuarios SET codigo_expiracao = NOW() - INTERVAL '1 minute' WHERE matricula = $1`, [u.matricula]);
      recuperar(u.matricula, s.body.codigo_teste, 'OutraSenha@99').its('status').should('eq', 400);
    });
  });

  it('nova senha com menos de 8 caracteres: 400', () => {
    solicitar(u.matricula).then((s) => {
      recuperar(u.matricula, s.body.codigo_teste, 'curta').then((r) => {
        expect(r.status).to.eq(400);
        expect(r.body.mensagem).to.contain('pelo menos 8');
      });
    });
  });

  it('campos faltando: 400', () => {
    cy.api('POST', '/api/recuperar-senha', { body: { matricula: u.matricula } }).its('status').should('eq', 400);
    cy.api('POST', '/api/recuperar-senha', { body: { codigo: '123456', novaSenha: 'Abcdefg@1' } }).its('status').should('eq', 400);
  });

  it('pedido de código e troca de senha aceitam a matrícula em minúsculas', () => {
    const minuscula = u.matricula.toLowerCase();
    solicitar(minuscula).then((s) => {
      expect(s.body.codigo_teste, 'a matrícula em minúsculas precisa ser reconhecida').to.match(/^\d{6}$/);
      recuperar(minuscula, s.body.codigo_teste, 'OutraSenha@99').its('status').should('eq', 200);
    });
    cy.loginApi(minuscula, 'OutraSenha@99').its('status').should('eq', 200);
    cy.loginApi(u.matricula, 'OutraSenha@99').its('status').should('eq', 200);
  });

  it('o código de um usuário não vale para outro', () => {
    criarUsuarioAtivo(t.coord).then((outro) => {
      solicitar(u.matricula).then((s) => {
        recuperar(outro.matricula, s.body.codigo_teste, 'OutraSenha@99').its('status').should('eq', 400);
      });
      cy.loginApi(outro.matricula, outro.senha).its('status').should('eq', 200);
    });
  });

  it('curingas na matrícula (% e _) não atingem outros usuários', () => {
    cy.bd('UPDATE usuarios SET codigo_recuperacao = NULL, codigo_expiracao = NULL');
    ['%', '_%', 'TESTE_%', '%A1', '%%'].forEach((m) => {
      solicitar(m).its('status').should('eq', 200);
    });
    cy.bd('SELECT COUNT(*)::int AS n FROM usuarios WHERE codigo_recuperacao IS NOT NULL').then((rows) => {
      expect(rows[0].n, 'nenhum usuário pode ter recebido código').to.eq(0);
    });

    recuperar('%', '123456', 'SenhaInvasora@1').its('status').should('eq', 400);
    cy.loginApi(USUARIOS.alunoA1.matricula, USUARIOS.alunoA1.senha).its('status').should('eq', 200);
    cy.loginApi(u.matricula, u.senha).its('status').should('eq', 200);
  });

  it('conta excluída não recebe código', () => {
    cy.api('POST', '/api/alterar-status-usuario', { token: t.coord, body: { id: u.id, ativo: false } }).its('status').should('eq', 200);
    solicitar(u.matricula).then((r) => {
      expect(r.status).to.eq(200);
      expect(r.body).to.not.have.property('codigo_teste');
    });
  });

  it('registra REDEFINICAO_SENHA na auditoria', () => {
    solicitar(u.matricula).then((s) => {
      recuperar(u.matricula, s.body.codigo_teste, 'OutraSenha@99').its('status').should('eq', 200);
    });
    cy.api('GET', '/api/auditoria', { token: t.coord }).then((r) => {
      expect(r.body.logs.some((l) => l.acao === 'REDEFINICAO_SENHA' && l.descricao.includes(u.matricula))).to.eq(true);
    });
  });
});
