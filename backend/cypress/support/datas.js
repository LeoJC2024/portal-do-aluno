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

export const dataBr = (iso) => iso.split('-').reverse().join('/');
