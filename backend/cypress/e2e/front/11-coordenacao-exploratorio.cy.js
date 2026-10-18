// Correções encontradas nos testes exploratórios da COORDENAÇÃO (parte das telas; o servidor é simulado)
import { SESSOES } from '../../support/dados';
import { abrirCoordenador, irParaAba, respostaAuditoria, DISCIPLINAS_PADRAO } from '../../support/telas';
import { dataSP, hojeSP } from '../../support/datas';

const usuario = (o = {}) => ({ id: 1, nome: 'Ana Souza', matricula: 'E00000', curso: 'Direito', tipo: 'Aluno', email: 'ana@x.com', ativo: true, foto_url: null, polo: null, ...o });
const USUARIOS_TIPOS = [
  usuario({ id: 1, nome: 'Ana Aluna', tipo: 'Aluno' }),
  usuario({ id: 2, nome: 'Caio Coord', matricula: 'C00001', tipo: 'coordenador', curso: '' }),
  usuario({ id: 3, nome: 'Rita Recep', matricula: 'AT00001', tipo: 'Recepção do Polo', curso: '', polo: 'Polo Resende' }),
  usuario({ id: 4, nome: 'Davi Auditor', matricula: 'TESTE_AUDIT', tipo: 'AUDIT', curso: '' }),
  usuario({ id: 5, nome: 'Bia Antiga', matricula: 'E00009', tipo: ' aluno ' }),
  usuario({ id: 6, nome: 'Rui Recep', matricula: 'AT00002', tipo: 'recepção do polo', curso: '', polo: 'Polo Barra Mansa' })
];
const linha = (nome) => cy.contains('#listaUsuarios tr', nome);

// ------------------------------------------------------------------
describe('Item 1: confirmação de exclusão só fala em agendamentos para aluno', () => {
  beforeEach(() => {
    abrirCoordenador({ usuarios: USUARIOS_TIPOS });
    irParaAba('usuarios');
  });

  it('aluno: explica que só as provas que ainda não terminaram e sem entrada são canceladas', () => {
    linha('Ana Aluna').contains('button', 'Excluir').click();
    cy.swal('Excluir usuário?', 'Ana Aluna não poderá mais entrar no sistema.');
    cy.get('.swal2-html-container').should('contain.text', 'agendamentos de provas que ainda não terminaram e sem entrada confirmada serão cancelados')
      .and('contain.text', 'os com entrada confirmada e os de provas já terminadas são mantidos');
  });

  it('aluno com o tipo gravado em minúsculas e espaços também é tratado como aluno', () => {
    linha('Bia Antiga').contains('button', 'Excluir').click();
    cy.get('.swal2-html-container').should('contain.text', 'agendamentos');
  });

  ['Caio Coord', 'Rita Recep', 'Davi Auditor'].forEach((nome) => {
    it(`${nome}: a mensagem não cita agendamentos`, () => {
      linha(nome).contains('button', 'Excluir').click();
      cy.swal('Excluir usuário?');
      cy.get('.swal2-html-container')
        .should('have.text', `${nome} não poderá mais entrar no sistema. O histórico e os logs são mantidos.`)
        .and('not.contain.text', 'agendamento');
    });
  });

  it('o resultado mostra os dois números que o servidor mandou', () => {
    cy.mockApi('POST', '/api/alterar-status-usuario', { sucesso: true, mensagem: 'Usuário excluído. 2 agendamento(s) futuro(s) cancelado(s); 1 com entrada confirmada foi mantido.' }, { alias: 'status' });
    linha('Ana Aluna').contains('button', 'Excluir').click();
    cy.confirmarSwal();
    cy.wait('@status');
    cy.swal('Pronto!', 'Usuário excluído. 2 agendamento(s) futuro(s) cancelado(s); 1 com entrada confirmada foi mantido.');
  });
});

// ------------------------------------------------------------------
describe('Item 7: coluna de tipo com rótulo padronizado', () => {
  it('mostra Aluno, Coordenador, Recepção e Auditor, seja qual for a grafia gravada', () => {
    abrirCoordenador({ usuarios: USUARIOS_TIPOS });
    irParaAba('usuarios');
    const tipoNaLinha = (nome) => linha(nome).find('td').eq(3);
    tipoNaLinha('Ana Aluna').should('have.text', 'Aluno');
    tipoNaLinha('Bia Antiga').should('have.text', 'Aluno');
    tipoNaLinha('Caio Coord').should('have.text', 'Coordenador');
    tipoNaLinha('Rita Recep').should('have.text', 'Recepção');
    tipoNaLinha('Rui Recep').should('have.text', 'Recepção');
    tipoNaLinha('Davi Auditor').should('have.text', 'Auditor');
  });

  it('só muda a exibição: as regras por tipo continuam (foto para aluno, polo para recepção)', () => {
    abrirCoordenador({ usuarios: USUARIOS_TIPOS });
    irParaAba('usuarios');
    linha('Bia Antiga').find('[data-usuario-acao="foto"]').should('exist');
    linha('Rui Recep').find('[data-usuario-acao="polo"]').should('exist').and('contain.text', 'Trocar polo');
    linha('Rui Recep').should('contain.text', 'Polo Barra Mansa');
  });
});

// ------------------------------------------------------------------
describe('Item 3: resultado das notas na coordenação', () => {
  const nota = (o = {}) => ({ id: 1, nome_aluno: 'Aluno', matricula: 'E00001', avaliacao: 'Prova', polo: 'Resende', nota: '7.00', resultado: 'Aprovado', ...o });
  const notas = [
    nota({ id: 1, nome_aluno: 'Nota Sete', nota: '7.00', resultado: 'Aprovado' }),
    nota({ id: 2, nome_aluno: 'Nota Cinco', nota: '5.00', resultado: 'Reprovado' }),
    nota({ id: 3, nome_aluno: 'Sem Lancamento', nota: null, resultado: 'Sem nota' })
  ];
  const selo = (nome) => cy.contains('#page-sincronizacao tbody tr', nome).find('[data-resultado]');

  it('a coluna Status mostra Aprovado (verde), Reprovado (vermelho) e Sem nota, e nunca "Sincronizado"', () => {
    abrirCoordenador({ notas });
    irParaAba('sincronizacao');
    selo('Nota Sete').should('have.text', 'Aprovado').and('have.class', 'bg-emerald-100').and('have.class', 'text-emerald-800');
    selo('Nota Cinco').should('have.text', 'Reprovado').and('have.class', 'bg-red-100').and('have.class', 'text-red-800');
    selo('Sem Lancamento').should('have.text', 'Sem nota').and('have.class', 'bg-slate-100');
    cy.get('#page-sincronizacao').should('not.contain.text', 'Sincronizado');
  });

  it('a tela só exibe o que o servidor calculou (não recalcula pela nota)', () => {
    abrirCoordenador({ notas: [nota({ nome_aluno: 'Regra Servidor', nota: '9.00', resultado: 'Reprovado' })] });
    irParaAba('sincronizacao');
    selo('Regra Servidor').should('have.text', 'Reprovado');
  });

  it('depois de salvar, recarrega a lista para mostrar o novo resultado', () => {
    abrirCoordenador({ notas: [nota({ nome_aluno: 'Vai Mudar', nota: '5.00', resultado: 'Reprovado' })] });
    irParaAba('sincronizacao');
    cy.wait('@notas');
    selo('Vai Mudar').should('have.text', 'Reprovado');
    cy.mockApi('POST', '/api/atualizar-nota', { sucesso: true, mensagem: 'Nota salva com sucesso!' }, { alias: 'salvar' });
    cy.mockApi('GET', '/api/notas', [nota({ nome_aluno: 'Vai Mudar', nota: '7.00', resultado: 'Aprovado' })], { alias: 'notasDepois' });
    cy.get('#nota-1').clear().type('7');
    cy.get('[data-salvar-nota="1"]').click();
    cy.wait('@salvar').its('request.body').should('deep.equal', { id: 1, nota: 7 });
    cy.wait('@notasDepois');
    selo('Vai Mudar').should('have.text', 'Aprovado');
  });

  it('nota recusada pelo servidor mostra a mensagem dele', () => {
    const mensagem = 'Informe uma nota numérica entre 0 e 10, com até 2 casas decimais (ex.: 7.5). Texto, vírgula e outros formatos não são aceitos.';
    abrirCoordenador({ notas: [nota()] });
    irParaAba('sincronizacao');
    cy.mockApi('POST', '/api/atualizar-nota', { sucesso: false, mensagem }, { status: 400 });
    cy.get('#nota-1').clear().type('7.555');
    cy.get('[data-salvar-nota="1"]').click();
    cy.swal('Atenção', mensagem);
  });
});

// ------------------------------------------------------------------
describe('Item 4: prova em andamento na lista de vagas', () => {
  const vaga = (o = {}) => ({
    id: 1, polo: 'Polo EaD Resende', curso: 'Engenharia de Software', disciplina: 'A', data_prova: hojeSP(),
    horario: '00:00:00', horario_fim: '23:59:00', limite_vagas: 40, agendamento_inicio: null, agendamento_fim: null,
    criado_em: '2030-05-20T15:30:00.000Z', criado_por: 'Prof. Carlos Lima', ocupadas: 3, futura: true, ...o
  });

  it('a prova que ainda não terminou (servidor manda futura) não aparece como "Prova realizada"', () => {
    abrirCoordenador({ vagas: [vaga({ id: 1, disciplina: 'Em Andamento' }), vaga({ id: 2, disciplina: 'Terminada', data_prova: dataSP(-1), futura: false })] });
    cy.contains('#listaVagas tr', 'Em Andamento').should('not.contain.text', 'Prova realizada');
    cy.contains('#listaVagas tr', 'Terminada').should('contain.text', 'Prova realizada');
    cy.contains('#listaVagas tr', 'Em Andamento').find('[data-vaga-detalhe]').click();
    cy.get('#conteudoDetalheVaga').should('contain.text', 'Prova agendada').and('not.contain.text', 'Prova realizada');
  });
});

// ------------------------------------------------------------------
describe('Item 5: Voltar depois de Sair', () => {
  const PAGINAS = {
    aluno: { arquivo: 'alunoHome.html', dado: 'MARIA CLARA SOUZA' },
    coordenador: { arquivo: 'coordenadorHome.html', dado: 'ana@x.com' },
    recepcao: { arquivo: 'recepcaoHome.html', dado: 'Recepção Resende' },
    audit: { arquivo: 'auditHome.html', dado: 'Auditor Geral' }
  };

  // token no formato JWT só com o "exp" (o navegador lê o exp; quem valida de verdade é o servidor)
  const tokenComExp = (exp) => `cabecalho.${btoa(JSON.stringify({ exp })).replace(/=+$/, '')}.assinatura`;

  // entra como se tivesse acabado de fazer login: o login fica no histórico antes do painel
  // (um segundo cy.visit, com a sessão gravada antes de carregar; trocar location.href pelo
  // próprio Cypress não dispara o load da página nova)
  function entrarPeloLogin(chave) {
    const { arquivo } = PAGINAS[chave];
    cy.stubApiGeral();
    cy.mockApi('GET', '/api/usuarios', [usuario()]);
    cy.abrirPagina('login.html');
    cy.visit(`/${arquivo}`, {
      onBeforeLoad(win) { Object.entries(SESSOES[chave]).forEach(([k, v]) => win.localStorage.setItem(k, v)); }
    });
    cy.location('pathname').should('eq', `/${arquivo}`);
    cy.contains(PAGINAS[chave].dado).should('exist');
  }

  Object.entries(PAGINAS).forEach(([chave, { arquivo, dado }]) => {
    context(arquivo, () => {
      it('sair e apertar Voltar cai no login, sem mostrar os dados do painel', () => {
        entrarPeloLogin(chave);
        cy.get('#userAvatar').click();
        cy.get('#userDropdown').contains(/Sair/).click();
        cy.confirmarSwal();
        cy.location('pathname').should('eq', '/login.html');

        cy.go('back');
        cy.location('pathname').should('eq', '/login.html');
        cy.get('body').should('not.contain.text', dado);
        cy.get('#userDropdown').should('not.exist');
      });

      it('página reexibida do cache do navegador (pageshow persisted) sem sessão vai para o login com replace', () => {
        entrarPeloLogin(chave);
        cy.window().then((win) => {
          win.localStorage.clear(); // como depois de "Sair" em outra aba
          win.dispatchEvent(new win.PageTransitionEvent('pageshow', { persisted: true }));
        });
        cy.location('pathname').should('eq', '/login.html');
        cy.get('body').should('not.contain.text', dado);
      });

      it('reexibida do cache com a sessão ainda válida: recarrega (nada de dados velhos) e continua no painel', () => {
        entrarPeloLogin(chave);
        cy.window().then((win) => {
          win.__antesDoCache = true;
          win.dispatchEvent(new win.PageTransitionEvent('pageshow', { persisted: true }));
        });
        cy.window().should('not.have.property', '__antesDoCache');
        cy.location('pathname').should('eq', `/${arquivo}`);
      });

      it('aberta com token vencido vai direto para o login; com token no prazo continua', () => {
        cy.stubApiGeral();
        cy.abrirPagina(arquivo, { ...SESSOES[chave], unifaa_token: tokenComExp(Math.floor(Date.now() / 1000) - 60) });
        cy.location('pathname').should('eq', '/login.html');

        cy.abrirPagina(arquivo, { ...SESSOES[chave], unifaa_token: tokenComExp(Math.floor(Date.now() / 1000) + 3600) });
        cy.location('pathname').should('eq', `/${arquivo}`);
        cy.get('#userName').should('have.text', SESSOES[chave].usuario_nome);
      });
    });
  });

  it('no próprio login o pageshow não redireciona nem recarrega (sem laço)', () => {
    cy.stubApiGeral();
    cy.abrirPagina('login.html');
    cy.window().then((win) => {
      win.__semLaco = true;
      win.dispatchEvent(new win.PageTransitionEvent('pageshow', { persisted: true }));
    });
    cy.wait(500);
    cy.window().its('__semLaco').should('eq', true);
    cy.location('pathname').should('eq', '/login.html');
  });
});

// ------------------------------------------------------------------
describe('Item 7: texto longo sem espaço quebra dentro das células', () => {
  const LONGO = 'W'.repeat(100);
  const larguraDaTabela = (tbody) => cy.get(tbody).closest('.overflow-x-auto').then(($w) => $w[0].scrollWidth);
  const cabeNaCaixa = ($el) => expect($el[0].scrollWidth, 'o texto não passa da própria caixa').to.be.at.most($el[0].clientWidth + 1);
  const semRolagemHorizontal = () =>
    cy.document().then((d) => expect(d.documentElement.scrollWidth).to.be.at.most(d.documentElement.clientWidth));
  const semEstourarATabela = (tbody) =>
    cy.get(tbody).closest('.overflow-x-auto').then(($w) => expect($w[0].scrollWidth).to.be.at.most($w[0].clientWidth + 1));

  const cenarios = {
    disciplinas: {
      tbody: '#listaDisciplinas',
      abrir: (nome) => { abrirCoordenador({ disciplinas: [{ ...DISCIPLINAS_PADRAO[0], nome }] }); irParaAba('disciplinas'); }
    },
    vagas: {
      tbody: '#listaVagas',
      abrir: (nome) => abrirCoordenador({
        vagas: [{
          id: 1, polo: nome, curso: nome, disciplina: nome, data_prova: dataSP(5), horario: '08:00:00', horario_fim: '10:00:00',
          limite_vagas: 5, agendamento_inicio: null, agendamento_fim: null, criado_em: null, criado_por: null, ocupadas: 0, futura: true
        }]
      })
    },
    usuarios: {
      tbody: '#listaUsuarios',
      abrir: (nome) => { abrirCoordenador({ usuarios: [usuario({ nome, email: `${nome}@x.com`, curso: nome })] }); irParaAba('usuarios'); }
    }
  };

  Object.entries(cenarios).forEach(([nomeCenario, { tbody, abrir }]) => {
    it(`${nomeCenario}: em 1366 px a tabela não estoura e o texto quebra dentro da célula`, () => {
      cy.viewport(1366, 768);
      abrir(LONGO);
      semEstourarATabela(tbody);
      cy.get(`${tbody} .quebra-texto`).each(cabeNaCaixa);
    });

    it(`${nomeCenario}: em 375 px o texto longo não alarga a tabela mais que um texto normal`, () => {
      cy.viewport(375, 740);
      abrir('Texto normal');
      larguraDaTabela(tbody).then((normal) => {
        abrir(LONGO);
        larguraDaTabela(tbody).should('be.at.most', normal + 1);
      });
      semRolagemHorizontal();
    });
  });

  it('auditoria da coordenação em 375 px: um log com texto longo não faz a página rolar na horizontal', () => {
    cy.viewport(375, 740);
    abrirCoordenador({
      logs: [{ id: 1, acao: 'CADASTRO_DISCIPLINA', descricao: `Disciplina cadastrada: ${LONGO}`, usuario: LONGO, ip: '::1', data_hora: '2030-05-20T15:30:00.000Z' }]
    });
    irParaAba('auditoria');
    cy.wait('@logs');
    cy.get('#lista-logs-auditoria > div').should('have.length', 1);
    semRolagemHorizontal();
    cy.get('#lista-logs-auditoria .quebra-texto').each(cabeNaCaixa);
  });

  it('auditor em 375 px: descrição longa quebra na célula e a página não rola na horizontal', () => {
    const log = (descricao) => ({ id: 1, acao: 'CADASTRO_DISCIPLINA', descricao, usuario: 'Coord', ip: '::1', data_hora: '2030-05-20T15:30:00.000Z' });
    const abrirAuditor = (descricao) => {
      cy.stubApiGeral();
      cy.mockApi('GET', '/api/admin/auditoria-completa',
        respostaAuditoria([log(descricao)], { estatisticas: { totalTransacoes: 1, registrosInativos: 0, violacoes24h: 0 } }), { alias: 'audit' });
      cy.abrirPagina('auditHome.html', SESSOES.audit);
      cy.wait('@audit');
    };
    cy.viewport(375, 740);
    abrirAuditor('Disciplina cadastrada: Texto normal');
    larguraDaTabela('#auditTable tbody').then((normal) => {
      abrirAuditor(`Disciplina cadastrada: ${LONGO}`);
      larguraDaTabela('#auditTable tbody').should('be.at.most', normal + 1);
    });
    semRolagemHorizontal();
    cy.get('#auditTable .quebra-texto').each(cabeNaCaixa);
  });

  it('texto normal com espaços não é quebrado no meio das palavras (1366 px)', () => {
    cy.viewport(1366, 768);
    abrirCoordenador({ disciplinas: [{ ...DISCIPLINAS_PADRAO[0], nome: 'Cálculo Diferencial e Integral' }] });
    irParaAba('disciplinas');
    cy.contains('#listaDisciplinas .quebra-texto', 'Cálculo Diferencial e Integral').then(($d) => {
      const alturaLinha = parseFloat(getComputedStyle($d[0]).lineHeight);
      expect($d[0].getBoundingClientRect().height, 'cabe em uma linha').to.be.at.most(alturaLinha + 1);
    });
  });
});
