document.addEventListener('DOMContentLoaded', () => {
  if (!exigirPerfil(['audit'])) return;

  const nome = localStorage.getItem('usuario_nome') || 'Auditoria';
  setTexto('userName', nome);
  setTexto('userAvatar', nome.trim().slice(0, 2).toUpperCase() || 'AU');

  carregarDadosAuditoria();

  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      const termo = e.target.value.toLowerCase();
      document.querySelectorAll('#auditTable tbody tr').forEach((linha) => {
        linha.style.display = linha.textContent.toLowerCase().includes(termo) ? '' : 'none';
      });
    });
  }
});

function definirStatusBanco(ok) {
  const ponto = document.getElementById('dbStatusDot');
  const texto = document.getElementById('dbStatusTexto');
  if (!ponto || !texto) return;

  ponto.classList.remove('bg-slate-500', 'bg-emerald-500', 'bg-rose-500');
  ponto.classList.add(ok ? 'bg-emerald-500' : 'bg-rose-500');
  texto.textContent = ok ? 'DB Status: OK' : 'DB Status: ERRO';
}

function classificarAcao(acao) {
  const a = String(acao || '').toUpperCase();

  // BLOQUEADO precisa ser testado antes de CANCEL (CANCELAMENTO_BLOQUEADO contém os dois)
  if (/REJECT|BLOQUEADO|FALHA/.test(a)) {
    return {
      acaoClass: 'text-rose-400 font-bold',
      badgeClass: 'bg-rose-950/80 text-rose-300 border border-rose-800/60',
      statusTexto: a.includes('FALHA') ? 'FALHA' : 'BLOQUEADO'
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

async function carregarDadosAuditoria() {
  const tbody = document.querySelector('#auditTable tbody');

  try {
    const { ok, dados } = await apiFetch('/api/admin/auditoria-completa');
    if (!ok || !dados?.sucesso) throw new Error(dados?.mensagem || 'Falha ao carregar auditoria');

    definirStatusBanco(true);

    setTexto('statTotalTransacoes', Number(dados.estatisticas.totalTransacoes).toLocaleString('pt-BR'));
    setTexto('statRegistrosInativos', Number(dados.estatisticas.registrosInativos).toLocaleString('pt-BR'));
    setTexto('statViolacoes', Number(dados.estatisticas.violacoes24h).toLocaleString('pt-BR'));

    if (dados.logs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="px-4 py-4 text-center text-slate-500">Nenhum log registrado até o momento.</td></tr>';
      return;
    }

    tbody.innerHTML = dados.logs.map((log) => {
      const { acaoClass, badgeClass, statusTexto } = classificarAcao(log.acao);
      return `
        <tr class="hover:bg-slate-700/50 transition">
          <td class="px-4 py-3 text-slate-400">${escapeHtml(formatarDataHoraBr(log.data_hora))}</td>
          <td class="px-4 py-3 font-semibold text-white">${escapeHtml(log.usuario || 'sistema')}</td>
          <td class="px-4 py-3 ${acaoClass}">${escapeHtml(log.acao)}</td>
          <td class="px-4 py-3"><span class="${badgeClass} px-2 py-0.5 rounded">${statusTexto}</span></td>
          <td class="px-4 py-3 text-slate-400">${escapeHtml(log.ip || '—')}</td>
          <td class="px-4 py-3 text-slate-400">${escapeHtml(log.descricao || 'N/A')}</td>
        </tr>`;
    }).join('');
  } catch (erro) {
    console.error('Erro ao conectar com o serviço de auditoria:', erro);
    definirStatusBanco(false);
    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="6" class="px-4 py-4 text-center text-rose-400">Erro ao carregar os logs do servidor.</td></tr>';
    }
  }
}
