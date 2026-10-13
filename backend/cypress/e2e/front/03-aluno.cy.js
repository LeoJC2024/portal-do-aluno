import { SESSOES } from '../../support/dados';
import { dataSP } from '../../support/datas';

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

describe('Portal do aluno: comprovante do agendamento', () => {
  const comprovante = (o = {}) => ({
    codigo: 'AG-000077', agendamento_id: 77, aluno_nome: 'MARIA CLARA SOUZA', matricula: 'E00001',
    disciplina: 'Banco de Dados', curso: 'Engenharia de Software', polo: 'Polo Resende',
    data_prova: '2030-12-11', horario_inicio: '14:00', horario_fim: '16:00', situacao: 'ATIVO',
    emitido_em: '2030-12-01T13:05:09.000Z', emitido_em_local: '01/12/2030 10:05:09', fuso: 'America/Sao_Paulo', ...o
  });
  const mockComprovante = (id, c = comprovante()) =>
    cy.mockApi('GET', `/api/agendamentos/${id}/comprovante`, { sucesso: true, comprovante: c }, { alias: 'comprovante' });

  const conferirCampos = (c) => {
    cy.get('#modalComprovante').should('have.class', 'flex').and('be.visible');
    cy.get('#tituloComprovante').should('have.text', 'Comprovante do agendamento');
    cy.get('#compCodigo').should('have.text', c.codigo);
    cy.get('#compAluno').should('have.text', c.aluno_nome);
    cy.get('#compMatricula').should('have.text', c.matricula);
    cy.get('#compCurso').should('have.text', c.curso);
    cy.get('#compDisciplina').should('have.text', c.disciplina);
    cy.get('#compPolo').should('have.text', c.polo);
    cy.get('#compData').should('have.text', c.data_prova.split('-').reverse().join('/'));
    cy.get('#compHorario').should('have.text', `${c.horario_inicio} às ${c.horario_fim}`);
    cy.get('#compSituacao').should('have.text', c.situacao);
    cy.get('#compEmitido').should('have.text', c.emitido_em_local);
  };

  const fechado = () => {
    cy.get('#modalComprovante').should('have.class', 'hidden').and('not.be.visible');
    cy.get('body').should('not.have.class', 'comprovante-aberto');
  };

  describe('pelo botão do cartão', () => {
    beforeEach(() => {
      abrir({ vagas: [vaga({ id: 2, disciplina: 'Banco de Dados' })], agendamentos: [agendamento()] });
      mockComprovante(77);
    });

    const abrirPeloCartao = () => {
      cy.contains('.task-item', 'Banco de Dados').find('[data-acao="comprovante"]').click();
      cy.wait('@comprovante');
    };

    it('o cartão agendado tem o botão Comprovante, que abre o modal com todos os campos', () => {
      cy.contains('.task-item', 'Banco de Dados').within(() => {
        cy.contains('button', 'Comprovante');
        cy.contains('button', 'Reagendar');
        cy.contains('button', 'Cancelar');
      });
      abrirPeloCartao();
      conferirCampos(comprovante());
      cy.get('#comprovanteAviso').should('have.class', 'hidden'); // o aviso de sucesso só aparece depois de agendar
      cy.get('body').should('have.class', 'comprovante-aberto');
      cy.get('.swal2-popup').should('not.exist');
    });

    it('cartão de avaliação ainda não agendada não tem botão Comprovante', () => {
      abrir({ vagas: [vaga()] });
      cy.get('[data-acao="comprovante"]').should('not.exist');
    });

    it('fecha pelo botão Fechar', () => {
      abrirPeloCartao();
      cy.contains('#modalComprovante button', 'Fechar').click();
      fechado();
    });

    it('fecha pelo X', () => {
      abrirPeloCartao();
      cy.get('#fecharComprovanteX').click();
      fechado();
    });

    it('fecha com Esc', () => {
      abrirPeloCartao();
      cy.get('body').type('{esc}');
      fechado();
    });

    it('fecha clicando fora', () => {
      abrirPeloCartao();
      cy.get('#modalComprovante').click('topLeft');
      fechado();
    });

    it('clicar dentro do comprovante não fecha', () => {
      abrirPeloCartao();
      cy.get('#compCodigo').click();
      cy.get('#modalComprovante').should('have.class', 'flex');
    });

    it('"Imprimir / Salvar PDF" chama window.print e há CSS de impressão só para o comprovante', () => {
      abrirPeloCartao();
      cy.window().then((w) => cy.stub(w, 'print').as('print'));
      cy.contains('#modalComprovante button', 'Imprimir / Salvar PDF').click();
      cy.get('@print').should('have.been.calledOnce');
      // botões e aviso ficam fora da impressão
      cy.get('#modalComprovante .nao-imprimir').should('have.length.at.least', 3);
      cy.document().then((doc) => {
        const regras = [...doc.styleSheets].flatMap((s) => {
          try { return [...s.cssRules]; } catch (_) { return []; }
        });
        const print = regras.filter((r) => r.media && /print/.test(r.media.mediaText)).map((r) => r.cssText).join(' ');
        expect(print).to.contain('#modalComprovante');
        expect(print).to.contain('comprovante-aberto');
      });
    });

    it('vaga antiga sem horário de fim mostra só o início', () => {
      mockComprovante(77, comprovante({ horario_fim: null }));
      abrirPeloCartao();
      cy.get('#compHorario').should('have.text', '14:00');
    });

    it('404 do servidor mostra aviso e não abre o modal', () => {
      cy.mockApi('GET', '/api/agendamentos/77/comprovante',
        { sucesso: false, mensagem: 'Comprovante não encontrado.' }, { status: 404, alias: 'comprovante' });
      abrirPeloCartao();
      cy.swal('Comprovante indisponível', 'Comprovante não encontrado.');
      cy.get('#modalComprovante').should('have.class', 'hidden');
    });
  });

  it('HTML vindo do servidor no comprovante é exibido como texto e não executa', () => {
    const malicioso = '<img src=x onerror="window.__xss=1">';
    abrir({ vagas: [vaga({ id: 2, disciplina: 'Banco de Dados' })], agendamentos: [agendamento()] });
    mockComprovante(77, comprovante({
      aluno_nome: malicioso, disciplina: malicioso, curso: malicioso, polo: malicioso, codigo: malicioso, emitido_em_local: malicioso
    }));
    cy.get('[data-acao="comprovante"]').click();
    cy.wait('@comprovante');
    cy.get('#modalComprovante').should('have.class', 'flex');
    cy.get('#modalComprovante img').should('not.exist');
    cy.get('#compAluno').should('have.text', malicioso);
    cy.get('#compDisciplina').should('have.text', malicioso);
    cy.window().its('__xss').should('not.exist');
  });

  it('depois de agendar, abre o comprovante (com o aviso de sucesso) em vez de só o aviso', () => {
    abrir({ vagas: [vaga({ id: 1 })] });
    cy.mockApi('POST', '/api/agendar', {
      sucesso: true, mensagem: 'Agendamento realizado com sucesso!',
      agendamento: { id: 101, vaga_id: 1, data_agendada: '2030-12-10', horario_agendado: '08:00:00' }
    }, { alias: 'agendar' });
    const c = comprovante({
      codigo: 'AG-000101', agendamento_id: 101, disciplina: 'Machine Learning',
      data_prova: '2030-12-10', horario_inicio: '08:00', horario_fim: '10:00'
    });
    mockComprovante(101, c);

    cy.get('[data-acao="agendar"]').click();
    cy.get('#horarioSelect').select('1');
    cy.contains('#modalAgendamento button', 'Confirmar Horário').click();

    cy.wait('@agendar').its('request.body').should('deep.equal', { vaga_id: 1 });
    cy.wait('@comprovante').its('request.url').should('contain', '/api/agendamentos/101/comprovante');
    cy.get('#modalAgendamento').should('have.class', 'hidden');
    conferirCampos(c);
    cy.get('#comprovanteAviso').should('not.have.class', 'hidden').and('have.text', 'Agendamento realizado com sucesso!');
    cy.get('.swal2-popup').should('not.exist');
    cy.wait('@vagas'); // recarregou a lista
  });

  it('se o comprovante falhar depois de agendar, mostra o aviso de sucesso de antes', () => {
    abrir({ vagas: [vaga({ id: 1 })] });
    cy.mockApi('POST', '/api/agendar', {
      sucesso: true, mensagem: 'Agendamento realizado com sucesso!', agendamento: { id: 101, vaga_id: 1 }
    }, { alias: 'agendar' });
    cy.mockApi('GET', '/api/agendamentos/101/comprovante',
      { sucesso: false, mensagem: 'Erro interno no servidor.' }, { status: 500, alias: 'comprovante' });

    cy.get('[data-acao="agendar"]').click();
    cy.get('#horarioSelect').select('1');
    cy.contains('#modalAgendamento button', 'Confirmar Horário').click();
    cy.wait('@comprovante');
    cy.swal('Sucesso!', 'Agendamento realizado com sucesso!');
    cy.get('#modalComprovante').should('have.class', 'hidden');
  });

  it('depois de reagendar, abre o comprovante do NOVO agendamento', () => {
    abrir({
      vagas: [
        vaga({ id: 2, disciplina: 'Banco de Dados', data_prova: '2030-12-11', horario: '14:00:00', horario_fim: '16:00:00' }),
        vaga({ id: 3, disciplina: 'Banco de Dados', data_prova: '2030-12-14', horario: '09:00:00', horario_fim: '11:00:00', polo: 'Polo Barra Mansa' })
      ],
      agendamentos: [agendamento()]
    });
    cy.mockApi('POST', '/api/reagendar', {
      sucesso: true, mensagem: 'Reagendamento realizado com sucesso!',
      agendamento: { id: 205, vaga_id: 3, data_agendada: '2030-12-14', horario_agendado: '09:00:00' }
    }, { alias: 'reagendar' });
    const c = comprovante({
      codigo: 'AG-000205', agendamento_id: 205, polo: 'Polo Barra Mansa',
      data_prova: '2030-12-14', horario_inicio: '09:00', horario_fim: '11:00'
    });
    mockComprovante(205, c);

    cy.get('[data-acao="reagendar"]').click();
    cy.get('#horarioSelect').select('3');
    cy.contains('#modalAgendamento button', 'Confirmar Horário').click();

    cy.wait('@reagendar').its('request.body').should('deep.equal', { agendamento_id: 77, nova_vaga_id: 3 });
    cy.wait('@comprovante');
    conferirCampos(c);
    cy.get('#comprovanteAviso').should('have.text', 'Reagendamento realizado com sucesso!');
    cy.get('.swal2-popup').should('not.exist');
  });

  it('no celular o comprovante cabe na tela e os botões continuam acessíveis', () => {
    cy.viewport('iphone-6');
    abrir({ vagas: [vaga({ id: 2, disciplina: 'Banco de Dados' })], agendamentos: [agendamento()] });
    mockComprovante(77);
    cy.get('[data-acao="comprovante"]').click();
    cy.wait('@comprovante');
    cy.get('#modalComprovante .comprovante-caixa').then(($c) => {
      expect($c[0].getBoundingClientRect().width).to.be.at.most(375);
    });
    cy.contains('#modalComprovante button', 'Imprimir / Salvar PDF').scrollIntoView().should('be.visible');
    cy.contains('#modalComprovante button', 'Fechar').scrollIntoView().click();
    fechado();
  });
});

describe('Portal do aluno: avisos da coordenação com o período de agendamento', () => {
  // datas relativas a "hoje" no fuso de São Paulo (as mesmas regras da tela)
  const dm = (iso) => iso.slice(5).split('-').reverse().join('/');
  const comPeriodo = (o = {}) => vaga({
    disciplina: 'Linux Security', polo: 'Polo Valença (Sede)',
    agendamento_inicio: dataSP(-1), agendamento_fim: dataSP(4), data_prova: dataSP(5), ...o
  });
  const avisos = () => cy.get('#avisosAgendamento .aviso-agendamento');

  it('período aberto: "Agendamento liberado de ... a ...", disciplina, polo e data da prova', () => {
    const v = comPeriodo();
    abrir({ vagas: [v] });
    avisos().should('have.length', 1).first().as('aviso');
    cy.get('@aviso').should('have.attr', 'data-situacao', 'aberto')
      .and('contain.text', `Agendamento liberado de ${dm(v.agendamento_inicio)} a ${dm(v.agendamento_fim)}`)
      .and('contain.text', `Linux Security – Polo Valença (Sede), prova em ${dm(v.data_prova)}`)
      .and('not.contain.text', '(Polo Valença (Sede))');
    // mesmo visual dos avisos fixos
    cy.get('@aviso').should('have.class', 'bg-slate-50').and('have.class', 'rounded-xl')
      .find('.text-teal-700.font-semibold').should('exist');
  });

  it('período que ainda não começou: "Agendamento abre em ..." no lugar de "liberado"', () => {
    const v = comPeriodo({ agendamento_inicio: dataSP(2), agendamento_fim: dataSP(6), data_prova: dataSP(8), agendamento_aberto: false });
    abrir({ vagas: [v] });
    avisos().should('have.length', 1).first()
      .should('have.attr', 'data-situacao', 'abre-em')
      .and('contain.text', `Agendamento abre em ${dm(v.agendamento_inicio)}`)
      .and('contain.text', dm(v.agendamento_fim))
      .and('contain.text', `Linux Security – Polo Valença (Sede), prova em ${dm(v.data_prova)}`)
      .and('not.contain.text', 'liberado');
  });

  it('período encerrado ou prova já passada não geram aviso', () => {
    abrir({ vagas: [
      comPeriodo({ id: 1, disciplina: 'Encerrada', agendamento_inicio: dataSP(-5), agendamento_fim: dataSP(-1), data_prova: dataSP(3) }),
      comPeriodo({ id: 2, disciplina: 'Prova Passada', agendamento_inicio: dataSP(-5), agendamento_fim: dataSP(2), data_prova: dataSP(-1) }),
      comPeriodo({ id: 3, disciplina: 'Aberta' })
    ] });
    avisos().should('have.length', 1).and('contain.text', 'Aberta');
    cy.get('#avisosAgendamento').should('not.contain.text', 'Encerrada').and('not.contain.text', 'Prova Passada');
  });

  it('sem vagas com período: mostra a mensagem de lista vazia', () => {
    abrir({ vagas: [vaga({ agendamento_inicio: null, agendamento_fim: null })] });
    avisos().should('not.exist');
    cy.get('#avisosAgendamento').should('be.visible')
      .and('have.text', 'Nenhum período de agendamento aberto no momento.');
  });

  it('os avisos fixos de Agosto foram removidos: a caixa só tem os avisos automáticos', () => {
    abrir({ vagas: [comPeriodo()] });
    avisos().should('have.length', 1);
    cy.get('#avisosAgendamento').siblings().should('not.exist');
    cy.contains('25 de Agosto').should('not.exist');
    cy.contains('20 de Agosto').should('not.exist');
  });

  it('ordena pelo fim do período (mais próximo primeiro) e limita a 5 avisos', () => {
    const fins = [6, 2, 9, 1, 4, 3, 8];
    abrir({ vagas: fins.map((f, i) => comPeriodo({
      id: i + 1, disciplina: `Disc ${f}`, agendamento_fim: dataSP(f), data_prova: dataSP(f + 1)
    })) });
    avisos().should('have.length', 5);
    [1, 2, 3, 4, 6].forEach((f, i) => avisos().eq(i).should('contain.text', `Disc ${f} – `));
  });

  it('mesma disciplina, polo, período e data de prova com horários diferentes geram um único aviso', () => {
    const v = comPeriodo({ id: 1, horario: '08:00:00', horario_fim: '10:00:00' });
    abrir({ vagas: [
      v,
      comPeriodo({ id: 2, horario: '14:00:00', horario_fim: '16:00:00' }),
      comPeriodo({ id: 3, horario: '19:00:00', horario_fim: '21:00:00' })
    ] });
    avisos().should('have.length', 1).first()
      .should('contain.text', `Linux Security – Polo Valença (Sede), prova em ${dm(v.data_prova)}`);
  });

  it('data de prova ou polo diferentes geram avisos separados', () => {
    abrir({ vagas: [
      comPeriodo({ id: 1, data_prova: dataSP(5) }),
      comPeriodo({ id: 2, data_prova: dataSP(6) }),
      comPeriodo({ id: 3, data_prova: dataSP(5), polo: 'Polo Resende' })
    ] });
    avisos().should('have.length', 3);
    cy.get('#avisosAgendamento')
      .should('contain.text', `Linux Security – Polo Valença (Sede), prova em ${dm(dataSP(5))}`)
      .and('contain.text', `Linux Security – Polo Valença (Sede), prova em ${dm(dataSP(6))}`)
      .and('contain.text', `Linux Security – Polo Resende, prova em ${dm(dataSP(5))}`);
  });

  it('o agrupamento vem antes do limite de 5: horários repetidos não ocupam vagas de aviso', () => {
    const fins = [1, 2, 3, 4, 5, 6];
    abrir({ vagas: [
      ...fins.map((f, i) => comPeriodo({ id: i + 1, disciplina: `Disc ${f}`, agendamento_fim: dataSP(f), data_prova: dataSP(f + 1) })),
      // mais horários da Disc 1: se não agrupasse, empurrariam as outras para fora do limite
      comPeriodo({ id: 7, disciplina: 'Disc 1', agendamento_fim: dataSP(1), data_prova: dataSP(2), horario: '14:00:00' }),
      comPeriodo({ id: 8, disciplina: 'Disc 1', agendamento_fim: dataSP(1), data_prova: dataSP(2), horario: '19:00:00' })
    ] });
    avisos().should('have.length', 5);
    [1, 2, 3, 4, 5].forEach((f, i) => avisos().eq(i).should('contain.text', `Disc ${f} – `));
  });

  it('disciplina e polo com HTML são exibidos como texto e não executam', () => {
    abrir({ vagas: [comPeriodo({ disciplina: '<img src=x onerror="window.__xss=1">', polo: '<b>Polo</b>' })] });
    avisos().first().should('contain.text', '<img src=x onerror="window.__xss=1">').and('contain.text', '<b>Polo</b>');
    cy.get('#avisosAgendamento img, #avisosAgendamento b').should('not.exist');
    cy.window().its('__xss').should('be.undefined');
  });
});
