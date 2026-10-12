let logsGlobais = [];
let fotoCadastro = null;      // foto escolhida no formulário (data URL já reduzida)
let usuarioFotoId = null;     // aluno cuja foto está sendo trocada pela lista

const CLASSES_ABA_ATIVA = ['font-bold', 'bg-emerald-800', 'text-white', 'border', 'border-emerald-700', 'shadow-sm'];
const CLASSES_ABA_INATIVA = ['text-emerald-200', 'hover:text-white', 'hover:bg-emerald-800/50'];

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
  document.getElementById('userCourse').innerHTML =
    'Coordenador <i class="fa-solid fa-chevron-down text-[9px]"></i>';

  // não permite cadastrar vaga no passado
  const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  document.getElementById('vagaData').min = hoje;
  document.getElementById('vagaAgendInicio').min = hoje;
  document.getElementById('vagaAgendFim').min = hoje;

  carregarCursos();
  carregarNotas();
  carregarAuditoria();
  carregarUsuarios();

  // ----- lista de usuários -----
  let esperaBusca;
  document.getElementById('buscaUsuario').addEventListener('input', () => {
    clearTimeout(esperaBusca);
    esperaBusca = setTimeout(carregarUsuarios, 300);
  });

  document.getElementById('listaUsuarios').addEventListener('click', (e) => {
    const botao = e.target.closest('[data-usuario-acao]');
    if (!botao) return;
    const id = Number(botao.dataset.id);

    if (botao.dataset.usuarioAcao === 'foto') {
      usuarioFotoId = id;
      document.getElementById('inputFotoUsuario').click();
    } else if (botao.dataset.usuarioAcao === 'polo') {
      definirPolo(id, botao.dataset.nome, botao.dataset.polo);
    } else {
      alterarStatusUsuario(id, botao.dataset.usuarioAcao === 'reativar', botao.dataset.nome);
    }
  });

  // troca de foto de um aluno já cadastrado
  document.getElementById('inputFotoUsuario').addEventListener('change', async (e) => {
    const arquivo = e.target.files[0];
    e.target.value = '';
    if (!arquivo || !usuarioFotoId) return;
    await enviarNovaFoto(usuarioFotoId, arquivo);
  });

  // tabela de notas
  document.querySelector('#page-sincronizacao tbody').addEventListener('click', (e) => {
    const botao = e.target.closest('[data-salvar-nota]');
    if (botao) salvarNota(Number(botao.dataset.salvarNota), botao);
  });

  // ----- formulário de cadastro: foto só para aluno -----
  // a lista de polos é a mesma do formulário de vagas (uma única fonte)
  document.getElementById('novoPolo').innerHTML =
    '<option value="">Selecione o polo...</option>' + document.getElementById('vagaPolo').innerHTML;
  document.getElementById('novoTipo').addEventListener('change', () => { alternarCampoFoto(); alternarCampoPolo(); });
  alternarCampoFoto();
  alternarCampoPolo();

  document.getElementById('inputFoto').addEventListener('change', async (e) => {
    const arquivo = e.target.files[0];
    if (!arquivo) { limparFotoCadastro(); return; }
    try {
      fotoCadastro = await redimensionarImagem(arquivo);
      const prev = document.getElementById('previewFoto');
      prev.src = fotoCadastro;
      prev.classList.remove('hidden');
      document.getElementById('placeholderFoto').classList.add('hidden');
    } catch (erro) {
      limparFotoCadastro();
      Swal.fire({ title: 'Foto inválida', text: erro.message, icon: 'warning', confirmButtonColor: '#047857' });
    }
  });

  document.getElementById('formVaga').addEventListener('submit', enviarVaga);
  document.getElementById('formCadastrarUsuario').addEventListener('submit', enviarUsuario);
});

// ==========================================
// CURSOS
// ==========================================
async function carregarCursos() {
  try {
    const { ok, dados } = await apiFetch('/api/cursos');
    if (!ok || !Array.isArray(dados)) throw new Error(dados?.mensagem || 'Falha ao carregar cursos');

    const select = document.getElementById('vagaCurso');
    const atual = select.value;
    select.innerHTML = dados.length
      ? '<option value="">Selecione o curso...</option>' + dados.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')
      : '<option value="">Nenhum curso cadastrado (cadastre um aluno primeiro)</option>';
    if (atual && dados.includes(atual)) select.value = atual;

    document.getElementById('listaCursos').innerHTML = dados.map((c) => `<option value="${escapeHtml(c)}"></option>`).join('');
  } catch (e) {
    console.error('Erro ao carregar cursos:', e);
    document.getElementById('vagaCurso').innerHTML = '<option value="">Erro ao carregar cursos</option>';
  }
}

// ==========================================
// VAGAS
// ==========================================
async function enviarVaga(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const botao = e.submitter;

  const inicio = document.getElementById('vagaHorarioInicio').value;
  const fim = document.getElementById('vagaHorarioFim').value;
  if (fim <= inicio) {
    Swal.fire({ title: 'Horário inválido', text: 'O fim da prova deve ser depois do início.', icon: 'warning', confirmButtonColor: '#047857' });
    return;
  }

  const dataProva = document.getElementById('vagaData').value;
  const agInicio = document.getElementById('vagaAgendInicio').value;
  const agFim = document.getElementById('vagaAgendFim').value;
  if (agFim < agInicio) {
    Swal.fire({ title: 'Período inválido', text: 'O fim do agendamento deve ser igual ou depois do início.', icon: 'warning', confirmButtonColor: '#047857' });
    return;
  }
  if (agFim > dataProva) {
    Swal.fire({ title: 'Período inválido', text: 'O agendamento deve terminar até a data da prova.', icon: 'warning', confirmButtonColor: '#047857' });
    return;
  }

  const corpo = {
    polo: document.getElementById('vagaPolo').value,
    curso: document.getElementById('vagaCurso').value,
    disciplina: document.getElementById('vagaDisciplina').value.trim(),
    data: document.getElementById('vagaData').value,
    horario_inicio: inicio,
    horario_fim: fim,
    agendamento_inicio: agInicio,
    agendamento_fim: agFim,
    limite_vagas: Number(document.getElementById('vagaLimite').value)
  };

  if (botao) botao.disabled = true;
  try {
    const { ok, dados } = await apiFetch('/api/cadastrar-vaga', { method: 'POST', body: JSON.stringify(corpo) });

    if (ok && dados?.sucesso) {
      Swal.fire({ title: 'Sucesso!', text: dados.mensagem, icon: 'success', confirmButtonColor: '#047857' });
      form.reset();
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
// CADASTRO DE USUÁRIO
// ==========================================
function alternarCampoFoto() {
  const ehAluno = document.getElementById('novoTipo').value === 'Aluno';
  document.getElementById('blocoFoto').classList.toggle('hidden', !ehAluno);
  if (!ehAluno) limparFotoCadastro();
}

// o polo só aparece (e só é obrigatório) para recepção do polo
function alternarCampoPolo() {
  const ehRecepcao = document.getElementById('novoTipo').value === 'Recepção do Polo';
  document.getElementById('blocoPolo').classList.toggle('hidden', !ehRecepcao);
  document.getElementById('novoPolo').required = ehRecepcao;
  if (!ehRecepcao) document.getElementById('novoPolo').value = '';
}

function limparFotoCadastro() {
  fotoCadastro = null;
  document.getElementById('inputFoto').value = '';
  const prev = document.getElementById('previewFoto');
  prev.removeAttribute('src');
  prev.classList.add('hidden');
  document.getElementById('placeholderFoto').classList.remove('hidden');
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

  const tipo = document.getElementById('novoTipo').value;
  const corpo = {
    nome: document.getElementById('novoNome').value.trim(),
    email: document.getElementById('novoEmail').value.trim(),
    curso: document.getElementById('novoCurso').value.trim(),
    tipo
  };
  if (tipo === 'Aluno' && fotoCadastro) corpo.foto = fotoCadastro;
  if (tipo === 'Recepção do Polo') corpo.polo = document.getElementById('novoPolo').value;

  if (botao) {
    botao.disabled = true;
    botao.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Cadastrando e enviando e-mail...';
  }

  try {
    const { ok, dados } = await apiFetch('/api/cadastrar-usuario', { method: 'POST', body: JSON.stringify(corpo) });

    if (ok && dados?.sucesso) {
      Swal.fire({ title: 'Usuário cadastrado!', text: dados.mensagem, icon: 'success', confirmButtonColor: '#047857' });
      form.reset();
      limparFotoCadastro();
      alternarCampoFoto();
      alternarCampoPolo();
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
// USUÁRIOS (listar, foto, excluir e reativar)
// ==========================================
async function carregarUsuarios() {
  const container = document.getElementById('listaUsuarios');
  if (!container) return;

  const busca = document.getElementById('buscaUsuario').value.trim();
  const minhaMatricula = localStorage.getItem('usuario_matricula');

  try {
    const { ok, dados } = await apiFetch(`/api/usuarios?busca=${encodeURIComponent(busca)}`);
    if (!ok || !Array.isArray(dados)) throw new Error(dados?.mensagem || 'Falha ao carregar usuários');

    if (dados.length === 0) {
      container.innerHTML = '<p class="text-center text-slate-400 text-sm py-4">Nenhum usuário encontrado.</p>';
      return;
    }

    container.innerHTML = dados.map((u) => {
      const ehVoce = u.matricula === minhaMatricula;
      const ehAluno = String(u.tipo || '').trim().toLowerCase() === 'aluno';
      const ehRecepcao = String(u.tipo || '').trim().toLowerCase() === 'recepção do polo';
      const foto = urlSegura(u.foto_url);

      const avatar = foto
        ? `<img src="${escapeHtml(foto)}" alt="" class="w-10 h-10 rounded-full object-cover border border-slate-300 shrink-0">`
        : `<div class="w-10 h-10 rounded-full bg-slate-200 text-slate-600 flex items-center justify-center text-sm font-bold shrink-0">${escapeHtml((u.nome || '?').charAt(0).toUpperCase())}</div>`;

      let acoes = '';
      if (u.ativo && ehAluno) {
        acoes += `<button data-usuario-acao="foto" data-id="${Number(u.id)}"
                    class="bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 font-medium px-3 py-1.5 rounded-lg text-xs transition flex items-center gap-1.5 cursor-pointer">
                    <i class="fa-solid fa-camera"></i> ${foto ? 'Trocar foto' : 'Foto'}</button>`;
      }
      if (u.ativo && ehRecepcao) {
        acoes += `<button data-usuario-acao="polo" data-id="${Number(u.id)}" data-nome="${escapeHtml(u.nome)}" data-polo="${escapeHtml(u.polo || '')}"
                    class="bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 font-medium px-3 py-1.5 rounded-lg text-xs transition flex items-center gap-1.5 cursor-pointer">
                    <i class="fa-solid fa-location-dot"></i> ${u.polo ? 'Trocar polo' : 'Definir polo'}</button>`;
      }
      if (ehVoce) {
        acoes += '<span class="text-xs text-slate-400">(você)</span>';
      } else if (u.ativo) {
        acoes += `<button data-usuario-acao="excluir" data-id="${Number(u.id)}" data-nome="${escapeHtml(u.nome)}"
                    class="bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 font-medium px-3 py-1.5 rounded-lg text-xs transition flex items-center gap-1.5 cursor-pointer">
                    <i class="fa-solid fa-user-xmark"></i> Excluir</button>`;
      } else {
        acoes += `<button data-usuario-acao="reativar" data-id="${Number(u.id)}" data-nome="${escapeHtml(u.nome)}"
                    class="bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 font-medium px-3 py-1.5 rounded-lg text-xs transition flex items-center gap-1.5 cursor-pointer">
                    <i class="fa-solid fa-user-check"></i> Reativar</button>`;
      }

      return `
        <div class="flex items-center justify-between gap-3 p-3 rounded-xl border ${u.ativo ? 'bg-slate-50 border-slate-200' : 'bg-slate-100 border-slate-200 opacity-70'}">
          <div class="flex items-center gap-3 min-w-0">
            ${avatar}
            <div class="min-w-0">
              <p class="text-sm font-semibold text-slate-900 truncate">${escapeHtml(u.nome)}
                ${u.ativo ? '' : '<span class="ml-1 text-[10px] font-bold uppercase bg-slate-300 text-slate-700 px-2 py-0.5 rounded-full">Excluído</span>'}</p>
              <p class="text-xs text-slate-500 truncate"><span class="font-mono">${escapeHtml(u.matricula)}</span> · ${escapeHtml(u.tipo)} · ${escapeHtml(u.curso)}${u.polo ? ` · ${escapeHtml(u.polo)}` : ''}</p>
            </div>
          </div>
          <div class="shrink-0 flex flex-col sm:flex-row items-end sm:items-center gap-2">${acoes}</div>
        </div>`;
    }).join('');
  } catch (e) {
    console.error('Erro ao carregar usuários:', e);
    container.innerHTML = '<p class="text-center text-red-500 text-sm py-4">Erro ao carregar os usuários do servidor.</p>';
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
  const valor = document.getElementById(`nota-${id}`).value;
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
async function carregarAuditoria() {
  try {
    const { ok, dados } = await apiFetch('/api/auditoria');
    if (!ok || !Array.isArray(dados)) throw new Error(dados?.mensagem || 'Falha ao carregar auditoria');
    logsGlobais = dados;
    filtrarAuditoria();
  } catch (e) {
    console.error('Erro ao carregar auditoria:', e);
  }
}

function renderizarLogs(lista) {
  const container = document.getElementById('lista-logs-auditoria');
  if (!container) return;

  if (lista.length === 0) {
    container.innerHTML = '<p class="text-slate-400 text-center py-4">Nenhum log encontrado com os filtros selecionados.</p>';
    return;
  }

  container.innerHTML = lista.map((log) => {
    const alerta = /SOFT_DELETE|CANCEL|BLOQUEADO|FALHA/.test(log.acao);
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

function filtrarAuditoria() {
  const texto = document.getElementById('filtroUsuario').value.trim().toLowerCase();
  const acao = document.getElementById('filtroAcao').value;

  renderizarLogs(logsGlobais.filter((log) => {
    const alvo = `${log.usuario || ''} ${log.descricao || ''} ${log.id}`.toLowerCase();
    return alvo.includes(texto) && (acao === '' || log.acao === acao);
  }));
}

// ==========================================
// ABAS
// ==========================================
function switchTab(tabId, botao) {
  document.querySelectorAll('.page-content').forEach((p) => p.classList.add('hidden'));

  document.querySelectorAll('.tab-btn').forEach((b) => {
    b.classList.remove(...CLASSES_ABA_ATIVA);
    b.classList.add(...CLASSES_ABA_INATIVA);
  });

  document.getElementById(`page-${tabId}`).classList.remove('hidden');
  botao.classList.remove(...CLASSES_ABA_INATIVA);
  botao.classList.add(...CLASSES_ABA_ATIVA);

  if (tabId === 'auditoria') carregarAuditoria();
  if (tabId === 'sincronizacao') carregarNotas();
  if (tabId === 'usuarios') carregarUsuarios();
  if (tabId === 'oferta') carregarCursos();
}
