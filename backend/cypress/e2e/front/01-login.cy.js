import { SESSOES } from '../../support/dados';

const preencherLogin = (matricula, senha) => {
  cy.get('#matricula').type(matricula);
  cy.get('#senha').type(senha);
};

describe('Tela de login', () => {
  beforeEach(() => {
    cy.stubApiGeral();
    cy.abrirPagina('login.html');
  });

  it('mostra o formulário e mantém o modal de senha escondido', () => {
    cy.contains('Portal do Aluno');
    cy.get('#matricula').should('have.attr', 'required');
    cy.get('#senha').should('have.attr', 'type', 'password');
    cy.get('#modalRecuperar').should('have.css', 'display', 'none');
  });

  it('não envia o formulário com campos vazios', () => {
    cy.mockApi('POST', '/api/login', {}, { alias: 'login' });
    cy.get('.btn-submit').click();
    cy.get('@login.all').should('have.length', 0);
  });

  it('credenciais inválidas mostram erro e não gravam sessão', () => {
    cy.mockApi('POST', '/api/login', { sucesso: false, mensagem: 'Matrícula ou senha incorretas.' }, { status: 401, alias: 'login' });
    preencherLogin('E00001', 'errada');
    cy.get('.btn-submit').click();

    cy.wait('@login').its('request.body').should('deep.equal', { matricula: 'E00001', senha: 'errada' });
    cy.swal('Erro no login', 'Matrícula ou senha incorretas.');
    cy.window().then((win) => expect(win.localStorage.getItem('unifaa_token')).to.be.null);
  });

  it('falha de rede mostra "Erro de Conexão"', () => {
    cy.intercept({ method: 'POST', pathname: '/api/login' }, { forceNetworkError: true });
    preencherLogin('E00001', 'qualquer');
    cy.get('.btn-submit').click();
    cy.swal('Erro de Conexão');
  });

  [
    ['aluno', 'Aluno', 'alunoHome.html'],
    ['coordenador', 'coordenador', 'coordenadorHome.html'],
    ['recepção do polo', 'Recepção do Polo', 'recepcaoHome.html'],
    ['audit', 'AUDIT', 'auditHome.html']
  ].forEach(([perfil, tipo, pagina]) => {
    it(`login de "${tipo}" grava a sessão e abre ${pagina}`, () => {
      cy.mockApi('POST', '/api/login',
        { sucesso: true, token: 'tok-123', nome: 'Fulano de Tal', curso: 'Curso X', tipo, perfil, matricula: 'M123' },
        { alias: 'login' });
      preencherLogin('M123', 'Senha@123');
      cy.get('.btn-submit').click();

      cy.location('pathname').should('eq', `/${pagina}`);
      cy.window().then((win) => {
        expect(win.localStorage.getItem('unifaa_token')).to.eq('tok-123');
        expect(win.localStorage.getItem('usuario_nome')).to.eq('Fulano de Tal');
        expect(win.localStorage.getItem('usuario_perfil')).to.eq(perfil);
        expect(win.localStorage.getItem('usuario_matricula')).to.eq('M123');
      });
    });
  });

  it('perfil desconhecido mostra aviso e não deixa sessão gravada', () => {
    cy.mockApi('POST', '/api/login',
      { sucesso: true, token: 't', nome: 'X', curso: 'Y', tipo: 'Visitante', perfil: 'visitante', matricula: 'M1' });
    preencherLogin('M1', 'Senha@123');
    cy.get('.btn-submit').click();

    cy.swal('Atenção', 'Perfil de usuário não reconhecido pelo sistema.');
    cy.window().then((win) => expect(win.localStorage.getItem('unifaa_token')).to.be.null);
  });

  it('senha provisória: avisa e abre direto a tela de definir nova senha', () => {
    cy.mockApi('POST', '/api/login',
      { sucesso: false, trocar_senha: true, mensagem: 'Primeiro acesso: é necessário definir uma nova senha.' }, { status: 403 });
    preencherLogin('E00009', 'ProvisoriA1');
    cy.get('.btn-submit').click();

    cy.swal('Primeiro acesso');
    cy.confirmarSwal();
    cy.get('#modalRecuperar').should('have.css', 'display', 'flex');
    cy.get('#passo2Confirmar').should('be.visible');
    cy.get('#passo1Solicitar').should('not.be.visible');
    cy.get('#resumoMatricula').should('contain.text', 'Matrícula: E00009');
    cy.window().then((win) => expect(win.localStorage.getItem('unifaa_token')).to.be.null);
  });
});

describe('Esqueci minha senha / primeiro acesso', () => {
  beforeEach(() => {
    cy.stubApiGeral();
    cy.abrirPagina('login.html');
  });

  it('abre o modal já com a matrícula digitada no login', () => {
    cy.get('#matricula').type('E00005');
    cy.get('#btnEsqueciSenha').click();
    cy.get('#modalRecuperar').should('have.css', 'display', 'flex');
    cy.get('#matriculaRecuperar').should('have.value', 'E00005');
    cy.get('#passo1Solicitar').should('be.visible');
  });

  it('fecha pelo X, por Cancelar e clicando fora', () => {
    cy.get('#btnEsqueciSenha').click();
    cy.get('#fecharModal').click();
    cy.get('#modalRecuperar').should('have.css', 'display', 'none');

    cy.get('#btnEsqueciSenha').click();
    cy.get('#btnCancelarModal').click();
    cy.get('#modalRecuperar').should('have.css', 'display', 'none');

    cy.get('#btnEsqueciSenha').click();
    cy.get('#modalRecuperar').click('topLeft');
    cy.get('#modalRecuperar').should('have.css', 'display', 'none');
  });

  it('passo 1: solicita o código e avança para o passo 2', () => {
    cy.mockApi('POST', '/api/solicitar-codigo',
      { sucesso: true, mensagem: 'Se a matrícula estiver cadastrada, enviaremos um código.' }, { alias: 'codigo' });
    cy.get('#btnEsqueciSenha').click();
    cy.get('#matriculaRecuperar').type('E00005');
    cy.get('#btnEnviarCodigo').click();

    cy.wait('@codigo').its('request.body').should('deep.equal', { matricula: 'E00005' });
    cy.swal('Solicitação enviada', 'Se a matrícula estiver cadastrada');
    cy.confirmarSwal();
    cy.get('#passo2Confirmar').should('be.visible');
    cy.get('#resumoMatricula').should('contain.text', 'E00005');
  });

  it('passo 1: erro do servidor é mostrado e o modal continua no passo 1', () => {
    cy.mockApi('POST', '/api/solicitar-codigo', { sucesso: false, mensagem: 'Muitas solicitações. Aguarde alguns minutos.' }, { status: 429 });
    cy.get('#btnEsqueciSenha').click();
    cy.get('#matriculaRecuperar').type('E00005');
    cy.get('#btnEnviarCodigo').click();

    cy.swal('Erro', 'Muitas solicitações');
    cy.confirmarSwal();
    cy.get('#passo1Solicitar').should('be.visible');
  });

  it('"Já tenho a senha provisória" exige a matrícula', () => {
    cy.get('#btnEsqueciSenha').click();
    cy.get('#btnJaTenhoSenha').click();
    cy.swal('Informe a matrícula');
  });

  it('"Já tenho a senha provisória" vai direto ao passo 2 sem pedir código', () => {
    cy.mockApi('POST', '/api/solicitar-codigo', {}, { alias: 'codigo' });
    cy.get('#btnEsqueciSenha').click();
    cy.get('#matriculaRecuperar').type('E00005');
    cy.get('#btnJaTenhoSenha').click();

    cy.get('#passo2Confirmar').should('be.visible');
    cy.get('@codigo.all').should('have.length', 0);
  });

  it('passo 2: define a nova senha e fecha o modal', () => {
    cy.mockApi('POST', '/api/recuperar-senha', { sucesso: true, mensagem: 'Senha definida com sucesso! Você já pode fazer login.' }, { alias: 'recuperar' });
    cy.get('#btnEsqueciSenha').click();
    cy.get('#matriculaRecuperar').type('E00005');
    cy.get('#btnJaTenhoSenha').click();
    cy.get('#codigoVerificacao').type('ProvisoriA1');
    cy.get('#novaSenhaRecuperar').type('NovaSenha@1');
    cy.get('#formConfirmarCodigo button[type=submit]').click();

    cy.wait('@recuperar').its('request.body')
      .should('deep.equal', { matricula: 'E00005', codigo: 'ProvisoriA1', novaSenha: 'NovaSenha@1' });
    cy.swal('Sucesso!', 'Senha definida com sucesso');
    cy.confirmarSwal();
    cy.get('#modalRecuperar').should('have.css', 'display', 'none');
  });

  it('passo 2: nova senha com menos de 8 caracteres não é enviada', () => {
    cy.mockApi('POST', '/api/recuperar-senha', {}, { alias: 'recuperar' });
    cy.get('#btnEsqueciSenha').click();
    cy.get('#matriculaRecuperar').type('E00005');
    cy.get('#btnJaTenhoSenha').click();
    cy.get('#codigoVerificacao').type('123456');
    cy.get('#novaSenhaRecuperar').type('curta');
    cy.get('#formConfirmarCodigo button[type=submit]').click();
    cy.get('@recuperar.all').should('have.length', 0);
  });

  it('passo 2: código inválido mostra a mensagem do servidor', () => {
    cy.mockApi('POST', '/api/recuperar-senha', { sucesso: false, mensagem: 'Código ou senha provisória inválidos ou expirados.' }, { status: 400 });
    cy.get('#btnEsqueciSenha').click();
    cy.get('#matriculaRecuperar').type('E00005');
    cy.get('#btnJaTenhoSenha').click();
    cy.get('#codigoVerificacao').type('000000');
    cy.get('#novaSenhaRecuperar').type('NovaSenha@1');
    cy.get('#formConfirmarCodigo button[type=submit]').click();
    cy.swal('Erro', 'inválidos ou expirados');
  });

  it('"Voltar" retorna ao passo 1 e limpa os campos do passo 2', () => {
    cy.get('#btnEsqueciSenha').click();
    cy.get('#matriculaRecuperar').type('E00005');
    cy.get('#btnJaTenhoSenha').click();
    cy.get('#codigoVerificacao').type('abc');
    cy.get('#btnVoltarPasso1').click();

    cy.get('#passo1Solicitar').should('be.visible');
    cy.get('#codigoVerificacao').should('have.value', '');
  });

  it('o campo do código aceita senha provisória longa', () => {
    cy.get('#btnEsqueciSenha').click();
    cy.get('#matriculaRecuperar').type('E00005');
    cy.get('#btnJaTenhoSenha').click();
    cy.get('#codigoVerificacao').should('have.attr', 'maxlength', '64').type('AbCdEfGhJk').should('have.value', 'AbCdEfGhJk');
  });
});

describe('Mostrar / ocultar senha', () => {
  const olho = (campo) => `${campo} + .btn-mostrar-senha`;

  // o campo começa oculto, o olho alterna para texto e volta
  const conferirAlternancia = (campo) => {
    cy.get(campo).should('have.attr', 'type', 'password');
    cy.get(olho(campo))
      .should('have.attr', 'type', 'button')
      .and('have.attr', 'aria-pressed', 'false')
      .and('have.attr', 'aria-label', 'Mostrar senha')
      .find('i').should('have.class', 'fa-eye');

    cy.get(olho(campo)).click();
    cy.get(campo).should('have.attr', 'type', 'text');
    cy.get(olho(campo))
      .should('have.attr', 'aria-pressed', 'true')
      .and('have.attr', 'aria-label', 'Ocultar senha')
      .find('i').should('have.class', 'fa-eye-slash');

    cy.get(olho(campo)).click();
    cy.get(campo).should('have.attr', 'type', 'password');
    cy.get(olho(campo))
      .should('have.attr', 'aria-pressed', 'false')
      .and('have.attr', 'aria-label', 'Mostrar senha');
  };

  const abrirPasso2 = () => {
    cy.get('#btnEsqueciSenha').click();
    cy.get('#matriculaRecuperar').type('E00005');
    cy.get('#btnJaTenhoSenha').click();
  };

  // a senha não aparece na URL nem no localStorage / sessionStorage
  const senhaNaoFoiGuardada = (senha) => {
    cy.location('href').should('not.contain', senha).and('not.contain', encodeURIComponent(senha));
    cy.window().then((win) => {
      [win.localStorage, win.sessionStorage].forEach((armazenamento) => {
        for (let i = 0; i < armazenamento.length; i++) {
          expect(armazenamento.getItem(armazenamento.key(i))).not.to.contain(senha);
        }
      });
    });
  };

  beforeEach(() => {
    cy.stubApiGeral();
    cy.abrirPagina('login.html');
  });

  it('login: o campo começa oculto, o olho alterna e volta, sem enviar o formulário', () => {
    cy.mockApi('POST', '/api/login', {}, { alias: 'login' });
    conferirAlternancia('#senha');
    cy.get('@login.all').should('have.length', 0);
  });

  it('login: o valor digitado continua o mesmo ao mostrar e ocultar', () => {
    cy.get('#senha').type('Senha@Longa123');
    cy.get(olho('#senha')).click();
    cy.get('#senha').should('have.value', 'Senha@Longa123');
    cy.get(olho('#senha')).click();
    cy.get('#senha').should('have.value', 'Senha@Longa123');
  });

  it('login: o campo tem espaço à direita para o ícone e o olho entra na ordem do Tab', () => {
    cy.get('#senha').should('have.class', 'campo-com-olho')
      .and(($c) => expect(parseFloat($c.css('padding-right'))).to.be.at.least(40));
    cy.get(olho('#senha')).should('be.visible').and('not.have.attr', 'tabindex');
    cy.get('#senha').focus();
    cy.press(Cypress.Keyboard.Keys.TAB);
    cy.focused().should('have.class', 'btn-mostrar-senha');
  });

  it('login: enviar com a senha visível volta para oculto, mantém o botão travado e não vaza a senha', () => {
    cy.intercept({ method: 'POST', pathname: '/api/login' },
      { delay: 1500, statusCode: 401, body: { sucesso: false, mensagem: 'Matrícula ou senha incorretas.' } }).as('login');
    cy.get('#matricula').type('E00001');
    cy.get('#senha').type('Senha@Secreta1');
    cy.get(olho('#senha')).click();
    cy.get('#senha').should('have.attr', 'type', 'text');

    cy.get('.btn-submit').click();
    cy.get('#senha').should('have.attr', 'type', 'password');
    cy.get(olho('#senha')).should('have.attr', 'aria-pressed', 'false');
    cy.get('.btn-submit').should('be.disabled');

    cy.wait('@login').its('request.body').should('deep.equal', { matricula: 'E00001', senha: 'Senha@Secreta1' });
    cy.swal('Erro no login', 'Matrícula ou senha incorretas.');
    cy.get('.btn-submit').should('not.be.disabled');
    senhaNaoFoiGuardada('Senha@Secreta1');
  });

  it('login: Enter no campo de senha continua enviando pelo botão Acessar', () => {
    cy.mockApi('POST', '/api/login', { sucesso: false, mensagem: 'Matrícula ou senha incorretas.' }, { status: 401, alias: 'login' });
    cy.get('#matricula').type('E00001');
    cy.get('#senha').type('errada{enter}');
    cy.wait('@login').its('request.body').should('deep.equal', { matricula: 'E00001', senha: 'errada' });
  });

  it('nova senha (recuperação / primeiro acesso): o olho alterna e volta', () => {
    abrirPasso2();
    conferirAlternancia('#novaSenhaRecuperar');
  });

  it('nova senha: "Voltar" e fechar o modal deixam o campo oculto de novo', () => {
    abrirPasso2();
    cy.get(olho('#novaSenhaRecuperar')).click();
    cy.get('#novaSenhaRecuperar').should('have.attr', 'type', 'text');
    cy.get('#btnVoltarPasso1').click();
    cy.get('#novaSenhaRecuperar').should('have.attr', 'type', 'password');

    cy.get('#btnJaTenhoSenha').click();
    cy.get(olho('#novaSenhaRecuperar')).click();
    cy.get('#fecharModal').click();
    cy.get('#novaSenhaRecuperar').should('have.attr', 'type', 'password');
    cy.get(olho('#novaSenhaRecuperar')).should('have.attr', 'aria-pressed', 'false');
  });

  it('nova senha: enviar com a senha visível volta para oculto e não vaza a senha', () => {
    cy.mockApi('POST', '/api/recuperar-senha', { sucesso: true, mensagem: 'Senha definida com sucesso! Você já pode fazer login.' }, { alias: 'recuperar' });
    abrirPasso2();
    cy.get('#codigoVerificacao').type('ProvisoriA1');
    cy.get('#novaSenhaRecuperar').type('NovaSenha@1');
    cy.get(olho('#novaSenhaRecuperar')).click();
    cy.get('#formConfirmarCodigo button[type=submit]').click();

    cy.get('#novaSenhaRecuperar').should('have.attr', 'type', 'password');
    cy.wait('@recuperar').its('request.body')
      .should('deep.equal', { matricula: 'E00005', codigo: 'ProvisoriA1', novaSenha: 'NovaSenha@1' });
    cy.swal('Sucesso!', 'Senha definida com sucesso');
    senhaNaoFoiGuardada('NovaSenha@1');
  });

  it('primeiro acesso aberto pelo login: os dois campos de senha ficam ocultos', () => {
    cy.mockApi('POST', '/api/login',
      { sucesso: false, trocar_senha: true, mensagem: 'Primeiro acesso: é necessário definir uma nova senha.' }, { status: 403 });
    cy.get('#matricula').type('E00009');
    cy.get('#senha').type('ProvisoriA1');
    cy.get(olho('#senha')).click();
    cy.get('.btn-submit').click();
    cy.swal('Primeiro acesso');
    cy.confirmarSwal();
    cy.get('#senha').should('have.attr', 'type', 'password');
    cy.get('#novaSenhaRecuperar').should('have.attr', 'type', 'password');
    cy.get(olho('#novaSenhaRecuperar')).should('be.visible').and('have.attr', 'aria-pressed', 'false');
  });
});
