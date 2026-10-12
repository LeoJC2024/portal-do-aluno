// Utilitários compartilhados por todas as telas.
// Para trocar o endereço do backend, defina window.API_URL antes de carregar este arquivo.
const API_URL = window.API_URL || 'http://localhost:3000';

const CHAVES_SESSAO = [
  'unifaa_token', 'usuario_nome', 'usuario_curso',
  'usuario_tipo', 'usuario_perfil', 'usuario_matricula'
];

const ROTAS_POR_PERFIL = {
  'aluno': 'alunoHome.html',
  'coordenador': 'coordenadorHome.html',
  'recepção do polo': 'recepcaoHome.html',
  'audit': 'auditHome.html'
};

// ---------- segurança de HTML ----------
function escapeHtml(valor) {
  return String(valor ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// só aceita http(s) em atributos src/href vindos do banco
function urlSegura(url) {
  const u = String(url ?? '').trim();
  return /^https?:\/\//i.test(u) ? u : '';
}

// ---------- formatação ----------
function formatarDataBr(iso) {
  if (!iso) return '';
  const [ano, mes, dia] = String(iso).slice(0, 10).split('-');
  return `${dia}/${mes}/${ano}`;
}

function formatarHora(h) {
  return String(h ?? '').slice(0, 5);
}

// "08:00 – 10:00" (ou só o início, para vagas antigas sem horário de fim)
function faixaHorario(inicio, fim) {
  const i = formatarHora(inicio);
  const f = formatarHora(fim);
  return f ? `${i} – ${f}` : i;
}

function formatarDataHoraBr(valor) {
  if (!valor) return '';
  return new Date(valor).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

// ---------- sessão ----------
function limparSessao() {
  CHAVES_SESSAO.forEach((k) => localStorage.removeItem(k));
}

function irParaLogin() {
  window.location.href = 'login.html';
}

function salvarSessao(dados) {
  localStorage.setItem('unifaa_token', dados.token);
  localStorage.setItem('usuario_nome', dados.nome || '');
  localStorage.setItem('usuario_curso', dados.curso || '');
  localStorage.setItem('usuario_tipo', dados.tipo || '');
  localStorage.setItem('usuario_perfil', dados.perfil || '');
  localStorage.setItem('usuario_matricula', dados.matricula || '');
}

// Retorna true se o perfil logado pode ver a página.
// Atenção: isto é só experiência de uso. Quem protege os dados é o backend (JWT + perfil).
function exigirPerfil(perfisPermitidos) {
  const token = localStorage.getItem('unifaa_token');
  const perfil = localStorage.getItem('usuario_perfil');

  if (token && perfisPermitidos.includes(perfil)) return true;

  const semLogin = !token;
  Swal.fire({
    title: 'Acesso Negado',
    text: semLogin ? 'Faça login para acessar o painel.' : 'Seu perfil não tem acesso a esta página.',
    icon: 'warning',
    confirmButtonColor: '#047857'
  }).then(() => {
    if (semLogin || !ROTAS_POR_PERFIL[perfil]) irParaLogin();
    else window.location.href = ROTAS_POR_PERFIL[perfil];
  });
  return false;
}

// ---------- chamadas à API ----------
async function apiFetch(caminho, opcoes = {}) {
  const headers = { ...(opcoes.headers || {}) };
  if (opcoes.body) headers['Content-Type'] = 'application/json';

  const token = localStorage.getItem('unifaa_token');
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const resposta = await fetch(API_URL + caminho, { ...opcoes, headers });

  let dados = null;
  try { dados = await resposta.json(); } catch (_) { /* resposta sem JSON */ }

  if (resposta.status === 401 && caminho !== '/api/login') {
    limparSessao();
    await Swal.fire({
      title: 'Sessão expirada',
      text: 'Faça login novamente.',
      icon: 'info',
      confirmButtonColor: '#047857'
    });
    irParaLogin();
    return new Promise(() => {}); // interrompe quem chamou enquanto redireciona
  }

  return { ok: resposta.ok, status: resposta.status, dados };
}

// ---------- menu do usuário ----------
function toggleMenu(event) {
  event.stopPropagation();
  const dropdown = document.getElementById('userDropdown');
  if (dropdown) dropdown.classList.toggle('hidden');
}

window.addEventListener('click', () => {
  const dropdown = document.getElementById('userDropdown');
  if (dropdown && !dropdown.classList.contains('hidden')) dropdown.classList.add('hidden');
});

function sairDaConta() {
  const sistema = document.body.dataset.sistema || 'sistema';
  Swal.fire({
    title: 'Deseja sair?',
    text: `Será desconectado do ${sistema}.`,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: '#047857',
    cancelButtonColor: '#d33',
    confirmButtonText: 'Sim, sair',
    cancelButtonText: 'Cancelar'
  }).then((r) => {
    if (r.isConfirmed) {
      limparSessao();
      irParaLogin();
    }
  });
}

// ---------- auditoria (filtros e paginação no servidor; usados pelo auditor e pela coordenação) ----------
// monta a query string só com os filtros preenchidos
function queryAuditoria(filtros, pagina) {
  const params = new URLSearchParams({ page: String(pagina) });
  Object.entries(filtros).forEach(([chave, valor]) => {
    const v = String(valor ?? '').trim();
    if (v) params.set(chave, v);
  });
  return params.toString();
}

// atualiza "Página X de Y", o total e os botões Anterior / Próxima
function atualizarPaginacaoAuditoria(dados) {
  const pagina = Number(dados?.pagina) || 1;
  const totalPaginas = Math.max(1, Number(dados?.totalPaginas) || 1);
  const total = Number(dados?.total) || 0;
  setTexto('auditoriaPaginaInfo', `Página ${pagina} de ${totalPaginas}`);
  setTexto('auditoriaTotal', `${total.toLocaleString('pt-BR')} registro${total === 1 ? '' : 's'}`);
  const anterior = document.getElementById('auditoriaAnterior');
  const proxima = document.getElementById('auditoriaProxima');
  if (anterior) anterior.disabled = pagina <= 1;
  if (proxima) proxima.disabled = pagina >= totalPaginas;
}

// em erro, trava a navegação (a página exibida não corresponde mais aos filtros)
function desativarPaginacaoAuditoria() {
  ['auditoriaAnterior', 'auditoriaProxima'].forEach((id) => {
    const botao = document.getElementById(id);
    if (botao) botao.disabled = true;
  });
}

function setTexto(id, texto) {
  const el = document.getElementById(id);
  if (el) el.textContent = texto;
}
