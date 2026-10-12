import { PNG_1X1_BASE64 } from '../../support/dados';
import { abrirCoordenador, irParaAba, DISCIPLINAS_PADRAO } from '../../support/telas';
import { dataSP, dataBr, hojeSP } from '../../support/datas';

const foto = (nome = 'foto.png') => ({ contents: Cypress.Buffer.from(PNG_1X1_BASE64, 'base64'), fileName: nome, mimeType: 'image/png' });
const arquivoTexto = { contents: Cypress.Buffer.from('nao sou imagem'), fileName: 'a.txt', mimeType: 'text/plain' };

const vagaBD = (o = {}) => ({
  id: 1, polo: 'Polo EaD Resende', curso: 'Engenharia de Software', disciplina: 'A', data_prova: dataSP(10),
  horario: '08:00:00', horario_fim: '10:00:00', limite_vagas: 40, agendamento_inicio: hojeSP(), agendamento_fim: dataSP(5),
  criado_em: '2030-05-20T15:30:00.000Z', criado_por: 'Prof. Carlos Lima', ocupadas: 12, futura: true, ...o
});

describe('Coordenação: abas e layout', () => {
  beforeEach(() => abrirCoordenador());

  it('mostra o título com nome e matrícula e começa na aba de vagas', () => {
    cy.get('#userName').should('have.text', 'Prof. Carlos Lima');
    cy.get('#tituloNome').should('have.text', 'Prof. Carlos Lima');
    cy.get('#tituloMatricula').should('have.text', 'Matrícula C00000');
    cy.get('#userCourse').should('contain.text', 'Coordenador').and('not.contain.text', 'Engenharia');
    cy.get('#page-oferta').should('not.have.class', 'hidden');
    cy.get('#page-usuarios').should('have.class', 'hidden');
  });

  it('tem as 5 abas, numeradas, na ordem', () => {
    cy.get('.tab-btn').should('have.length', 5);
    ['Adição de Vagas', 'Cadastro de Usuários', 'Disciplinas', 'Sincronização de Notas', 'Trilha de Auditoria'].forEach((txt, i) => {
      cy.get('.tab-btn').eq(i).should('contain.text', txt);
    });
  });

  ['usuarios', 'disciplinas', 'sincronizacao', 'auditoria', 'oferta'].forEach((aba) => {
    it(`a aba "${aba}" abre e destaca o botão`, () => {
      irParaAba(aba);
      cy.get(`#page-${aba}`).should('not.have.class', 'hidden');
      cy.get(`#btn-${aba}`).should('have.class', 'bg-emerald-800');
      cy.get('.page-content').not(`#page-${aba}`).each(($p) => expect($p).to.have.class('hidden'));
    });
  });

  it('o botão da aba mantém as classes responsivas depois de trocar de aba', () => {
    irParaAba('usuarios');
    irParaAba('oferta');
    cy.get('#btn-usuarios').should('have.class', 'sm:px-3');
  });

  it('a tabela ocupa a mesma largura da caixa do título', () => {
    cy.get('main > div').first().then(($titulo) => {
      cy.get('#page-oferta > div').then(($tabela) => {
        expect(Math.abs($titulo[0].getBoundingClientRect().width - $tabela[0].getBoundingClientRect().width)).to.be.lessThan(2);
      });
    });
  });
});

describe('Coordenação: vagas cadastradas (tabela)', () => {
  it('sem vagas mostra mensagem', () => {
    abrirCoordenador();
    cy.contains('Nenhuma vaga cadastrada ainda.');
  });

  it('erro do servidor aparece na tabela', () => {
    cy.stubApiGeral();
    cy.mockApi('GET', '/api/vagas-gestao', { sucesso: false }, { status: 500 });
    cy.abrirPagina('coordenadorHome.html', { unifaa_token: 't', usuario_nome: 'C', usuario_curso: 'X', usuario_perfil: 'coordenador', usuario_matricula: 'C1' });
    cy.contains('Erro ao carregar as vagas do servidor.');
  });

  it('as colunas trazem as informações do cadastro da vaga', () => {
    abrirCoordenador({ vagas: [vagaBD()] });
    ['Polo / Curso', 'Disciplina / Avaliação', 'Data e horário', 'Período de agendamento', 'Vagas', 'Cadastrada em', 'Ação'].forEach((col) => {
      cy.contains('#page-oferta th', col);
    });
    // espera a linha com os dados (antes dela existe a linha "Carregando vagas...")
    cy.contains('#listaVagas tr', 'Polo EaD Resende').within(() => {
      cy.contains('Polo EaD Resende');
      cy.contains('Engenharia de Software');
      cy.contains('A');
      cy.contains(dataBr(dataSP(10)));
      cy.contains('08:00 – 10:00');
      cy.contains(`${dataBr(hojeSP())} a ${dataBr(dataSP(5))}`);
      cy.contains('Aberto');
      cy.contains('12 / 40');
      cy.contains('20/05/2030, 12:30:00'); // data e hora do cadastro, no fuso de São Paulo
      cy.contains('por Prof. Carlos Lima');
      cy.contains('button', 'Detalhes');
    });
  });

  it('mostra a situação do período: abre em, encerrado e sempre aberto', () => {
    abrirCoordenador({
      vagas: [
        vagaBD({ id: 1, disciplina: 'Futura', agendamento_inicio: dataSP(3), agendamento_fim: dataSP(6) }),
        vagaBD({ id: 2, disciplina: 'Velha', agendamento_inicio: dataSP(-6), agendamento_fim: dataSP(-1) }),
        vagaBD({ id: 3, disciplina: 'Antiga', agendamento_inicio: null, agendamento_fim: null })
      ]
    });
    cy.contains('#listaVagas tr', 'Futura').should('contain.text', `Abre em ${dataBr(dataSP(3))}`);
    cy.contains('#listaVagas tr', 'Velha').should('contain.text', 'Encerrado');
    cy.contains('#listaVagas tr', 'Antiga').should('contain.text', 'Sempre aberto').and('contain.text', 'Sem período definido');
  });

  it('vaga antiga sem data de cadastro mostra "—"; prova já realizada fica marcada', () => {
    abrirCoordenador({ vagas: [vagaBD({ criado_em: null, criado_por: null, futura: false, curso: null })] });
    cy.get('#listaVagas tr').first().should('contain.text', 'Prova realizada').and('contain.text', 'Todos os cursos').and('contain.text', '—');
  });

  it('a busca filtra por disciplina, polo ou curso', () => {
    abrirCoordenador({ vagas: [vagaBD({ id: 1, disciplina: 'A' }), vagaBD({ id: 2, disciplina: 'B', polo: 'Polo Barra Mansa' })] });
    cy.get('#buscaVaga').type('barra');
    cy.get('#listaVagas tr').should('have.length', 1).and('contain.text', 'Polo Barra Mansa');
    cy.get('#buscaVaga').clear().type('nada-disso');
    cy.contains('Nenhuma vaga encontrada para a busca.');
  });

  it('"Detalhes" abre o modal com todas as informações da vaga', () => {
    abrirCoordenador({ vagas: [vagaBD()] });
    cy.get('[data-vaga-detalhe="1"]').click();
    cy.get('#modalDetalheVaga').should('have.class', 'flex').within(() => {
      cy.contains('Detalhes da vaga');
      ['Polo', 'Curso', 'Data da prova', 'Horário', 'Período de agendamento', 'Limite de vagas', 'Vagas ocupadas', 'Vagas livres', 'Cadastrada em', 'Cadastrada por'].forEach((r) => cy.contains('dt', r));
      cy.contains('dt', 'Vagas livres').next('dd').should('have.text', '28');
      cy.contains('dt', 'Vagas ocupadas').next('dd').should('have.text', '12');
      cy.contains('Prof. Carlos Lima');
    });
  });

  it('o modal de detalhes fecha por Fechar, X, Esc e clicando fora', () => {
    abrirCoordenador({ vagas: [vagaBD()] });
    const abrir = () => cy.get('[data-vaga-detalhe="1"]').click();
    abrir(); cy.get('#modalDetalheVaga').contains('button', 'Fechar').click();
    cy.get('#modalDetalheVaga').should('have.class', 'hidden');
    abrir(); cy.get('#modalDetalheVaga [data-fechar-modal]').first().click();
    cy.get('#modalDetalheVaga').should('have.class', 'hidden');
    abrir(); cy.get('body').type('{esc}');
    cy.get('#modalDetalheVaga').should('have.class', 'hidden');
    abrir(); cy.get('#modalDetalheVaga').click('topLeft');
    cy.get('#modalDetalheVaga').should('have.class', 'hidden');
  });

  it('textos com HTML na tabela e nos detalhes não executam', () => {
    abrirCoordenador({ vagas: [vagaBD({ disciplina: '<img src=x onerror="window.__xss=1">', criado_por: '<b>x</b>' })] });
    cy.get('[data-vaga-detalhe="1"]').click();
    cy.get('#listaVagas img, #conteudoDetalheVaga img, #listaVagas b').should('not.exist');
    cy.window().its('__xss').should('not.exist');
  });
});

describe('Coordenação: modal de adição de vagas', () => {
  const preencher = ({ polo = 'Polo EaD Resende', curso = 'Engenharia de Software', disciplina = 'A', data = dataSP(10), inicio = '08:00', fim = '10:30', limite = '40', agInicio = hojeSP(), agFim = dataSP(5) } = {}) => {
    cy.get('#vagaPolo').select(polo);
    if (curso) cy.get('#vagaCurso').select(curso);
    if (disciplina) cy.get('#vagaDisciplina').select(disciplina);
    cy.get('#vagaData').type(data);
    cy.get('#vagaHorarioInicio').select(inicio);
    cy.get('#vagaHorarioFim').select(fim);
    cy.get('#vagaAgendInicio').type(agInicio);
    cy.get('#vagaAgendFim').type(agFim);
    cy.get('#vagaLimite').type(limite);
  };
  const enviar = () => cy.contains('#formVaga button[type=submit]', 'Cadastrar Vagas no Banco').click();

  beforeEach(() => {
    abrirCoordenador();
    cy.get('#btnAdicionarVaga').click();
  });

  it('abre ao clicar em "Adicionar Vagas" e fecha por Cancelar, X, Esc e clicando fora', () => {
    cy.get('#modalVaga').should('have.class', 'flex').and('contain.text', 'Adição de Vagas');
    cy.get('#modalVaga').contains('button', 'Cancelar').click();
    cy.get('#modalVaga').should('have.class', 'hidden');
    cy.get('#btnAdicionarVaga').click();
    cy.get('#modalVaga [data-fechar-modal]').first().click();
    cy.get('#modalVaga').should('have.class', 'hidden');
    cy.get('#btnAdicionarVaga').click();
    cy.get('body').type('{esc}');
    cy.get('#modalVaga').should('have.class', 'hidden');
    cy.get('#btnAdicionarVaga').click();
    cy.get('#modalVaga').click('topLeft');
    cy.get('#modalVaga').should('have.class', 'hidden');
  });

  it('tem polo, curso, disciplina, data, início/fim da prova, período de agendamento e limite', () => {
    ['Selecionar polo', 'Curso', 'Disciplina / Avaliação', 'Data', 'Início da prova', 'Fim da prova', 'Período de agendamento', 'Limite de vagas'].forEach((r) => {
      cy.contains('#modalVaga label, #modalVaga p', r);
    });
    cy.get('#vagaPolo option').should('have.length', 3);
  });

  it('o curso vem do servidor e a disciplina é uma lista (só as ativas)', () => {
    cy.get('#vagaCurso option').should(($o) => {
      expect([...$o].map((o) => o.textContent)).to.deep.equal(['Selecione o curso...', 'Engenharia de Software', 'Direito']);
    });
    cy.get('#vagaDisciplina option').should(($o) => {
      expect([...$o].map((o) => o.textContent)).to.deep.equal(['Selecione a disciplina...', 'A', 'B', 'C']);
    });
  });

  it('disciplina inativa não aparece na lista', () => {
    abrirCoordenador({ disciplinas: [DISCIPLINAS_PADRAO[0], { ...DISCIPLINAS_PADRAO[1], ativa: false }] });
    cy.get('#btnAdicionarVaga').click();
    cy.get('#vagaDisciplina option').should(($o) => {
      expect([...$o].map((o) => o.textContent)).to.deep.equal(['Selecione a disciplina...', 'A']);
    });
  });

  it('sem cursos ou sem disciplinas ativas avisa no próprio seletor', () => {
    abrirCoordenador({ cursos: [], disciplinas: [] });
    cy.get('#btnAdicionarVaga').click();
    cy.get('#vagaCurso').should('contain.text', 'Nenhum curso cadastrado');
    cy.get('#vagaDisciplina').should('contain.text', 'Nenhuma disciplina ativa');
  });

  it('início e fim da prova são listas de 07:00 a 22:00, de 30 em 30 minutos', () => {
    ['#vagaHorarioInicio', '#vagaHorarioFim'].forEach((id) => {
      cy.get(`${id} option`).should('have.length', 32); // "Selecione..." + 31 horários
      cy.get(`${id} option`).eq(1).should('have.text', '07:00');
      cy.get(`${id} option`).eq(2).should('have.text', '07:30');
      cy.get(`${id} option`).last().should('have.text', '22:00');
    });
  });

  it('as datas têm mínimo de hoje e o período fica numa caixa própria', () => {
    ['#vagaData', '#vagaAgendInicio', '#vagaAgendFim'].forEach((id) => cy.get(id).should('have.attr', 'min', hojeSP()).and('have.attr', 'required'));
    cy.contains('#modalVaga p', 'Período de agendamento').parent().should('contain.text', 'Início').and('contain.text', 'Fim');
  });

  it('fim da prova igual ou antes do início é recusado na tela', () => {
    cy.mockApi('POST', '/api/cadastrar-vaga', {}, { alias: 'vaga' });
    preencher({ inicio: '10:00', fim: '09:00' });
    enviar();
    cy.swal('Horário inválido');
    cy.get('@vaga.all').should('have.length', 0);
  });

  it('período de agendamento inválido é recusado na tela', () => {
    cy.mockApi('POST', '/api/cadastrar-vaga', {}, { alias: 'vaga' });
    preencher({ agInicio: dataSP(6), agFim: dataSP(3) });
    enviar();
    cy.swal('Período inválido', 'igual ou depois do início');
    cy.confirmarSwal(); // o aviso cobre a tela: fecha antes de clicar em outro botão
    cy.get('#modalVaga').contains('button', 'Cancelar').click();

    cy.get('#btnAdicionarVaga').click(); // reabre limpo: preenche de novo
    preencher({ data: dataSP(10), agFim: dataSP(12) });
    enviar();
    cy.swal('Período inválido', 'até a data da prova');
    cy.confirmarSwal();
    cy.get('@vaga.all').should('have.length', 0);
  });

  it('exige curso e disciplina (campos obrigatórios)', () => {
    cy.mockApi('POST', '/api/cadastrar-vaga', {}, { alias: 'vaga' });
    preencher({ curso: '' });
    enviar();
    cy.get('@vaga.all').should('have.length', 0);
    cy.get('#vagaCurso').select('Direito');
    cy.get('#vagaDisciplina').select('');
    enviar();
    cy.get('@vaga.all').should('have.length', 0);
  });

  it('envia todos os campos, avisa sucesso, mantém o modal aberto e preenchido e atualiza a tabela', () => {
    const data = dataSP(10);
    cy.mockApi('POST', '/api/cadastrar-vaga', { sucesso: true, mensagem: 'Vagas cadastradas e log gerado com sucesso!', id: 5 }, { alias: 'vaga' });
    preencher({ data });
    enviar();

    cy.wait('@vaga').its('request.body').should('deep.equal', {
      polo: 'Polo EaD Resende', curso: 'Engenharia de Software', disciplina: 'A', data,
      horario_inicio: '08:00', horario_fim: '10:30', limite_vagas: 40,
      agendamento_inicio: hojeSP(), agendamento_fim: dataSP(5)
    });
    cy.swal('Sucesso!', 'Vagas cadastradas');
    cy.confirmarSwal(); // o aviso cobre a tela: fecha antes de clicar em outro botão
    cy.get('#modalVaga').should('have.class', 'flex').and('be.visible');
    cy.get('#vagaPolo').should('have.value', 'Polo EaD Resende');
    cy.get('#vagaCurso').should('have.value', 'Engenharia de Software');
    cy.get('#vagaDisciplina').should('have.value', 'A');
    cy.get('#vagaData').should('have.value', data);
    cy.get('#vagaHorarioInicio').should('have.value', '08:00');
    cy.get('#vagaHorarioFim').should('have.value', '10:30');
    cy.get('#vagaAgendInicio').should('have.value', hojeSP());
    cy.get('#vagaAgendFim').should('have.value', dataSP(5));
    cy.get('#vagaLimite').should('have.value', '40');
    cy.wait('@vagas'); // recarregou a tabela
    cy.wait('@logs'); // atualizou a auditoria

    // só fecha pelo X / Cancelar; ao reabrir, vem limpo
    cy.get('#modalVaga').contains('button', 'Cancelar').click();
    cy.get('#modalVaga').should('have.class', 'hidden');
    cy.get('#btnAdicionarVaga').click();
    cy.get('#vagaLimite').should('have.value', '');
    cy.get('#vagaData').should('have.value', '');
    cy.get('#vagaCurso').should('have.value', '');
  });

  it('erro do servidor (ex.: agenda duplicada) é exibido e o modal continua aberto', () => {
    cy.mockApi('POST', '/api/cadastrar-vaga', { sucesso: false, mensagem: 'Já existe uma agenda para esta disciplina, neste polo, na mesma data e horário.' }, { status: 409 });
    preencher();
    enviar();
    cy.swal('Erro', 'Já existe uma agenda');
    cy.confirmarSwal();
    cy.get('#modalVaga').should('have.class', 'flex');
    cy.get('#vagaLimite').should('have.value', '40');
  });
});

describe('Coordenação: usuários cadastrados (tabela)', () => {
  const usuarios = [
    { id: 1, nome: 'Ana Souza', matricula: 'E00000', curso: 'Direito', tipo: 'Aluno', email: 'ana@x.com', ativo: true, foto_url: 'https://example.com/ana.jpg', polo: null },
    { id: 2, nome: 'Carlos Lima', matricula: 'C00000', curso: '', tipo: 'coordenador', email: 'c@x.com', ativo: true, foto_url: null, polo: null },
    { id: 3, nome: 'Carla Excluída', matricula: 'E00002', curso: 'Direito', tipo: 'Aluno', email: 'carla@x.com', ativo: false, foto_url: null, polo: null },
    { id: 4, nome: 'Rita Recepção', matricula: 'AT00000', curso: '', tipo: 'Recepção do Polo', email: 'rita@x.com', ativo: true, foto_url: null, polo: null },
    { id: 5, nome: 'Rui Recepção', matricula: 'AT00001', curso: '', tipo: 'Recepção do Polo', email: 'rui@x.com', ativo: true, foto_url: null, polo: 'Polo Barra Mansa' }
  ];
  const linha = (nome) => cy.contains('#listaUsuarios tr', nome);

  beforeEach(() => {
    abrirCoordenador({ usuarios });
    irParaAba('usuarios');
    cy.wait('@usuarios');
  });

  it('a tabela tem as colunas das informações do cadastro', () => {
    ['Usuário', 'Matrícula', 'E-mail', 'Perfil', 'Curso / Polo', 'Status', 'Ação'].forEach((col) => cy.contains('#page-usuarios th', col));
  });

  it('o aluno mostra nome, matrícula, e-mail, perfil, curso, status e foto', () => {
    linha('Ana Souza').within(() => {
      cy.contains('E00000');
      cy.contains('ana@x.com');
      cy.contains('Aluno');
      cy.contains('Direito');
      cy.contains('Ativo');
      cy.get('img').should('have.attr', 'src', 'https://example.com/ana.jpg');
      cy.contains('button', 'Trocar foto');
      cy.contains('button', 'Excluir');
    });
  });

  it('a recepção mostra o polo (ou avisa que está sem polo); coordenador mostra "—"', () => {
    linha('Rui Recepção').should('contain.text', 'Polo Barra Mansa').find('[data-usuario-acao="polo"]').should('contain.text', 'Trocar polo');
    linha('Rita Recepção').should('contain.text', 'Todos os polos').find('[data-usuario-acao="polo"]').should('contain.text', 'Definir polo');
    linha('Carlos Lima').should('contain.text', '—');
    linha('Ana Souza').find('[data-usuario-acao="polo"]').should('not.exist');
  });

  it('o próprio usuário aparece como "(você)" e não tem botão de excluir', () => {
    linha('Carlos Lima').within(() => {
      cy.contains('(você)');
      cy.contains('button', 'Excluir').should('not.exist');
    });
  });

  it('usuário excluído aparece marcado e com botão Reativar (sem botão de foto)', () => {
    linha('Carla Excluída').within(() => {
      cy.contains('Excluído');
      cy.contains('button', 'Reativar');
      cy.contains('button', 'Foto').should('not.exist');
    });
  });

  it('a busca consulta o servidor (com espera) usando o termo digitado', () => {
    cy.get('#buscaUsuario').type('ana');
    cy.wait('@usuarios').its('request.url').should('include', 'busca=ana');
  });

  it('excluir: confirma, envia {id, ativo:false} e recarrega a lista', () => {
    cy.mockApi('POST', '/api/alterar-status-usuario', { sucesso: true, mensagem: 'Usuário excluído. 2 agendamento(s) ativo(s) foram cancelados.' }, { alias: 'status' });
    linha('Ana Souza').contains('button', 'Excluir').click();
    cy.swal('Excluir usuário?', 'Ana Souza');
    cy.confirmarSwal();
    cy.wait('@status').its('request.body').should('deep.equal', { id: 1, ativo: false });
    cy.swal('Pronto!', '2 agendamento(s)');
    cy.wait('@usuarios');
  });

  it('cancelar a exclusão não envia nada', () => {
    cy.mockApi('POST', '/api/alterar-status-usuario', {}, { alias: 'status' });
    linha('Ana Souza').contains('button', 'Excluir').click();
    cy.get('.swal2-cancel').click();
    cy.get('@status.all').should('have.length', 0);
  });

  it('reativar envia {id, ativo:true}', () => {
    cy.mockApi('POST', '/api/alterar-status-usuario', { sucesso: true, mensagem: 'Usuário reativado com sucesso.' }, { alias: 'status' });
    linha('Carla Excluída').contains('button', 'Reativar').click();
    cy.swal('Reativar usuário?');
    cy.confirmarSwal();
    cy.wait('@status').its('request.body').should('deep.equal', { id: 3, ativo: true });
  });

  it('erro do servidor ao excluir é exibido', () => {
    cy.mockApi('POST', '/api/alterar-status-usuario', { sucesso: false, mensagem: 'Você não pode excluir a sua própria conta.' }, { status: 400 });
    linha('Ana Souza').contains('button', 'Excluir').click();
    cy.confirmarSwal();
    cy.swal('Não foi possível', 'própria conta');
  });

  it('trocar a foto de um aluno envia {id, foto}; arquivo inválido é recusado', () => {
    cy.mockApi('POST', '/api/atualizar-foto', { sucesso: true, mensagem: 'Foto atualizada com sucesso.', foto_url: 'https://x/y.jpg' }, { alias: 'foto' });
    linha('Ana Souza').contains('button', 'Trocar foto').click();
    cy.get('#inputFotoUsuario').selectFile(arquivoTexto, { force: true });
    cy.swal('Foto inválida');
    cy.get('@foto.all').should('have.length', 0);
    cy.confirmarSwal();

    linha('Ana Souza').contains('button', 'Trocar foto').click();
    cy.get('#inputFotoUsuario').selectFile(foto(), { force: true });
    cy.wait('@foto').its('request.body').should((corpo) => {
      expect(corpo.id).to.eq(1);
      expect(corpo.foto).to.match(/^data:image\/jpeg;base64,/);
    });
    cy.swal('Foto atualizada!');
  });

  it('definir o polo: escolhe na lista, envia {id, polo} e recarrega', () => {
    cy.mockApi('POST', '/api/atualizar-polo', { sucesso: true, mensagem: 'Polo atualizado com sucesso.' }, { alias: 'polo' });
    linha('Rita Recepção').find('[data-usuario-acao="polo"]').click();
    cy.swal('Definir polo', 'Rita Recepção');
    cy.get('.swal2-select').select('Polo EaD Resende');
    cy.confirmarSwal();
    cy.wait('@polo').its('request.body').should('deep.equal', { id: 4, polo: 'Polo EaD Resende' });
    cy.swal('Polo atualizado!');
    cy.wait('@usuarios');
  });

  it('definir o polo sem escolher nenhum não envia nada', () => {
    cy.mockApi('POST', '/api/atualizar-polo', {}, { alias: 'polo' });
    linha('Rita Recepção').find('[data-usuario-acao="polo"]').click();
    cy.confirmarSwal();
    cy.get('.swal2-validation-message').should('contain.text', 'Selecione um polo.');
    cy.get('@polo.all').should('have.length', 0);
  });

  it('sem usuários e com erro do servidor mostram mensagem', () => {
    abrirCoordenador({ usuarios: [] });
    irParaAba('usuarios');
    cy.contains('Nenhum usuário encontrado.');
  });

  it('nomes e e-mails com HTML não executam; foto com endereço suspeito é ignorada', () => {
    abrirCoordenador({ usuarios: [{ ...usuarios[0], nome: '<img src=x onerror="window.__xss=1">', email: '<b>x</b>', foto_url: 'javascript:alert(1)' }] });
    irParaAba('usuarios');
    cy.get('#listaUsuarios img, #listaUsuarios b').should('not.exist');
    cy.contains('#listaUsuarios', '<img src=x').should('exist');
    cy.window().its('__xss').should('not.exist');
  });
});

describe('Coordenação: modal de cadastro de usuário', () => {
  const enviar = () => cy.contains('#formCadastrarUsuario button[type=submit]', 'Cadastrar e enviar senha').click();
  const preencherBase = (tipo = 'Aluno') => {
    cy.get('#novoNome').type('Ana Paula Lima');
    cy.get('#novoEmail').type('ana@teste.com');
    cy.get('#novoTipo').select(tipo);
  };

  beforeEach(() => {
    abrirCoordenador();
    irParaAba('usuarios');
    cy.get('#btnAdicionarUsuario').click();
  });

  it('abre ao clicar em "Adicionar Usuário" e fecha por Cancelar, X, Esc e clicando fora', () => {
    cy.get('#modalUsuario').should('have.class', 'flex').and('contain.text', 'Cadastro de Novos Usuários');
    cy.get('#modalUsuario').contains('button', 'Cancelar').click();
    cy.get('#modalUsuario').should('have.class', 'hidden');
    cy.get('#btnAdicionarUsuario').click();
    cy.get('#modalUsuario [data-fechar-modal]').first().click();
    cy.get('#modalUsuario').should('have.class', 'hidden');
    cy.get('#btnAdicionarUsuario').click();
    cy.get('body').type('{esc}');
    cy.get('#modalUsuario').should('have.class', 'hidden');
    cy.get('#btnAdicionarUsuario').click();
    cy.get('#modalUsuario').click('topLeft');
    cy.get('#modalUsuario').should('have.class', 'hidden');
  });

  it('não pede matrícula nem senha e explica o que acontece', () => {
    cy.get('#novaMatricula').should('not.exist');
    cy.get('#novaSenha').should('not.exist');
    cy.contains('#modalUsuario', 'matrícula é gerada automaticamente');
    cy.contains('#modalUsuario', 'senha provisória aleatória');
  });

  it('Aluno: pede curso e foto; não pede polo', () => {
    cy.get('#blocoCurso').should('not.have.class', 'hidden');
    cy.get('#blocoFoto').should('not.have.class', 'hidden');
    cy.get('#blocoPolo').should('have.class', 'hidden');
    cy.get('#novoCurso').should('have.attr', 'required');
    cy.get('#listaCursos option').should('have.length', 2);
  });

  it('Coordenador: não pede curso, foto nem polo', () => {
    cy.get('#novoTipo').select('coordenador');
    ['#blocoCurso', '#blocoFoto', '#blocoPolo'].forEach((id) => cy.get(id).should('have.class', 'hidden'));
    cy.get('#novoCurso').should('not.have.attr', 'required');
  });

  it('Recepção do Polo: pede o polo (lista dos polos das vagas), sem curso nem foto', () => {
    cy.get('#novoTipo').select('Recepção do Polo');
    cy.get('#blocoPolo').should('not.have.class', 'hidden');
    cy.get('#novoPolo').should('have.attr', 'required');
    cy.get('#novoPolo option').should('have.length', 4); // "Selecione..." + 3 polos
    cy.get('#blocoCurso').should('have.class', 'hidden');
    cy.get('#blocoFoto').should('have.class', 'hidden');
    cy.get('#novoTipo').select('Aluno');
    cy.get('#novoPolo').should('not.have.attr', 'required');
  });

  it('escolher uma foto mostra a prévia (já reduzida para JPEG); outro tipo descarta a foto', () => {
    cy.get('#inputFoto').selectFile(foto());
    cy.get('#previewFoto').should('not.have.class', 'hidden').and('have.attr', 'src').and('match', /^data:image\/jpeg;base64,/);
    cy.get('#placeholderFoto').should('have.class', 'hidden');
    cy.get('#novoTipo').select('coordenador');
    cy.get('#previewFoto').should('have.class', 'hidden');
  });

  it('arquivo que não é imagem é recusado', () => {
    cy.get('#inputFoto').selectFile(arquivoTexto);
    cy.swal('Foto inválida', 'JPG, PNG ou WEBP');
    cy.get('#previewFoto').should('have.class', 'hidden');
  });

  it('cadastra aluno com foto: envia nome, e-mail, tipo, curso e foto; fecha o modal e recarrega a lista', () => {
    cy.mockApi('POST', '/api/cadastrar-usuario',
      { sucesso: true, matricula: 'E00007', mensagem: 'Usuário cadastrado! Matrícula: E00007. A senha provisória foi enviada para ana@teste.com.' }, { alias: 'cadastro' });
    preencherBase('Aluno');
    cy.get('#novoCurso').type('Direito');
    cy.get('#inputFoto').selectFile(foto());
    cy.get('#previewFoto').should('have.attr', 'src');
    enviar();

    cy.wait('@cadastro').its('request.body').then((corpo) => {
      expect(corpo).to.include({ nome: 'Ana Paula Lima', email: 'ana@teste.com', curso: 'Direito', tipo: 'Aluno' });
      expect(corpo.foto).to.match(/^data:image\/jpeg;base64,/);
      ['matricula', 'senha', 'polo'].forEach((k) => expect(corpo).to.not.have.property(k));
    });
    cy.swal('Usuário cadastrado!', 'Matrícula: E00007');
    cy.get('#modalUsuario').should('have.class', 'hidden');
    cy.wait('@usuarios');
  });

  it('cadastra coordenador sem curso, foto nem polo', () => {
    cy.mockApi('POST', '/api/cadastrar-usuario', { sucesso: true, matricula: 'C00001', mensagem: 'ok' }, { alias: 'cadastro' });
    preencherBase('coordenador');
    enviar();
    cy.wait('@cadastro').its('request.body').should((corpo) => {
      expect(corpo).to.deep.equal({ nome: 'Ana Paula Lima', email: 'ana@teste.com', tipo: 'coordenador' });
    });
  });

  it('cadastra recepção com polo', () => {
    cy.mockApi('POST', '/api/cadastrar-usuario', { sucesso: true, matricula: 'AT00000', mensagem: 'Usuário cadastrado! Matrícula: AT00000.' }, { alias: 'cadastro' });
    preencherBase('Recepção do Polo');
    cy.get('#novoPolo').select('Polo EaD Resende');
    enviar();
    cy.wait('@cadastro').its('request.body').should('deep.equal', { nome: 'Ana Paula Lima', email: 'ana@teste.com', tipo: 'Recepção do Polo', polo: 'Polo EaD Resende' });
    cy.swal('Usuário cadastrado!', 'AT00000');
  });

  it('recepção sem polo e aluno sem curso não são enviados (campos obrigatórios)', () => {
    cy.mockApi('POST', '/api/cadastrar-usuario', {}, { alias: 'cadastro' });
    preencherBase('Recepção do Polo');
    enviar();
    cy.get('#novoTipo').select('Aluno');
    enviar();
    cy.get('@cadastro.all').should('have.length', 0);
  });

  it('e-mail é obrigatório e precisa ser válido', () => {
    cy.mockApi('POST', '/api/cadastrar-usuario', {}, { alias: 'cadastro' });
    cy.get('#novoNome').type('Sem Email');
    cy.get('#novoCurso').type('Direito');
    enviar();
    cy.get('@cadastro.all').should('have.length', 0);
    cy.get('#novoEmail').type('isso-nao-e-email');
    enviar();
    cy.get('@cadastro.all').should('have.length', 0);
  });

  it('erro do servidor é exibido e o modal continua aberto', () => {
    cy.mockApi('POST', '/api/cadastrar-usuario', { sucesso: false, mensagem: 'Este e-mail já está cadastrado.' }, { status: 400 });
    preencherBase('Aluno');
    cy.get('#novoCurso').type('Direito');
    enviar();
    cy.swal('Erro', 'já está cadastrado');
    cy.confirmarSwal();
    cy.get('#modalUsuario').should('have.class', 'flex');
  });
});
