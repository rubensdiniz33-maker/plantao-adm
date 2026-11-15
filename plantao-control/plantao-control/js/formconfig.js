// Personalização do formulário (somente admin) e senha de acesso.
// ATENÇÃO: o app é 100% estático, então a senha é apenas uma TRAVA de uso (impede toques acidentais e
// uso casual); não é segurança forte — quem inspecionar o código consegue contorná-la.
// Para trocar a senha: ver README ("Trocar a senha do admin").
import { applyFormConfig, sanitizeFormConfig } from './sectors.js';

const SALT = 'plantao-adm|v1|';
export const ADMIN_HASH = '26simolwg19';
const KEY = 'plantao-adm:formconfig';

// Hash não criptográfico (cyrb53), independente de HTTPS/crypto.subtle.
export function hashPassword(pw) {
  const str = SALT + String(pw).trim().toLowerCase();
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
export const checkPassword = (pw) => hashPassword(pw) === ADMIN_HASH;

let current = sanitizeFormConfig(null);
let source = 'padrão';
export const getConfig = () => JSON.parse(JSON.stringify(current));
export const configSource = () => source;
export const isCustomized = () => Object.keys(current.sectors).length > 0;

function stamp(raw) { return raw && typeof raw.updatedAt === 'string' ? raw.updatedAt : ''; }

// Usa a versão mais nova entre o arquivo form-config.json (publicado) e a alteração local deste aparelho.
export async function loadFormConfig() {
  let local = null, file = null;
  try { const t = localStorage.getItem(KEY); if (t) local = JSON.parse(t); } catch { local = null; }
  try {
    const r = await fetch('form-config.json', { cache: 'no-store' });
    if (r.ok) file = await r.json();
  } catch { file = null; }
  const useLocal = local && (!file || stamp(local) >= stamp(file));
  const raw = useLocal ? local : file;
  current = applyFormConfig(raw);
  source = !raw || !Object.keys(current.sectors).length ? 'padrão' : (useLocal ? 'este aparelho' : 'arquivo publicado');
  return current;
}

export function setConfig(cfg) {
  const clean = sanitizeFormConfig(cfg);
  current = applyFormConfig(clean);
  source = Object.keys(current.sectors).length ? 'este aparelho' : 'padrão';
  try { localStorage.setItem(KEY, JSON.stringify({ ...current, updatedAt: new Date().toISOString() })); return true; } catch { return false; }
}

export const exportConfigText = () => JSON.stringify({ ...current, updatedAt: new Date().toISOString() }, null, 2);

export function parseConfigText(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { throw new Error('O arquivo está corrompido ou não é JSON.'); }
  if (!raw || typeof raw !== 'object' || raw.version !== 1 || typeof raw.sectors !== 'object') throw new Error('Este arquivo não é uma configuração de formulário do Plantão ADM.');
  return sanitizeFormConfig(raw);
}
