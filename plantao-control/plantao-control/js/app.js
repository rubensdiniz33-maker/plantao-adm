// PLANTÃO CONTROL — interface, rotas e fluxo do plantão.
import * as storage from './storage.js';
import {
  SECTORS, SECTOR_BY_ID, NA, MAX_TEXT, MAX_NUM_DIGITS, conditionMet, isAnswered, sectorProgress, sectorAlerts, shiftSummary,
} from './sectors.js';
import {
  MAX_ACTIVITY, validateIdentification, cleanName, normalizeShift, parseBackup, buildBackup,
} from './validation.js';
import {
  openingMessage, reportText, missingList, alertsList, whatsappToHtml, formatDateBR, hoursText, shiftName, joinNames,
} from './report.js';
import { copyText, shareWhatsApp, buildPngs, buildPdf, downloadBlob, shareFiles } from './export.js';
import {
  h, icon, toast, dialog, confirmDialog, longDate, todayISO, timeHM, dateTimeBR, uuid, pad2,
} from './ui.js';

const app = document.getElementById('app');
const nowISO = () => new Date().toISOString();

// =====================================================================
// Salvamento automático
// =====================================================================
const save = { state: 'saved', at: null, pending: null, timer: null, queue: Promise.resolve(), error: null };
const badges = new Set();

function setSave(st, err) {
  save.state = st;
  save.error = err || null;
  if (st === 'saved' || st === 'volatile') save.at = new Date();
  badges.forEach((b) => (b.isConnected ? paintBadge(b, true) : badges.delete(b)));
}

function paintBadge(b, flash) {
  b.className = `savebadge ${save.state}`;
  b.replaceChildren();
  if (save.state === 'saving') b.append('Salvando…');
  else if (save.state === 'saved') {
    b.append(icon('check'), save.at ? `Salvo ${pad2(save.at.getHours())}:${pad2(save.at.getMinutes())}` : 'Salvo');
    if (flash) { b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash'); }
  } else if (save.state === 'volatile') b.append(icon('alert'), 'Não salvo (sem armazenamento)');
  else b.append(icon('alert'), 'Erro ao salvar · tentar de novo');
}

function saveBadge() {
  const b = h('button', { class: 'savebadge', type: 'button', 'aria-live': 'polite', onclick: () => { if (save.state === 'error') flush(); } });
  badges.add(b);
  paintBadge(b, false);
  return b;
}

// Diário síncrono em localStorage: protege contra fechamento/recarga no meio de uma gravação assíncrona.
const JOURNAL_KEY = 'plantao-control:journal';
function journalWrite(shift) {
  if (!storage.status().persistent) return;
  try { localStorage.setItem(JOURNAL_KEY, JSON.stringify(shift)); } catch { /* sem diário: segue com IndexedDB */ }
}
function journalClear(shift) {
  try {
    const raw = localStorage.getItem(JOURNAL_KEY);
    if (!raw) return;
    const j = JSON.parse(raw);
    if (j.id === shift.id && j.updatedAt === shift.updatedAt) localStorage.removeItem(JOURNAL_KEY);
  } catch { try { localStorage.removeItem(JOURNAL_KEY); } catch { /* ignora */ } }
}
async function recoverJournal() {
  let j;
  try {
    const raw = localStorage.getItem(JOURNAL_KEY);
    if (!raw) return;
    j = normalizeShift(JSON.parse(raw));
  } catch {
    try { localStorage.removeItem(JOURNAL_KEY); } catch { /* ignora */ }
    return; // diário ilegível: descartado
  }
  try {
    const stored = await storage.getShift(j.id);
    if (!stored || j.updatedAt > stored.updatedAt) await storage.saveShift(j);
    localStorage.removeItem(JOURNAL_KEY);
  } catch { /* gravação falhou: o diário é mantido para a próxima abertura */ }
}

function touch(shift) {
  shift.updatedAt = nowISO();
  journalWrite(shift);
  save.pending = shift;
  setSave('saving');
  clearTimeout(save.timer);
  save.timer = setTimeout(flush, 250);
}

function flush() {
  clearTimeout(save.timer);
  save.queue = save.queue.then(async () => {
    const s = save.pending;
    if (!s) return;
    save.pending = null;
    try {
      const r = await storage.saveShift(s);
      if (r.persisted) journalClear(s);
      if (save.pending) return; // há alteração mais nova a caminho
      setSave(r.persisted ? 'saved' : 'volatile');
    } catch (e) {
      if (!save.pending) save.pending = s;
      setSave('error', e);
      toast('Não foi possível salvar neste dispositivo. Tente novamente.', 'error');
    }
  });
  return save.queue;
}

function log(shift, type, textValue, sector, by) {
  shift.activity.push({ t: nowISO(), type, text: textValue, ...(sector ? { sector } : {}), ...(by ? { by } : {}) });
  if (shift.activity.length > MAX_ACTIVITY) shift.activity.splice(0, shift.activity.length - MAX_ACTIVITY);
}

// =====================================================================
// Estrutura básica de telas
// =====================================================================
function mount(node) {
  app.replaceChildren(node);
  window.scrollTo(0, 0);
}

const go = (hash) => { location.hash = hash; };

function topbar({ title, sub, back, right }) {
  return h('header', { class: 'topbar' },
    back ? h('a', { class: 'iconbtn', href: back, 'aria-label': 'Voltar' }, icon('back')) : null,
    h('h1', null, title, sub ? h('span', { class: 'sub' }, sub) : null),
    right);
}

function storageBanner() {
  const st = storage.status();
  if (st.persistent) return null;
  return h('div', { class: 'banner err', role: 'alert' }, icon('alert'),
    h('div', null, 'O armazenamento local está indisponível neste navegador. As informações NÃO serão salvas ao fechar ou atualizar a página. Copie ou exporte o relatório antes de sair.'));
}

const shiftTitle = (s) => `${shiftName(s.type)} · ${formatDateBR(s.date)}`;

// =====================================================================
// Sessão de preenchimento de setor (para o histórico de atividades)
// =====================================================================
let sess = null; // { shift, sector, dirty }

function commitSector(end) {
  if (!sess) return;
  const { shift, sector } = sess;
  if (sess.dirty) {
    const meta = shift.sectorMeta[sector.id] || (shift.sectorMeta[sector.id] = { firstAt: null, doneAt: null });
    const prog = sectorProgress(sector, shift.answers[sector.id] || {});
    const post = shift.status === 'finalizado';
    if (post) log(shift, 'post', `${sector.title} atualizado após a finalização`, sector.id);
    else if (prog.status === 'done' && !meta.doneAt) log(shift, 'done', `${sector.title} preenchido`, sector.id);
    else if (!sess.startedLogged) log(shift, 'update', `${sector.title} atualizado`, sector.id);
    if (prog.status === 'done' && !meta.doneAt) meta.doneAt = nowISO();
    sess.dirty = false;
    sess.startedLogged = false;
    touch(shift);
  }
  if (end) sess = null;
}

// =====================================================================
// Home
// =====================================================================
function screenHome(shifts) {
  const active = shifts.filter((s) => s.status === 'em_andamento').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const children = [
    h('div', null,
      h('h1', { class: 'brand' }, 'PLANTÃO ', h('span', null, 'CONTROL')),
      h('div', { class: 'datehero' }, longDate())),
    storageBanner(),
  ];
  if (active) {
    const sm = shiftSummary(active);
    children.push(h('div', { class: 'card active-card stack' },
      h('div', { class: 'eyebrow' }, 'Plantão em andamento'),
      h('div', null, h('h2', null, shiftTitle(active)), h('div', { class: 'meta' }, `${hoursText(active)} · ${joinNames(active.nurses)}`)),
      h('div', { class: 'meta' }, `${sm.done}/${sm.total} setores preenchidos${sm.alerts ? ` · ${sm.alerts} com ocorrência` : ''}`),
      h('a', { class: 'btn primary lg block', href: `#/p/${active.id}`, id: 'btn-resume' }, icon('play'), 'RETOMAR PLANTÃO')));
  }
  const startBtn = h('button', {
    class: `btn ${active ? 'secondary' : 'primary'} lg block`, type: 'button', id: 'btn-start',
    onclick: async () => {
      if (active) {
        const choice = await dialog({
          title: 'Já existe um plantão em andamento',
          body: `${shiftTitle(active)} ainda não foi finalizado. Você pode retomá-lo ou iniciar um novo plantão sem apagar este.`,
          actions: [
            { label: 'Cancelar', value: null, variant: 'ghost' },
            { label: 'Iniciar novo', value: 'new', variant: 'secondary' },
            { label: 'Retomar', value: 'resume', variant: 'primary' },
          ],
        });
        if (choice === 'resume') go(`#/p/${active.id}`);
        else if (choice === 'new') go('#/novo');
      } else go('#/novo');
    },
  }, icon('plus'), 'INICIAR PLANTÃO');
  children.push(h('div', { class: 'stack' }, startBtn,
    h('a', { class: 'btn ghost lg block', href: '#/historico', id: 'btn-history' }, icon('clock'), 'Histórico')));
  children.push(h('div', { class: 'spacer' }));
  children.push(h('p', { class: 'note' }, 'Os dados ficam armazenados neste dispositivo e neste navegador. Não há sincronização entre dispositivos.'));
  mount(h('main', { class: 'screen home' }, children));
}

// =====================================================================
// Abertura / identificação do plantão
// =====================================================================
function defaultDraft() {
  const d = new Date();
  const hr = d.getHours();
  const night = hr >= 17 || hr < 5;
  if (night && hr < 5) d.setDate(d.getDate() - 1);
  return night
    ? { type: 'N', date: todayISO(d), start: '19:00', end: '07:00', nurses: [''] }
    : { type: 'MT', date: todayISO(d), start: '07:00', end: '19:00', nurses: [''] };
}
const TYPE_DEFAULTS = { MT: ['07:00', '19:00'], N: ['19:00', '07:00'] };

function screenOpening(shift, shifts) {
  const isNew = !shift;
  const form = isNew ? defaultDraft() : { type: shift.type, date: shift.date, start: shift.start, end: shift.end, nurses: [...shift.nurses] };
  let timesTouched = !isNew;
  let attempted = false;
  let idLogged = false;
  let ready = false;

  const errType = h('div', { class: 'error', hidden: true });
  const errDate = h('div', { class: 'error', hidden: true });
  const errTime = h('div', { class: 'error', hidden: true });
  const errNurses = h('div', { class: 'error', hidden: true });
  const preview = h('div', { class: 'preview', id: 'opening-preview' });

  const dateIn = h('input', { class: 'input', type: 'date', id: 'f-date', 'aria-label': 'Data do plantão', oninput: (e) => { form.date = e.target.value; update(); } });
  const startIn = h('input', { class: 'input', type: 'time', id: 'f-start', 'aria-label': 'Horário de início', oninput: (e) => { form.start = e.target.value; timesTouched = true; update(); } });
  const endIn = h('input', { class: 'input', type: 'time', id: 'f-end', 'aria-label': 'Horário de término', oninput: (e) => { form.end = e.target.value; timesTouched = true; update(); } });
  dateIn.value = form.date; startIn.value = form.start; endIn.value = form.end;

  const typeSeg = h('div', { class: 'seg type', role: 'group', 'aria-label': 'Tipo de plantão' },
    [['MT', 'Manhã/Tarde'], ['N', 'Noturno']].map(([v, sub]) =>
      h('button', {
        type: 'button', 'data-v': v, id: `type-${v}`,
        onclick: () => {
          form.type = v;
          if (!timesTouched) { [form.start, form.end] = TYPE_DEFAULTS[v]; startIn.value = form.start; endIn.value = form.end; }
          update();
        },
      }, v, h('small', null, sub))));

  const nurseBox = h('div', { class: 'stack' });
  function drawNurses(focusIdx) {
    nurseBox.replaceChildren(...form.nurses.map((n, i) => {
      const inp = h('input', {
        class: 'input', type: 'text', maxlength: '60', autocomplete: 'off', autocapitalize: 'words', enterkeyhint: 'done',
        placeholder: i === 0 ? 'Enfermeiro responsável' : 'Enfermeiro adicional', 'aria-label': i === 0 ? 'Enfermeiro responsável' : `Enfermeiro adicional ${i}`,
        'data-nurse': String(i),
        oninput: (e) => { form.nurses[i] = e.target.value; update(); },
      });
      inp.value = n;
      return h('div', { class: 'nurse' }, inp,
        form.nurses.length > 1
          ? h('button', { class: 'iconbtn', type: 'button', 'aria-label': `Remover enfermeiro ${i + 1}`, onclick: () => { form.nurses.splice(i, 1); drawNurses(); update(); } }, icon('x'))
          : null);
    }));
    if (focusIdx !== undefined) nurseBox.querySelectorAll('input')[focusIdx]?.focus();
  }

  function update() {
    typeSeg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === form.type)));
    const errs = validateIdentification(form);
    const show = attempted || !isNew;
    const setErr = (el, msg, ...inputs) => { el.hidden = !(show && msg); el.textContent = msg || ''; inputs.forEach((i) => i?.classList.toggle('invalid', !!(show && msg))); };
    setErr(errType, errs.type);
    setErr(errDate, errs.date, dateIn);
    setErr(errTime, errs.start || errs.end, startIn, endIn);
    setErr(errNurses, errs.nurses);
    const previewable = !errs.date && !errs.start && !errs.end && !errs.nurses && !errs.type;
    if (previewable) {
      preview.textContent = openingMessage({ ...form, nurses: form.nurses.map(cleanName).filter(Boolean) });
    } else preview.textContent = 'Preencha tipo, data, horários e o enfermeiro responsável para gerar a mensagem.';
    copyBtn.disabled = shareBtn.disabled = !previewable;
    if (ready && !isNew && Object.keys(errs).length === 0) {
      shift.type = form.type; shift.date = form.date; shift.start = form.start; shift.end = form.end;
      shift.nurses = form.nurses.map(cleanName).filter(Boolean);
      if (!idLogged) { log(shift, 'update', 'Dados do plantão alterados'); idLogged = true; }
      touch(shift);
    }
  }

  const msgText = () => openingMessage({ ...form, nurses: form.nurses.map(cleanName).filter(Boolean) });
  const copyBtn = h('button', {
    class: 'btn secondary', type: 'button', id: 'btn-copy-open',
    onclick: async () => toast((await copyText(msgText())) ? 'Mensagem copiada' : 'Não foi possível copiar. Selecione o texto manualmente.', 'ok'),
  }, icon('copy'), 'Copiar');
  const shareBtn = h('button', {
    class: 'btn secondary', type: 'button', id: 'btn-wa-open',
    onclick: async () => { const r = await shareWhatsApp(msgText()); if (r === 'fail') toast('Não foi possível abrir o WhatsApp.', 'error'); },
  }, icon('share'), 'WhatsApp');

  const addBtn = h('button', { class: 'btn ghost small', type: 'button', id: 'btn-add-nurse', onclick: () => { form.nurses.push(''); drawNurses(form.nurses.length - 1); update(); } }, icon('plus'), 'Adicionar enfermeiro');

  const createBtn = h('button', {
    class: 'btn primary lg', type: 'button', id: 'btn-create',
    onclick: async () => {
      attempted = true;
      update();
      const errs = validateIdentification(form);
      if (Object.keys(errs).length) {
        toast('Revise os campos destacados.', 'error');
        app.querySelector('.invalid, .error:not([hidden])')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
      const nurses = form.nurses.map(cleanName).filter(Boolean);
      const dup = shifts.find((s) => s.date === form.date && s.type === form.type);
      if (dup) {
        const c = await dialog({
          title: 'Já existe um plantão igual',
          body: `Já há um plantão ${shiftName(dup.type)} em ${formatDateBR(dup.date)}${dup.status === 'em_andamento' ? ' em andamento' : ''}. Abra o existente para evitar duplicidade, ou crie outro mesmo assim.`,
          actions: [
            { label: 'Cancelar', value: null, variant: 'ghost' },
            { label: 'Criar outro', value: 'new', variant: 'secondary' },
            { label: 'Abrir existente', value: 'open', variant: 'primary' },
          ],
        });
        if (c === 'open') { go(`#/p/${dup.id}`); return; }
        if (c !== 'new') return;
      }
      createBtn.disabled = true;
      const now = nowISO();
      const s = {
        id: uuid(), schema: 1, type: form.type, date: form.date, start: form.start, end: form.end, nurses,
        status: 'em_andamento', createdAt: now, updatedAt: now, finalizedAt: null, finalizedBy: null,
        answers: {}, sectorMeta: {}, activity: [],
      };
      log(s, 'start', 'Plantão iniciado');
      try {
        const r = await storage.saveShift(s);
        setSave(r.persisted ? 'saved' : 'volatile');
        if (!r.persisted) toast('Plantão criado, mas NÃO foi salvo no dispositivo (armazenamento indisponível).', 'error');
      } catch (e) {
        createBtn.disabled = false;
        setSave('error', e);
        toast('Não foi possível salvar o plantão neste dispositivo.', 'error');
        return;
      }
      go(`#/p/${s.id}/abertura`);
    },
  }, 'Criar plantão');

  const screen = h('main', { class: 'screen' },
    topbar({ title: isNew ? 'Novo plantão' : 'Dados do plantão', back: isNew ? '#/' : `#/p/${shift.id}`, right: isNew ? null : saveBadge() }),
    h('div', { class: 'content' },
      storageBanner(),
      h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Tipo de plantão'), typeSeg, errType),
      h('div', { class: 'field' }, h('label', { for: 'f-date' }, 'Data'), dateIn, errDate),
      h('div', { class: 'field' },
        h('div', { class: 'row' },
          h('div', { class: 'field' }, h('label', { for: 'f-start' }, 'Início'), startIn),
          h('div', { class: 'field' }, h('label', { for: 'f-end' }, 'Término'), endIn)),
        errTime),
      h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Enfermeiros responsáveis'), nurseBox, addBtn, errNurses),
      h('div', { class: 'sectiontitle' }, 'Mensagem de apresentação'),
      preview,
      h('div', { class: 'row' }, copyBtn, shareBtn),
      isNew ? null : h('p', { class: 'note' }, 'As alterações são salvas automaticamente.')),
    h('div', { class: 'actionbar' },
      isNew ? createBtn : h('a', { class: 'btn primary lg', href: `#/p/${shift.id}`, id: 'btn-to-panel' }, 'Ir para o painel')));
  mount(screen);
  drawNurses();
  update();
  ready = true;
}

// =====================================================================
// Painel de setores
// =====================================================================
function screenPanel(shift) {
  const sm = shiftSummary(shift);
  const fill = h('i');
  const list = h('div', { class: 'sectors' }, SECTORS.map((sector) => {
    const ans = shift.answers[sector.id] || {};
    const prog = sectorProgress(sector, ans);
    const alerts = sectorAlerts(sector, ans);
    const stText = { none: 'Não iniciado', progress: 'Em preenchimento', done: 'Preenchido' }[prog.status];
    return h('a', {
      class: `sec ${prog.status}${alerts.length ? ' alert' : ''}`, href: `#/p/${shift.id}/s/${sector.id}`, id: `sec-${sector.id}`,
      'data-status': prog.status, 'data-alert': alerts.length ? '1' : '0',
      'aria-label': `${sector.title}: ${stText}${alerts.length ? ', com ocorrência' : ''}`,
    },
    h('span', { class: 'ico' }, icon(sector.icon)),
    h('span', { class: 'txt' },
      h('span', { class: 'name' }, sector.title),
      h('span', { class: 'st' }, stText),
      alerts.length || prog.status === 'progress'
        ? h('span', { class: 'tags' },
          alerts.length ? h('span', { class: 'tag amber' }, icon('alert'), 'Ocorrência') : null,
          prog.status === 'progress' ? h('span', { class: 'tag pend' }, `${prog.missing.length} pend.`) : null)
        : null),
    prog.status === 'done' && !alerts.length ? h('span', { class: 'tag ok' }, icon('check')) : null,
    icon('chevron', 'chev'));
  }));

  const screen = h('main', { class: 'screen' },
    topbar({
      title: 'Painel', sub: `${shift.type === 'N' ? 'Noturno' : 'Manhã/Tarde'} · ${formatDateBR(shift.date)}`, back: '#/',
      right: h('div', { style: 'display:flex;align-items:center;gap:2px' }, saveBadge(),
        h('a', { class: 'iconbtn', href: `#/p/${shift.id}/abertura`, 'aria-label': 'Dados do plantão e mensagem de início', id: 'btn-edit-shift' }, icon('edit'))),
    }),
    h('div', { class: 'content' },
      storageBanner(),
      shift.status === 'finalizado'
        ? h('div', { class: 'banner warn' }, icon('flag'), h('div', null, `Plantão finalizado em ${dateTimeBR(shift.finalizedAt)}. Alterações atualizam o relatório e ficam registradas na atividade.`))
        : null,
      h('div', { class: 'card panelhead' },
        h('div', { class: 'line' }, h('span', { class: 'big', id: 'progress-label' }, `${sm.done} de ${sm.total} setores preenchidos`), h('span', { class: 'meta' }, hoursText(shift))),
        h('div', { class: 'pbar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(sm.total), 'aria-valuenow': String(sm.done) }, fill),
        h('div', { class: 'counts' },
          h('span', null, h('i', { class: 'dot done' }), h('b', null, sm.done), ' preenchidos'),
          h('span', null, h('i', { class: 'dot progress' }), h('b', null, sm.progress), ' em preenchimento'),
          h('span', null, h('i', { class: 'dot' }), h('b', null, sm.none), ' não iniciados'),
          h('span', null, h('i', { class: 'dot alert' }), h('b', null, sm.alerts), ' com ocorrência'))),
      list),
    h('div', { class: 'actionbar' },
      h('a', { class: 'btn secondary fit', href: `#/p/${shift.id}/atividade`, id: 'btn-activity' }, icon('list'), 'Atividade'),
      h('a', { class: 'btn primary', href: `#/p/${shift.id}/relatorio`, id: 'btn-report' }, icon('file'), 'Relatório')));
  mount(screen);
  requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = `${(sm.done / sm.total) * 100}%`; }));
}

// =====================================================================
// Formulário de setor
// =====================================================================
function buildField(f, answers, onChange) {
  const stateEl = h('span', { class: 'state' });
  const qid = `q-${f.id}`;
  const wrap = h('div', { class: `fieldcard${f.showIf ? ' cond' : ''}`, 'data-field': f.id });
  const head = h('div', { class: 'qrow' }, h('span', { class: 'q', id: qid }, f.label), stateEl);
  let control;
  let refresh;

  const setVal = (v) => {
    if (v === undefined) delete answers[f.id]; else answers[f.id] = v;
    onChange(f);
  };

  if (f.type === 'yn') {
    const btns = [['sim', 'Sim', 'Sim'], ['nao', 'Não', 'Não'], [NA, 'N/A', 'Não se aplica']].map(([v, label, aria]) =>
      h('button', { type: 'button', 'data-v': v, 'aria-label': aria, 'aria-pressed': 'false', onclick: () => setVal(answers[f.id] === v ? undefined : v) }, label));
    control = h('div', { class: 'seg', role: 'group', 'aria-labelledby': qid }, btns);
    refresh = () => btns.forEach((b) => b.setAttribute('aria-pressed', String(answers[f.id] === b.dataset.v)));
  } else {
    const multiline = f.type === 'area';
    const input = multiline
      ? h('textarea', { class: 'textarea', maxlength: String(MAX_TEXT), rows: '2', 'aria-labelledby': qid, placeholder: f.placeholder || '', enterkeyhint: 'enter' })
      : h('input', f.type === 'num'
        ? { class: 'input', type: 'text', inputmode: 'numeric', pattern: '[0-9]*', maxlength: String(MAX_NUM_DIGITS), autocomplete: 'off', 'aria-labelledby': qid, placeholder: '0', enterkeyhint: 'done' }
        : { class: 'input', type: 'text', maxlength: String(MAX_TEXT), autocomplete: 'off', 'aria-labelledby': qid, placeholder: f.placeholder || '', enterkeyhint: 'done' });
    const grow = () => { if (multiline) { input.style.height = 'auto'; input.style.height = `${Math.max(76, input.scrollHeight + 2)}px`; } };
    const na = h('button', { type: 'button', class: 'nabtn', 'aria-pressed': 'false', 'aria-label': 'Não se aplica', onclick: () => {
      if (answers[f.id] === NA) { input.value = ''; setVal(undefined); input.focus(); } else { input.value = ''; setVal(NA); }
    } }, 'N/A');
    input.addEventListener('input', () => {
      let v = input.value;
      if (f.type === 'num') {
        const cleaned = v.replace(/\D/g, '').slice(0, MAX_NUM_DIGITS);
        if (cleaned !== v) { input.value = cleaned; v = cleaned; }
      }
      grow();
      setVal(v.trim() === '' ? undefined : (f.type === 'num' ? v : v.trim()));
    });
    control = h('div', { class: 'valuerow' }, input, na);
    refresh = () => {
      const v = answers[f.id];
      na.setAttribute('aria-pressed', String(v === NA));
      input.disabled = v === NA;
      if (v !== NA && document.activeElement !== input) input.value = isAnswered(v) ? v : '';
      if (v === NA) input.value = '';
      grow();
    };
  }
  wrap.append(head, control);

  const paintState = () => {
    const v = answers[f.id];
    let t;
    if (!isAnswered(v)) t = f.optional ? 'opcional' : 'Não informado';
    else if (v === NA) t = 'Não se aplica';
    else t = 'Informado';
    stateEl.textContent = t;
    wrap.classList.toggle('answered', isAnswered(v));
  };
  const update = () => { refresh(); paintState(); };
  update();
  return { el: wrap, update };
}

function screenSector(shift, sector) {
  const idx = SECTORS.findIndex((s) => s.id === sector.id);
  const answers = shift.answers[sector.id] || (shift.answers[sector.id] = {});
  const stLabel = h('span', { class: 'sub', id: 'sector-status' });
  const items = [];
  const alertBox = h('div', { class: 'banner warn', hidden: true, id: 'sector-alerts' });

  sess = { shift, sector, dirty: false, startedLogged: false };

  const refreshAll = () => {
    for (const it of items) {
      const show = conditionMet(it.f.showIf, answers);
      it.el.hidden = !show;
    }
    const prog = sectorProgress(sector, answers);
    stLabel.textContent = { none: 'Não iniciado', progress: `Em preenchimento · ${prog.missing.length} pendente(s)`, done: 'Preenchido' }[prog.status];
    const al = sectorAlerts(sector, answers);
    alertBox.hidden = al.length === 0;
    alertBox.replaceChildren(icon('alert'), h('div', null, h('b', null, 'Ocorrência: '), al.join(' · ')));
  };

  const onChange = (f) => {
    if (!sess) return;
    const meta = shift.sectorMeta[sector.id] || (shift.sectorMeta[sector.id] = { firstAt: null, doneAt: null });
    if (!meta.firstAt) {
      meta.firstAt = nowISO();
      if (shift.status !== 'finalizado') { log(shift, 'update', `${sector.title}: preenchimento iniciado`, sector.id); sess.startedLogged = true; }
    }
    sess.dirty = true;
    // remove respostas de campos que ficaram ocultos? mantidas para não perder dados ao alternar a resposta
    items.forEach((it) => it.update());
    refreshAll();
    touch(shift);
  };

  for (const f of sector.fields) {
    const it = buildField(f, answers, onChange);
    it.f = f;
    items.push(it);
  }
  refreshAll();

  const prev = SECTORS[idx - 1];
  const next = SECTORS[idx + 1];
  const nav = (s, label, ic) => (s
    ? h('a', { class: 'iconbtn', href: `#/p/${shift.id}/s/${s.id}`, 'aria-label': `${label}: ${s.title}` }, icon(ic))
    : h('span', { class: 'iconbtn', 'aria-hidden': 'true', style: 'opacity:.25' }, icon(ic)));

  const screen = h('main', { class: 'screen' },
    h('header', { class: 'topbar' },
      h('a', { class: 'iconbtn', href: `#/p/${shift.id}`, 'aria-label': 'Voltar ao painel', id: 'btn-back-panel' }, icon('back')),
      h('h1', null, `${idx + 1}. ${sector.title}`, stLabel),
      nav(prev, 'Setor anterior', 'left'), nav(next, 'Próximo setor', 'right')),
    h('div', { class: 'content' },
      storageBanner(),
      alertBox,
      items.map((it) => it.el),
      h('p', { class: 'note' }, 'Não registre nomes de pacientes nem outros dados pessoais identificáveis.')),
    h('div', { class: 'actionbar' },
      saveBadge(),
      h('span', { style: 'flex:1' }),
      h('a', { class: 'btn secondary fit', href: `#/p/${shift.id}`, id: 'btn-done-sector' }, 'Painel'),
      next ? h('a', { class: 'btn primary fit', href: `#/p/${shift.id}/s/${next.id}`, id: 'btn-next-sector' }, 'Próximo', icon('right')) : null));
  mount(screen);
  // textareas só medem altura corretamente depois de inseridas
  items.forEach((it) => it.update());
}

// =====================================================================
// Relatório
// =====================================================================
function screenReport(shift) {
  const text = reportText(shift);
  const miss = missingList(shift);
  const alerts = alertsList(shift);
  const totalMissing = miss.reduce((n, m) => n + m.labels.length, 0);
  const imgBox = h('div', { class: 'imgpages' });
  let urls = [];

  const busy = (btn, on) => { btn.disabled = on; };

  const btnCopy = h('button', { class: 'btn primary', type: 'button', id: 'btn-copy-report', onclick: async () => {
    toast((await copyText(text)) ? 'Relatório copiado para a área de transferência' : 'Não foi possível copiar. Selecione o texto da prévia manualmente.', 'ok');
  } }, icon('copy'), 'Copiar relatório');

  const btnWa = h('button', { class: 'btn secondary', type: 'button', id: 'btn-wa-report', onclick: async () => {
    const r = await shareWhatsApp(text);
    if (r === 'long') toast('Relatório extenso: o texto foi copiado. Cole na conversa do WhatsApp.', 'ok');
    else if (r === 'fail') toast('Não foi possível abrir o WhatsApp. Use "Copiar relatório".', 'error');
  } }, icon('share'), 'WhatsApp');

  const fileBase = `plantao-${shift.date}-${shift.type}`;

  const btnImg = h('button', { class: 'btn secondary', type: 'button', id: 'btn-image', onclick: async () => {
    busy(btnImg, true);
    try {
      const blobs = await buildPngs(shift);
      urls.forEach((u) => URL.revokeObjectURL(u));
      urls = blobs.map((b) => URL.createObjectURL(b));
      const files = blobs.map((b, i) => new File([b], `${fileBase}-p${i + 1}.png`, { type: 'image/png' }));
      imgBox.replaceChildren(
        h('div', { class: 'row' },
          h('button', { class: 'btn primary small', type: 'button', id: 'btn-img-share', onclick: async () => {
            if (!(await shareFiles(files, 'Plantão administrativo'))) { files.forEach((f) => downloadBlob(f, f.name)); toast('Compartilhamento indisponível: imagens baixadas.', 'ok'); }
          } }, icon('share'), 'Compartilhar'),
          h('button', { class: 'btn secondary small', type: 'button', id: 'btn-img-download', onclick: () => files.forEach((f) => downloadBlob(f, f.name)) }, icon('download'), 'Baixar todas')),
        ...urls.map((u, i) => h('div', { class: 'stack' },
          h('div', { class: 'pgrow' }, h('span', { class: 'meta' }, `Página ${i + 1} de ${urls.length}`),
            h('button', { class: 'btn ghost small', type: 'button', onclick: () => downloadBlob(files[i], files[i].name) }, icon('download'), 'Baixar')),
          h('img', { src: u, alt: `Relatório do plantão, página ${i + 1} de ${urls.length}`, 'data-page': String(i + 1) }))));
      imgBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
      toast(`${urls.length} imagem(ns) gerada(s)`, 'ok');
    } catch (e) {
      toast(`Não foi possível gerar a imagem: ${e.message || 'erro desconhecido'}`, 'error');
    } finally { busy(btnImg, false); }
  } }, icon('image'), 'Gerar imagens');

  const btnPdf = h('button', { class: 'btn secondary', type: 'button', id: 'btn-pdf', onclick: async () => {
    busy(btnPdf, true);
    try {
      downloadBlob(await buildPdf(shift), `${fileBase}.pdf`);
      toast('PDF gerado', 'ok');
    } catch (e) {
      toast(`Não foi possível gerar o PDF: ${e.message || 'erro desconhecido'}`, 'error');
    } finally { busy(btnPdf, false); }
  } }, icon('file'), 'Exportar PDF');

  const finalize = async () => {
    const sel = h('select', { class: 'select', id: 'finalize-by', 'aria-label': 'Confirmado por' }, shift.nurses.map((n) => h('option', { value: n }, n)));
    const body = h('div', { class: 'stack' },
      alerts.length
        ? h('div', { class: 'banner warn' }, icon('alert'), h('div', null, h('b', null, `${alerts.length} setor(es) com ocorrência: `), alerts.map((a) => a.title).join(', ')))
        : h('p', null, 'Nenhuma ocorrência operacional registrada.'),
      totalMissing
        ? h('div', { class: 'banner warn' }, icon('alert'), h('div', null, h('b', null, `${totalMissing} campo(s) não informado(s) `), `em ${miss.length} setor(es). O relatório será finalizado como parcial, com esses campos marcados como "Não informado".`))
        : h('p', null, 'Todos os campos foram informados.'),
      h('div', { class: 'field' }, h('label', { for: 'finalize-by' }, 'Finalização confirmada por'), sel),
      h('p', null, 'Depois de finalizar, ainda é possível corrigir os setores; as alterações ficam registradas na atividade.'));
    const ok = await dialog({
      title: 'Finalizar plantão', body,
      actions: [{ label: 'Cancelar', value: false, variant: 'ghost' }, { label: 'Finalizar plantão', value: true, variant: 'green' }],
    });
    if (!ok) return;
    shift.status = 'finalizado';
    shift.finalizedAt = nowISO();
    shift.finalizedBy = sel.value;
    log(shift, 'finish', `Relatório finalizado${totalMissing ? ' (parcial)' : ''}`, null, sel.value);
    touch(shift);
    await flush();
    toast('Plantão finalizado', 'ok');
    screenReport(shift);
  };

  const screen = h('main', { class: 'screen' },
    topbar({ title: 'Relatório', sub: shiftTitle(shift), back: `#/p/${shift.id}`, right: saveBadge() }),
    h('div', { class: 'content' },
      storageBanner(),
      shift.status === 'finalizado'
        ? h('div', { class: 'banner warn', id: 'final-banner' }, icon('flag'), h('div', null, `Finalizado em ${dateTimeBR(shift.finalizedAt)}${shift.finalizedBy ? ` · confirmado por ${shift.finalizedBy}` : ''}.`))
        : null,
      totalMissing
        ? h('details', { class: 'miss', id: 'missing-box' },
          h('summary', null, h('span', null, icon('alert'), ` ${totalMissing} campo(s) não informado(s) em ${miss.length} setor(es)`), icon('chevron')),
          h('ul', null, miss.map((m) => h('li', null, h('b', { style: 'color:var(--text)' }, m.title), `: ${m.labels.join('; ')}`))))
        : h('div', { class: 'banner', id: 'missing-box', style: 'background:rgba(61,190,139,.12);border:1px solid rgba(61,190,139,.4);color:#9be3c4' }, icon('check'), 'Todos os campos informados.'),
      alerts.length
        ? h('div', { class: 'banner warn', id: 'alerts-box' }, icon('alert'), h('div', null, h('b', null, 'Ocorrências: '), alerts.map((a) => `${a.title} (${a.alerts.join(', ')})`).join(' · ')))
        : null,
      h('div', { class: 'sectiontitle' }, 'Prévia do relatório'),
      h('div', { class: 'preview', id: 'report-preview', html: whatsappToHtml(text) }),
      h('div', { class: 'outputs' }, btnCopy, btnWa, btnImg, btnPdf),
      imgBox,
      h('p', { class: 'note' }, 'O WhatsApp abre para você escolher a conversa; o aplicativo não envia a mensagem sozinho.')),
    shift.status === 'em_andamento'
      ? h('div', { class: 'actionbar' }, h('button', { class: 'btn green lg', type: 'button', id: 'btn-finalize', onclick: finalize }, icon('flag'), 'Finalizar plantão'))
      : null);
  mount(screen);
}

// =====================================================================
// Atividade
// =====================================================================
function screenActivity(shift) {
  const items = [...shift.activity].reverse();
  mount(h('main', { class: 'screen' },
    topbar({ title: 'Atividade do plantão', sub: shiftTitle(shift), back: `#/p/${shift.id}` }),
    h('div', { class: 'content' },
      items.length
        ? h('ul', { class: 'timeline', id: 'timeline' }, items.map((a) => h('li', { class: a.type },
          h('span', { class: 'when' }, dateTimeBR(a.t)), a.text, a.by ? ` — ${a.by}` : '')))
        : h('p', { class: 'note' }, 'Nenhuma atividade registrada.'),
      h('p', { class: 'note' }, 'Mais recentes primeiro. Alterações não são atribuídas a um profissional, exceto a confirmação da finalização.'))));
}

// =====================================================================
// Histórico e backup
// =====================================================================
function screenHistory(shifts) {
  const list = h('div', { class: 'stack', id: 'history-list' });
  const draw = (all) => {
    list.replaceChildren(...(all.length ? all.map((s) => {
      const sm = shiftSummary(s);
      return h('div', { class: 'card hitem', 'data-id': s.id },
        h('div', { class: 'top' },
          h('div', null, h('h3', null, shiftTitle(s)), h('div', { class: 'meta' }, `${hoursText(s)} · ${joinNames(s.nurses)}`)),
          s.status === 'em_andamento' ? h('span', { class: 'tag pend' }, 'Em andamento') : h('span', { class: 'tag ok' }, 'Finalizado')),
        h('div', { class: 'meta' }, `${sm.done}/${sm.total} setores preenchidos${sm.alerts ? ` · ${sm.alerts} com ocorrência` : ''}`),
        h('div', { class: 'acts' },
          h('a', { class: 'btn primary small', href: `#/p/${s.id}`, 'data-act': 'open' }, 'Abrir'),
          h('a', { class: 'btn secondary small', href: `#/p/${s.id}/relatorio`, 'data-act': 'report' }, 'Relatório'),
          h('button', { class: 'btn ghost small', type: 'button', style: 'flex:0 0 auto', 'aria-label': 'Excluir plantão', 'data-act': 'delete', onclick: async () => {
            const ok = await confirmDialog({
              title: 'Excluir plantão?',
              message: `${shiftTitle(s)} e todas as informações preenchidas serão apagados deste dispositivo. Esta ação não pode ser desfeita. Se precisar, exporte um backup antes.`,
              confirmText: 'Excluir', danger: true,
            });
            if (!ok) return;
            try { await storage.deleteShift(s.id); } catch (e) { toast('Não foi possível excluir.', 'error'); return; }
            const fresh = await storage.listShifts();
            draw(fresh);
            toast('Plantão excluído', 'ok');
          } }, icon('trash'))));
    }) : [h('p', { class: 'note', id: 'history-empty' }, 'Nenhum plantão registrado neste dispositivo.')]));
  };
  draw(shifts);

  const fileIn = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, id: 'import-file', onchange: async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('O arquivo é grande demais para ser um backup válido.');
      const { shifts: incoming, rejected } = parseBackup(await file.text());
      const current = await storage.listShifts();
      const map = new Map(current.map((s) => [s.id, s]));
      const toWrite = incoming.filter((s) => !map.has(s.id) || s.updatedAt > map.get(s.id).updatedAt);
      const added = toWrite.filter((s) => !map.has(s.id)).length;
      const replaced = toWrite.length - added;
      const skipped = incoming.length - toWrite.length;
      if (!toWrite.length) { toast(`Nada a importar: os ${incoming.length} plantão(ões) do arquivo já estão aqui com a mesma versão ou mais nova.`, 'ok'); return; }
      const ok = await confirmDialog({
        title: 'Importar backup?',
        message: `${added} novo(s), ${replaced} atualizado(s) por versão mais recente${skipped ? `, ${skipped} ignorado(s) por já existirem` : ''}${rejected ? `. ${rejected} registro(s) inválido(s) serão descartados` : ''}. Nenhum plantão existente será apagado.`,
        confirmText: 'Importar',
      });
      if (!ok) return;
      const r = await storage.saveMany(toWrite);
      if (!r.persisted) toast('Importado apenas na memória: armazenamento indisponível.', 'error');
      else toast(`Backup importado: ${added} novo(s), ${replaced} atualizado(s)`, 'ok');
      draw(await storage.listShifts());
    } catch (err) {
      toast(err.message || 'Não foi possível importar o arquivo.', 'error');
    }
  } });

  mount(h('main', { class: 'screen' },
    topbar({ title: 'Histórico', back: '#/' }),
    h('div', { class: 'content' },
      storageBanner(),
      list,
      h('div', { class: 'sectiontitle' }, 'Backup'),
      h('div', { class: 'card stack' },
        h('div', { class: 'row' },
          h('button', { class: 'btn secondary', type: 'button', id: 'btn-export-backup', onclick: async () => {
            try {
              const all = await storage.listShifts();
              if (!all.length) { toast('Não há plantões para exportar.', 'error'); return; }
              downloadBlob(new Blob([buildBackup(all)], { type: 'application/json' }), `plantao-control-backup-${todayISO()}.json`);
              toast('Backup exportado', 'ok');
            } catch (e) { toast('Não foi possível exportar o backup.', 'error'); }
          } }, icon('download'), 'Exportar'),
          h('button', { class: 'btn secondary', type: 'button', id: 'btn-import-backup', onclick: () => fileIn.click() }, icon('upload'), 'Importar'),
          fileIn),
        h('p', { class: 'note' }, 'Os dados ficam armazenados neste dispositivo e neste navegador. Não há sincronização entre dispositivos; use o backup para transferir ou guardar uma cópia.')))));
}

// =====================================================================
// Rotas
// =====================================================================
async function route() {
  commitSector(true);
  await flush();
  const parts = (location.hash.replace(/^#/, '') || '/').split('/').filter(Boolean);
  try {
    if (!parts.length) return screenHome(await storage.listShifts());
    if (parts[0] === 'novo') return screenOpening(null, await storage.listShifts());
    if (parts[0] === 'historico') return screenHistory(await storage.listShifts());
    if (parts[0] === 'p' && parts[1]) {
      const shift = await storage.getShift(parts[1]);
      if (!shift) { toast('Plantão não encontrado.', 'error'); go('#/'); return; }
      const sub = parts[2];
      if (!sub) return screenPanel(shift);
      if (sub === 'abertura') return screenOpening(shift, []);
      if (sub === 'relatorio') return screenReport(shift);
      if (sub === 'atividade') return screenActivity(shift);
      if (sub === 's' && SECTOR_BY_ID[parts[3]]) return screenSector(shift, SECTOR_BY_ID[parts[3]]);
    }
    go('#/');
  } catch (e) {
    console.error(e);
    mount(h('main', { class: 'screen home' },
      h('div', { class: 'banner err', role: 'alert' }, icon('alert'), h('div', null, 'Não foi possível carregar os dados deste dispositivo.')),
      h('a', { class: 'btn secondary lg block', href: '#/' }, 'Voltar ao início')));
  }
}

// Em ordem de saída da página: grava o que estiver pendente.
function persistNow() { commitSector(false); flush(); }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persistNow(); });
window.addEventListener('pagehide', persistNow);
window.addEventListener('hashchange', route);
window.addEventListener('error', () => toast('Ocorreu um erro inesperado.', 'error'));
window.addEventListener('unhandledrejection', () => toast('Ocorreu um erro inesperado.', 'error'));

(async function start() {
  const st = await storage.init();
  if (!st.persistent) setSave('volatile');
  else await recoverJournal();
  await route();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* funciona sem service worker */ });
  }
})();
