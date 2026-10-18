let resultadosAtuais = [];
let versaoResultado = 0; // evita que uma resposta lenta apague um resultado mais novo
let modoAtual = 'hoje'; // 'hoje' = lista do dia; 'consulta' = resultado de uma busca

window.addEventListener('DOMContentLoaded', () => {
  if (!exigirPerfil(['recepção do polo'])) return;

  // mesmo preenchimento do cabeçalho da Coordenação (dados gravados no login, sempre como texto)
  const nome = localStorage.getItem('usuario_nome') || 'Recepção';
  const matricula = localStorage.getItem('usuario_matricula') || '';
  const inicial = (nome.trim().split(' ')[0] || 'R').charAt(0).toUpperCase();
  setTexto('userName', nome);
  setTexto('userAvatar', inicial);
  setTexto('tituloAvatar', inicial);
  setTexto('tituloNome', nome);
  setTexto('tituloMatricula', `Matrícula ${matricula}`);

  carregarPoloDaRecepcao();
  carregarListaDoDia(); // a lista de hoje já aparece ao abrir a tela

  ['inputBusca', 'inputDataFiltro'].forEach((id) => {
    document.getElementById(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') consultar();
    });
  });

  // clique no nome do aluno (lista) abre a confirmação de presença
  document.getElementById('containerResultado').addEventListener('click', (e) => {
    const linha = e.target.closest('[data-abrir-aluno]');
    if (linha) abrirModalAluno(Number(linha.dataset.abrirAluno));
  });

  const modal = document.getElementById('modalAluno');
  modal.addEventListener('click', (e) => {
    if (e.target === modal || e.target.closest('[data-fechar-modal]')) {
      fecharModalAluno();
      return;
    }
    const botao = e.target.closest('[data-confirmar-ticket]');
    if (botao) confirmarEntrada(Number(botao.dataset.confirmarTicket), botao.dataset.nome, botao);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') fecharModalAluno();
  });
});

// fetch sem resposta do servidor (API fora do ar, sem rede) lança TypeError ("Failed to fetch"):
// mostra uma mensagem em português em vez do texto técnico do navegador
const MENSAGEM_SEM_CONEXAO = 'Não foi possível conectar ao servidor. Tente novamente.';
function textoDoErro(error) {
  if (error instanceof TypeError) return MENSAGEM_SEM_CONEXAO;
  return error?.message || MENSAGEM_SEM_CONEXAO;
}

// ==========================================
// CONSULTA UNIFICADA (aluno e/ou data)
// ==========================================
function mensagemCarregando(texto) {
  return `
    <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 text-center text-slate-500">
      <i class="fa-solid fa-spinner fa-spin text-3xl text-emerald-600 mb-3"></i>
      <p class="text-sm font-medium text-slate-700">${escapeHtml(texto)}</p>
    </div>`;
}

function mensagemErro(titulo, detalhe) {
  return `
    <div class="bg-rose-50 rounded-2xl shadow-sm border border-rose-200 p-8 text-center text-rose-600">
      <i class="fa-solid fa-triangle-exclamation text-3xl mb-3"></i>
      <p class="text-sm font-bold">${escapeHtml(titulo)}</p>
      <p class="text-xs mt-1">${escapeHtml(detalhe)}</p>
    </div>`;
}

function statusDoAluno(ag) {
  if (ag.ticket_id === null || ag.ticket_id === undefined) {
    return { texto: 'Sem agendamento', classes: 'bg-slate-100 text-slate-600' };
  }
  if (ag.entrada_confirmada_em) {
    return { texto: 'Presente', classes: 'bg-emerald-100 text-emerald-800' };
  }
  return { texto: 'Aguardando', classes: 'bg-amber-100 text-amber-800' };
}

async function consultar(opcoes = {}) {
  const termo = document.getElementById('inputBusca').value.trim();
  const data = document.getElementById('inputDataFiltro').value;
  const container = document.getElementById('containerResultado');

  if (!termo && !data) {
    Swal.fire({
      icon: 'warning',
      title: 'Nada para consultar',
      text: 'Informe o nome/matrícula do aluno, a data da prova, ou os dois.',
      confirmButtonColor: '#047857'
    });
    return;
  }
  if (termo && !data && termo.length < 3) {
    Swal.fire({
      icon: 'warning',
      title: 'Busca muito curta',
      text: 'Digite pelo menos 3 caracteres do nome ou a matrícula completa.',
      confirmButtonColor: '#047857'
    });
    return;
  }

  const minha = ++versaoResultado;
  container.innerHTML = mensagemCarregando('Pesquisando no sistema...');

  try {
    let lista;
    let resumo = null;

    if (data) {
      const { ok, dados } = await apiFetch(
        `/api/portaria/por-data?data=${encodeURIComponent(data)}&busca=${encodeURIComponent(termo)}`
      );
      if (!ok || !dados?.sucesso) throw new Error(dados?.mensagem || 'Erro ao buscar dados da data.');
      lista = dados.alunos;
      resumo = { total: dados.total, presentes: dados.presentes, data };
    } else {
      const { ok, dados } = await apiFetch(`/api/portaria/consultar?busca=${encodeURIComponent(termo)}`);
      if (!ok) throw new Error(dados?.mensagem || 'Erro na consulta.');
      lista = dados.encontrado ? dados.resultados : [];
    }

    if (minha !== versaoResultado) return;
    resultadosAtuais = lista;
    modoAtual = 'consulta';

    if (lista.length === 0) {
      container.innerHTML = `
        <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 text-center text-slate-500">
          <i class="fa-solid fa-calendar-xmark text-4xl text-amber-500 mb-3"></i>
          <p class="text-sm font-medium text-slate-700">${data
            ? `Nenhum aluno agendado para ${escapeHtml(formatarDataBr(data))}${termo ? ' com esse filtro' : ''}.`
            : 'Aluno não encontrado no sistema.'}</p>
        </div>`;
      return;
    }

    container.innerHTML = renderizarLista(lista, resumo);

    // busca que retornou um único aluno: já abre a confirmação (como era antes)
    if (!data && lista.length === 1 && opcoes.abrirAutomatico !== false) abrirModalAluno(0);
  } catch (error) {
    console.error(error);
    container.innerHTML = mensagemErro('Erro na consulta', textoDoErro(error));
  }
}

function renderizarLista(lista, resumo) {
  const cabecalho = resumo
    ? `<div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 pb-4 border-b border-slate-100">
         <div>
           <h3 class="text-lg font-bold text-slate-900">${escapeHtml(resumo.titulo || 'Alunos agendados')}</h3>
           <p class="text-xs text-slate-500">Data consultada: <strong class="text-slate-700">${escapeHtml(formatarDataBr(resumo.data))}</strong></p>
         </div>
         <div class="flex gap-3">
           <div class="bg-emerald-50 border border-emerald-200 px-4 py-2 rounded-xl text-center">
             <span class="block text-xs text-emerald-700 font-semibold uppercase">Total</span>
             <span class="text-xl font-black text-emerald-900">${Number(resumo.total)}</span>
           </div>
           <div class="bg-slate-50 border border-slate-200 px-4 py-2 rounded-xl text-center">
             <span class="block text-xs text-slate-600 font-semibold uppercase">Presentes</span>
             <span class="text-xl font-black text-slate-900">${Number(resumo.presentes)}</span>
           </div>
         </div>
       </div>`
    : `<div class="pb-4 border-b border-slate-100">
         <h3 class="text-lg font-bold text-slate-900">${totalDeAlunos(lista)} aluno(s) encontrado(s)</h3>
       </div>`;

  const destaques = provasEmDestaque(lista);

  const linhas = lista.map((ag, i) => {
    const st = statusDoAluno(ag);
    const temAg = ag.ticket_id !== null && ag.ticket_id !== undefined;
    const destaque = destaques.get(i);
    const foto = urlSegura(ag.foto_url);
    const nome = ag.aluno_nome || 'Estudante';

    const avatar = foto
      ? `<img src="${escapeHtml(foto)}" alt="" class="w-11 h-11 rounded-full object-cover border border-slate-300 shrink-0">`
      : `<div class="w-11 h-11 rounded-full bg-emerald-100 text-emerald-800 flex items-center justify-center font-bold border border-emerald-200 shrink-0">${escapeHtml(nome.charAt(0).toUpperCase())}</div>`;

    const detalhe = temAg
      ? `${escapeHtml(ag.disciplina)} · ${escapeHtml(formatarDataBr(ag.data_agendada))} ${escapeHtml(faixaHorario(ag.horario_agendado, ag.horario_fim))}`
      : 'Sem agendamento ativo a partir de hoje';

    const fundo = destaque
      ? 'bg-emerald-50 border-emerald-500 ring-1 ring-emerald-500'
      : 'bg-slate-50 border-slate-200';
    const seloDestaque = destaque
      ? `<span class="inline-block mb-0.5 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-full bg-emerald-600 text-white">${destaque}</span>`
      : '';

    return `
      <button type="button" data-abrir-aluno="${i}"${destaque ? ' data-destaque="sim"' : ''}
        class="w-full text-left flex items-center justify-between gap-3 p-3 ${fundo} hover:bg-emerald-50 rounded-xl border hover:border-emerald-400 transition cursor-pointer">
        <div class="flex items-center gap-3 min-w-0">
          ${avatar}
          <div class="min-w-0">
            ${seloDestaque}
            <p class="text-sm font-bold text-emerald-800 underline decoration-dotted truncate">${escapeHtml(nome)}</p>
            <p class="text-xs text-slate-500 truncate">Matrícula <span class="font-mono">${escapeHtml(ag.matricula || 'N/A')}</span> · ${detalhe}</p>
          </div>
        </div>
        <span class="px-2.5 py-1 text-xs font-semibold rounded-full shrink-0 ${st.classes}">${st.texto}</span>
      </button>`;
  }).join('');

  return `
    <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 border-t-4 border-t-emerald-600 space-y-4">
      ${cabecalho}
      <div class="space-y-2 max-h-[28rem] overflow-y-auto pr-1">${linhas}</div>
    </div>`;
}

// a consulta por nome/matrícula devolve uma linha por prova: conta os alunos, não as linhas
function totalDeAlunos(lista) {
  return new Set(lista.map((ag, i) => ag.matricula || ag.usuario_id || `linha-${i}`)).size;
}

// aluno com mais de uma prova no dia (consulta por nome/matrícula, que traz momento_prova): destaca a
// prova em andamento ou, se nenhuma estiver, a próxima. Devolve Map(índice da linha -> rótulo do selo)
function provasEmDestaque(lista) {
  const porAluno = new Map();
  lista.forEach((ag, i) => {
    if (ag.ticket_id === null || ag.ticket_id === undefined || !ag.momento_prova) return;
    const chave = ag.matricula || ag.usuario_id;
    if (!porAluno.has(chave)) porAluno.set(chave, []);
    porAluno.get(chave).push(i);
  });

  const destaques = new Map();
  porAluno.forEach((indices) => {
    if (indices.length < 2) return;
    const atual = indices.find((i) => lista[i].momento_prova === 'em_andamento');
    const proxima = indices.find((i) => lista[i].momento_prova === 'futura');
    if (atual !== undefined) destaques.set(atual, 'Prova atual');
    else if (proxima !== undefined) destaques.set(proxima, 'Próxima prova');
  });
  return destaques;
}

// ==========================================
// CONFIRMAÇÃO DE PRESENÇA (modal)
// ==========================================
function abrirModalAluno(indice) {
  const ag = resultadosAtuais[indice];
  if (!ag) return;

  const nome = ag.aluno_nome || 'Estudante';
  const foto = urlSegura(ag.foto_url);
  const avatar = foto
    ? `<img src="${escapeHtml(foto)}" class="w-24 h-24 rounded-full object-cover border-2 border-emerald-500 shadow-sm" alt="Foto do aluno">`
    : `<div class="w-24 h-24 rounded-full bg-emerald-100 text-emerald-800 flex items-center justify-center font-bold text-3xl border-2 border-emerald-500 shadow-sm">${escapeHtml(nome.charAt(0).toUpperCase())}</div>`;

  const temAg = ag.ticket_id !== null && ag.ticket_id !== undefined;
  const jaEntrou = Boolean(ag.entrada_confirmada_em);
  const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  const naoEhHoje = temAg && String(ag.data_agendada).slice(0, 10) !== hoje;

  let rodape;
  if (!temAg) {
    rodape = '<span class="text-xs text-amber-700 font-semibold">Aluno sem agendamento ativo a partir de hoje.</span>';
  } else if (jaEntrou) {
    const hora = new Date(ag.entrada_confirmada_em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
    rodape = `<span class="text-xs text-emerald-700 font-semibold"><i class="fa-solid fa-circle-check"></i> Entrada já confirmada às ${escapeHtml(hora)}</span>`;
  } else if (ag.momento_prova === 'encerrada' && !naoEhHoje) {
    // o servidor recusa a confirmação depois do término; a tela já avisa em vez de oferecer o botão
    rodape = `<span class="text-xs text-rose-700 font-semibold"><i class="fa-solid fa-clock"></i> O horário desta prova já terminou${ag.horario_fim ? ` às ${escapeHtml(formatarHora(ag.horario_fim))}` : ''}. A entrada não pode mais ser confirmada.</span>`;
  } else {
    rodape = `
      <span class="text-xs text-slate-500">Documento com foto conferido?</span>
      <button data-confirmar-ticket="${Number(ag.ticket_id)}" data-nome="${escapeHtml(nome)}" class="btn-primary w-full sm:w-auto gap-2">
        <i class="fa-solid fa-check"></i> Confirmar Entrada
      </button>`;
  }

  document.getElementById('conteudoModalAluno').innerHTML = `
    <div class="modal-corpo bg-white rounded-2xl shadow-2xl border border-slate-200 border-l-4 border-l-emerald-600 p-6 relative">
      <button type="button" data-fechar-modal class="botao-icone absolute top-1 right-2 text-slate-400 hover:text-slate-700 cursor-pointer" title="Fechar" aria-label="Fechar">
        <i class="fa-solid fa-xmark text-lg"></i>
      </button>

      <div class="flex justify-between items-start mb-4 pr-6">
        <span class="${temAg ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'} text-xs font-bold px-3 py-1 rounded-full uppercase tracking-wider">
          ${temAg ? 'Agendamento Confirmado' : 'Registro Encontrado'}
        </span>
        <span class="text-xs font-mono text-slate-400">${temAg ? `TICKET #${Number(ag.ticket_id)}` : 'SEM TICKET'}</span>
      </div>

      <div class="flex items-center gap-4 mb-5">
        <div class="shrink-0">${avatar}</div>
        <div class="min-w-0">
          <h3 id="modalNomeAluno" class="text-xl font-bold text-slate-900 leading-tight [overflow-wrap:anywhere] line-clamp-3" title="${escapeHtml(nome)}">${escapeHtml(nome)}</h3>
          <p class="text-xs text-slate-500 mt-1 [overflow-wrap:anywhere]">Matrícula: <strong class="text-slate-700 font-mono">${escapeHtml(ag.matricula || 'N/A')}</strong></p>
          <p class="text-xs text-slate-500 [overflow-wrap:anywhere]">${escapeHtml(ag.curso || 'Curso não informado')}</p>
        </div>
      </div>

      <div class="bg-slate-50 p-4 rounded-xl space-y-2 text-sm border border-slate-200 mb-4">
        <p class="flex justify-between gap-3"><span class="text-slate-500 shrink-0">Avaliação:</span>
          <strong class="text-slate-800 text-right min-w-0 [overflow-wrap:anywhere]">${escapeHtml(temAg ? ag.disciplina : 'Nenhuma avaliação agendada')}</strong></p>
        <p class="flex justify-between gap-3"><span class="text-slate-500 shrink-0">Data e Horário:</span>
          <strong class="text-slate-800 text-right min-w-0">${temAg ? `${escapeHtml(formatarDataBr(ag.data_agendada))} · ${escapeHtml(faixaHorario(ag.horario_agendado, ag.horario_fim))}` : '—'}</strong></p>
        <p class="flex justify-between gap-3"><span class="text-slate-500 shrink-0">Local Alocado:</span>
          <strong class="text-slate-800 text-right min-w-0 [overflow-wrap:anywhere]">${escapeHtml(temAg ? ag.polo : '—')}</strong></p>
      </div>

      ${naoEhHoje ? `<div class="bg-amber-50 border border-amber-200 text-amber-800 text-xs rounded-lg p-3 mb-4">
        <i class="fa-solid fa-triangle-exclamation"></i> A prova deste aluno é em ${escapeHtml(formatarDataBr(ag.data_agendada))}, não hoje.</div>` : ''}

      <div class="border-t border-slate-100 pt-4 flex flex-col sm:flex-row items-center justify-between gap-3">${rodape}</div>
    </div>`;

  const modal = document.getElementById('modalAluno');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function fecharModalAluno() {
  const modal = document.getElementById('modalAluno');
  if (!modal) return;
  modal.classList.remove('flex');
  modal.classList.add('hidden');
}

async function confirmarEntrada(ticketId, nomeAluno, botao) {
  if (botao) botao.disabled = true;

  try {
    const { ok, dados } = await apiFetch('/api/portaria/confirmar-entrada', {
      method: 'POST',
      body: JSON.stringify({ ticket_id: ticketId })
    });

    if (!ok || !dados?.sucesso) {
      throw new Error(dados?.mensagem || 'Erro ao processar confirmação de entrada.');
    }

    fecharModalAluno();
    await Swal.fire({
      icon: 'success',
      title: 'Entrada Confirmada!',
      text: `Presença de ${nomeAluno} registrada com sucesso no sistema.`,
      confirmButtonColor: '#047857'
    });

    recarregarUltima(); // atualiza a lista com o status "Presente"
  } catch (error) {
    console.error(error);
    if (botao) botao.disabled = false;
    Swal.fire({
      icon: 'error',
      title: 'Erro na Confirmação',
      text: textoDoErro(error),
      confirmButtonColor: '#047857'
    });
  }
}

// ==========================================
// LISTA DO DIA (carrega sozinha) e polo da recepção
// ==========================================
async function carregarListaDoDia() {
  const container = document.getElementById('containerResultado');
  const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  const minha = ++versaoResultado;
  container.innerHTML = mensagemCarregando('Carregando a lista de hoje...');

  try {
    const { ok, dados } = await apiFetch(`/api/portaria/por-data?data=${encodeURIComponent(hoje)}`);
    if (!ok || !dados?.sucesso) throw new Error(dados?.mensagem || 'Erro ao carregar a lista do dia.');

    if (minha !== versaoResultado) return;
    modoAtual = 'hoje';
    resultadosAtuais = dados.alunos;

    if (dados.total === 0) {
      container.innerHTML = `
        <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 text-center text-slate-500">
          <i class="fa-solid fa-calendar-xmark text-4xl text-amber-500 mb-3"></i>
          <p class="text-sm font-medium text-slate-700">Nenhum aluno agendado para hoje (${escapeHtml(formatarDataBr(hoje))}).</p>
          <p class="text-xs text-slate-400 mt-1">Use os campos acima para consultar outro aluno ou outra data.</p>
        </div>`;
      return;
    }

    container.innerHTML = renderizarLista(dados.alunos, { total: dados.total, presentes: dados.presentes, data: hoje, titulo: 'Lista do dia — hoje' });
  } catch (error) {
    console.error(error);
    container.innerHTML = mensagemErro('Erro ao carregar a lista do dia', textoDoErro(error));
  }
}

// volta para a lista de hoje, limpando os filtros
function mostrarListaDeHoje() {
  document.getElementById('inputBusca').value = '';
  document.getElementById('inputDataFiltro').value = '';
  carregarListaDoDia();
}

function recarregarUltima() {
  if (modoAtual === 'hoje') carregarListaDoDia();
  else consultar({ abrirAutomatico: false });
}

async function carregarPoloDaRecepcao() {
  try {
    const { ok, dados } = await apiFetch('/api/perfil');
    if (!ok || !dados) return;
    setTexto('infoPolo', dados.polo ? `Polo: ${dados.polo}` : 'Polo: todos (nenhum polo definido para este usuário)');
    const bloco = document.getElementById('blocoPolo');
    bloco.classList.remove('hidden');
    bloco.classList.add('inline-flex');
  } catch (error) {
    console.error('Erro ao carregar o perfil:', error);
  }
}
