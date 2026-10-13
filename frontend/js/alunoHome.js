let vagasPorDisciplina = new Map();
let agendamentosPorDisciplina = new Map();
let disciplinaAtual = null;
let enviandoAgendamento = false;
let carregandoComprovante = false;
let modoReagendar = null; // { agendamentoId, vagaAtualId } quando o modal está trocando um horário

window.addEventListener('DOMContentLoaded', () => {
  if (!exigirPerfil(['aluno'])) return;

  const nome = localStorage.getItem('usuario_nome') || '';
  const curso = localStorage.getItem('usuario_curso') || '';
  const matricula = localStorage.getItem('usuario_matricula') || '—';
  const primeiroNome = nome.split(' ')[0] || 'Aluno';

  setTexto('userName', nome);
  setTexto('userAvatar', primeiroNome.charAt(0).toUpperCase());
  setTexto('welcomeName', primeiroNome.charAt(0).toUpperCase() + primeiroNome.slice(1).toLowerCase());
  setTexto('userMatricula', `Matrícula ${matricula}`);
  document.getElementById('userCourse').innerHTML =
    `${escapeHtml(curso)} <i class="fa-solid fa-chevron-down text-[9px]"></i>`;

  // cliques nos cards (delegação: nada de dado do banco dentro de onclick inline)
  document.getElementById('listaVagasAluno').addEventListener('click', (e) => {
    const botao = e.target.closest('[data-acao]');
    if (!botao) return;
    if (botao.dataset.acao === 'agendar') abrirModalAgendamento(botao.dataset.disciplina);
    if (botao.dataset.acao === 'cancelar') solicitarCancelamento(Number(botao.dataset.id));
    if (botao.dataset.acao === 'comprovante') abrirComprovante(Number(botao.dataset.id));
    if (botao.dataset.acao === 'reagendar') {
      abrirModalAgendamento(botao.dataset.disciplina, { agendamentoId: Number(botao.dataset.id), vagaAtualId: Number(botao.dataset.vaga) });
    }
  });

  document.getElementById('modalAgendamento').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) fecharModal();
  });
  document.getElementById('modalResultados').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) fecharModalResultados();
  });
  document.getElementById('modalComprovante').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) fecharComprovante();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('modalComprovante').classList.contains('flex')) fecharComprovante();
  });

  carregarPerfil(nome);
  carregarVagas();
  carregarResultados();
});

// foto do aluno ao lado do nome (se não houver, continua a inicial)
async function carregarPerfil(nome) {
  try {
    const { ok, dados } = await apiFetch('/api/perfil');
    const foto = ok && dados ? urlSegura(dados.foto_url) : '';
    if (!foto) return;

    const avatar = document.getElementById('userAvatar');
    const inicial = avatar.textContent;
    const img = document.createElement('img');
    img.src = foto;
    img.alt = nome || '';
    img.className = 'w-full h-full object-cover';
    img.onerror = () => { avatar.textContent = inicial; };
    avatar.textContent = '';
    avatar.appendChild(img);
  } catch (erro) {
    console.error('Erro ao carregar o perfil:', erro);
  }
}

// ==========================================
// AVALIAÇÕES E AGENDAMENTOS
// ==========================================
function atualizarContadores(total, disponiveis) {
  setTexto('contadorTotalPendentes', total);
  document.getElementById('contadorDisponiveisAgendar').innerHTML =
    `<i class="fa-regular fa-clock"></i> ${disponiveis} disponíveis para agendar`;
}

async function carregarVagas() {
  const container = document.getElementById('listaVagasAluno');

  try {
    const [rv, ra] = await Promise.all([apiFetch('/api/vagas'), apiFetch('/api/meus-agendamentos')]);
    renderizarAvisosAgendamento(rv.ok && Array.isArray(rv.dados) ? rv.dados : null);
    if (!rv.ok || !ra.ok) throw new Error('Falha ao carregar dados');

    vagasPorDisciplina = new Map();
    rv.dados.forEach((v) => {
      if (!vagasPorDisciplina.has(v.disciplina)) vagasPorDisciplina.set(v.disciplina, []);
      vagasPorDisciplina.get(v.disciplina).push(v);
    });

    agendamentosPorDisciplina = new Map();
    ra.dados.forEach((a) => agendamentosPorDisciplina.set(a.disciplina, a));

    const disciplinas = [...new Set([...vagasPorDisciplina.keys(), ...agendamentosPorDisciplina.keys()])]
      .sort((a, b) => a.localeCompare(b, 'pt-BR'));

    if (disciplinas.length === 0) {
      container.innerHTML = `
        <div class="text-center py-8 text-slate-500 bg-slate-50 rounded-xl border border-dashed border-slate-300">
          <i class="fa-solid fa-folder-open text-2xl mb-2 text-slate-400"></i>
          <p class="text-sm font-medium">Nenhuma avaliação disponível para agendamento no momento.</p>
        </div>`;
      atualizarContadores(0, 0);
      return;
    }

    container.innerHTML = disciplinas.map(renderizarCard).join('');
    atualizarContadores(disciplinas.length, disciplinas.filter((d) => !agendamentosPorDisciplina.has(d)).length);
  } catch (error) {
    console.error('Erro ao carregar dados:', error);
    container.innerHTML = `
      <div class="text-center py-8 text-red-500 bg-red-50 rounded-xl border border-red-200">
        <i class="fa-solid fa-triangle-exclamation text-2xl mb-2"></i>
        <p class="text-sm font-medium">Erro ao carregar as avaliações do servidor.</p>
      </div>`;
    atualizarContadores(0, 0);
  }
}

// ---------- avisos da coordenação: períodos de agendamento ----------
const LIMITE_AVISOS_AGENDAMENTO = 5;

// "YYYY-MM-DD" -> "dd/mm" (as datas chegam do banco como texto, sem conversão de fuso)
function diaMes(iso) {
  const [, mes, dia] = String(iso).slice(0, 10).split('-');
  return `${dia}/${mes}`;
}

// usa as mesmas vagas de /api/vagas (já filtradas pelo curso do aluno). Só entram vagas com
// período definido, que ainda não terminou e cuja prova não passou ("hoje" no fuso de São Paulo).
// Todo texto vindo do banco entra por textContent.
function renderizarAvisosAgendamento(vagas) {
  const container = document.getElementById('avisosAgendamento');
  container.replaceChildren();
  if (!vagas) {
    container.hidden = true;
    return;
  }

  const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  const validas = vagas
    .filter((v) => v.agendamento_inicio && v.agendamento_fim && v.data_prova)
    .filter((v) => String(v.agendamento_fim).slice(0, 10) >= hoje && String(v.data_prova).slice(0, 10) >= hoje);

  // vagas da mesma disciplina, polo, período e data de prova (só o horário muda) viram um único aviso
  const agrupadas = new Map();
  validas.forEach((v) => {
    const chave = JSON.stringify([
      v.disciplina, v.polo,
      String(v.agendamento_inicio).slice(0, 10), String(v.agendamento_fim).slice(0, 10), String(v.data_prova).slice(0, 10)
    ]);
    if (!agrupadas.has(chave)) agrupadas.set(chave, v);
  });

  const avisos = [...agrupadas.values()]
    .sort((a, b) => String(a.agendamento_fim).localeCompare(String(b.agendamento_fim))
      || String(a.data_prova).localeCompare(String(b.data_prova))
      || String(a.disciplina).localeCompare(String(b.disciplina), 'pt-BR'))
    .slice(0, LIMITE_AVISOS_AGENDAMENTO);

  if (avisos.length === 0) {
    const vazio = document.createElement('div');
    vazio.className = 'p-3 bg-slate-50 rounded-xl border border-slate-200 text-slate-500';
    vazio.textContent = 'Nenhum período de agendamento aberto no momento.';
    container.appendChild(vazio);
  }

  avisos.forEach((v) => {
    const inicio = diaMes(v.agendamento_inicio);
    const fim = diaMes(v.agendamento_fim);
    const aberto = String(v.agendamento_inicio).slice(0, 10) <= hoje;

    const cartao = document.createElement('div');
    cartao.className = 'aviso-agendamento p-3 bg-slate-50 rounded-xl border border-slate-200';
    cartao.dataset.situacao = aberto ? 'aberto' : 'abre-em';

    const titulo = document.createElement('div');
    titulo.className = 'text-teal-700 font-semibold mb-1';
    titulo.textContent = aberto
      ? `Agendamento liberado de ${inicio} a ${fim}:`
      : `Agendamento abre em ${inicio} (até ${fim}):`;

    const texto = document.createElement('div');
    texto.className = 'text-slate-700';
    texto.textContent = `${v.disciplina || ''} – ${v.polo || 'Polo Geral'}, prova em ${diaMes(v.data_prova)}`;

    cartao.append(titulo, texto);
    container.appendChild(cartao);
  });

  container.hidden = false;
}

function renderizarCard(disciplina) {
  const ag = agendamentosPorDisciplina.get(disciplina);

  if (ag) {
    return `
      <div class="task-item bg-slate-50 p-4 sm:p-5 rounded-xl border border-slate-200 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 transition hover:border-emerald-500">
        <div class="space-y-1.5 flex-1">
          <h4 class="font-bold text-slate-900 text-sm sm:text-base">${escapeHtml(disciplina)} <span class="text-xs font-normal text-slate-500">(${escapeHtml(ag.polo || 'Polo Geral')})</span></h4>
          <div class="inline-block bg-emerald-100 text-emerald-800 text-xs font-semibold px-2.5 py-0.5 rounded-full border border-emerald-200">Agendamento Confirmado</div>
          <div class="text-xs text-slate-600 pt-1">
            <i class="fa-regular fa-calendar-days text-emerald-600"></i> <strong>Data/Hora:</strong>
            ${escapeHtml(formatarDataBr(ag.data_agendada))} às ${escapeHtml(faixaHorario(ag.horario_agendado, ag.horario_fim))}
          </div>
        </div>
        <div class="w-full md:w-auto border-t md:border-t-0 pt-3 md:pt-0 border-slate-200 shrink-0">
          <div class="flex flex-wrap gap-2">
          <button data-acao="comprovante" data-id="${Number(ag.id)}" class="bg-white hover:bg-slate-100 text-slate-700 border border-slate-300 font-medium px-3 py-2 rounded-lg text-xs transition flex items-center justify-center gap-1.5 cursor-pointer">
            <i class="fa-solid fa-receipt"></i> Comprovante
          </button>
          <button data-acao="reagendar" data-id="${Number(ag.id)}" data-vaga="${Number(ag.vaga_id)}" data-disciplina="${escapeHtml(disciplina)}" class="bg-teal-50 hover:bg-teal-100 text-teal-700 border border-teal-200 font-medium px-3 py-2 rounded-lg text-xs transition flex items-center justify-center gap-1.5 cursor-pointer">
            <i class="fa-solid fa-rotate"></i> Reagendar
          </button>
          <button data-acao="cancelar" data-id="${Number(ag.id)}" class="bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 font-medium px-3 py-2 rounded-lg text-xs transition flex items-center justify-center gap-1.5 cursor-pointer">
            <i class="fa-solid fa-trash-can"></i> Cancelar
          </button>
          </div>
        </div>
      </div>`;
  }

  const vagas = vagasPorDisciplina.get(disciplina) || [];
  const comVaga = vagas.filter((v) => v.agendamento_aberto !== false && v.vagas_restantes > 0).length;
  const aAbrir = vagas.filter((v) => v.agendamento_aberto === false)
    .sort((x, y) => String(x.agendamento_inicio).localeCompare(String(y.agendamento_inicio)));
  const rotulo = comVaga > 0 ? 'Agendar' : (aAbrir.length ? `Abre em ${formatarDataBr(aAbrir[0].agendamento_inicio)}` : 'Sem vagas');

  return `
    <div class="task-item bg-slate-50 p-4 sm:p-5 rounded-xl border border-slate-200 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 transition hover:border-emerald-500">
      <div class="space-y-1.5 flex-1">
        <h4 class="font-bold text-slate-900 text-sm sm:text-base">${escapeHtml(disciplina)}</h4>
        <div class="inline-block bg-amber-100 text-amber-800 text-xs font-semibold px-2.5 py-0.5 rounded-full border border-amber-200">Agendamento de Avaliação disponível</div>
        <div class="text-xs text-slate-600 pt-1">
          <i class="fa-regular fa-calendar-days text-amber-600"></i> ${comVaga === 0 && aAbrir.length ? `Agendamento abre em ${escapeHtml(formatarDataBr(aAbrir[0].agendamento_inicio))}` : `${comVaga} horário(s) com vaga`}
        </div>
      </div>
      <div class="w-full md:w-auto border-t md:border-t-0 pt-3 md:pt-0 border-slate-200 shrink-0">
        <button data-acao="agendar" data-disciplina="${escapeHtml(disciplina)}" ${comVaga === 0 ? 'disabled' : ''}
          class="bg-teal-600 hover:bg-teal-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-medium px-4 py-2 rounded-lg text-xs transition flex items-center justify-center gap-1.5 cursor-pointer">
          <i class="fa-solid fa-calendar-plus"></i> ${escapeHtml(rotulo)}
        </button>
      </div>
    </div>`;
}

// ---------- modal de agendamento ----------
function abrirModalAgendamento(disciplina, reagendar = null) {
  disciplinaAtual = disciplina;
  modoReagendar = reagendar;
  const select = document.getElementById('horarioSelect');
  select.innerHTML = '<option value="">Selecione...</option>';

  // ao reagendar, o horário atual não é opção
  const vagas = (vagasPorDisciplina.get(disciplina) || []).filter((v) => !reagendar || v.id !== reagendar.vagaAtualId);

  vagas.forEach((vaga) => {
    const opt = document.createElement('option');
    opt.value = vaga.id;
    const naoAbriu = vaga.agendamento_aberto === false;
    const esgotada = vaga.vagas_restantes <= 0;
    opt.disabled = esgotada || naoAbriu;
    opt.textContent = `${formatarDataBr(vaga.data_prova)} ${faixaHorario(vaga.horario, vaga.horario_fim)} — ${vaga.polo || 'Institucional'} ` +
      (naoAbriu ? `(abre em ${formatarDataBr(vaga.agendamento_inicio)})` : esgotada ? '(esgotado)' : `(${vaga.vagas_restantes} vagas)`);
    select.appendChild(opt);
  });

  if (reagendar && !vagas.some((v) => v.agendamento_aberto !== false && v.vagas_restantes > 0)) {
    modoReagendar = null;
    Swal.fire({ title: 'Sem outros horários', text: 'Não há outros horários disponíveis para esta avaliação no momento.', icon: 'info', confirmButtonColor: '#065f46' });
    return;
  }

  setTexto('tituloModalAgendamento', reagendar ? 'Reagendar avaliação' : 'Agendar avaliação');
  document.getElementById('avisoReagendar').classList.toggle('hidden', !reagendar);

  const modal = document.getElementById('modalAgendamento');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function fecharModal() {
  const modal = document.getElementById('modalAgendamento');
  modal.classList.remove('flex');
  modal.classList.add('hidden');
  document.getElementById('horarioSelect').value = '';
  disciplinaAtual = null;
  modoReagendar = null;
}

async function confirmarAgendamento() {
  if (enviandoAgendamento) return;

  const vagaId = document.getElementById('horarioSelect').value;
  if (!vagaId) {
    Swal.fire({
      title: 'Atenção',
      text: 'Por favor, selecione um horário na agenda.',
      icon: 'warning',
      confirmButtonColor: '#065f46'
    });
    return;
  }

  const reagendando = modoReagendar;
  enviandoAgendamento = true;
  try {
    const { ok, dados } = reagendando
      ? await apiFetch('/api/reagendar', {
        method: 'POST',
        body: JSON.stringify({ agendamento_id: reagendando.agendamentoId, nova_vaga_id: Number(vagaId) })
      })
      : await apiFetch('/api/agendar', {
        method: 'POST',
        body: JSON.stringify({ vaga_id: Number(vagaId) })
      });

    if (ok && dados?.sucesso) {
      fecharModal();
      const novoId = Number(dados.agendamento?.id);
      const abriu = Number.isInteger(novoId) && novoId > 0 &&
        await abrirComprovante(novoId, { aviso: dados.mensagem, avisarErro: false });
      // sem comprovante (resposta sem id ou falha ao buscá-lo): mantém o aviso de sucesso de antes
      if (!abriu) {
        Swal.fire({ title: reagendando ? 'Reagendado!' : 'Sucesso!', text: dados.mensagem, icon: 'success', confirmButtonColor: '#065f46' });
      }
    } else {
      const mensagem = dados?.mensagem || (reagendando ? 'Não foi possível reagendar.' : 'Não foi possível agendar esta vaga.');
      const bloqueado = /Bloqueada/.test(mensagem);
      Swal.fire({
        title: bloqueado ? 'Ação Bloqueada' : (reagendando ? 'Falha no Reagendamento' : 'Falha no Agendamento'),
        text: mensagem,
        icon: 'error',
        confirmButtonColor: '#ef4444'
      });
    }
    carregarVagas(); // atualiza vagas restantes mesmo em caso de erro (ex.: vaga esgotou)
  } catch (erro) {
    console.error('Erro ao agendar:', erro);
    Swal.fire({ title: 'Erro de Conexão', text: 'Erro ao salvar o agendamento.', icon: 'error', confirmButtonColor: '#ef4444' });
  } finally {
    enviandoAgendamento = false;
  }
}

async function solicitarCancelamento(agendamentoId) {
  const confirmacao = await Swal.fire({
    title: 'Cancelar agendamento?',
    text: 'Atenção: o cancelamento só é permitido se faltarem mais de 24 horas para a prova.',
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: '#ef4444',
    cancelButtonColor: '#6b7280',
    confirmButtonText: 'Sim, cancelar',
    cancelButtonText: 'Manter agendamento',
    reverseButtons: true
  });
  if (!confirmacao.isConfirmed) {
    Swal.fire({ title: 'Agendamento mantido', text: 'Nenhuma alteração foi feita no seu agendamento.', icon: 'info', confirmButtonColor: '#065f46' });
    return;
  }

  try {
    const { ok, dados } = await apiFetch('/api/cancelar-agendamento', {
      method: 'POST',
      body: JSON.stringify({ agendamento_id: agendamentoId })
    });

    if (ok && dados?.sucesso) {
      Swal.fire({ title: 'Cancelado!', text: dados.mensagem, icon: 'success', confirmButtonColor: '#065f46' });
      carregarVagas();
    } else {
      Swal.fire({
        title: 'Ação Bloqueada',
        text: dados?.mensagem || 'Não foi possível cancelar o agendamento.',
        icon: 'error',
        confirmButtonColor: '#ef4444'
      });
    }
  } catch (erro) {
    console.error('Erro ao cancelar:', erro);
    Swal.fire({ title: 'Erro de Conexão', text: 'Erro ao comunicar com o servidor.', icon: 'error', confirmButtonColor: '#ef4444' });
  }
}

// ---------- comprovante do agendamento ----------
// busca no servidor (dados do banco e hora de emissão do servidor) e mostra no modal.
// Todo texto entra por textContent. Devolve true se o modal abriu.
async function abrirComprovante(agendamentoId, { aviso = '', avisarErro = true } = {}) {
  if (carregandoComprovante) return false;
  carregandoComprovante = true;
  try {
    const { ok, dados } = await apiFetch(`/api/agendamentos/${encodeURIComponent(agendamentoId)}/comprovante`);
    const c = dados?.comprovante;
    if (!ok || !dados?.sucesso || !c || typeof c !== 'object') {
      if (avisarErro) {
        Swal.fire({
          title: 'Comprovante indisponível',
          text: dados?.mensagem || 'Não foi possível carregar o comprovante.',
          icon: 'error',
          confirmButtonColor: '#ef4444'
        });
      }
      return false;
    }

    setTexto('compCodigo', c.codigo || '');
    setTexto('compAluno', c.aluno_nome || '');
    setTexto('compMatricula', c.matricula || '');
    setTexto('compCurso', c.curso || '—');
    setTexto('compDisciplina', c.disciplina || '');
    setTexto('compPolo', c.polo || '—');
    setTexto('compData', formatarDataBr(c.data_prova));
    setTexto('compHorario', c.horario_fim
      ? `${formatarHora(c.horario_inicio)} às ${formatarHora(c.horario_fim)}`
      : formatarHora(c.horario_inicio));
    setTexto('compSituacao', c.situacao || '');
    setTexto('compEmitido', c.emitido_em_local || '');

    const avisoEl = document.getElementById('comprovanteAviso');
    avisoEl.textContent = aviso || '';
    avisoEl.classList.toggle('hidden', !aviso);

    const modal = document.getElementById('modalComprovante');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    document.body.classList.add('comprovante-aberto');
    return true;
  } catch (erro) {
    console.error('Erro ao carregar o comprovante:', erro);
    if (avisarErro) {
      Swal.fire({ title: 'Erro de Conexão', text: 'Erro ao carregar o comprovante.', icon: 'error', confirmButtonColor: '#ef4444' });
    }
    return false;
  } finally {
    carregandoComprovante = false;
  }
}

function fecharComprovante() {
  const modal = document.getElementById('modalComprovante');
  modal.classList.remove('flex');
  modal.classList.add('hidden');
  document.body.classList.remove('comprovante-aberto');
}

// o CSS @media print do alunoHome.html deixa só o comprovante na impressão / no PDF
function imprimirComprovante() {
  window.print();
}

// ==========================================
// RESULTADOS
// ==========================================
async function carregarResultados() {
  try {
    const { ok, dados } = await apiFetch('/api/resultados');
    if (!ok || !Array.isArray(dados)) return null;
    setTexto('contadorResultadosLancados', dados.filter((r) => r.nota !== null && r.nota !== undefined).length);
    return dados;
  } catch (erro) {
    console.error('Erro ao carregar resultados:', erro);
    return null;
  }
}

async function abrirResultados() {
  const modal = document.getElementById('modalResultados');
  modal.classList.remove('hidden');
  modal.classList.add('flex');

  const lista = document.getElementById('listaResultadosModal');
  lista.innerHTML = '<p class="text-center text-slate-500 py-6">A carregar resultados...</p>';

  const resultados = await carregarResultados();

  if (resultados === null) {
    lista.innerHTML = '<p class="text-center text-red-500 py-6">Erro ao carregar os resultados do servidor.</p>';
    return;
  }
  if (resultados.length === 0) {
    lista.innerHTML = '<p class="text-center text-slate-500 py-6">Nenhum resultado lançado até o momento.</p>';
    return;
  }

  const linhas = resultados.map((item) => {
    const temNota = item.nota !== null && item.nota !== undefined && item.nota !== '';
    const nota = parseFloat(item.nota);
    let status = 'Sem nota';
    let classes = 'bg-slate-100 text-slate-600 border border-slate-200';
    if (temNota && nota >= 6) {
      status = 'Aprovado';
      classes = 'bg-emerald-100 text-emerald-800 border border-emerald-200';
    } else if (temNota) {
      status = 'Reprovado';
      classes = 'bg-red-100 text-red-800 border border-red-200';
    }

    return `
      <tr class="hover:bg-slate-50 transition">
        <td class="py-3.5 px-4 font-semibold text-slate-800">${escapeHtml(item.avaliacao || 'N/A')}</td>
        <td class="py-3.5 px-4 whitespace-nowrap">${escapeHtml(item.polo || 'N/A')}</td>
        <td class="py-3.5 px-4 font-bold text-emerald-600 text-center whitespace-nowrap">${temNota ? escapeHtml(item.nota) : '—'}</td>
        <td class="py-3.5 px-4 text-center whitespace-nowrap">
          <span class="${classes} px-3 py-1 rounded-full text-[10px] font-semibold">${status}</span>
        </td>
      </tr>`;
  }).join('');

  lista.innerHTML = `
    <div class="w-full overflow-x-auto">
      <table class="w-full text-left text-xs">
        <thead>
          <tr class="border-b border-slate-200 text-slate-500 uppercase">
            <th class="py-3 px-4">Avaliação</th>
            <th class="py-3 px-4 whitespace-nowrap">Polo</th>
            <th class="py-3 px-4 text-center whitespace-nowrap">Nota</th>
            <th class="py-3 px-4 text-center whitespace-nowrap">Status</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100 text-slate-700">${linhas}</tbody>
      </table>
    </div>`;
}

function fecharModalResultados() {
  const modal = document.getElementById('modalResultados');
  modal.classList.remove('flex');
  modal.classList.add('hidden');
}
