let vagasGestao = [];
let disciplinas = [];
let fotoCadastro = null;      // foto escolhida no formulário (data URL já reduzida)
let usuarioFotoId = null;     // aluno cuja foto está sendo trocada pela lista

const CLASSES_ABA_ATIVA = ['aba-ativa', 'font-bold', 'bg-emerald-800', 'text-white', 'shadow-sm'];
const CLASSES_ABA_INATIVA = ['text-emerald-800', 'hover:bg-emerald-100', 'hover:text-emerald-900'];

const byId = (id) => document.getElementById(id);
const hojeSP = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });

window.addEventListener('DOMContentLoaded', () => {
  if (!exigirPerfil(['coordenador'])) return;

  const nome = localStorage.getItem('usuario_nome') || '';
  const matricula = localStorage.getItem('usuario_matricula') || '';
  const inicial = (nome.split(' ')[0] || 'C').charAt(0).toUpperCase();
  setTexto('userName', nome);
  setTexto('userAvatar', inicial);
  setTexto('tituloAvatar', inicial);
  setTexto('tituloNome', nome);
  setTexto('tituloMatricula', `Matrícula ${matricula}`);
  byId('userCourse').innerHTML = 'Coordenador <i class="fa-solid fa-chevron-down text-[9px]"></i>';

  popularHorarios();
  // a lista de polos é a mesma do formulário de vagas (uma única fonte)
  byId('novoPolo').innerHTML = '<option value="">Selecione o polo...</option>' + byId('vagaPolo').innerHTML;

  const hoje = hojeSP();
  ['vagaData', 'vagaAgendInicio', 'vagaAgendFim'].forEach((id) => { byId(id).min = hoje; });

  carregarCursos();
  carregarDisciplinas();
  carregarVagas();
  carregarUsuarios();
  carregarNotas();
  carregarAuditoria();

  // ----- modais: fechar pelo X, por Cancelar, clicando fora ou com Esc -----
  document.addEventListener('click', (e) => {
    const fechar = e.target.closest('[data-fechar-modal]');
    if (fechar) { fecharModal(fechar.closest('[id^="modal"]').id); return; }
    if (e.target.id && e.target.id.startsWith('modal')) fecharModal(e.target.id);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('[id^="modal"].flex').forEach((m) => fecharModal(m.id));
  });

  // ----- vagas -----
  byId('buscaVaga').addEventListener('input', renderVagas);
  byId('listaVagas').addEventListener('click', (e) => {
    const botao = e.target.closest('[data-vaga-detalhe]');
    if (botao) abrirDetalheVaga(Number(botao.dataset.vagaDetalhe));
  });
  byId('formVaga').addEventListener('submit', enviarVaga);

  // ----- usuários -----
  let esperaBusca;
  byId('buscaUsuario').addEventListener('input', () => {
    clearTimeout(esperaBusca);
    esperaBusca = setTimeout(carregarUsuarios, 300);
  });
  byId('listaUsuarios').addEventListener('click', (e) => {
    const botao = e.target.closest('[data-usuario-acao]');
    if (!botao) return;
    const id = Number(botao.dataset.id);

    if (botao.dataset.usuarioAcao === 'foto') {
      usuarioFotoId = id;
      byId('inputFotoUsuario').click();
    } else if (botao.dataset.usuarioAcao === 'polo') {
      definirPolo(id, botao.dataset.nome, botao.dataset.polo);
    } else {
      alterarStatusUsuario(id, botao.dataset.usuarioAcao === 'reativar', botao.dataset.nome);
    }
  });
  byId('inputFotoUsuario').addEventListener('change', async (e) => {
    const arquivo = e.target.files[0];
    e.target.value = '';
    if (!arquivo || !usuarioFotoId) return;
    await enviarNovaFoto(usuarioFotoId, arquivo);
  });

  byId('novoTipo').addEventListener('change', alternarCamposUsuario);
  alternarCamposUsuario();
  byId('inputFoto').addEventListener('change', async (e) => {
    const arquivo = e.target.files[0];
    if (!arquivo) { limparFotoCadastro(); return; }
    try {
      fotoCadastro = await redimensionarImagem(arquivo);
      const prev = byId('previewFoto');
      prev.src = fotoCadastro;
      prev.classList.remove('hidden');
      byId('placeholderFoto').classList.add('hidden');
    } catch (erro) {
      limparFotoCadastro();
      Swal.fire({ title: 'Foto inválida', text: erro.message, icon: 'warning', confirmButtonColor: '#047857' });
    }
  });
  byId('formCadastrarUsuario').addEventListener('submit', enviarUsuario);

  // ----- disciplinas -----
  byId('buscaDisciplina').addEventListener('input', renderDisciplinas);
  byId('listaDisciplinas').addEventListener('click', (e) => {
    const botao = e.target.closest('[data-disc-acao]');
    if (botao) alterarStatusDisciplina(Number(botao.dataset.id), botao.dataset.discAcao === 'reativar', botao.dataset.nome);
  });
  byId('formDisciplina').addEventListener('submit', enviarDisciplina);

  // ----- notas -----
  document.querySelector('#page-sincronizacao tbody').addEventListener('click', (e) => {
    const botao = e.target.closest('[data-salvar-nota]');
    if (botao) salvarNota(Number(botao.dataset.salvarNota), botao);
  });
});

// ==========================================
// MODAIS
// ==========================================
function abrirModal(id) {
  const modal = byId(id);
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function fecharModal(id) {
  const modal = byId(id);
  if (!modal) return;
  modal.classList.remove('flex');
  modal.classList.add('hidden');
}

// ==========================================
// CURSOS
// ==========================================
async function carregarCursos() {
  try {
    const { ok, dados } = await apiFetch('/api/cursos');
    if (!ok || !Array.isArray(dados)) throw new Error(dados?.mensagem || 'Falha ao carregar cursos');

    const select = byId('vagaCurso');
    const atual = select.value;
    select.innerHTML = dados.length
      ? '<option value="">Selecione o curso...</option>' + dados.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')
      : '<option value="">Nenhum curso cadastrado (cadastre um aluno primeiro)</option>';
    if (atual && dados.includes(atual)) select.value = atual;

    byId('listaCursos').innerHTML = dados.map((c) => `<option value="${escapeHtml(c)}"></option>`).join('');
  } catch (e) {
    console.error('Erro ao carregar cursos:', e);
    byId('vagaCurso').innerHTML = '<option value="">Erro ao carregar cursos</option>';
  }
}

// ==========================================
// DISCIPLINAS
// ==========================================
async function carregarDisciplinas() {
  try {
    const { ok, dados } = await apiFetch('/api/disciplinas');
    if (!ok || !Array.isArray(dados)) throw new Error(dados?.mensagem || 'Falha ao carregar disciplinas');
    disciplinas = dados;
    renderDisciplinas();
    popularSelectDisciplinas();
  } catch (e) {
    console.error('Erro ao carregar disciplinas:', e);
    byId('listaDisciplinas').innerHTML = '<tr><td colspan="4" class="px-4 py-8 text-center text-red-500">Erro ao carregar as disciplinas do servidor.</td></tr>';
    byId('vagaDisciplina').innerHTML = '<option value="">Erro ao carregar disciplinas</option>';
  }
}

// o formulário de vagas só oferece disciplinas ATIVAS
function popularSelectDisciplinas() {
  const select = byId('vagaDisciplina');
  const atual = select.value;
  const ativas = disciplinas.filter((d) => d.ativa !== false);
  select.innerHTML = ativas.length
    ? '<option value="">Selecione a disciplina...</option>' + ativas.map((d) => `<option value="${escapeHtml(d.nome)}">${escapeHtml(d.nome)}</option>`).join('')
    : '<option value="">Nenhuma disciplina ativa (cadastre na aba Disciplinas)</option>';
  if (atual && ativas.some((d) => d.nome === atual)) select.value = atual;
}

function renderDisciplinas() {
  const tbody = byId('listaDisciplinas');
  const termo = byId('buscaDisciplina').value.trim().toLowerCase();
  const lista = disciplinas.filter((d) => !termo || d.nome.toLowerCase().includes(termo));

  if (disciplinas.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="px-4 py-8 text-center text-slate-400">Nenhuma disciplina cadastrada ainda.</td></tr>';
    return;
  }
  if (lista.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="px-4 py-8 text-center text-slate-400">Nenhuma disciplina encontrada para a busca.</td></tr>';
    return;
  }

  tbody.innerHTML = lista.map((d) => {
    const ativa = d.ativa !== false;
    const acao = ativa
      ? `<button data-disc-acao="inativar" data-id="${Number(d.id)}" data-nome="${escapeHtml(d.nome)}"
           class="bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 font-medium px-3 py-1.5 rounded-lg text-xs transition cursor-pointer">
           <i class="fa-solid fa-ban"></i> Inativar</button>`
      : `<button data-disc-acao="reativar" data-id="${Number(d.id)}" data-nome="${escapeHtml(d.nome)}"
           class="bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 font-medium px-3 py-1.5 rounded-lg text-xs transition cursor-pointer">
           <i class="fa-solid fa-rotate-left"></i> Reativar</button>`;
    return `
      <tr class="hover:bg-slate-50 transition ${ativa ? '' : 'opacity-70'}">
        <td class="px-4 py-3 font-semibold text-slate-900">${escapeHtml(d.nome)}</td>
        <td class="px-4 py-3 text-center">
          <span class="text-xs font-semibold px-2.5 py-0.5 rounded-full ${ativa ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600'}">${ativa ? 'Ativa' : 'Inativa'}</span>
        </td>
        <td class="px-4 py-3 text-xs text-slate-500">${d.criado_em ? escapeHtml(formatarDataHoraBr(d.criado_em)) : '—'}${d.criado_por ? `<div class="text-slate-400">por ${escapeHtml(d.criado_por)}</div>` : ''}</td>
        <td class="px-4 py-3 text-right">${acao}</td>
      </tr>`;
  }).join('');
}

async function enviarDisciplina(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const botao = e.submitter;
  if (botao) botao.disabled = true;

  try {
    const { ok, dados } = await apiFetch('/api/disciplinas', {
      method: 'POST',
      body: JSON.stringify({ nome: byId('novaDisciplina').value.trim() })
    });
    if (ok && dados?.sucesso) {
      fecharModal('modalDisciplina');
      form.reset();
      Swal.fire({ title: 'Disciplina cadastrada!', text: dados.mensagem, icon: 'success', confirmButtonColor: '#047857' });
      carregarDisciplinas();
      carregarAuditoria();
    } else {
      Swal.fire({ title: 'Não foi possível', text: dados?.mensagem || 'Erro ao cadastrar a disciplina.', icon: 'error', confirmButtonColor: '#047857' });
    }
  } catch (err) {
    console.error(err);
    Swal.fire({ title: 'Erro de Conexão', text: 'Erro ao comunicar com o servidor.', icon: 'error', confirmButtonColor: '#047857' });
  } finally {
    if (botao) botao.disabled = false;
  }
}

async function alterarStatusDisciplina(id, reativar, nome) {
  const confirmacao = await Swal.fire({
    title: reativar ? 'Reativar disciplina?' : 'Inativar disciplina?',
    text: reativar
      ? `${nome} volta a aparecer ao cadastrar novas vagas.`
      : `${nome} deixa de aparecer ao cadastrar novas vagas. As vagas já cadastradas continuam valendo.`,
    icon: reativar ? 'question' : 'warning',
    showCancelButton: true,
    confirmButtonColor: reativar ? '#047857' : '#ef4444',
    cancelButtonColor: '#6b7280',
    confirmButtonText: reativar ? 'Sim, reativar' : 'Sim, inativar',
    cancelButtonText: 'Cancelar',
    reverseButtons: true
  });
  if (!confirmacao.isConfirmed) return;

  try {
    const { ok, dados } = await apiFetch('/api/alterar-status-disciplina', {
      method: 'POST',
      body: JSON.stringify({ id, ativa: reativar })
    });
    if (ok && dados?.sucesso) {
      Swal.fire({ title: 'Pronto!', text: dados.mensagem, icon: 'success', confirmButtonColor: '#047857' });
      carregarDisciplinas();
      carregarAuditoria();
    } else {
      Swal.fire({ title: 'Não foi possível', text: dados?.mensagem || 'Erro ao alterar a disciplina.', icon: 'error', confirmButtonColor: '#047857' });
    }
  } catch (e) {
    console.error(e);
    Swal.fire({ title: 'Erro de Conexão', text: 'Erro ao comunicar com o servidor.', icon: 'error', confirmButtonColor: '#047857' });
  }
}

// ==========================================
// VAGAS (tabela + modal de cadastro + modal de detalhes)
// ==========================================
function popularHorarios() {
  const opcoes = ['<option value="">Selecione...</option>'];
  for (let min = 7 * 60; min <= 22 * 60; min += 30) {
    const hora = `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
    opcoes.push(`<option value="${hora}">${hora}</option>`);
  }
  ['vagaHorarioInicio', 'vagaHorarioFim'].forEach((id) => { byId(id).innerHTML = opcoes.join(''); });
}

function situacaoPeriodo(v) {
  if (!v.agendamento_inicio || !v.agendamento_fim) return { texto: 'Sempre aberto', classes: 'bg-emerald-100 text-emerald-800' };
  const hoje = hojeSP();
  if (hoje < v.agendamento_inicio) return { texto: `Abre em ${formatarDataBr(v.agendamento_inicio)}`, classes: 'bg-amber-100 text-amber-800' };
  if (hoje > v.agendamento_fim) return { texto: 'Encerrado', classes: 'bg-slate-200 text-slate-600' };
  return { texto: 'Aberto', classes: 'bg-emerald-100 text-emerald-800' };
}

const textoPeriodo = (v) =>
  (v.agendamento_inicio && v.agendamento_fim ? `${formatarDataBr(v.agendamento_inicio)} a ${formatarDataBr(v.agendamento_fim)}` : 'Sem período definido');

async function carregarVagas() {
  const tbody = byId('listaVagas');
  try {
    const { ok, dados } = await apiFetch('/api/vagas-gestao');
    if (!ok || !Array.isArray(dados)) throw new Error(dados?.mensagem || 'Falha ao carregar vagas');
    vagasGestao = dados;
    renderVagas();
  } catch (e) {
    console.error('Erro ao carregar vagas:', e);
    tbody.innerHTML = '<tr><td colspan="7" class="px-4 py-8 text-center text-red-500">Erro ao carregar as vagas do servidor.</td></tr>';
  }
}

function renderVagas() {
  const tbody = byId('listaVagas');
  const termo = byId('buscaVaga').value.trim().toLowerCase();
  const lista = vagasGestao.filter((v) => !termo || `${v.disciplina} ${v.polo} ${v.curso || ''}`.toLowerCase().includes(termo));

  if (vagasGestao.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="px-4 py-8 text-center text-slate-400">Nenhuma vaga cadastrada ainda.</td></tr>';
    return;
  }
  if (lista.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="px-4 py-8 text-center text-slate-400">Nenhuma vaga encontrada para a busca.</td></tr>';
    return;
  }

  tbody.innerHTML = lista.map((v) => {
    const sit = situacaoPeriodo(v);
    return `
      <tr class="hover:bg-slate-50 transition">
        <td class="px-4 py-3">
          <div class="font-semibold text-slate-900">${escapeHtml(v.polo)}</div>
          <div class="text-xs text-slate-500">${escapeHtml(v.curso || 'Todos os cursos')}</div>
        </td>
        <td class="px-4 py-3">
          <div class="font-medium text-slate-800">${escapeHtml(v.disciplina)}</div>
          ${v.futura ? '' : '<div class="text-xs text-slate-400">Prova realizada</div>'}
        </td>
        <td class="px-4 py-3 whitespace-nowrap">
          <div class="text-slate-800">${escapeHtml(formatarDataBr(v.data_prova))}</div>
          <div class="text-xs text-slate-500">${escapeHtml(faixaHorario(v.horario, v.horario_fim))}</div>
        </td>
        <td class="px-4 py-3">
          <div class="text-xs text-slate-700">${escapeHtml(textoPeriodo(v))}</div>
          <span class="inline-block mt-1 text-[11px] font-semibold px-2 py-0.5 rounded-full ${sit.classes}">${escapeHtml(sit.texto)}</span>
        </td>
        <td class="px-4 py-3 text-center whitespace-nowrap"><span class="font-semibold text-slate-900">${Number(v.ocupadas)}</span> / ${Number(v.limite_vagas)}</td>
        <td class="px-4 py-3 text-xs text-slate-500">
          ${v.criado_em ? escapeHtml(formatarDataHoraBr(v.criado_em)) : '—'}
          ${v.criado_por ? `<div class="text-slate-400">por ${escapeHtml(v.criado_por)}</div>` : ''}
        </td>
        <td class="px-4 py-3 text-right">
          <button data-vaga-detalhe="${Number(v.id)}" class="bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 font-medium px-3 py-1.5 rounded-lg text-xs transition cursor-pointer">
            <i class="fa-solid fa-eye"></i> Detalhes
          </button>
        </td>
      </tr>`;
  }).join('');
}

function abrirDetalheVaga(id) {
  const v = vagasGestao.find((x) => x.id === id);
  if (!v) return;
  const sit = situacaoPeriodo(v);
  const item = (rotulo, valor) => `
    <div>
      <dt class="text-[11px] font-semibold uppercase tracking-wider text-slate-500">${rotulo}</dt>
      <dd class="text-sm text-slate-900 mt-0.5">${valor}</dd>
    </div>`;

  byId('conteudoDetalheVaga').innerHTML = `
    <div class="bg-slate-50 border border-slate-200 rounded-xl p-4">
      <p class="text-lg font-bold text-slate-900">${escapeHtml(v.disciplina)}</p>
      <p class="text-xs text-slate-500">${v.futura ? 'Prova agendada' : 'Prova realizada'}</p>
    </div>
    <dl class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      ${item('Polo', escapeHtml(v.polo))}
      ${item('Curso', escapeHtml(v.curso || 'Todos os cursos'))}
      ${item('Data da prova', escapeHtml(formatarDataBr(v.data_prova)))}
      ${item('Horário', escapeHtml(faixaHorario(v.horario, v.horario_fim)))}
      ${item('Período de agendamento', `${escapeHtml(textoPeriodo(v))} <span class="ml-1 text-[11px] font-semibold px-2 py-0.5 rounded-full ${sit.classes}">${escapeHtml(sit.texto)}</span>`)}
      ${item('Limite de vagas', Number(v.limite_vagas))}
      ${item('Vagas ocupadas', Number(v.ocupadas))}
      ${item('Vagas livres', Math.max(0, Number(v.limite_vagas) - Number(v.ocupadas)))}
      ${item('Cadastrada em', v.criado_em ? escapeHtml(formatarDataHoraBr(v.criado_em)) : '—')}
      ${item('Cadastrada por', escapeHtml(v.criado_por || '—'))}
    </dl>`;
  abrirModal('modalDetalheVaga');
}

async function enviarVaga(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const botao = e.submitter;

  const inicio = byId('vagaHorarioInicio').value;
  const fim = byId('vagaHorarioFim').value;
  if (fim <= inicio) {
    Swal.fire({ title: 'Horário inválido', text: 'O fim da prova deve ser depois do início.', icon: 'warning', confirmButtonColor: '#047857' });
    return;
  }

  const dataProva = byId('vagaData').value;
  const agInicio = byId('vagaAgendInicio').value;
  const agFim = byId('vagaAgendFim').value;
  if (agFim < agInicio) {
    Swal.fire({ title: 'Período inválido', text: 'O fim do agendamento deve ser igual ou depois do início.', icon: 'warning', confirmButtonColor: '#047857' });
    return;
  }
  if (agFim > dataProva) {
    Swal.fire({ title: 'Período inválido', text: 'O agendamento deve terminar até a data da prova.', icon: 'warning', confirmButtonColor: '#047857' });
    return;
  }

  const corpo = {
    polo: byId('vagaPolo').value,
    curso: byId('vagaCurso').value,
    disciplina: byId('vagaDisciplina').value,
    data: dataProva,
    horario_inicio: inicio,
    horario_fim: fim,
    agendamento_inicio: agInicio,
    agendamento_fim: agFim,
    limite_vagas: Number(byId('vagaLimite').value)
  };

  if (botao) botao.disabled = true;
  try {
    const { ok, dados } = await apiFetch('/api/cadastrar-vaga', { method: 'POST', body: JSON.stringify(corpo) });

    if (ok && dados?.sucesso) {
      fecharModal('modalVaga');
      form.reset();
      Swal.fire({ title: 'Sucesso!', text: dados.mensagem, icon: 'success', confirmButtonColor: '#047857' });
      carregarVagas();
      carregarAuditoria();
    } else {
      Swal.fire({ title: 'Erro', text: dados?.mensagem || 'Não foi possível cadastrar a vaga.', icon: 'error', confirmButtonColor: '#047857' });
    }
  } catch (err) {
    console.error(err);
    Swal.fire({ title: 'Erro de Conexão', text: 'Não foi possível se comunicar com o servidor.', icon: 'error', confirmButtonColor: '#047857' });
  } finally {
    if (botao) botao.disabled = false;
  }
}

// ==========================================
// CADASTRO DE USUÁRIO (modal)
// ==========================================
// curso e foto só para aluno; polo só para recepção do polo
function alternarCamposUsuario() {
  const tipo = byId('novoTipo').value;
  const ehAluno = tipo === 'Aluno';
  const ehRecepcao = tipo === 'Recepção do Polo';

  byId('blocoCurso').classList.toggle('hidden', !ehAluno);
  byId('novoCurso').required = ehAluno;
  if (!ehAluno) byId('novoCurso').value = '';

  byId('blocoFoto').classList.toggle('hidden', !ehAluno);
  if (!ehAluno) limparFotoCadastro();

  byId('blocoPolo').classList.toggle('hidden', !ehRecepcao);
  byId('novoPolo').required = ehRecepcao;
  if (!ehRecepcao) byId('novoPolo').value = '';
}

function limparFotoCadastro() {
  fotoCadastro = null;
  byId('inputFoto').value = '';
  const prev = byId('previewFoto');
  prev.removeAttribute('src');
  prev.classList.add('hidden');
  byId('placeholderFoto').classList.remove('hidden');
}

// reduz a foto no navegador (lado maior 480px, JPEG) antes de enviar
function redimensionarImagem(arquivo, maxLado = 480, qualidade = 0.85) {
  return new Promise((resolve, reject) => {
    if (!/^image\/(jpeg|png|webp)$/.test(arquivo.type)) {
      reject(new Error('Use uma imagem JPG, PNG ou WEBP.'));
      return;
    }
    const url = URL.createObjectURL(arquivo);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const escala = Math.min(1, maxLado / Math.max(img.width, img.height));
      const largura = Math.max(1, Math.round(img.width * escala));
      const altura = Math.max(1, Math.round(img.height * escala));
      const canvas = document.createElement('canvas');
      canvas.width = largura;
      canvas.height = altura;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, largura, altura);
      ctx.drawImage(img, 0, 0, largura, altura);
      resolve(canvas.toDataURL('image/jpeg', qualidade));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Não foi possível ler a imagem.'));
    };
    img.src = url;
  });
}

async function enviarUsuario(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const botao = e.submitter;
  const textoOriginal = botao ? botao.innerHTML : '';

  const tipo = byId('novoTipo').value;
  const corpo = { nome: byId('novoNome').value.trim(), email: byId('novoEmail').value.trim(), tipo };
  if (tipo === 'Aluno') {
    corpo.curso = byId('novoCurso').value.trim();
    if (fotoCadastro) corpo.foto = fotoCadastro;
  }
  if (tipo === 'Recepção do Polo') corpo.polo = byId('novoPolo').value;

  if (botao) {
    botao.disabled = true;
    botao.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Cadastrando e enviando e-mail...';
  }

  try {
    const { ok, dados } = await apiFetch('/api/cadastrar-usuario', { method: 'POST', body: JSON.stringify(corpo) });

    if (ok && dados?.sucesso) {
      fecharModal('modalUsuario');
      form.reset();
      limparFotoCadastro();
      alternarCamposUsuario();
      Swal.fire({ title: 'Usuário cadastrado!', text: dados.mensagem, icon: 'success', confirmButtonColor: '#047857' });
      carregarUsuarios();
      carregarCursos();
      carregarAuditoria();
    } else {
      Swal.fire({ title: 'Erro', text: dados?.mensagem || 'Não foi possível cadastrar o usuário.', icon: 'error', confirmButtonColor: '#047857' });
    }
  } catch (err) {
    console.error(err);
    Swal.fire({ title: 'Erro de Conexão', text: 'Erro de conexão com o servidor.', icon: 'error', confirmButtonColor: '#047857' });
  } finally {
    if (botao) {
      botao.disabled = false;
      botao.innerHTML = textoOriginal;
    }
  }
}

// ==========================================
// USUÁRIOS (tabela: foto, polo, excluir e reativar)
// ==========================================
async function carregarUsuarios() {
  const tbody = byId('listaUsuarios');
  const busca = byId('buscaUsuario').value.trim();
  const minhaMatricula = localStorage.getItem('usuario_matricula');

  try {
    const { ok, dados } = await apiFetch(`/api/usuarios?busca=${encodeURIComponent(busca)}`);
    if (!ok || !Array.isArray(dados)) throw new Error(dados?.mensagem || 'Falha ao carregar usuários');

    if (dados.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="px-4 py-8 text-center text-slate-400">Nenhum usuário encontrado.</td></tr>';
      return;
    }

    tbody.innerHTML = dados.map((u) => {
      const ehVoce = u.matricula === minhaMatricula;
      const tipoNorm = String(u.tipo || '').trim().toLowerCase();
      const ehAluno = tipoNorm === 'aluno';
      const ehRecepcao = tipoNorm === 'recepção do polo';
      const foto = urlSegura(u.foto_url);

      const avatar = foto
        ? `<img src="${escapeHtml(foto)}" alt="" class="w-10 h-10 rounded-full object-cover border border-slate-300 shrink-0">`
        : `<div class="w-10 h-10 rounded-full bg-slate-200 text-slate-600 flex items-center justify-center text-sm font-bold shrink-0">${escapeHtml((u.nome || '?').charAt(0).toUpperCase())}</div>`;

      let cursoPolo = '—';
      if (ehAluno) cursoPolo = u.curso || '—';
      if (ehRecepcao) cursoPolo = u.polo || 'Todos os polos (sem polo definido)';

      let acoes = '';
      if (u.ativo && ehAluno) {
        acoes += `<button data-usuario-acao="foto" data-id="${Number(u.id)}"
                    class="bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 font-medium px-3 py-1.5 rounded-lg text-xs transition cursor-pointer whitespace-nowrap">
                    <i class="fa-solid fa-camera"></i> ${foto ? 'Trocar foto' : 'Foto'}</button>`;
      }
      if (u.ativo && ehRecepcao) {
        acoes += `<button data-usuario-acao="polo" data-id="${Number(u.id)}" data-nome="${escapeHtml(u.nome)}" data-polo="${escapeHtml(u.polo || '')}"
                    class="bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 font-medium px-3 py-1.5 rounded-lg text-xs transition cursor-pointer whitespace-nowrap">
                    <i class="fa-solid fa-location-dot"></i> ${u.polo ? 'Trocar polo' : 'Definir polo'}</button>`;
      }
      if (ehVoce) {
        acoes += '<span class="text-xs text-slate-400">(você)</span>';
      } else if (u.ativo) {
        acoes += `<button data-usuario-acao="excluir" data-id="${Number(u.id)}" data-nome="${escapeHtml(u.nome)}"
                    class="bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 font-medium px-3 py-1.5 rounded-lg text-xs transition cursor-pointer whitespace-nowrap">
                    <i class="fa-solid fa-user-xmark"></i> Excluir</button>`;
      } else {
        acoes += `<button data-usuario-acao="reativar" data-id="${Number(u.id)}" data-nome="${escapeHtml(u.nome)}"
                    class="bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 font-medium px-3 py-1.5 rounded-lg text-xs transition cursor-pointer whitespace-nowrap">
                    <i class="fa-solid fa-user-check"></i> Reativar</button>`;
      }

      return `
        <tr class="hover:bg-slate-50 transition ${u.ativo ? '' : 'opacity-70'}">
          <td class="px-4 py-3">
            <div class="flex items-center gap-3">${avatar}<span class="font-semibold text-slate-900">${escapeHtml(u.nome)}</span></div>
          </td>
          <td class="px-4 py-3 font-mono text-xs text-slate-700">${escapeHtml(u.matricula)}</td>
          <td class="px-4 py-3 text-xs text-slate-600">${escapeHtml(u.email || '—')}</td>
          <td class="px-4 py-3 text-xs text-slate-700">${escapeHtml(u.tipo)}</td>
          <td class="px-4 py-3 text-xs text-slate-700">${escapeHtml(cursoPolo)}</td>
          <td class="px-4 py-3 text-center">
            <span class="text-xs font-semibold px-2.5 py-0.5 rounded-full ${u.ativo ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600'}">${u.ativo ? 'Ativo' : 'Excluído'}</span>
          </td>
          <td class="px-4 py-3"><div class="flex flex-wrap justify-end items-center gap-2">${acoes}</div></td>
        </tr>`;
    }).join('');
  } catch (e) {
    console.error('Erro ao carregar usuários:', e);
    tbody.innerHTML = '<tr><td colspan="7" class="px-4 py-8 text-center text-red-500">Erro ao carregar os usuários do servidor.</td></tr>';
  }
}

async function definirPolo(id, nome, poloAtual) {
  const polos = [...document.querySelectorAll('#vagaPolo option')].map((o) => o.value);
  const { value: polo } = await Swal.fire({
    title: 'Definir polo',
    text: nome,
    input: 'select',
    inputOptions: Object.fromEntries(polos.map((p) => [p, p])),
    inputValue: poloAtual || '',
    inputPlaceholder: 'Selecione o polo',
    showCancelButton: true,
    confirmButtonColor: '#047857',
    confirmButtonText: 'Salvar',
    cancelButtonText: 'Cancelar',
    inputValidator: (v) => (v ? null : 'Selecione um polo.')
  });
  if (!polo) return;

  try {
    const { ok, dados } = await apiFetch('/api/atualizar-polo', { method: 'POST', body: JSON.stringify({ id, polo }) });
    if (ok && dados?.sucesso) {
      Swal.fire({ title: 'Polo atualizado!', text: dados.mensagem, icon: 'success', confirmButtonColor: '#047857' });
      carregarUsuarios();
      carregarAuditoria();
    } else {
      Swal.fire({ title: 'Não foi possível', text: dados?.mensagem || 'Erro ao atualizar o polo.', icon: 'error', confirmButtonColor: '#047857' });
    }
  } catch (e) {
    console.error(e);
    Swal.fire({ title: 'Erro de Conexão', text: 'Erro ao comunicar com o servidor.', icon: 'error', confirmButtonColor: '#047857' });
  }
}

async function enviarNovaFoto(id, arquivo) {
  try {
    const foto = await redimensionarImagem(arquivo);
    const { ok, dados } = await apiFetch('/api/atualizar-foto', { method: 'POST', body: JSON.stringify({ id, foto }) });

    if (ok && dados?.sucesso) {
      Swal.fire({ title: 'Foto atualizada!', text: dados.mensagem, icon: 'success', confirmButtonColor: '#047857' });
      carregarUsuarios();
      carregarAuditoria();
    } else {
      Swal.fire({ title: 'Não foi possível', text: dados?.mensagem || 'Erro ao salvar a foto.', icon: 'error', confirmButtonColor: '#047857' });
    }
  } catch (erro) {
    Swal.fire({ title: 'Foto inválida', text: erro.message, icon: 'warning', confirmButtonColor: '#047857' });
  }
}

async function alterarStatusUsuario(id, reativar, nome) {
  const confirmacao = await Swal.fire({
    title: reativar ? 'Reativar usuário?' : 'Excluir usuário?',
    text: reativar
      ? `${nome} poderá entrar no sistema novamente.`
      : `${nome} não poderá mais entrar no sistema e os agendamentos ativos dele serão cancelados. O histórico e os logs são mantidos.`,
    icon: reativar ? 'question' : 'warning',
    showCancelButton: true,
    confirmButtonColor: reativar ? '#047857' : '#ef4444',
    cancelButtonColor: '#6b7280',
    confirmButtonText: reativar ? 'Sim, reativar' : 'Sim, excluir',
    cancelButtonText: 'Cancelar',
    reverseButtons: true
  });
  if (!confirmacao.isConfirmed) return;

  try {
    const { ok, dados } = await apiFetch('/api/alterar-status-usuario', {
      method: 'POST',
      body: JSON.stringify({ id, ativo: reativar })
    });

    if (ok && dados?.sucesso) {
      Swal.fire({ title: 'Pronto!', text: dados.mensagem, icon: 'success', confirmButtonColor: '#047857' });
      carregarUsuarios();
      carregarAuditoria();
    } else {
      Swal.fire({ title: 'Não foi possível', text: dados?.mensagem || 'Erro ao alterar o usuário.', icon: 'error', confirmButtonColor: '#047857' });
    }
  } catch (e) {
    console.error(e);
    Swal.fire({ title: 'Erro de Conexão', text: 'Erro ao comunicar com o servidor.', icon: 'error', confirmButtonColor: '#047857' });
  }
}

// ==========================================
// NOTAS
// ==========================================
async function carregarNotas() {
  const tbody = document.querySelector('#page-sincronizacao tbody');
  if (!tbody) return;

  try {
    const { ok, dados } = await apiFetch('/api/notas');
    if (!ok || !Array.isArray(dados)) throw new Error(dados?.mensagem || 'Falha ao carregar notas');

    if (dados.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="px-4 py-6 text-center text-slate-400">Nenhuma nota cadastrada.</td></tr>';
      return;
    }

    tbody.innerHTML = dados.map((item) => `
      <tr class="hover:bg-slate-50 transition">
        <td class="px-4 py-3">
          <div class="font-semibold text-slate-900">${escapeHtml(item.nome_aluno)}</div>
          <div class="text-xs text-slate-400 font-mono">${escapeHtml(item.matricula)}</div>
        </td>
        <td class="px-4 py-3 font-medium text-slate-800">${escapeHtml(item.avaliacao)}</td>
        <td class="px-4 py-3"><span class="text-xs bg-slate-100 px-2 py-0.5 rounded font-medium text-slate-700">${escapeHtml(item.polo)}</span></td>
        <td class="px-4 py-3 text-center">
          <span class="inline-flex items-center gap-1 bg-emerald-100 text-emerald-800 text-xs font-semibold px-2.5 py-0.5 rounded-full">
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> ${escapeHtml(item.status || 'Sincronizado')}
          </span>
        </td>
        <td class="px-4 py-3 text-center">
          <input type="number" step="0.5" min="0" max="10" id="nota-${Number(item.id)}" value="${escapeHtml(item.nota ?? '')}"
            class="w-16 bg-slate-50 border border-slate-300 rounded text-center py-1 text-slate-900 font-semibold focus:ring-2 focus:ring-emerald-500 outline-none">
        </td>
        <td class="px-4 py-3 text-right">
          <button data-salvar-nota="${Number(item.id)}" class="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded-lg text-xs font-medium shadow-sm transition cursor-pointer">
            Salvar
          </button>
        </td>
      </tr>`).join('');
  } catch (e) {
    console.error('Erro ao carregar notas:', e);
    tbody.innerHTML = '<tr><td colspan="6" class="px-4 py-6 text-center text-red-500">Erro ao carregar as notas do servidor.</td></tr>';
  }
}

async function salvarNota(id, botao) {
  const valor = byId(`nota-${id}`).value;
  const nota = Number(String(valor).replace(',', '.'));

  if (valor === '' || !Number.isFinite(nota) || nota < 0 || nota > 10) {
    Swal.fire({ title: 'Atenção', text: 'Informe uma nota entre 0 e 10.', icon: 'warning', confirmButtonColor: '#047857' });
    return;
  }

  if (botao) botao.disabled = true;
  try {
    const { ok, dados } = await apiFetch('/api/atualizar-nota', { method: 'POST', body: JSON.stringify({ id, nota }) });

    if (ok && dados?.sucesso) {
      Swal.fire({ title: 'Salvo!', text: dados.mensagem, icon: 'success', confirmButtonColor: '#047857' });
      carregarAuditoria();
    } else {
      Swal.fire({ title: 'Atenção', text: dados?.mensagem || 'Não foi possível salvar a nota.', icon: 'warning', confirmButtonColor: '#047857' });
    }
  } catch (e) {
    console.error(e);
    Swal.fire({ title: 'Erro', text: 'Erro ao comunicar com o servidor.', icon: 'error', confirmButtonColor: '#047857' });
  } finally {
    if (botao) botao.disabled = false;
  }
}

// ==========================================
// AUDITORIA
// ==========================================
let paginaAuditoria = 1;
let ultimaRequisicaoAuditoria = 0; // descarta respostas antigas que chegarem fora de ordem

function filtrosAuditoria() {
  return {
    busca: byId('filtroUsuario').value,
    acao: byId('filtroAcao').value,
    data_inicio: byId('filtroDataInicio').value,
    data_fim: byId('filtroDataFim').value,
    ip: byId('filtroIp').value
  };
}

// filtros e paginação são feitos no servidor; sem argumento recarrega a página atual
// (é chamada assim depois de cada ação da coordenação)
async function carregarAuditoria(pagina = paginaAuditoria) {
  const requisicao = ++ultimaRequisicaoAuditoria;
  try {
    const { ok, status, dados } = await apiFetch(`/api/auditoria?${queryAuditoria(filtrosAuditoria(), pagina)}`);
    if (requisicao !== ultimaRequisicaoAuditoria) return;

    if (status === 400) {
      const container = byId('lista-logs-auditoria');
      if (container) container.innerHTML = `<p class="text-amber-700 text-center py-4">${escapeHtml(dados?.mensagem || 'Filtro inválido.')}</p>`;
      desativarPaginacaoAuditoria();
      return;
    }
    if (!ok || !Array.isArray(dados?.logs)) throw new Error(dados?.mensagem || 'Falha ao carregar auditoria');

    paginaAuditoria = Number(dados.pagina) || 1;
    atualizarPaginacaoAuditoria(dados);
    renderizarLogs(dados.logs);
  } catch (e) {
    if (requisicao !== ultimaRequisicaoAuditoria) return;
    console.error('Erro ao carregar auditoria:', e);
    desativarPaginacaoAuditoria();
  }
}

function mudarPaginaAuditoria(passo) {
  carregarAuditoria(paginaAuditoria + passo);
}

function renderizarLogs(lista) {
  const container = byId('lista-logs-auditoria');
  if (!container) return;

  if (lista.length === 0) {
    container.innerHTML = '<p class="text-slate-400 text-center py-4">Nenhum log encontrado com os filtros selecionados.</p>';
    return;
  }

  container.innerHTML = lista.map((log) => {
    const alerta = /SOFT_DELETE|CANCEL|BLOQUEADO|FALHA|INATIVACAO/.test(log.acao);
    const corBorda = alerta ? 'border-l-amber-500' : 'border-l-emerald-500';
    const corTexto = alerta ? 'text-amber-700' : 'text-emerald-700';

    return `
      <div class="p-4 bg-slate-50 rounded-xl border border-slate-200 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 text-slate-700 border-l-4 ${corBorda}">
        <span>[LOG #${Number(log.id)}] <strong class="${corTexto}">${escapeHtml(log.acao)}</strong>: ${escapeHtml(log.descricao)}
          ${log.usuario ? `<span class="text-slate-400"> — por ${escapeHtml(log.usuario)}</span>` : ''}</span>
        <span class="text-slate-400">${escapeHtml(formatarDataHoraBr(log.data_hora))} | IP: ${escapeHtml(log.ip || '—')}</span>
      </div>`;
  }).join('');
}

// botão "Filtrar Registros": aplica os filtros a partir da página 1
function filtrarAuditoria() {
  carregarAuditoria(1);
}

// ==========================================
// ABAS
// ==========================================
function switchTab(tabId, botao) {
  document.querySelectorAll('.page-content').forEach((p) => p.classList.add('hidden'));

  document.querySelectorAll('.tab-btn').forEach((b) => {
    b.classList.remove(...CLASSES_ABA_ATIVA);
    b.classList.add(...CLASSES_ABA_INATIVA);
    b.removeAttribute('aria-current');
  });

  byId(`page-${tabId}`).classList.remove('hidden');
  botao.classList.remove(...CLASSES_ABA_INATIVA);
  botao.classList.add(...CLASSES_ABA_ATIVA);
  botao.setAttribute('aria-current', 'page');

  if (tabId === 'oferta') { carregarVagas(); carregarCursos(); }
  if (tabId === 'usuarios') carregarUsuarios();
  if (tabId === 'disciplinas') carregarDisciplinas();
  if (tabId === 'sincronizacao') carregarNotas();
  if (tabId === 'auditoria') carregarAuditoria();
}
