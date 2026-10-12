import { SESSOES } from '../../support/dados';
import { dataSP, dataBr, hojeSP } from '../../support/datas';

const linha = (o = {}) => ({
  ticket_id: 10, usuario_id: 1, aluno_nome: 'Leonardo José', matricula: 'E00001', curso: 'Engenharia de Software',
  foto_url: 'https://example.com/leo.jpg', disciplina: 'Machine Learning', polo: 'Polo Resende',
  data_agendada: hojeSP(), horario_agendado: '08:00:00', horario_fim: '10:00:00', entrada_confirmada_em: null, ...o
});

// ao abrir, a tela busca o perfil (polo) e a lista de hoje: os dois são simulados aqui
const abrir = ({ lista = [], perfil = { polo: null } } = {}) => {
  cy.stubApiGeral();
  cy.mockApi('GET', '/api/perfil', perfil, { alias: 'perfil' });
  cy.mockApi('GET', '/api/portaria/por-data',
    { sucesso: true, total: lista.length, presentes: lista.filter((a) => a.entrada_confirmada_em).length, alunos: lista }, { alias: 'listaDia' });
  cy.abrirPagina('recepcaoHome.html', SESSOES.recepcao);
};

const mockPorNome = (resultados, alias = 'consulta') =>
  cy.mockApi('GET', '/api/portaria/consultar', { encontrado: resultados.length > 0, resultados }, { alias });
const mockPorData = (alunos, alias = 'porData') =>
  cy.mockApi('GET', '/api/portaria/por-data', { sucesso: true, total: alunos.length, presentes: alunos.filter((a) => a.entrada_confirmada_em).length, alunos }, { alias });

describe('Recepção: tela unificada', () => {
  beforeEach(abrir);

  it('mostra o cabeçalho e UM só painel de consulta (nome/matrícula + data)', () => {
    cy.get('#userName').should('have.text', 'Recepção Resende');
    cy.get('#userAvatar').should('have.text', 'R');
    // mesmo padrão da Coordenação: perfil na barra e nome + matrícula no cartão de título
    cy.get('#userRole').should('contain.text', 'Recepção do Polo').and('not.contain.text', 'Operador Portaria');
    cy.get('#userRole i.fa-chevron-down').should('exist');
    cy.get('#tituloAvatar').should('have.text', 'R');
    cy.get('#tituloNome').should('have.text', 'Recepção Resende');
    cy.get('#tituloMatricula').should('have.text', 'Matrícula AT00000').and('have.class', 'font-mono');
    cy.contains('Consultar Alunos e Validar Entrada');
    cy.get('#inputBusca').should('exist');
    cy.get('#inputDataFiltro').should('exist');
    cy.get('#btnConsultarData').should('not.exist');
    cy.contains('Validar Entrada do Estudante').should('not.exist');
  });

  it('sem nenhum filtro avisa', () => {
    cy.get('#btnConsultar').click();
    cy.swal('Nada para consultar');
  });

  it('nome com menos de 3 letras (sem data) é recusado na tela', () => {
    mockPorNome([], 'consulta');
    cy.get('#inputBusca').type('ab');
    cy.get('#btnConsultar').click();
    cy.swal('Busca muito curta');
    cy.get('@consulta.all').should('have.length', 0);
  });

  it('nome curto é aceito quando há data (filtra dentro do dia)', () => {
    mockPorData([linha()]);
    cy.get('#inputBusca').type('le');
    cy.get('#inputDataFiltro').type(hojeSP());
    cy.get('#btnConsultar').click();
    cy.wait('@porData').its('request.url').should('include', 'busca=le');
  });

  it('Enter no campo de busca consulta', () => {
    mockPorNome([linha()]);
    cy.get('#inputBusca').type('Leonardo{enter}');
    cy.wait('@consulta').its('request.url').should('include', 'busca=Leonardo');
  });
});

describe('Recepção: consulta por nome/matrícula', () => {
  beforeEach(abrir);

  it('um único aluno: lista e já abre a confirmação de presença', () => {
    mockPorNome([linha()]);
    cy.get('#inputBusca').type('Leonardo');
    cy.get('#btnConsultar').click();

    cy.get('[data-abrir-aluno]').should('have.length', 1).and('contain.text', 'Aguardando');
    cy.get('#modalAluno').should('have.class', 'flex');
    cy.get('#modalAluno').within(() => {
      cy.contains('Leonardo José');
      cy.contains('E00001');
      cy.contains('Machine Learning');
      cy.contains('08:00 – 10:00');
      cy.contains('Polo Resende');
      cy.contains('TICKET #10');
      cy.get('img').should('have.attr', 'src', 'https://example.com/leo.jpg');
      cy.contains('button', 'Confirmar Entrada').should('be.visible');
    });
  });

  it('vários alunos: lista sem abrir o modal; clicar no nome abre o aluno clicado', () => {
    mockPorNome([linha(), linha({ ticket_id: 11, aluno_nome: 'Leonora Dias', matricula: 'E00002' })]);
    cy.get('#inputBusca').type('Leo');
    cy.get('#btnConsultar').click();

    cy.get('[data-abrir-aluno]').should('have.length', 2);
    cy.get('#modalAluno').should('have.class', 'hidden');
    cy.contains('[data-abrir-aluno]', 'Leonora Dias').click();
    cy.get('#modalAluno').should('have.class', 'flex').and('contain.text', 'Leonora Dias').and('contain.text', 'TICKET #11');
  });

  it('aluno não encontrado', () => {
    mockPorNome([]);
    cy.get('#inputBusca').type('Fulano');
    cy.get('#btnConsultar').click();
    cy.contains('Aluno não encontrado no sistema.');
  });

  it('erro do servidor é mostrado', () => {
    cy.mockApi('GET', '/api/portaria/consultar', { encontrado: false, mensagem: 'Digite ao menos 3 caracteres.' }, { status: 400 });
    cy.get('#inputBusca').type('Fulano');
    cy.get('#btnConsultar').click();
    cy.contains('Erro na consulta');
    cy.contains('Digite ao menos 3 caracteres.');
  });

  it('aluno sem agendamento: badge, aviso e SEM botão de confirmar', () => {
    mockPorNome([linha({ ticket_id: null, disciplina: null, data_agendada: null, horario_agendado: null, polo: null })]);
    cy.get('#inputBusca').type('Leonardo');
    cy.get('#btnConsultar').click();
    cy.get('[data-abrir-aluno]').should('contain.text', 'Sem agendamento');
    cy.get('#modalAluno').within(() => {
      cy.contains('SEM TICKET');
      cy.contains('Aluno sem agendamento ativo a partir de hoje.');
      cy.contains('button', 'Confirmar Entrada').should('not.exist');
    });
  });

  it('sem foto mostra a inicial do nome; foto com endereço suspeito é ignorada', () => {
    mockPorNome([linha({ foto_url: 'javascript:alert(1)' })]);
    cy.get('#inputBusca').type('Leonardo');
    cy.get('#btnConsultar').click();
    cy.get('#containerResultado img').should('not.exist');
    cy.get('#modalAluno img').should('not.exist');
    cy.get('#modalAluno').should('contain.text', 'L');
  });

  it('nome com HTML não executa', () => {
    mockPorNome([linha({ aluno_nome: '<img src=x onerror="window.__xss=1">' })]);
    cy.get('#inputBusca').type('Leonardo');
    cy.get('#btnConsultar').click();
    cy.get('#modalAluno').should('have.class', 'flex');
    cy.window().its('__xss').should('not.exist');
  });
});

describe('Recepção: consulta por data (lista clicável)', () => {
  const data = dataSP(3);

  beforeEach(() => {
    abrir();
    mockPorData([
      linha({ data_agendada: data }),
      linha({ ticket_id: 11, aluno_nome: 'Ana Beatriz', matricula: 'E00002', data_agendada: data, entrada_confirmada_em: '2030-01-01T12:00:00.000Z' })
    ]);
    cy.get('#inputDataFiltro').type(data);
    cy.get('#btnConsultar').click();
    cy.wait('@porData');
  });

  it('manda a data e o filtro de nome ao servidor', () => {
    cy.get('#inputBusca').type('Ana');
    cy.get('#btnConsultar').click();
    cy.wait('@porData').its('request.url').should('include', `data=${data}`).and('include', 'busca=Ana');
  });

  it('mostra a data, o total e os presentes', () => {
    cy.contains('Alunos agendados');
    cy.contains(dataBr(data));
    cy.contains('Total').parent().should('contain.text', '2');
    cy.contains('Presentes').parent().should('contain.text', '1');
  });

  it('lista o nome de cada aluno com seu status', () => {
    cy.get('[data-abrir-aluno]').should('have.length', 2);
    cy.contains('[data-abrir-aluno]', 'Leonardo José').should('contain.text', 'Aguardando');
    cy.contains('[data-abrir-aluno]', 'Ana Beatriz').should('contain.text', 'Presente');
  });

  it('NÃO abre a confirmação sozinha; abre ao clicar no nome', () => {
    cy.get('#modalAluno').should('have.class', 'hidden');
    cy.contains('[data-abrir-aluno]', 'Leonardo José').click();
    cy.get('#modalAluno').should('have.class', 'flex').and('contain.text', 'Leonardo José');
  });

  it('avisa quando a prova do aluno não é hoje', () => {
    cy.contains('[data-abrir-aluno]', 'Leonardo José').click();
    cy.get('#modalAluno').should('contain.text', `A prova deste aluno é em ${dataBr(data)}, não hoje.`);
  });

  it('aluno que já entrou: mostra a hora e não oferece confirmar de novo', () => {
    cy.contains('[data-abrir-aluno]', 'Ana Beatriz').click();
    cy.get('#modalAluno').should('contain.text', 'Entrada já confirmada');
    cy.get('#modalAluno').contains('button', 'Confirmar Entrada').should('not.exist');
  });

  it('confirma a entrada pelo modal, fecha e atualiza a lista com "Presente"', () => {
    cy.mockApi('POST', '/api/portaria/confirmar-entrada', { sucesso: true, mensagem: 'Entrada confirmada com sucesso!' }, { alias: 'confirmar' });
    mockPorData([
      linha({ data_agendada: data, entrada_confirmada_em: '2030-01-01T12:00:00.000Z' }),
      linha({ ticket_id: 11, aluno_nome: 'Ana Beatriz', matricula: 'E00002', data_agendada: data, entrada_confirmada_em: '2030-01-01T12:00:00.000Z' })
    ], 'porData2');

    cy.contains('[data-abrir-aluno]', 'Leonardo José').click();
    cy.get('#modalAluno').contains('button', 'Confirmar Entrada').click();

    cy.wait('@confirmar').its('request.body').should('deep.equal', { ticket_id: 10 });
    cy.get('#modalAluno').should('have.class', 'hidden');
    cy.swal('Entrada Confirmada!', 'Presença de Leonardo José registrada com sucesso');
    cy.confirmarSwal();
    cy.wait('@porData2');
    cy.contains('[data-abrir-aluno]', 'Leonardo José').should('contain.text', 'Presente');
  });

  it('erro ao confirmar (ex.: já confirmada) mostra a mensagem e mantém o modal', () => {
    cy.mockApi('POST', '/api/portaria/confirmar-entrada', { sucesso: false, mensagem: 'A entrada deste aluno já foi confirmada.' }, { status: 409 });
    cy.contains('[data-abrir-aluno]', 'Leonardo José').click();
    cy.get('#modalAluno').contains('button', 'Confirmar Entrada').click();
    cy.swal('Erro na Confirmação', 'já foi confirmada');
    cy.confirmarSwal();
    cy.get('#modalAluno').contains('button', 'Confirmar Entrada').should('not.be.disabled');
  });

  it('o modal fecha pelo X, pela tecla Esc e clicando fora', () => {
    cy.contains('[data-abrir-aluno]', 'Leonardo José').click();
    cy.get('#modalAluno [data-fechar-modal]').click();
    cy.get('#modalAluno').should('have.class', 'hidden');

    cy.contains('[data-abrir-aluno]', 'Leonardo José').click();
    cy.get('body').type('{esc}');
    cy.get('#modalAluno').should('have.class', 'hidden');

    cy.contains('[data-abrir-aluno]', 'Leonardo José').click();
    cy.get('#modalAluno').click('topLeft');
    cy.get('#modalAluno').should('have.class', 'hidden');
  });
});

describe('Recepção: consulta por data (casos especiais)', () => {
  beforeEach(abrir);

  it('prova hoje: não mostra o aviso de "não é hoje"', () => {
    mockPorData([linha()]);
    cy.get('#inputDataFiltro').type(hojeSP());
    cy.get('#btnConsultar').click();
    cy.contains('[data-abrir-aluno]', 'Leonardo José').click();
    cy.get('#modalAluno').should('not.contain.text', 'não hoje');
  });

  it('data sem agendamentos', () => {
    mockPorData([]);
    cy.get('#inputDataFiltro').type(dataSP(5));
    cy.get('#btnConsultar').click();
    cy.contains(`Nenhum aluno agendado para ${dataBr(dataSP(5))}`);
  });

  it('data com filtro de nome sem resultado diz "com esse filtro"', () => {
    mockPorData([]);
    cy.get('#inputBusca').type('Zzz');
    cy.get('#inputDataFiltro').type(dataSP(5));
    cy.get('#btnConsultar').click();
    cy.contains('com esse filtro');
  });

  it('erro do servidor na consulta por data', () => {
    cy.mockApi('GET', '/api/portaria/por-data', { sucesso: false, mensagem: 'Data inválida.' }, { status: 400 });
    cy.get('#inputDataFiltro').type(dataSP(5));
    cy.get('#btnConsultar').click();
    cy.contains('Erro na consulta');
    cy.contains('Data inválida.');
  });
});

describe('Recepção: lista do dia (carrega sozinha) e polo', () => {
  const hoje = hojeSP();
  const doDia = [
    linha({ data_agendada: hoje }),
    linha({ ticket_id: 11, aluno_nome: 'Ana Beatriz', matricula: 'E00002', data_agendada: hoje, entrada_confirmada_em: '2030-01-01T12:00:00.000Z' })
  ];

  it('ao abrir, já lista os alunos de HOJE, sem digitar nada', () => {
    abrir({ lista: doDia });
    cy.wait('@listaDia').its('request.url').should('include', `data=${hoje}`);
    cy.contains('Lista do dia');
    cy.get('[data-abrir-aluno]').should('have.length', 2);
    cy.contains('[data-abrir-aluno]', 'Leonardo José').should('contain.text', 'Aguardando');
    cy.contains('[data-abrir-aluno]', 'Ana Beatriz').should('contain.text', 'Presente');
    cy.get('#inputBusca').should('have.value', '');
    cy.get('#inputDataFiltro').should('have.value', '');
  });

  it('mostra o total e quantos já entraram', () => {
    abrir({ lista: doDia });
    cy.contains('Total').parent().should('contain.text', '2');
    cy.contains('Presentes').parent().should('contain.text', '1');
  });

  it('o modal não abre sozinho; clicar no nome abre a confirmação (sem aviso de "não é hoje")', () => {
    abrir({ lista: doDia });
    cy.get('#modalAluno').should('have.class', 'hidden');
    cy.contains('[data-abrir-aluno]', 'Leonardo José').click();
    cy.get('#modalAluno').should('have.class', 'flex').and('contain.text', 'Leonardo José').and('not.contain.text', 'não hoje');
  });

  it('hoje sem alunos mostra mensagem', () => {
    abrir({ lista: [] });
    cy.contains('Nenhum aluno agendado para hoje');
  });

  it('erro ao carregar a lista do dia é mostrado', () => {
    cy.stubApiGeral();
    cy.mockApi('GET', '/api/perfil', { polo: null });
    cy.mockApi('GET', '/api/portaria/por-data', { sucesso: false, mensagem: 'Erro interno ao consultar.' }, { status: 500 });
    cy.abrirPagina('recepcaoHome.html', SESSOES.recepcao);
    cy.contains('Erro ao carregar a lista do dia');
  });

  it('confirmar a entrada na lista do dia recarrega a lista de hoje (sem pedir filtro)', () => {
    abrir({ lista: doDia });
    cy.wait('@listaDia');
    cy.mockApi('POST', '/api/portaria/confirmar-entrada', { sucesso: true, mensagem: 'ok' }, { alias: 'confirmar' });
    mockPorData(doDia.map((a) => ({ ...a, entrada_confirmada_em: '2030-01-01T12:00:00.000Z' })), 'listaDia2');

    cy.contains('[data-abrir-aluno]', 'Leonardo José').click();
    cy.get('#modalAluno').contains('button', 'Confirmar Entrada').click();
    cy.wait('@confirmar').its('request.body').should('deep.equal', { ticket_id: 10 });
    cy.swal('Entrada Confirmada!');
    cy.confirmarSwal();
    cy.wait('@listaDia2').its('request.url').should('include', `data=${hoje}`);
    cy.contains('[data-abrir-aluno]', 'Leonardo José').should('contain.text', 'Presente');
  });

  it('a consulta por nome continua funcionando com a lista do dia na tela', () => {
    abrir({ lista: doDia });
    mockPorNome([linha({ aluno_nome: 'Carlos Souza', matricula: 'E00077', ticket_id: 55 })]);
    cy.get('#inputBusca').type('Carlos');
    cy.get('#btnConsultar').click();
    cy.wait('@consulta').its('request.url').should('include', 'busca=Carlos');
    cy.get('#modalAluno').should('have.class', 'flex').and('contain.text', 'Carlos Souza');
  });

  it('a consulta por data continua funcionando', () => {
    abrir({ lista: doDia });
    mockPorData([linha({ data_agendada: dataSP(3) })]);
    cy.get('#inputDataFiltro').type(dataSP(3));
    cy.get('#btnConsultar').click();
    cy.wait('@porData').its('request.url').should('include', `data=${dataSP(3)}`);
    cy.contains('Alunos agendados');
  });

  it('"Ver lista de hoje" limpa os filtros e volta à lista do dia', () => {
    abrir({ lista: doDia });
    cy.wait('@listaDia');
    mockPorNome([linha(), linha({ ticket_id: 11, aluno_nome: 'Leonora Dias', matricula: 'E00003' })]);
    cy.get('#inputBusca').type('Leo');
    cy.get('#btnConsultar').click();
    cy.contains('2 aluno(s) encontrado(s)');

    cy.get('#btnHoje').click();
    cy.wait('@listaDia');
    cy.contains('Lista do dia');
    cy.get('#inputBusca').should('have.value', '');
  });

  it('mostra o polo da recepção (ou "todos" quando não há polo definido)', () => {
    abrir({ perfil: { polo: 'Polo EaD Resende' } });
    cy.get('#infoPolo').should('have.text', 'Polo: Polo EaD Resende');
    cy.get('#blocoPolo').should('be.visible');
    abrir({ perfil: { polo: null } });
    cy.get('#infoPolo').should('contain.text', 'todos');
  });
});
