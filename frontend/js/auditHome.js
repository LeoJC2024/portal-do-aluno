document.addEventListener('DOMContentLoaded', () => {
  if (!exigirPerfil(['audit'])) return;

  const nome = localStorage.getItem('usuario_nome') || 'Auditoria';
  const matricula = localStorage.getItem('usuario_matricula') || '';
  const inicial = (nome.trim().split(' ')[0] || 'A').charAt(0).toUpperCase();
  setTexto('userName', nome);
  setTexto('userAvatar', inicial);
  setTexto('tituloAvatar', inicial);
  setTexto('tituloNome', nome);
  setTexto('tituloMatricula', `Matrícula ${matricula}`);

  carregarDadosAuditoria();

  // filtros e busca são aplicados no servidor; qualquer mudança volta para a página 1
  let espera;
  const aoDigitar = () => {
    clearTimeout(espera);
    espera = setTimeout(() => carregarDadosAuditoria(1), 400);
  };
  ['searchInput', 'filtroIp'].forEach((id) => document.getElementById(id)?.addEventListener('input', aoDigitar));
  ['filtroDataInicio', 'filtroDataFim', 'filtroAcao'].forEach((id) =>
    document.getElementById(id)?.addEventListener('change', () => carregarDadosAuditoria(1)));

  document.getElementById('btnLimparFiltros')?.addEventListener('click', () => {
    ['searchInput', 'filtroDataInicio', 'filtroDataFim', 'filtroIp', 'filtroAcao'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    clearTimeout(espera);
    carregarDadosAuditoria(1);
  });

  document.getElementById('auditoriaAnterior')?.addEventListener('click', () => carregarDadosAuditoria(paginaAuditoria - 1));
  document.getElementById('auditoriaProxima')?.addEventListener('click', () => carregarDadosAuditoria(paginaAuditoria + 1));
});

let paginaAuditoria = 1;
let ultimaRequisicaoAuditoria = 0; // descarta respostas antigas que chegarem fora de ordem

function filtrosAuditoria() {
  const valor = (id) => document.getElementById(id)?.value ?? '';
  return {
    busca: valor('searchInput'),
    data_inicio: valor('filtroDataInicio'),
    data_fim: valor('filtroDataFim'),
    ip: valor('filtroIp'),
    acao: valor('filtroAcao')
  };
}

function definirStatusBanco(ok) {
  const ponto = document.getElementById('dbStatusDot');
  const texto = document.getElementById('dbStatusTexto');
  if (!ponto || !texto) return;

  ponto.classList.remove('bg-slate-500', 'bg-emerald-500', 'bg-rose-500');
  ponto.classList.add(ok ? 'bg-emerald-500' : 'bg-rose-500');
  texto.textContent = ok ? 'Banco de dados: conectado' : 'Banco de dados: fora do ar';
}

// em erro, o rodapé não mostra mais o total/página da busca anterior e a navegação fica travada
// até a próxima busca bem-sucedida
function limparRodapeAuditoria() {
  setTexto('auditoriaTotal', '—');
  setTexto('auditoriaPaginaInfo', '—');
  desativarPaginacaoAuditoria();
}

function classificarAcao(acao) {
  const a = String(acao || '').toUpperCase();

  // BLOQUEADO precisa ser testado antes de CANCEL (CANCELAMENTO_BLOQUEADO contém os dois);
  // RECUSADO antes de INATIV (LOGIN_RECUSADO_CONTA_INATIVA é login recusado, não inativação)
  if (/REJECT|BLOQUEADO|FALHA|RECUSADO/.test(a)) {
    let statusTexto = 'BLOQUEADO';
    if (a.includes('FALHA')) statusTexto = 'FALHA';
    else if (a.includes('RECUSADO')) statusTexto = 'RECUSADO';
    return {
      acaoClass: 'text-rose-400 font-bold',
      badgeClass: 'bg-rose-950/80 text-rose-300 border border-rose-800/60',
      statusTexto
    };
  }
  // exclusão de usuário (soft delete): o registro é de uma inativação, não de algo "ativo"
  if (a === 'SOFT_DELETE') {
    return {
      acaoClass: 'text-slate-300 font-bold',
      badgeClass: 'bg-slate-700/80 text-slate-200 border border-slate-500/60',
      statusTexto: 'INATIVADO'
    };
  }
  if (/CANCEL|INATIV/.test(a)) {
    return {
      acaoClass: 'text-amber-400 font-bold',
      badgeClass: 'bg-amber-950/80 text-amber-300 border border-amber-800/60',
      statusTexto: 'INATIVO'
    };
  }
  return {
    acaoClass: 'text-emerald-400 font-bold',
    badgeClass: 'bg-emerald-950/80 text-emerald-300 border border-emerald-800/60',
    statusTexto: 'ATIVO'
  };
}

async function carregarDadosAuditoria(pagina = paginaAuditoria) {
  const tbody = document.querySelector('#auditTable tbody');
  const filtros = filtrosAuditoria();
  const requisicao = ++ultimaRequisicaoAuditoria;

  try {
    const { ok, status, dados } = await apiFetch(`/api/admin/auditoria-completa?${queryAuditoria(filtros, pagina)}`);
    if (requisicao !== ultimaRequisicaoAuditoria) return;

    // filtro inválido (ex.: data inicial depois da final): o servidor respondeu, só avisa na tabela
    if (status === 400) {
      definirStatusBanco(true);
      tbody.innerHTML = `<tr><td colspan="6" class="px-4 py-4 text-center text-amber-400">${escapeHtml(dados?.mensagem || 'Filtro inválido.')}</td></tr>`;
      limparRodapeAuditoria();
      return;
    }
    if (!ok || !dados?.sucesso || !Array.isArray(dados.logs)) throw new Error(dados?.mensagem || 'Falha ao carregar auditoria');

    definirStatusBanco(true);
    paginaAuditoria = Number(dados.pagina) || 1;
    atualizarPaginacaoAuditoria(dados);

    setTexto('statTotalTransacoes', Number(dados.estatisticas.totalTransacoes).toLocaleString('pt-BR'));
    setTexto('statRegistrosInativos', Number(dados.estatisticas.registrosInativos).toLocaleString('pt-BR'));
    setTexto('statViolacoes', Number(dados.estatisticas.violacoes24h).toLocaleString('pt-BR'));

    if (dados.logs.length === 0) {
      const comFiltro = Object.values(filtros).some((v) => String(v).trim() !== '');
      const mensagem = comFiltro ? 'Nenhum log encontrado com os filtros selecionados.' : 'Nenhum log registrado até o momento.';
      tbody.innerHTML = `<tr><td colspan="6" class="px-4 py-4 text-center text-slate-500">${mensagem}</td></tr>`;
      return;
    }

    tbody.innerHTML = dados.logs.map((log) => {
      const { acaoClass, badgeClass, statusTexto } = classificarAcao(log.acao);
      return `
        <tr class="hover:bg-slate-700/50 transition">
          <td class="px-4 py-3 text-slate-400">${escapeHtml(formatarDataHoraBr(log.data_hora))}</td>
          <td class="px-4 py-3 font-semibold text-white"><div class="quebra-texto">${escapeHtml(log.usuario || 'sistema')}</div></td>
          <td class="px-4 py-3 ${acaoClass}">${escapeHtml(log.acao)}</td>
          <td class="px-4 py-3"><span class="${badgeClass} px-2 py-0.5 rounded">${statusTexto}</span></td>
          <td class="px-4 py-3 text-slate-400">${escapeHtml(log.ip || '—')}</td>
          <td class="px-4 py-3 text-slate-400"><div class="quebra-texto">${escapeHtml(log.descricao || 'N/A')}</div></td>
        </tr>`;
    }).join('');
  } catch (erro) {
    if (requisicao !== ultimaRequisicaoAuditoria) return;
    console.error('Erro ao conectar com o serviço de auditoria:', erro);
    definirStatusBanco(false);
    limparRodapeAuditoria();
    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="6" class="px-4 py-4 text-center text-rose-400">Erro ao carregar os logs do servidor.</td></tr>';
    }
  }
}
