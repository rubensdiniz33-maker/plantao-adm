// Sincronização opcional com o Supabase. O app continua funcionando offline: tudo é gravado primeiro no aparelho
// e enviado em segundo plano; se falhar, fica na fila e é reenviado depois.
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { normalizeShift } from './validation.js';

const KEY = 'plantao-adm:cloud';
const PENDING = 'plantao-adm:cloud-pending';
let memCode = '';
const remote = new Map(); // plantões vindos da nuvem usados só como base de "continuar do anterior"

export const available = () => !!(SUPABASE_URL && SUPABASE_KEY);

export function getCode() {
  try { const t = localStorage.getItem(KEY); if (t) { const c = JSON.parse(t)?.code; if (typeof c === 'string') return c; } } catch { /* memória */ }
  return memCode;
}
export const enabled = () => available() && !!getCode();
export function setCode(code) {
  memCode = code;
  try { localStorage.setItem(KEY, JSON.stringify({ code })); } catch { /* memória */ }
}
export function clearCode() {
  memCode = '';
  try { localStorage.removeItem(KEY); localStorage.removeItem(PENDING); } catch { /* ok */ }
  remote.clear();
}

const getPending = () => { try { const a = JSON.parse(localStorage.getItem(PENDING) || '[]'); return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []; } catch { return []; } };
const setPending = (ids) => { try { localStorage.setItem(PENDING, JSON.stringify([...new Set(ids)].slice(0, 200))); } catch { /* ok */ } };

async function rpc(fn, args, timeoutMs = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      body: JSON.stringify(args),
      signal: ctl.signal,
    });
    if (!res.ok) {
      let msg = '';
      try { msg = (await res.json())?.message || ''; } catch { /* sem corpo */ }
      const e = new Error(msg || `HTTP ${res.status}`);
      e.code = /codigo_invalido/.test(msg) ? 'bad_code' : 'http';
      throw e;
    }
    return await res.json();
  } finally { clearTimeout(t); }
}

// Valida um código e devolve o nome do hospital/grupo (lança erro se inválido ou sem internet).
export async function check(code) {
  return rpc('plantao_check', { p_code: code });
}

// Envia um plantão (em segundo plano). Falhou? Entra na fila para tentar de novo.
export async function push(shift) {
  if (!enabled()) return false;
  try {
    await rpc('plantao_push', { p_code: getCode(), p_shift: shift });
    setPending(getPending().filter((id) => id !== shift.id));
    return true;
  } catch (e) {
    if (e.code !== 'bad_code') setPending([...getPending(), shift.id]);
    return false;
  }
}

// Reenvia o que ficou na fila (chamar ao abrir o app e quando a internet voltar).
export async function flushPending(getShift) {
  if (!enabled()) return 0;
  let sent = 0;
  for (const id of getPending()) {
    const s = await getShift(id).catch(() => null);
    if (!s) { setPending(getPending().filter((x) => x !== id)); continue; }
    if (await push(s)) sent++; else break;
  }
  return sent;
}

// Plantões recentes da nuvem (validados). Retorna [] se offline/sem código.
export async function recent(limit = 20) {
  if (!enabled()) return [];
  try {
    const rows = await rpc('plantao_recent', { p_code: getCode(), p_limit: limit }, 4500);
    const out = [];
    for (const r of Array.isArray(rows) ? rows : []) { try { out.push(normalizeShift(r)); } catch { /* ignora inválido */ } }
    for (const s of out) remote.set(s.id, s);
    return out;
  } catch { return []; }
}

export const cached = (id) => remote.get(id);
