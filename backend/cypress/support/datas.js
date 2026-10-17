// Datas e horários no fuso de São Paulo (o mesmo usado pelo servidor).
const FUSO = 'America/Sao_Paulo';

function partes(ms) {
  const [data, hora] = new Date(ms).toLocaleString('sv-SE', { timeZone: FUSO }).split(' ');
  return { data, hora: hora.slice(0, 5) };
}

export const hojeSP = () => partes(Date.now()).data;

// data daqui a N dias (YYYY-MM-DD)
export const dataSP = (dias) => partes(Date.now() + dias * 86400000).data;

// vaga que começa daqui a "horas" horas (sempre menos de 24h) com fim 30 min depois, no mesmo dia
export function vagaEmHoras(horas) {
  let alvo = Date.now() + horas * 3600000;
  if (partes(alvo).hora >= '23:30') alvo += 3600000; // evita atravessar a meia-noite com o fim da prova
  const { data, hora } = partes(alvo);
  const fim = partes(alvo + 30 * 60000).hora;
  return { data, inicio: hora, fim };
}

// vaga para HOJE com início ainda no futuro: agora + 2h, fim 30 min depois.
// Se agora + 2h cair depois das 23:00 (ou já em amanhã), usa o horário mais tarde do dia: 23:58 às 23:59.
// A partir das 23:50 devolve null: não há folga segura para a vaga ser "de hoje e no futuro"
// quando chegar ao servidor (quem chamar deve pular o teste de forma explícita).
export function vagaHojeNoFuturo() {
  const agora = partes(Date.now());
  if (agora.hora >= '23:50') return null;
  const alvo = Date.now() + 2 * 3600000;
  const p = partes(alvo);
  if (p.data === agora.data && p.hora < '23:00') {
    return { data: agora.data, inicio: p.hora, fim: partes(alvo + 30 * 60000).hora };
  }
  return { data: agora.data, inicio: '23:58', fim: '23:59' };
}

// prova de HOJE em andamento: começou há 1h (ou à 00:00) e termina daqui a 1h (ou às 23:59).
// Antes das 00:05 e a partir das 23:55 devolve null (sem folga segura; quem chamar pula o teste)
export function vagaEmAndamento() {
  const agora = partes(Date.now());
  if (agora.hora < '00:05' || agora.hora >= '23:55') return null;
  const ini = partes(Date.now() - 3600000);
  const fim = partes(Date.now() + 3600000);
  return {
    data: agora.data,
    inicio: ini.data === agora.data ? ini.hora : '00:00',
    fim: fim.data === agora.data ? fim.hora : '23:59'
  };
}

// prova de HOJE que já terminou: termina 5 min atrás e começa 1h antes disso (ou à 00:00).
// Antes das 00:10 devolve null (não há prova de hoje que já tenha terminado com folga)
export function vagaHojeTerminada() {
  const agora = partes(Date.now());
  if (agora.hora < '00:10') return null;
  const ini = partes(Date.now() - 65 * 60000);
  return {
    data: agora.data,
    inicio: ini.data === agora.data ? ini.hora : '00:00',
    fim: partes(Date.now() - 5 * 60000).hora
  };
}

export const dataBr = (iso) => iso.split('-').reverse().join('/');
