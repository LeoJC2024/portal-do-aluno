import { SESSOES } from '../../support/dados';

const vaga = (o = {}) => ({
  id: 1, polo: 'Polo Resende', curso: 'Engenharia de Software', disciplina: 'Machine Learning',
  data_prova: '2030-12-10', horario: '08:00:00', horario_fim: '10:00:00', limite_vagas: 40, vagas_restantes: 10, ...o
});
const agendamento = (o = {}) => ({
  id: 77, vaga_id: 2, data_agendada: '2030-12-11', horario_agendado: '14:00:00', horario_fim: '16:00:00',
  disciplina: 'Banco de Dados', polo: 'Polo Resende', ...o
});

function abrir({ vagas = [], agendamentos = [], resultados = [], sessao = SESSOES.aluno, perfil = {} } = {}) {
  cy.stubApiGeral();
  cy.mockApi('GET', '/api/perfil', perfil, { alias: 'perfil' });
  cy.mockApi('GET', '/api/vagas', vagas, { alias: 'vagas' });
  cy.mockApi('GET', '/api/meus-agendamentos', agendamentos, { alias: 'ags' });
  cy.mockApi('GET', '/api/resultados', resultados, { alias: 'res' });
  cy.abrirPagina('alunoHome.html', sessao);
  cy.wait(['@vagas', '@ags', '@res']);
}

describe('Portal do aluno', () => {
  it('mostra os dados do aluno no cabeçalho e na saudação', () => {
    abrir();
    cy.get('#userName').should('have.text', 'MARIA CLARA SOUZA');
    cy.get('#welcomeName').should('have.text', 'Maria');
    cy.get('#userAvatar').should('have.text', 'M');
    cy.get('#userMatricula').should('have.text', 'Matrícula E00001');
    cy.get('#userCourse').should('contain.text', 'Engenharia de Software');
  });

  it('a caixa de curso/matrícula da saudação foi removida', () => {
    abrir();
    cy.get('#courseBadgeText').should('not.exist');
    cy.get('#matriculaBadge').should('not.exist');
  });

  it('mostra a foto do aluno ao lado do nome', () => {
    abrir({ perfil: { nome: 'Maria', foto_url: 'https://example.com/maria.jpg' } });
    cy.get('#userAvatar img').should('have.attr', 'src', 'https://example.com/maria.jpg');
  });

  it('sem foto, mostra a inicial do nome', () => {
    abrir({ perfil: { nome: 'Maria', foto_url: null } });
    cy.get('#userAvatar img').should('not.exist');
    cy.get('#userAvatar').should('have.text', 'M');
  });

  it('endereço de foto suspeito é ignorado', () => {
    abrir({ perfil: { foto_url: 'javascript:alert(1)' } });
    cy.get('#userAvatar img').should('not.exist');
    cy.get('#userAvatar').should('have.text', 'M');
  });

  it('sem vagas mostra mensagem e contadores zerados', () => {
    abrir();
    cy.contains('Nenhuma avaliação disponível para agendamento no momento.');
    cy.get('#contadorTotalPendentes').should('have.text', '0');
    cy.get('#contadorDisponiveisAgendar').should('contain.text', '0 disponíveis');
  });

  it('agrupa as vagas por disciplina (um card por avaliação)', () => {
    abrir({ vagas: [vaga({ id: 1 }), vaga({ id: 2, data_prova: '2030-12-12' }), vaga({ id: 3, disciplina: 'Banco de Dados' })] });
    cy.get('#listaVagasAluno .task-item').should('have.length', 2);
    cy.get('#contadorTotalPendentes').should('have.text', '2');
    cy.get('#contadorDisponiveisAgendar').should('contain.text', '2 disponíveis');
    cy.contains('.task-item', 'Machine Learning').should('contain.text', '2 horário(s) com vaga');
  });

  it('card com agendamento mostra data/hora com início e fim e o botão Cancelar', () => {
    abrir({ vagas: [vaga({ id: 2, disciplina: 'Banco de Dados' }), vaga()], agendamentos: [agendamento()] });
    cy.contains('.task-item', 'Banco de Dados').within(() => {
      cy.contains('Agendamento Confirmado');
      cy.contains('11/12/2030 às 14:00 – 16:00');
      cy.get('[data-acao="cancelar"]').should('exist');
    });
    cy.get('#contadorDisponiveisAgendar').should('contain.text', '1 disponíveis');
  });

  it('vaga esgotada aparece como "Sem vagas" e o botão fica desabilitado', () => {
    abrir({ vagas: [vaga({ vagas_restantes: 0 })] });
    cy.get('[data-acao="agendar"]').should('be.disabled').and('contain.text', 'Sem vagas');
  });

  it('agendamento que ainda não abriu: botão desabilitado com a data de abertura', () => {
    abrir({ vagas: [vaga({ agendamento_aberto: false, agendamento_inicio: '2030-12-05', agendamento_fim: '2030-12-08' })] });
    cy.get('[data-acao="agendar"]').should('be.disabled').and('contain.text', 'Abre em 05/12/2030');
    cy.contains('.task-item', 'Machine Learning').should('contain.text', 'Agendamento abre em 05/12/2030');
  });

  it('com um horário aberto e outro ainda não aberto: o aberto é agendável e o outro aparece desabilitado', () => {
    abrir({ vagas: [vaga({ id: 1 }), vaga({ id: 2, data_prova: '2030-12-20', agendamento_aberto: false, agendamento_inicio: '2030-12-05' })] });
    cy.get('[data-acao="agendar"]').should('not.be.disabled').and('contain.text', 'Agendar');
    cy.get('[data-acao="agendar"]').click();
    cy.get('#horarioSelect option[value="1"]').should('not.be.disabled');
    cy.get('#horarioSelect option[value="2"]').should('be.disabled').and('contain.text', '(abre em 05/12/2030)');
  });

  it('mantém a avaliação já agendada mesmo que a vaga saia da lista', () => {
    abrir({ vagas: [], agendamentos: [agendamento()] });
    cy.contains('.task-item', 'Banco de Dados').should('contain.text', 'Agendamento Confirmado');
  });

  describe('modal de agendamento', () => {
    beforeEach(() => {
      abrir({ vagas: [vaga({ id: 1 }), vaga({ id: 2, data_prova: '2030-12-12', vagas_restantes: 0 }), vaga({ id: 3, disciplina: 'Banco de Dados' })] });
      cy.contains('.task-item', 'Machine Learning').find('[data-acao="agendar"]').click();
    });

    it('lista só os horários da disciplina, com data, faixa, polo e vagas', () => {
      cy.get('#modalAgendamento').should('have.class', 'flex');
      cy.get('#horarioSelect option').should('have.length', 3); // "Selecione..." + 2 vagas de Machine Learning
      cy.get('#horarioSelect option[value="1"]').should('contain.text', '10/12/2030 08:00 – 10:00 — Polo Resende (10 vagas)');
      cy.get('#horarioSelect option[value="2"]').should('be.disabled').and('contain.text', '(esgotado)');
    });

    it('confirmar sem escolher horário avisa e não envia', () => {
      cy.mockApi('POST', '/api/agendar', {}, { alias: 'agendar' });
      cy.contains('#modalAgendamento button', 'Confirmar Horário').click();
      cy.swal('Atenção', 'Por favor, selecione um horário na agenda.');
      cy.get('@agendar.all').should('have.length', 0);
    });

    it('confirma o agendamento, fecha o modal e recarrega as vagas', () => {
      cy.mockApi('POST', '/api/agendar', { sucesso: true, mensagem: 'Agendamento realizado com sucesso!' }, { alias: 'agendar' });
      cy.get('#horarioSelect').select('1');
      cy.contains('#modalAgendamento button', 'Confirmar Horário').click();

      cy.wait('@agendar').its('request.body').should('deep.equal', { vaga_id: 1 });
      cy.swal('Sucesso!', 'Agendamento realizado com sucesso!');
      cy.get('#modalAgendamento').should('have.class', 'hidden');
      cy.wait('@vagas'); // recarregou
    });

    it('erro do servidor (ex.: vaga esgotou) é mostrado', () => {
      cy.mockApi('POST', '/api/agendar', { sucesso: false, mensagem: 'Não há mais vagas neste horário.' }, { status: 409 });
      cy.get('#horarioSelect').select('1');
      cy.contains('#modalAgendamento button', 'Confirmar Horário').click();
      cy.swal('Falha no Agendamento', 'Não há mais vagas neste horário.');
    });

    it('fecha por Cancelar e clicando fora', () => {
      cy.contains('#modalAgendamento button', 'Cancelar').click();
      cy.get('#modalAgendamento').should('have.class', 'hidden');

      cy.contains('.task-item', 'Machine Learning').find('[data-acao="agendar"]').click();
      cy.get('#modalAgendamento').click('topLeft');
      cy.get('#modalAgendamento').should('have.class', 'hidden');
    });
  });

  describe('cancelamento', () => {
    beforeEach(() => {
      abrir({ vagas: [vaga({ id: 2, disciplina: 'Banco de Dados' })], agendamentos: [agendamento()] });
    });

    it('confirma, envia o id e recarrega', () => {
      cy.mockApi('POST', '/api/cancelar-agendamento', { sucesso: true, mensagem: 'Agendamento cancelado com sucesso!' }, { alias: 'cancelar' });
      cy.get('[data-acao="cancelar"]').click();
      cy.swal('Cancelar agendamento?', 'mais de 24 horas');
      cy.confirmarSwal();

      cy.wait('@cancelar').its('request.body').should('deep.equal', { agendamento_id: 77 });
      cy.swal('Cancelado!', 'Agendamento cancelado com sucesso!');
      cy.wait('@vagas');
    });

    it('"Manter agendamento" não envia nada', () => {
      cy.mockApi('POST', '/api/cancelar-agendamento', {}, { alias: 'cancelar' });
      cy.get('[data-acao="cancelar"]').click();
      cy.get('.swal2-cancel').click();
      cy.swal('Agendamento mantido');
      cy.get('@cancelar.all').should('have.length', 0);
    });

    it('cancelamento com menos de 24h é bloqueado e a mensagem aparece', () => {
      cy.mockApi('POST', '/api/cancelar-agendamento',
        { sucesso: false, mensagem: 'Ação Bloqueada: o cancelamento só é permitido com mais de 24 horas de antecedência da prova.' }, { status: 400 });
      cy.get('[data-acao="cancelar"]').click();
      cy.confirmarSwal();
      cy.swal('Ação Bloqueada', 'mais de 24 horas');
    });
  });

  describe('resultados', () => {
    const resultados = [
      { avaliacao: 'A1 - Algoritmos', polo: 'Polo Resende', nota: '7.50' },
      { avaliacao: 'A2 - Redes', polo: 'Polo Resende', nota: '4.00' },
      { avaliacao: 'A3 - Cálculo', polo: 'Polo Resende', nota: null }
    ];

    it('o contador conta só notas lançadas e o modal classifica cada nota', () => {
      abrir({ resultados });
      cy.get('#contadorResultadosLancados').should('have.text', '2');
      cy.get('#cardResultados').click();

      cy.get('#modalResultados').should('have.class', 'flex');
      cy.get('#listaResultadosModal tbody tr').should('have.length', 3);
      cy.contains('#listaResultadosModal tr', 'A1 - Algoritmos').should('contain.text', '7.50').and('contain.text', 'Aprovado');
      cy.contains('#listaResultadosModal tr', 'A2 - Redes').should('contain.text', 'Reprovado');
      cy.contains('#listaResultadosModal tr', 'A3 - Cálculo').should('contain.text', 'Sem nota');
    });

    it('nota 6.0 é aprovação (limite)', () => {
      abrir({ resultados: [{ avaliacao: 'Limite', polo: 'P', nota: '6.00' }] });
      cy.get('#cardResultados').click();
      cy.contains('#listaResultadosModal tr', 'Limite').should('contain.text', 'Aprovado');
    });

    it('sem resultados mostra mensagem', () => {
      abrir();
      cy.get('#cardResultados').click();
      cy.contains('Nenhum resultado lançado até o momento.');
    });

    it('erro do servidor mostra mensagem de erro', () => {
      abrir();
      cy.mockApi('GET', '/api/resultados', { sucesso: false }, { status: 500 });
      cy.get('#cardResultados').click();
      cy.contains('Erro ao carregar os resultados do servidor.');
    });

    it('fecha pelo botão Fechar', () => {
      abrir({ resultados });
      cy.get('#cardResultados').click();
      cy.contains('#modalResultados button', 'Fechar').click();
      cy.get('#modalResultados').should('have.class', 'hidden');
    });
  });

  describe('erros e segurança', () => {
    it('erro 500 ao carregar vagas mostra mensagem', () => {
      cy.stubApiGeral();
      cy.mockApi('GET', '/api/vagas', { sucesso: false }, { status: 500, alias: 'vagas' });
      cy.abrirPagina('alunoHome.html', SESSOES.aluno);
      cy.contains('Erro ao carregar as avaliações do servidor.');
    });

    it('vaga sem horário de fim (antiga) mostra só o início', () => {
      abrir({ vagas: [vaga({ horario_fim: null })] });
      cy.get('[data-acao="agendar"]').click();
      cy.get('#horarioSelect option[value="1"]').invoke('text').should('match', /10\/12\/2030 08:00 — Polo Resende/);
    });

    it('HTML vindo do banco é exibido como texto e não executa', () => {
      const malicioso = '<img src=x onerror="window.__xss=1">';
      abrir({ vagas: [vaga({ disciplina: malicioso, polo: malicioso })] });
      cy.get('#listaVagasAluno img').should('not.exist');
      cy.contains('#listaVagasAluno', '<img src=x').should('exist');
      cy.window().its('__xss').should('not.exist');
    });

    it('nome e curso com HTML na sessão não executam', () => {
      abrir({ sessao: { ...SESSOES.aluno, usuario_curso: '<img src=x onerror="window.__xss=1">' } });
      cy.get('#userCourse img').should('not.exist');
      cy.window().its('__xss').should('not.exist');
    });
  });
});

describe('Portal do aluno: reagendamento', () => {
  const vagasBD = [
    vaga({ id: 2, disciplina: 'Banco de Dados', data_prova: '2030-12-11', horario: '14:00:00', horario_fim: '16:00:00' }),
    vaga({ id: 3, disciplina: 'Banco de Dados', data_prova: '2030-12-14', horario: '09:00:00', horario_fim: '11:00:00', polo: 'Polo Barra Mansa', vagas_restantes: 4 }),
    vaga({ id: 9, disciplina: 'Redes' })
  ];

  beforeEach(() => abrir({ vagas: vagasBD, agendamentos: [agendamento()] }));

  const abrirReagendar = () => cy.get('[data-acao="reagendar"]').click();

  it('o cartão agendado tem os botões Reagendar e Cancelar', () => {
    cy.contains('.task-item', 'Banco de Dados').within(() => {
      cy.contains('button', 'Reagendar');
      cy.contains('button', 'Cancelar');
    });
  });

  it('abre o modal em modo reagendar: título, aviso das 24h e só os OUTROS horários', () => {
    abrirReagendar();
    cy.get('#modalAgendamento').should('have.class', 'flex');
    cy.get('#tituloModalAgendamento').should('have.text', 'Reagendar avaliação');
    cy.get('#avisoReagendar').should('not.have.class', 'hidden').and('contain.text', '24 horas');
    cy.get('#horarioSelect option').should('have.length', 2); // "Selecione..." + vaga 3
    cy.get('#horarioSelect option[value="3"]').should('contain.text', '14/12/2030 09:00 – 11:00 — Polo Barra Mansa (4 vagas)');
    cy.get('#horarioSelect option[value="2"]').should('not.exist'); // o horário atual não é opção
  });

  it('confirma o reagendamento enviando {agendamento_id, nova_vaga_id} e recarrega', () => {
    cy.mockApi('POST', '/api/reagendar', { sucesso: true, mensagem: 'Reagendamento realizado com sucesso!' }, { alias: 'reagendar' });
    abrirReagendar();
    cy.get('#horarioSelect').select('3');
    cy.contains('#modalAgendamento button', 'Confirmar Horário').click();

    cy.wait('@reagendar').its('request.body').should('deep.equal', { agendamento_id: 77, nova_vaga_id: 3 });
    cy.swal('Reagendado!', 'Reagendamento realizado com sucesso!');
    cy.get('#modalAgendamento').should('have.class', 'hidden');
    cy.wait('@vagas');
  });

  it('sem escolher horário avisa e não envia', () => {
    cy.mockApi('POST', '/api/reagendar', {}, { alias: 'reagendar' });
    abrirReagendar();
    cy.contains('#modalAgendamento button', 'Confirmar Horário').click();
    cy.swal('Atenção', 'selecione um horário');
    cy.get('@reagendar.all').should('have.length', 0);
  });

  it('com menos de 24h o servidor bloqueia e a mensagem aparece', () => {
    cy.mockApi('POST', '/api/reagendar',
      { sucesso: false, mensagem: 'Ação Bloqueada: o reagendamento só é permitido com mais de 24 horas de antecedência da prova.' }, { status: 400 });
    abrirReagendar();
    cy.get('#horarioSelect').select('3');
    cy.contains('#modalAgendamento button', 'Confirmar Horário').click();
    cy.swal('Ação Bloqueada', 'mais de 24 horas');
  });

  it('outro erro (ex.: horário lotou) mostra "Falha no Reagendamento"', () => {
    cy.mockApi('POST', '/api/reagendar', { sucesso: false, mensagem: 'Não há mais vagas neste horário.' }, { status: 409 });
    abrirReagendar();
    cy.get('#horarioSelect').select('3');
    cy.contains('#modalAgendamento button', 'Confirmar Horário').click();
    cy.swal('Falha no Reagendamento', 'Não há mais vagas');
  });

  it('sem outros horários disponíveis: avisa e não abre o modal', () => {
    abrir({ vagas: [vagasBD[0]], agendamentos: [agendamento()] });
    abrirReagendar();
    cy.swal('Sem outros horários');
    cy.get('#modalAgendamento').should('have.class', 'hidden');
  });

  it('só horários que ainda não abriram ou esgotados também contam como "sem opção"', () => {
    abrir({
      vagas: [vagasBD[0], vaga({ id: 3, disciplina: 'Banco de Dados', agendamento_aberto: false, agendamento_inicio: '2030-12-05' })],
      agendamentos: [agendamento()]
    });
    abrirReagendar();
    cy.swal('Sem outros horários');
  });

  it('depois de usar o modo reagendar, o modal de uma avaliação nova volta ao normal', () => {
    abrirReagendar();
    cy.contains('#modalAgendamento button', 'Cancelar').click();
    cy.contains('.task-item', 'Redes').find('[data-acao="agendar"]').click();
    cy.get('#tituloModalAgendamento').should('have.text', 'Agendar avaliação');
    cy.get('#avisoReagendar').should('have.class', 'hidden');
  });
});
