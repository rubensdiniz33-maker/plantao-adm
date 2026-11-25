// Preferências do usuário neste navegador (localStorage): ordem de navegação dos setores e formatação do relatório.
// A ordem do RELATÓRIO final nunca muda: a preferência vale só para a navegação (painel, seletor, Próximo/Anterior).
import { SECTORS } from './sectors.js';
import { normalizeFormat, FORMAT_VERSION } from './report.js';

const KEY = 'plantao-adm:prefs';
let mem = {}; // se o localStorage falhar, a preferência vale ao menos na sessão

function read() {
  try {
    const t = localStorage.getItem(KEY);
    if (t) {
      const p = JSON.parse(t);
      if (p && typeof p === 'object') {
        // Padrão de formatação mudou: descarta a formatação antiga salva (a ordem dos setores é mantida).
        if (p.formatVersion !== FORMAT_VERSION) { delete p.format; p.formatVersion = FORMAT_VERSION; try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ok */ } }
        mem = p; return p;
      }
    }
  } catch { /* usa memória */ }
  return mem;
}
function write(p) {
  p = { ...p, formatVersion: FORMAT_VERSION };
  mem = p;
  try { localStorage.setItem(KEY, JSON.stringify(p)); return true; } catch { return false; }
}

export function getOrder() {
  const ids = SECTORS.map((s) => s.id);
  const raw = read().order;
  if (!Array.isArray(raw)) return ids;
  const out = [];
  for (const id of raw) if (ids.includes(id) && !out.includes(id)) out.push(id);
  for (const id of ids) if (!out.includes(id)) out.push(id);
  return out;
}
export function orderedSectors() {
  const by = Object.fromEntries(SECTORS.map((s) => [s.id, s]));
  return getOrder().map((id) => by[id]);
}
export const isCustomOrder = () => getOrder().some((id, i) => id !== SECTORS[i].id);
export function setOrder(ids) { return write({ ...read(), order: ids }); }
export function resetOrder() { const p = { ...read() }; delete p.order; return write(p); }

export const getFormat = () => normalizeFormat(read().format);
export function setFormat(f) { return write({ ...read(), format: normalizeFormat(f) }); }
export function resetFormat() { const p = { ...read() }; delete p.format; return write(p); }
