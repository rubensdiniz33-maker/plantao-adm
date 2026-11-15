// Utilitários de interface: criação de elementos, ícones, diálogos e avisos.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

const P = {
  door: '<path d="M5 21V4a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v17M3 21h18"/><path d="M12.5 12h.01"/>',
  desk: '<rect x="3" y="10" width="18" height="5" rx="1"/><path d="M6 15v5M18 15v5M9 10V6h6v4"/>',
  pill: '<path d="M10.5 20.5a4.95 4.95 0 0 1-7-7l10-10a4.95 4.95 0 0 1 7 7z"/><path d="m8.5 8.5 7 7"/>',
  linen: '<path d="M8 3 3 6l2 4 3-1v12h8V9l3 1 2-4-5-3a4 4 0 0 1-8 0z"/>',
  flask: '<path d="M9 3h6M10 3v6L4.5 19a1.5 1.5 0 0 0 1.3 2.2h12.4a1.5 1.5 0 0 0 1.3-2.2L14 9V3M7.5 15h9"/>',
  cath: '<path d="M20.8 5.6a5 5 0 0 0-7.1 0L12 7.3l-1.7-1.7a5 5 0 0 0-7.1 7.1L12 21l8.8-8.3a5 5 0 0 0 0-7.1z"/><path d="M5 12h3l2 -3 3 6 2-3h4"/>',
  scalpel: '<path d="M4 20 15 9"/><path d="m14 4 6 6-3 1-4-4z"/>',
  bed: '<path d="M3 19V5M3 15h18v4M21 15v-2a3 3 0 0 0-3-3h-7v5"/><circle cx="7" cy="11" r="1.5"/>',
  bed2: '<path d="M3 19V5M21 19v-6a3 3 0 0 0-3-3H8v5h13M3 16h18"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4M6 10h3l2-3 2 5 1-2h4"/>',
  heart: '<path d="M20.8 5.6a5 5 0 0 0-7.1 0L12 7.3l-1.7-1.7a5 5 0 0 0-7.1 7.1L12 21l8.8-8.3a5 5 0 0 0 0-7.1z"/>',
  cross: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  minus: '<path d="M5 12h14"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.5-4M4 5v4h4M4 13a8 8 0 0 0 14.5 4M20 19v-4h-4"/>',
  settings: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  logo: '<path d="M20.8 5.6a5 5 0 0 0-7.1 0L12 7.3l-1.7-1.7a5 5 0 0 0-7.1 7.1L12 21l8.8-8.3a5 5 0 0 0 0-7.1z"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  left: '<path d="M15 6l-6 6 6 6"/>',
  right: '<path d="m9 6 6 6-6 6"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 4 2.5 20h19z"/><path d="M12 10v4M12 17h.01"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  share: '<path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M12 15V4M8 8l4-4 4 4"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m21 16-5-5-8 8"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  download: '<path d="M12 4v11M8 11l4 4 4-4M5 20h14"/>',
  upload: '<path d="M12 16V5M8 9l4-4 4 4M5 20h14"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  play: '<path d="m7 4 13 8-13 8z"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
};

export function icon(name, cls = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.8');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('class', `ic ${cls}`.trim());
  s.innerHTML = P[name] || '';
  return s;
}

// ---------- Aviso rápido ----------
let toastTimer = null;
export function toast(message, kind = 'info') {
  let t = document.getElementById('toast');
  if (!t) {
    t = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(t);
  }
  t.className = `toast ${kind} show`;
  t.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), kind === 'error' ? 5000 : 2400);
}

// ---------- Diálogo ----------
// actions: [{label, value, variant: 'primary'|'danger'|'ghost'}] → Promise<value>
export function dialog({ title, body, actions }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const close = (v) => {
      overlay.classList.remove('open');
      setTimeout(() => overlay.remove(), 160);
      document.removeEventListener('keydown', onKey);
      if (prevFocus && prevFocus.focus) prevFocus.focus();
      resolve(v);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    const cancel = actions.find((a) => a.variant === 'ghost');
    const card = h('div', { class: 'dlg', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('h2', null, title),
      typeof body === 'string' ? h('p', null, body) : body,
      h('div', { class: 'dlg-actions' },
        actions.map((a) => h('button', { class: `btn ${a.variant || 'primary'}`, type: 'button', onclick: () => close(a.value) }, a.label))));
    const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) close(cancel ? cancel.value : null); } }, card);
    document.body.append(overlay);
    requestAnimationFrame(() => overlay.classList.add('open'));
    document.addEventListener('keydown', onKey);
    const first = card.querySelector('.btn.primary, .btn.danger') || card.querySelector('.btn');
    first?.focus();
  });
}

export const confirmDialog = ({ title, message, confirmText = 'Confirmar', cancelText = 'Cancelar', danger = false }) =>
  dialog({
    title,
    body: message,
    actions: [
      { label: cancelText, value: false, variant: 'ghost' },
      { label: confirmText, value: true, variant: danger ? 'danger' : 'primary' },
    ],
  });

// ---------- Datas ----------
const WD = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const MO = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
export const longDate = (d = new Date()) => `${WD[d.getDay()]}, ${d.getDate()} de ${MO[d.getMonth()]} de ${d.getFullYear()}`;
export const pad2 = (n) => String(n).padStart(2, '0');
export const todayISO = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
export const timeHM = (iso) => {
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
export const dateTimeBR = (iso) => {
  const d = new Date(iso);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${timeHM(iso)}`;
};

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// ---------- Painel inferior (sheet) ----------
export function sheet({ title, body }) {
  const prevFocus = document.activeElement;
  const close = () => {
    overlay.classList.remove('open');
    setTimeout(() => overlay.remove(), 160);
    document.removeEventListener('keydown', onKey);
    if (prevFocus && prevFocus.focus) prevFocus.focus();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const card = h('div', { class: 'dlg sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'sheethead' }, h('h2', null, title),
      h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Fechar', onclick: close }, icon('x'))),
    h('div', { class: 'sheetbody' }, body));
  const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) close(); } }, card);
  document.body.append(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
  document.addEventListener('keydown', onKey);
  return { close };
}

// Ao copiar texto selecionado da prévia, devolve a sintaxe do WhatsApp (*negrito*, _itálico_).
export function attachWaCopy(el) {
  el.addEventListener('copy', (e) => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount || !el.contains(sel.anchorNode)) return;
    const box = document.createElement('div');
    box.append(sel.getRangeAt(0).cloneContents());
    box.querySelectorAll('strong').forEach((n) => n.replaceWith(`*${n.textContent}*`));
    box.querySelectorAll('em').forEach((n) => n.replaceWith(`_${n.textContent}_`));
    e.clipboardData.setData('text/plain', box.textContent);
    e.preventDefault();
  });
}
