// Regras de validação: plantão, respostas e arquivos de backup.
import { SECTORS, SECTOR_BY_ID, NA, MAX_TEXT, MAX_NUM_DIGITS } from './sectors.js';

export const APP_ID = 'plantao-control';
export const SCHEMA = 1;
export const MAX_ACTIVITY = 500;
export const MAX_BACKUP_BYTES = 10 * 1024 * 1024;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && y >= 2000 && y <= 2100;
}
export const isValidTime = (s) => typeof s === 'string' && TIME_RE.test(s);
const isIso = (s) => typeof s === 'string' && !Number.isNaN(Date.parse(s));

export function cleanName(n) {
  return String(n ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

// Erros de identificação do plantão (usado ao criar e ao editar)
export function validateIdentification(d) {
  const e = {};
  if (d.type !== 'MT' && d.type !== 'N') e.type = 'Selecione o tipo de plantão.';
  if (!isValidDate(d.date)) e.date = 'Informe uma data válida.';
  if (!isValidTime(d.start)) e.start = 'Informe o horário de início.';
  if (!isValidTime(d.end)) e.end = 'Informe o horário de término.';
  if (!(d.nurses || []).some((n) => cleanName(n))) e.nurses = 'Informe pelo menos um enfermeiro responsável.';
  return e;
}

function cleanAnswerValue(field, v) {
  if (typeof v !== 'string') return undefined;
  if (v === NA) return NA;
  if (field.type === 'yn') return v === 'sim' || v === 'nao' ? v : undefined;
  if (field.type === 'num') {
    return new RegExp(`^\\d{1,${MAX_NUM_DIGITS}}$`).test(v) ? v : undefined;
  }
  const t = v.trim().slice(0, MAX_TEXT);
  return t === '' ? undefined : t;
}

export function sanitizeAnswers(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const s of SECTORS) {
    const src = raw[s.id];
    if (!src || typeof src !== 'object') continue;
    const dst = {};
    for (const f of s.fields) {
      const v = cleanAnswerValue(f, src[f.id]);
      if (v !== undefined) dst[f.id] = v;
    }
    if (Object.keys(dst).length) out[s.id] = dst;
  }
  return out;
}

// Normaliza e valida um plantão vindo do disco ou de backup. Lança Error se inválido.
export function normalizeShift(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('registro inválido');
  if (typeof raw.id !== 'string' || !/^[\w-]{8,64}$/.test(raw.id)) throw new Error('identificador inválido');
  if (raw.type !== 'MT' && raw.type !== 'N') throw new Error('tipo de plantão inválido');
  if (!isValidDate(raw.date)) throw new Error('data inválida');
  if (!isValidTime(raw.start) || !isValidTime(raw.end)) throw new Error('horário inválido');
  if (!Array.isArray(raw.nurses)) throw new Error('lista de enfermeiros inválida');
  const nurses = raw.nurses.map(cleanName).filter(Boolean).slice(0, 20);
  if (!nurses.length) throw new Error('nenhum enfermeiro informado');
  const status = raw.status === 'finalizado' ? 'finalizado' : 'em_andamento';
  const now = new Date().toISOString();
  const sectorMeta = {};
  for (const s of SECTORS) {
    const m = raw.sectorMeta?.[s.id];
    if (m && typeof m === 'object') {
      sectorMeta[s.id] = {
        firstAt: isIso(m.firstAt) ? m.firstAt : null,
        doneAt: isIso(m.doneAt) ? m.doneAt : null,
        carried: m.carried === true,
      };
    }
  }
  const activity = (Array.isArray(raw.activity) ? raw.activity : [])
    .filter((a) => a && isIso(a.t) && typeof a.text === 'string')
    .slice(-MAX_ACTIVITY)
    .map((a) => ({
      t: a.t,
      type: typeof a.type === 'string' ? a.type.slice(0, 20) : 'info',
      text: a.text.slice(0, 300),
      ...(typeof a.sector === 'string' && SECTOR_BY_ID[a.sector] ? { sector: a.sector } : {}),
      ...(typeof a.by === 'string' && cleanName(a.by) ? { by: cleanName(a.by) } : {}),
    }));
  return {
    id: raw.id,
    schema: SCHEMA,
    type: raw.type,
    date: raw.date,
    start: raw.start,
    end: raw.end,
    nurses,
    status,
    carriedFrom: typeof raw.carriedFrom === 'string' && /^[\w-]{8,64}$/.test(raw.carriedFrom) ? raw.carriedFrom : null,
    createdAt: isIso(raw.createdAt) ? raw.createdAt : now,
    updatedAt: isIso(raw.updatedAt) ? raw.updatedAt : now,
    finalizedAt: status === 'finalizado' && isIso(raw.finalizedAt) ? raw.finalizedAt : null,
    finalizedBy: status === 'finalizado' && typeof raw.finalizedBy === 'string' ? cleanName(raw.finalizedBy) : null,
    answers: sanitizeAnswers(raw.answers),
    sectorMeta,
    reportEdit: raw.reportEdit && typeof raw.reportEdit.text === 'string' && raw.reportEdit.text.trim()
      ? { text: raw.reportEdit.text.slice(0, 20000), base: typeof raw.reportEdit.base === 'string' ? raw.reportEdit.base.slice(0, 20000) : '' }
      : null,
    activity,
  };
}

// Valida o texto de um arquivo de backup. Retorna { shifts, rejected } ou lança Error.
export function parseBackup(textContent) {
  if (typeof textContent !== 'string' || textContent.length === 0) throw new Error('O arquivo está vazio.');
  if (textContent.length > MAX_BACKUP_BYTES) throw new Error('O arquivo é grande demais para ser um backup válido.');
  let data;
  try {
    data = JSON.parse(textContent);
  } catch {
    throw new Error('O arquivo não é um backup válido (JSON corrompido).');
  }
  if (!data || typeof data !== 'object' || data.app !== APP_ID) throw new Error('Este arquivo não é um backup do Plantão ADM.');
  if (data.schema !== SCHEMA) throw new Error('Versão de backup não suportada.');
  if (!Array.isArray(data.shifts)) throw new Error('O backup não contém a lista de plantões.');
  const shifts = [];
  let rejected = 0;
  const seen = new Set();
  for (const r of data.shifts) {
    try {
      const s = normalizeShift(r);
      if (seen.has(s.id)) { rejected++; continue; }
      seen.add(s.id);
      shifts.push(s);
    } catch {
      rejected++;
    }
  }
  if (!shifts.length) throw new Error('Nenhum plantão válido foi encontrado no arquivo.');
  return { shifts, rejected };
}

export function buildBackup(shifts) {
  return JSON.stringify({ app: APP_ID, schema: SCHEMA, exportedAt: new Date().toISOString(), shifts }, null, 1);
}
