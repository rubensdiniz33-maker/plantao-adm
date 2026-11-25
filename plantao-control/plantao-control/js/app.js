// PLANTÃO ADM — interface, rotas e fluxo do plantão.
import * as storage from './storage.js';
import * as formcfg from './formconfig.js';
import * as prefs from './prefs.js';
import {
  SECTORS, SECTOR_BY_ID, defaultFields, NA, MAX_TEXT, MAX_NUM_DIGITS, conditionMet, isAnswered, splitNames, sectorProgress, sectorAlerts,
  sectorStatus, effectiveAnswers, nextAttention, shiftSummary,
} from './sectors.js';
import {
  MAX_ACTIVITY, validateIdentification, cleanName, normalizeShift, parseBackup, buildBackup,
} from './validation.js';
import {
  openingMessage, reportText, finalReportText, BULLETS, DEFAULT_FORMAT, isDefaultFormat, missingList, alertsList, whatsappToHtml, formatDateBR, hoursText, shiftName, joinNames,
} from './report.js';
import { copyText, shareWhatsApp, buildPngs, buildPdf, downloadBlob, shareFiles } from './export.js';
import {
  h, icon, toast, dialog, confirmDialog, sheet, attachWaCopy, longDate, todayISO, dateTimeBR, uuid, pad2,
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
  const compact = b.classList.contains('compact');
  b.className = `savebadge ${save.state}${compact ? ' compact' : ''}`;
  b.replaceChildren();
  const full = { saving: 'Salvando…', saved: save.at ? `Salvo ${pad2(save.at.getHours())}:${pad2(save.at.getMinutes())}` : 'Salvo', volatile: 'Não salvo (sem armazenamento)', error: 'Erro ao salvar · tentar de novo' }[save.state];
  b.setAttribute('aria-label', full);
  b.title = full;
  if (save.state === 'saving') b.append(compact ? icon('refresh') : 'Salvando…');
  else if (save.state === 'saved') {
    b.append(icon('check'));
    if (!compact) b.append(full);
    if (flash) { b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash'); }
  } else if (save.state === 'volatile') b.append(icon('alert'), 'Não salvo (sem armazenamento)');
  else b.append(icon('alert'), 'Erro ao salvar · tentar de novo');
}

function saveBadge(compact = false) {
  const b = h('button', { class: `savebadge${compact ? ' compact' : ''}`, type: 'button', 'aria-live': 'polite', onclick: () => { if (save.state === 'error') flush(); } });
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
    else if (prog.status === 'done' && !meta.doneAt && !meta.carried) log(shift, 'done', `${sector.title} preenchido`, sector.id);
    else if (!sess.startedLogged) log(shift, 'update', `${sector.title} atualizado`, sector.id);
    if (prog.status === 'done' && !meta.doneAt && !meta.carried) meta.doneAt = nowISO();
    sess.dirty = false;
    sess.startedLogged = false;
    touch(shift);
  }
  if (end) sess = null;
}

// =====================================================================
// Home
// =====================================================================
const hasAnswers = (sh) => Object.values(sh.answers || {}).some((a) => a && Object.keys(a).length);

function screenHome(shifts) {
  const active = shifts.filter((s) => s.status === 'em_andamento').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const last = shifts.find((s) => s.status === 'finalizado' && (!active || s.id !== active.id));
  const children = [
    h('div', { class: 'tri', 'aria-hidden': 'true' }, h('i'), h('i')),
    h('div', { class: 'brandrow' },
      h('div', { class: 'logo' }, icon('logo')),
      h('div', null,
        h('h1', { class: 'brand' }, 'PLANTÃO ', h('span', null, 'ADM')),
        h('div', { class: 'datehero' }, longDate())),
      h('a', { class: 'iconbtn adminbtn', href: '#/admin', id: 'btn-admin', 'aria-label': 'Editar formulário (acesso com senha)' }, icon('settings'))),
    storageBanner(),
  ];
  const startNew = async () => {
    // Uma única pergunta: começar em branco ou a partir do último plantão (de quem quer que tenha preenchido).
    // Plantão em andamento não gera pergunta: continua acessível em "Retomar" na Home.
    const base = shifts.find((s) => hasAnswers(s));
    if (!base) { go('#/novo'); return; }
    const c = await dialog({
      title: 'Continuar a partir do último plantão?',
      body: h('div', { class: 'stack', style: 'gap:6px' },
        h('div', null, h('b', null, shiftTitle(base)), h('div', { class: 'meta' }, `${hoursText(base)} · ${joinNames(base.nurses)}${base.status === 'finalizado' ? '' : ' · não finalizado'}`)),
        h('p', null, 'Copia as informações para você só confirmar e alterar o que mudou, setor a setor.')),
      actions: [
        { label: 'Não, em branco', value: 'blank', variant: 'secondary' },
        { label: 'Sim, continuar', value: 'carry', variant: 'primary' },
      ],
    });
    if (c === 'carry') go(`#/novo/${base.id}`);
    else if (c === 'blank') go('#/novo');
  };

  children.push(h('div', { class: 'herozone' },
    h('button', { class: 'btn primary hero block', type: 'button', id: 'btn-start', onclick: startNew }, icon('plus'), 'INICIAR PLANTÃO'),
    active
      ? h('a', { class: 'resume', href: `#/p/${active.id}`, id: 'btn-resume' }, icon('play'),
        h('span', { class: 'ell' }, `Retomar plantão em andamento · ${shiftTitle(active)}`))
      : null));
  const links = [];
  if (last) links.push(h('button', { class: 'linkbtn', type: 'button', id: 'btn-last', onclick: () => {
    let sh;
    sh = sheet({ title: 'Último plantão', body: h('div', { class: 'stack' },
      h('div', null, h('h3', null, shiftTitle(last)), h('div', { class: 'meta' }, `${hoursText(last)} · ${joinNames(last.nurses)}`)),
      h('div', { class: 'row' },
        h('a', { class: 'btn secondary', href: `#/p/${last.id}/relatorio`, id: 'btn-last-report', onclick: () => sh.close() }, icon('file'), 'Relatório'),
        h('a', { class: 'btn secondary', href: `#/p/${last.id}`, id: 'btn-last-open', onclick: () => sh.close() }, icon('edit'), 'Editar'))) });
  } }, icon('clock'), 'Último plantão'));
  links.push(h('button', { class: 'linkbtn', type: 'button', id: 'btn-backup', onclick: () => openBackupSheet() }, icon('download'), 'Backup'));
  children.push(h('div', { class: 'spacer' }), h('div', { class: 'linkrow' }, links), credit());
  mount(h('main', { class: 'screen home' }, children));
}

const credit = () => h('p', { class: 'credit', id: 'credit' }, 'por ENF Rubens Diniz');

// ---------- Backup (exportar / importar) ----------
function openBackupSheet() {
  let sh;
  const fileIn = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, id: 'import-file', onchange: async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('O arquivo é grande demais para ser um backup válido.');
      const { shifts: incoming, rejected } = parseBackup(await file.text());
      const current = await storage.listShifts();
      const map = new Map(current.map((x) => [x.id, x]));
      const toWrite = incoming.filter((x) => !map.has(x.id) || x.updatedAt > map.get(x.id).updatedAt);
      const added = toWrite.filter((x) => !map.has(x.id)).length;
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
      sh.close();
      route();
    } catch (err) {
      toast(err.message || 'Não foi possível importar o arquivo.', 'error');
    }
  } });
  const body = h('div', { class: 'stack' },
    h('p', { class: 'note' }, 'Guarde uma cópia dos plantões ou leve-os para outro aparelho. Os dados ficam só neste dispositivo e navegador; não há sincronização.'),
    h('div', { class: 'row' },
      h('button', { class: 'btn secondary', type: 'button', id: 'btn-export-backup', onclick: async () => {
        try {
          const all = await storage.listShifts();
          if (!all.length) { toast('Não há plantões para exportar.', 'error'); return; }
          downloadBlob(new Blob([buildBackup(all)], { type: 'application/json' }), `plantao-adm-backup-${todayISO()}.json`);
          toast('Backup exportado', 'ok');
        } catch { toast('Não foi possível exportar o backup.', 'error'); }
      } }, icon('download'), 'Exportar'),
      h('button', { class: 'btn secondary', type: 'button', id: 'btn-import-backup', onclick: () => fileIn.click() }, icon('upload'), 'Importar'),
      fileIn));
  sh = sheet({ title: 'Backup dos dados', body });
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

function screenOpening(shift, shifts, base) {
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
  attachWaCopy(preview);

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
  const recent = [];
  for (const sh of shifts) for (const n of sh.nurses) if (!recent.includes(n) && recent.length < 8) recent.push(n);
  const chipBox = h('div', { class: 'chips', id: 'recent-nurses' });
  function drawChips() {
    const used = new Set(form.nurses.map((n) => cleanName(n).toLowerCase()));
    const list = recent.filter((n) => !used.has(n.toLowerCase()));
    chipBox.hidden = !isNew || !list.length;
    chipBox.replaceChildren(h('span', { class: 'lbl2' }, 'Recentes:'), ...list.map((n) => h('button', {
      class: 'chip', type: 'button', 'data-name': n,
      onclick: () => {
        const empty = form.nurses.findIndex((x) => !cleanName(x));
        if (empty >= 0) form.nurses[empty] = n; else form.nurses.push(n);
        drawNurses(); update();
      },
    }, n)));
  }
  function drawNurses(focusIdx) {
    nurseBox.replaceChildren(...form.nurses.map((n, i) => {
      const inp = h('input', {
        class: 'input', type: 'text', maxlength: '60', autocomplete: 'off', autocapitalize: 'words', enterkeyhint: 'done',
        placeholder: i === 0 ? 'Enfermeiro responsável' : 'Enfermeiro adicional', 'aria-label': i === 0 ? 'Enfermeiro responsável' : `Enfermeiro adicional ${i}`,
        'data-nurse': String(i),
        oninput: (e) => { form.nurses[i] = e.target.value; update(); drawChips(); },
      });
      inp.value = n;
      return h('div', { class: 'nurse' }, inp,
        form.nurses.length > 1
          ? h('button', { class: 'iconbtn', type: 'button', 'aria-label': `Remover enfermeiro ${i + 1}`, onclick: () => { form.nurses.splice(i, 1); drawNurses(); update(); } }, icon('x'))
          : null);
    }));
    if (focusIdx !== undefined) nurseBox.querySelectorAll('input')[focusIdx]?.focus();
    drawChips();
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
      preview.innerHTML = whatsappToHtml(openingMessage({ ...form, nurses: form.nurses.map(cleanName).filter(Boolean) }));
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
    class: 'btn primary', type: 'button', id: 'btn-copy-open',
    onclick: async () => toast((await copyText(msgText())) ? 'Mensagem copiada' : 'Não foi possível copiar. Selecione o texto manualmente.', 'ok'),
  }, icon('copy'), 'Copiar');
  const shareBtn = h('button', {
    class: 'btn wa', type: 'button', id: 'btn-wa-open',
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
        answers: {}, sectorMeta: {}, activity: [], carriedFrom: base ? base.id : null,
      };
      if (base) {
        for (const sec of SECTORS) {
          const a = base.answers[sec.id];
          if (a && Object.keys(a).length) {
            s.answers[sec.id] = JSON.parse(JSON.stringify(a));
            s.sectorMeta[sec.id] = { firstAt: null, doneAt: null, carried: true };
          }
        }
      }
      log(s, 'start', base ? `Plantão iniciado a partir do plantão de ${formatDateBR(base.date)}` : 'Plantão iniciado');
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
      go(`#/p/${s.id}`);
    },
  }, 'Começar o preenchimento');

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
      h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Enfermeiros responsáveis'), nurseBox, chipBox, addBtn, errNurses),
      h('div', { class: 'sectiontitle' }, 'Mensagem de apresentação (atualiza sozinha)'),
      preview,
      isNew ? null : h('p', { class: 'note' }, 'As alterações são salvas automaticamente.')),
    h('div', { class: 'actionbar cta stack2' },
      h('div', { class: 'row' }, copyBtn, shareBtn),
      isNew ? createBtn : h('a', { class: 'btn secondary lg', href: `#/p/${shift.id}`, id: 'btn-to-panel' }, 'Ir para o painel')));
  mount(screen);
  drawNurses();
  update();
  ready = true;
}

// =====================================================================
// Painel de setores
// =====================================================================
const ST_TEXT = { none: 'Não iniciado', progress: 'Em preenchimento', review: 'Revisar informações', done: 'Preenchido' };

function screenPanel(shift) {
  const sm = shiftSummary(shift);
  const fill = h('i');
  const order = prefs.orderedSectors();
  const list = h('div', { class: 'sectors' }, order.map((sector) => {
    const status = sectorStatus(shift, sector);
    const ans = effectiveAnswers(shift, sector.id);
    const prog = sectorProgress(sector, ans);
    const alerts = sectorAlerts(sector, ans);
    return h('a', {
      class: `sec ${status}${alerts.length ? ' alert' : ''}`, href: `#/p/${shift.id}/s/${sector.id}`, id: `sec-${sector.id}`,
      'data-status': status, 'data-alert': alerts.length ? '1' : '0',
      'aria-label': `${sector.title}: ${ST_TEXT[status]}${alerts.length ? ', com ocorrência' : ''}`,
    },
    h('span', { class: 'ico' }, icon(sector.icon)),
    h('span', { class: 'txt' },
      h('span', { class: 'name' }, sector.title),
      h('span', { class: 'st' }, ST_TEXT[status]),
      alerts.length || status === 'progress'
        ? h('span', { class: 'tags' },
          alerts.length ? h('span', { class: 'tag amber' }, icon('alert'), 'Ocorrência') : null,
          status === 'progress' ? h('span', { class: 'tag pend' }, `${prog.missing.length} pend.`) : null,
          null)
        : null),
    status === 'done' && !alerts.length ? h('span', { class: 'tag ok' }, icon('check')) : null,
    icon('chevron', 'chev'));
  }));

  const nxt = nextAttention(shift, -1, order);
  const screen = h('main', { class: 'screen' },
    topbar({
      title: 'Painel', sub: `${shift.type === 'N' ? 'Noturno' : 'Manhã/Tarde'} · ${formatDateBR(shift.date)}`, back: '#/',
      right: h('div', { style: 'display:flex;align-items:center;gap:2px' }, saveBadge(),
        h('a', { class: 'iconbtn', href: `#/p/${shift.id}/abertura`, 'aria-label': 'Dados do plantão e mensagem de início', id: 'btn-edit-shift' }, icon('edit'))),
    }),
    h('div', { class: 'content' },
      storageBanner(),
      shift.status === 'finalizado'
        ? h('div', { class: 'banner warn' }, icon('flag'), h('div', null, `Plantão finalizado em ${dateTimeBR(shift.finalizedAt)}. Alterações atualizam o relatório.`))
        : null,
      sm.review
        ? h('div', { class: 'banner info', id: 'review-banner' }, icon('refresh'), h('div', null, `${sm.review} setor(es) vieram do plantão anterior. Abra cada um, altere o que mudou e confirme.`))
        : null,
      h('div', { class: 'card panelhead' },
        h('div', { class: 'line' }, h('span', { class: 'big', id: 'progress-label' }, `${sm.done} de ${sm.total} setores preenchidos`), h('span', { class: 'meta' }, hoursText(shift))),
        h('div', { class: 'pbar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(sm.total), 'aria-valuenow': String(sm.done) }, fill),
        h('div', { class: 'counts' },
          h('span', null, h('i', { class: 'dot done' }), h('b', null, sm.done), ' preenchidos'),
          sm.review ? h('span', null, h('i', { class: 'dot review' }), h('b', null, sm.review), ' para revisar') : null,
          h('span', null, h('i', { class: 'dot progress' }), h('b', null, sm.progress), ' em preenchimento'),
          h('span', null, h('i', { class: 'dot' }), h('b', null, sm.none), ' não iniciados'),
          h('span', null, h('i', { class: 'dot alert' }), h('b', null, sm.alerts), ' com ocorrência'))),
      list),
    h('div', { class: 'actionbar' },
      nxt ? h('a', { class: 'btn secondary fit', href: `#/p/${shift.id}/relatorio`, id: 'btn-report' }, icon('file'), 'Relatório') : null,
      nxt
        ? h('a', { class: 'btn primary', href: `#/p/${shift.id}/s/${nxt.id}`, id: 'btn-continue' }, icon('play'), h('span', { class: 'ell' }, `Continuar: ${nxt.title}`))
        : h('a', { class: 'btn primary', href: `#/p/${shift.id}/relatorio`, id: 'btn-report' }, icon('file'), 'Ver relatório')));
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
  } else if (f.type === 'multi') {
    // lista de nomes (ex.: mais de um médico): guarda um por linha
    const box = h('div', { class: 'multi' });
    const rows = [];
    const joined = () => rows.map((r) => r.input.value.trim()).filter(Boolean).join('\n');
    const commit = () => setVal(joined() || undefined);
    const syncRm = () => rows.forEach((r) => { r.rm.hidden = rows.length < 2; r.input.setAttribute('aria-label', `${f.label} ${rows.indexOf(r) + 1}`); });
    const addRow = (val = '', focus = false) => {
      const input = h('input', { class: 'input', type: 'text', maxlength: '120', autocomplete: 'off', placeholder: f.placeholder || '', value: val, enterkeyhint: 'done' });
      const rm = h('button', { type: 'button', class: 'stepbtn rm', 'aria-label': 'Remover este nome', onclick: () => {
        const i = rows.findIndex((r) => r.input === input);
        rows[i].line.remove(); rows.splice(i, 1); syncRm(); commit();
      } }, icon('x'));
      const line = h('div', { class: 'valuerow' }, input, rm);
      const r = { input, rm, line };
      input.addEventListener('input', commit);
      rows.push(r); box.append(line); syncRm();
      if (focus) input.focus();
    };
    const existing = splitNames(answers[f.id]);
    (existing.length ? existing : ['']).forEach((n) => addRow(n));
    control = h('div', { class: 'stack', style: 'gap:8px' }, box,
      h('button', { type: 'button', class: 'btn secondary small addmore', id: `add-${f.id}`, onclick: () => addRow('', true) }, icon('plus'), f.addLabel || 'Adicionar'));
    refresh = () => {};
  } else {
    const multiline = f.type === 'area';
    const isNum = f.type === 'num';
    const input = multiline
      ? h('textarea', { class: 'textarea', maxlength: String(MAX_TEXT), rows: '2', 'aria-labelledby': qid, placeholder: f.placeholder || '', enterkeyhint: 'enter' })
      : h('input', isNum
        ? { class: 'input', type: 'text', inputmode: 'numeric', pattern: '[0-9]*', maxlength: String(MAX_NUM_DIGITS), autocomplete: 'off', 'aria-labelledby': qid, placeholder: '0', enterkeyhint: 'done' }
        : { class: 'input', type: 'text', maxlength: String(MAX_TEXT), autocomplete: 'off', 'aria-labelledby': qid, placeholder: f.placeholder || '', enterkeyhint: 'done' });
    const grow = () => { if (multiline) { input.style.height = 'auto'; input.style.height = `${Math.max(76, input.scrollHeight + 2)}px`; } };
    const na = h('button', { type: 'button', class: 'nabtn', 'aria-pressed': 'false', 'aria-label': 'Não se aplica', onclick: () => {
      if (answers[f.id] === NA) { input.value = ''; setVal(undefined); input.focus(); } else { input.value = ''; setVal(NA); }
    } }, 'N/A');
    input.addEventListener('input', () => {
      let v = input.value;
      if (isNum) {
        const cleaned = v.replace(/\D/g, '').slice(0, MAX_NUM_DIGITS);
        if (cleaned !== v) { input.value = cleaned; v = cleaned; }
      }
      grow();
      setVal(v.trim() === '' ? undefined : (isNum ? v : v.trim()));
    });
    const step = (d) => {
      const cur = /^\d+$/.test(answers[f.id] || '') ? Number(answers[f.id]) : null;
      const n = cur === null ? (d > 0 ? 1 : 0) : Math.min(999999, Math.max(0, cur + d));
      input.value = String(n);
      setVal(String(n));
    };
    control = h('div', { class: 'valuerow' }, input,
      isNum ? h('button', { type: 'button', class: 'stepbtn', 'aria-label': 'Diminuir', 'data-step': '-1', onclick: () => step(-1) }, icon('minus')) : null,
      isNum ? h('button', { type: 'button', class: 'stepbtn', 'aria-label': 'Aumentar', 'data-step': '1', onclick: () => step(1) }, icon('plus')) : null,
      na);
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
    if (!isAnswered(v)) t = f.optional ? 'opcional' : '';
    else if (v === NA) t = 'Não se aplica';
    else t = '';
    stateEl.textContent = t;
    wrap.classList.toggle('answered', isAnswered(v));
  };
  const update = () => { refresh(); paintState(); };
  update();
  return { el: wrap, update };
}

function openSectorSheet(shift, currentId, onOrder) {
  let sh;
  const sm = shiftSummary(shift);
  const fill = h('i');
  const rowsBox = h('div', { class: 'srows', id: 'srows' });
  const resetBtn = h('button', { class: 'linkbtn', type: 'button', id: 'btn-reset-order', hidden: !prefs.isCustomOrder() }, icon('refresh'), 'Ordem padrão');
  const renumber = () => [...rowsBox.children].forEach((w, i) => { w.querySelector('.t').textContent = `${i + 1}. ${w.dataset.title}`; });
  const commit = () => {
    prefs.setOrder([...rowsBox.children].map((w) => w.dataset.wrap));
    renumber(); resetBtn.hidden = !prefs.isCustomOrder();
    if (onOrder) onOrder();
  };

  const mkRow = (sec) => {
    const status = sectorStatus(shift, sec);
    const alerts = sectorAlerts(sec, effectiveAnswers(shift, sec.id)).length > 0;
    const btn = h('button', {
      class: 'srow', type: 'button', 'data-sector': sec.id, id: `srow-${sec.id}`, 'aria-current': sec.id === currentId ? 'true' : 'false',
      onclick: () => { sh.close(); if (sec.id !== currentId) go(`#/p/${shift.id}/s/${sec.id}`); },
    },
    h('i', { class: `dot ${status === 'done' ? 'done' : (status === 'progress' || status === 'review') ? 'progress' : ''}` }),
    h('span', { class: 'nm' }, h('span', { class: 't' }, sec.title), h('small', { class: 'stx' }, ST_TEXT[status])),
    alerts ? h('span', { class: 'tag amber compact', title: 'Ocorrência', 'aria-label': 'Com ocorrência' }, icon('alert')) : null);
    const handle = h('span', { class: 'drag', role: 'button', tabindex: '0', 'data-drag': sec.id, 'aria-label': `Reordenar ${sec.title}: arraste ou use as setas para cima e para baixo` }, icon('drag'));
    const wrap = h('div', { class: 'srowwrap', 'data-wrap': sec.id, 'data-title': sec.title }, btn, handle);

    // arrastar (toque/mouse) — a ordem é só da navegação; o relatório final não muda
    handle.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      try { handle.setPointerCapture(e.pointerId); } catch { /* ok */ }
      const box = rowsBox.closest('.sheetbody');
      const rowH = wrap.offsetHeight + 6;
      const grab = e.clientY - wrap.getBoundingClientRect().top;
      let curY = e.clientY, raf = 0, moved = false;
      wrap.classList.add('dragging');
      const place = () => {
        wrap.style.transform = '';
        const top = rowsBox.getBoundingClientRect().top;
        const n = rowsBox.children.length;
        const k = Math.max(0, Math.min(n - 1, Math.floor((curY - grab + wrap.offsetHeight / 2 - top) / rowH)));
        const cur = [...rowsBox.children].indexOf(wrap);
        if (k !== cur) { const ref = [...rowsBox.children].filter((x) => x !== wrap)[k]; if (ref) rowsBox.insertBefore(wrap, ref); else rowsBox.append(wrap); moved = true; }
        const nat = rowsBox.getBoundingClientRect().top + [...rowsBox.children].indexOf(wrap) * rowH;
        wrap.style.transform = `translateY(${curY - grab - nat}px)`;
      };
      const tick = () => {
        const br = box.getBoundingClientRect();
        if (curY < br.top + 56) box.scrollTop -= 10; else if (curY > br.bottom - 56) box.scrollTop += 10;
        place(); raf = requestAnimationFrame(tick);
      };
      const move = (ev) => { curY = ev.clientY; };
      const end = () => {
        cancelAnimationFrame(raf);
        handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end);
        place(); wrap.style.transform = ''; wrap.classList.remove('dragging');
        if (moved) commit();
      };
      handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
      tick();
    });
    handle.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      const ref = e.key === 'ArrowUp' ? wrap.previousElementSibling : wrap.nextElementSibling;
      if (!ref) return;
      if (e.key === 'ArrowUp') rowsBox.insertBefore(wrap, ref); else rowsBox.insertBefore(ref, wrap);
      handle.focus(); wrap.scrollIntoView({ block: 'nearest' }); commit();
    });
    return wrap;
  };
  prefs.orderedSectors().forEach((sec) => rowsBox.append(mkRow(sec)));
  renumber();
  resetBtn.onclick = () => {
    const by = Object.fromEntries([...rowsBox.children].map((w) => [w.dataset.wrap, w]));
    SECTORS.forEach((sec) => rowsBox.append(by[sec.id]));
    prefs.resetOrder(); renumber(); resetBtn.hidden = true;
    if (onOrder) onOrder();
  };

  const list = () => prefs.orderedSectors();
  const curIdx = () => list().findIndex((x) => x.id === currentId);
  const nxt = nextAttention(shift, curIdx(), list());
  const body = h('div', { class: 'stack' },
    h('div', { class: 'stack sheetsum', style: 'gap:6px' },
      h('b', { id: 'sheet-count' }, `${sm.done} de ${sm.total} preenchidos${sm.review ? ` · ${sm.review} p/ revisar` : ''}`),
      h('div', { class: 'pbar' }, fill),
      nxt ? h('button', { class: 'btn secondary small block', type: 'button', id: 'btn-sheet-next', onclick: () => {
        const n = nextAttention(shift, curIdx(), list());
        sh.close(); if (n && n.id !== currentId) go(`#/p/${shift.id}/s/${n.id}`);
      } }, icon('play'), h('span', { class: 'ell' }, `Ir para o próximo pendente: ${nxt.title}`)) : null),
    h('div', { class: 'srows-head' }, h('span', { class: 'note' }, 'Segure e arraste ⠿ para reorganizar. Fica salvo neste aparelho; o relatório mantém a ordem padrão.'), resetBtn),
    rowsBox);
  sh = sheet({ title: 'Ir para o setor', body });
  requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = `${(sm.done / sm.total) * 100}%`; }));
  const cur = body.querySelector('[aria-current="true"]');
  const box = body.closest('.sheetbody');
  if (cur && box) box.scrollTop = cur.closest('.srowwrap').offsetTop - box.clientHeight / 2 + 30;
}

function screenSector(shift, sector) {
  const orderNow = () => prefs.orderedSectors();
  const posNow = () => orderNow().findIndex((s) => s.id === sector.id);
  const answers = shift.answers[sector.id] || (shift.answers[sector.id] = {});
  const stLabel = h('span', { class: 'sub', id: 'sector-status' });
  const items = [];
  const alertBox = h('div', { class: 'inlinenote warn', hidden: true, id: 'sector-alerts' });
  const carried = () => !!shift.sectorMeta[sector.id]?.carried;
  const reviewNote = h('div', { class: 'inlinenote', id: 'review-note', hidden: !carried() },
    'Dados do plantão anterior: confira, altere o que mudou e toque em Confirmar e seguir.');

  sess = { shift, sector, dirty: false, startedLogged: false };

  // posição no fluxo (ex.: 9/13) e filete fino de progresso por posição
  const fill = h('i');
  const selCount = h('span', { id: 'sel-count' });
  const bar = h('div', { class: 'pbar thin', role: 'progressbar', 'aria-valuemin': '1', 'aria-valuemax': String(SECTORS.length) }, fill);
  const updateStrip = () => { const p = posNow(); selCount.textContent = `${p + 1}/${SECTORS.length}`; bar.setAttribute('aria-valuenow', String(p + 1)); requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = `${((p + 1) / SECTORS.length) * 100}%`; })); };

  const confirmBtn = h('button', { class: 'btn green', type: 'button', id: 'btn-confirm-sector', hidden: !carried(), onclick: () => {
    const meta = shift.sectorMeta[sector.id];
    meta.carried = false;
    meta.firstAt = meta.firstAt || nowISO();
    if (sectorProgress(sector, answers).status === 'done') meta.doneAt = meta.doneAt || nowISO();
    log(shift, 'done', `${sector.title} revisado e confirmado`, sector.id);
    sess.dirty = false;
    sess.startedLogged = false;
    touch(shift);
    refreshAll();
    goNext();
  } }, icon('check'), 'Confirmar e seguir');
  const nextLabel = h('span', null, 'Próximo');
  const nextBtn = h('button', { class: 'btn primary', type: 'button', id: 'btn-next-sector', hidden: carried(), onclick: () => goNext() }, nextLabel, icon('right'));
  // Sequencial na ordem do usuário; depois do último, abre o relatório (sem voltar ao início).
  function goNext() {
    const n = orderNow()[posNow() + 1];
    go(n ? `#/p/${shift.id}/s/${n.id}` : `#/p/${shift.id}/relatorio`);
  }
  const prevBtn = h('button', { class: 'btn secondary sq', type: 'button', id: 'btn-prev-sector', onclick: () => { const p = orderNow()[posNow() - 1]; if (p) go(`#/p/${shift.id}/s/${p.id}`); } }, icon('left'));
  const refreshNav = () => {
    const p = posNow(), l = orderNow();
    nextLabel.textContent = p === l.length - 1 ? 'Ver relatório' : 'Próximo';
    prevBtn.disabled = p === 0;
    prevBtn.setAttribute('aria-label', p > 0 ? `Setor anterior: ${l[p - 1].title}` : 'Primeiro setor');
    updateStrip();
  };

  const refreshAll = () => {
    for (const it of items) it.el.hidden = !conditionMet(it.f.showIf, answers);
    const prog = sectorProgress(sector, answers);
    const c = carried();
    stLabel.textContent = c ? 'Revisar informações' : { none: 'Não iniciado', progress: `${prog.missing.length} pendente(s)`, done: 'Preenchido' }[prog.status];
    const al = sectorAlerts(sector, answers);
    alertBox.hidden = al.length === 0;
    alertBox.replaceChildren(icon('alert'), h('span', null, h('b', null, 'Ocorrência: '), al.join(' · ')));
    reviewNote.hidden = !c;
    confirmBtn.hidden = !c;
    nextBtn.hidden = c;
    refreshNav();
  };

  const onChange = () => {
    if (!sess) return;
    const meta = shift.sectorMeta[sector.id] || (shift.sectorMeta[sector.id] = { firstAt: null, doneAt: null, carried: false });
    if (!meta.firstAt && !meta.carried) {
      meta.firstAt = nowISO();
      if (shift.status !== 'finalizado') { log(shift, 'update', `${sector.title}: preenchimento iniciado`, sector.id); sess.startedLogged = true; }
    }
    sess.dirty = true;
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

  const screen = h('main', { class: 'screen' },
    h('div', { class: 'stickyhead' },
      h('header', { class: 'topbar' },
        h('a', { class: 'iconbtn', href: `#/p/${shift.id}`, 'aria-label': 'Voltar ao painel', id: 'btn-back-panel' }, icon('back')),
        h('h1', null, sector.title, stLabel),
        saveBadge(true),
        h('button', { class: 'selbtn', type: 'button', id: 'btn-sectors', 'aria-label': 'Escolher outro setor', onclick: () => openSectorSheet(shift, sector.id, refreshNav) }, icon('grid'), selCount)),
      bar),
    h('div', { class: 'content tight' },
      storageBanner(),
      items.map((it) => it.el),
      reviewNote,
      alertBox,
      h('p', { class: 'note' }, 'Não registre nomes de pacientes nem outros dados pessoais identificáveis.')),
    h('div', { class: 'actionbar' },
      prevBtn,
      h('a', { class: 'btn secondary fit', href: `#/p/${shift.id}/relatorio`, id: 'btn-report-sector', 'aria-label': 'Ver relatório' }, icon('file'), h('span', { class: 'ell' }, 'Relatório')),
      confirmBtn, nextBtn));
  mount(screen);
  items.forEach((it) => it.update());
}

// =====================================================================
// Relatório
// =====================================================================
function screenReport(shift) {
  let fmt = prefs.getFormat();
  const fr = finalReportText(shift, fmt);
  let auto = fr.auto;
  const miss = missingList(shift);
  const alerts = alertsList(shift);
  const reviewCount = miss.filter((m) => m.status === 'review').length;
  const totalMissing = miss.filter((m) => m.status !== 'review').reduce((n, m) => n + m.labels.length, 0);
  const imgBox = h('div', { class: 'imgpages' });
  let urls = [];

  // Editor do texto final: o enfermeiro revisa e pode digitar alterações; o que ele escreve é o que Copiar/WhatsApp enviam.
  const editor = h('textarea', { class: 'textarea reporttext', id: 'report-text', spellcheck: 'false', autocapitalize: 'off', 'aria-label': 'Texto do relatório (editável)' });
  editor.value = fr.text;
  editor.hidden = true;
  const previewEl = h('div', { class: 'preview', id: 'report-preview', html: whatsappToHtml(fr.text) });
  attachWaCopy(previewEl);
  const getText = () => editor.value;
  const grow = () => { editor.style.height = 'auto'; editor.style.height = `${Math.max(240, editor.scrollHeight + 4)}px`; };
  const editBadge = h('span', { class: 'editedtag', id: 'edited-tag', hidden: true }, 'Editado');
  const staleBox = h('div', { class: 'banner warn', id: 'stale-box', hidden: true }, icon('alert'),
    h('div', { class: 'grow1' }, 'Os dados ou a formatação mudaram depois da sua edição. O texto abaixo continua sendo a sua versão editada.',
      h('div', { class: 'row', style: 'margin-top:8px' },
        h('button', { class: 'btn secondary small', type: 'button', id: 'btn-regen', onclick: () => { resetEdit(); toast('Texto atualizado com os dados atuais', 'ok'); } }, icon('refresh'), 'Usar dados atuais (descarta edição)'))));
  const restoreBtn = h('button', { class: 'linkbtn', type: 'button', id: 'btn-restore', hidden: true, onclick: async () => {
    if (await confirmDialog({ title: 'Restaurar texto original?', message: 'Suas alterações manuais neste relatório serão descartadas e o texto voltará a ser gerado a partir dos setores.', confirmText: 'Restaurar' })) { resetEdit(); toast('Texto original restaurado', 'ok'); }
  } }, icon('refresh'), 'Restaurar texto original');
  const paintEdit = () => {
    const edited = !!shift.reportEdit;
    editBadge.hidden = !edited;
    restoreBtn.hidden = !edited;
    staleBox.hidden = !(edited && shift.reportEdit.base !== auto);
    const fm = !isDefaultFormat(fmt);
    fmtBtn.classList.toggle('on', fm);
  };
  function resetEdit() {
    shift.reportEdit = null;
    editor.value = auto;
    grow();
    touch(shift);
    paintEdit();
    if (!previewEl.hidden) previewEl.innerHTML = whatsappToHtml(getText());
  }
  // formatação personalizada mudou: regenera o texto base (preserva edição manual, que passa a "desatualizada")
  const reflow = () => {
    fmt = prefs.getFormat();
    auto = reportText(shift, fmt);
    if (!shift.reportEdit) { editor.value = auto; grow(); }
    paintEdit();
    previewEl.innerHTML = whatsappToHtml(getText());
  };
  const openFormat = () => {
    const mk = (key, label) => {
      const cb = h('input', { type: 'checkbox', 'data-fmt': key, checked: !!fmt[key],
        onchange: () => { prefs.setFormat({ ...prefs.getFormat(), [key]: cb.checked }); reflow(); } });
      return h('label', { class: 'checkrow' }, cb, ` ${label}`);
    };
    const bulletBtns = BULLETS.map(([v, l]) => h('button', { type: 'button', class: 'chip', 'data-bullet': v || 'none', 'aria-pressed': String(fmt.bullet === v),
      onclick: () => { prefs.setFormat({ ...prefs.getFormat(), bullet: v }); sync(); reflow(); } }, l));
    const toggles = [['boldQuestions', 'Perguntas em negrito'], ['boldTitles', 'Títulos dos setores em negrito'], ['upperTitles', 'Títulos em MAIÚSCULAS'],
      ['numberTitles', 'Numerar os setores (1., 2., …)'], ['blankBetween', 'Linha em branco entre os setores'], ['showDate', 'Incluir a data no topo']].map(([k, l]) => mk(k, l));
    const sync = () => { const f = prefs.getFormat(); toggles.forEach((t) => { const c = t.querySelector('input'); c.checked = !!f[c.dataset.fmt]; }); bulletBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(f.bullet === BULLETS[i][0]))); };
    const reset = h('button', { class: 'btn ghost', type: 'button', id: 'fmt-reset', onclick: () => { prefs.resetFormat(); sync(); reflow(); toast('Formatação padrão restaurada', 'ok'); } }, icon('refresh'), 'Restaurar formatação padrão');
    sheet({ title: 'Formatação da mensagem', body: h('div', { class: 'stack', id: 'fmt-sheet' },
      h('p', { class: 'note' }, 'O padrão é o modelo do WhatsApp. Suas escolhas ficam salvas neste navegador e valem para os próximos relatórios. A ordem dos setores não muda.'),
      h('b', null, 'Marcador das perguntas'), h('div', { class: 'chips' }, bulletBtns), toggles, reset) });
  };
  editor.addEventListener('input', () => {
    grow();
    const v = editor.value;
    shift.reportEdit = (v === auto || !v.trim()) ? null : { text: v, base: auto };
    touch(shift);
    paintEdit();
  });

  const fmtBtn = h('button', { class: 'tab fmtbtn', type: 'button', id: 'btn-format', onclick: openFormat, 'aria-label': 'Formatação da mensagem' }, icon('settings'));
  const tabEdit = h('button', { class: 'tab', type: 'button', id: 'tab-edit', role: 'tab', 'aria-selected': 'false' }, icon('edit'), 'Editar texto');
  const tabFmt = h('button', { class: 'tab on', type: 'button', id: 'tab-fmt', role: 'tab', 'aria-selected': 'true' }, icon('check'), 'Prévia WhatsApp');
  const setTab = (fmt) => {
    tabEdit.classList.toggle('on', !fmt); tabFmt.classList.toggle('on', fmt);
    tabEdit.setAttribute('aria-selected', String(!fmt)); tabFmt.setAttribute('aria-selected', String(fmt));
    editor.hidden = fmt; previewEl.hidden = !fmt;
    if (fmt) previewEl.innerHTML = whatsappToHtml(getText()); else grow();
  };
  tabEdit.onclick = () => setTab(false);
  tabFmt.onclick = () => setTab(true);

  const busy = (btn, on) => { btn.disabled = on; };

  const btnCopy = h('button', { class: 'btn primary lg', type: 'button', id: 'btn-copy-report', onclick: async () => {
    const t = getText();
    if (!t.trim()) { toast('O relatório está vazio.', 'error'); return; }
    toast((await copyText(t)) ? 'Relatório copiado. Cole no WhatsApp.' : 'Não foi possível copiar. Selecione o texto e copie manualmente.', 'ok');
  } }, icon('copy'), 'Copiar');

  const btnWa = h('button', { class: 'btn wa lg', type: 'button', id: 'btn-wa-report', onclick: async () => {
    const t = getText();
    if (!t.trim()) { toast('O relatório está vazio.', 'error'); return; }
    const r = await shareWhatsApp(t);
    if (r === 'long') toast('Relatório extenso: o texto foi copiado. Cole na conversa do WhatsApp.', 'ok');
    else if (r === 'fail') toast('Não foi possível abrir o WhatsApp. Use "Copiar".', 'error');
  } }, icon('share'), 'Enviar no WhatsApp');

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
    const warn = [];
    if (reviewCount) warn.push(h('div', { class: 'banner warn' }, icon('alert'), h('div', null, h('b', null, `${reviewCount} setor(es) aguardam revisão `), 'e ficam com "-" na mensagem.')));
    if (totalMissing) warn.push(h('div', { class: 'banner warn' }, icon('alert'), h('div', null, h('b', null, `${totalMissing} campo(s) sem informação `), 'ficam com "-" na mensagem.')));
    const ok = await dialog({
      title: 'Finalizar coleta do ADM?',
      body: h('div', { class: 'stack' }, ...warn, h('p', null, 'Você ainda poderá corrigir os setores e gerar a mensagem de novo.')),
      actions: [{ label: 'Cancelar', value: false, variant: 'ghost' }, { label: 'Finalizar coleta', value: true, variant: 'green' }],
    });
    if (!ok) return;
    shift.status = 'finalizado';
    shift.finalizedAt = nowISO();
    shift.finalizedBy = shift.nurses[0] || null;
    log(shift, 'finish', `Coleta do ADM finalizada${totalMissing || reviewCount ? ' (parcial)' : ''}`);
    touch(shift);
    await flush();
    toast('Coleta finalizada. Bom plantão! 💚', 'ok');
    screenReport(shift);
  };

  const screen = h('main', { class: 'screen' },
    topbar({ title: 'Relatório', sub: shiftTitle(shift), back: `#/p/${shift.id}`, right: saveBadge() }),
    h('div', { class: 'content' },
      storageBanner(),
      reviewCount
        ? h('div', { class: 'banner warn', id: 'review-warn' }, icon('alert'), h('div', null, h('b', null, `${reviewCount} setor(es) ainda aguardam revisão `), 'e saem com "-" neste relatório. Abra o painel e confirme cada setor.'))
        : null,
      shift.status === 'finalizado'
        ? h('div', { class: 'banner warn', id: 'final-banner' }, icon('flag'), h('div', null, `Coleta finalizada em ${dateTimeBR(shift.finalizedAt)}. Bom plantão!`))
        : null,
      miss.length
        ? h('details', { class: 'miss', id: 'missing-box' },
          h('summary', null, h('span', null, icon('alert'), ` ${totalMissing + reviewCount} pendência(s) em ${miss.length} setor(es)`), icon('chevron')),
          h('ul', null, miss.map((m) => h('li', null, h('b', null, m.title), `: ${m.labels.join('; ')}`))))
        : h('div', { class: 'banner ok', id: 'missing-box' }, icon('check'), 'Todos os campos informados.'),
      alerts.length
        ? h('div', { class: 'banner warn', id: 'alerts-box' }, icon('alert'), h('div', null, h('b', null, 'Ocorrências: '), alerts.map((a) => `${a.title} (${a.alerts.join(', ')})`).join(' · ')))
        : null,
      staleBox,
      h('div', { class: 'tabs', role: 'tablist' }, tabFmt, tabEdit, fmtBtn, editBadge),
      editor,
      previewEl,
      h('div', { class: 'editfoot' }, restoreBtn, h('span', { class: 'note' }, 'Para alterar a mensagem, toque em Editar texto. Copiar e WhatsApp enviam exatamente o que você vê aqui.')),
      shift.status === 'em_andamento'
        ? h('button', { class: 'btn green block', type: 'button', id: 'btn-finalize', onclick: finalize }, icon('flag'), 'Finalizar coleta do ADM')
        : null,
      h('details', { class: 'more', id: 'more-formats' },
        h('summary', null, h('span', null, 'Outros formatos (imagem e PDF)'), icon('chevron')),
        h('div', { class: 'stack' },
          h('div', { class: 'outputs' }, btnImg, btnPdf),
          h('p', { class: 'note' }, 'Imagem e PDF seguem os dados dos setores e não incluem alterações digitadas no texto.'))),
      imgBox),
    h('div', { class: 'actionbar cta' }, btnCopy, btnWa));
  mount(screen);
  paintEdit();
  requestAnimationFrame(grow);
}

// =====================================================================
// Admin: editar o formulário (protegido por senha)
// =====================================================================
let adminOk = false;
const TYPE_LABEL = { yn: 'Sim / Não / N/A', num: 'Número', text: 'Texto curto', area: 'Texto longo', multi: 'Lista de nomes' };

function screenAdminRoute(sub) {
  if (!adminOk) return screenAdminLogin();
  if (sub && SECTOR_BY_ID[sub]) return screenAdminSector(SECTOR_BY_ID[sub]);
  return screenAdmin();
}

function screenAdminLogin() {
  const msg = h('p', { class: 'err-inline', id: 'admin-error', role: 'alert', hidden: true }, 'Senha incorreta.');
  const input = h('input', { class: 'input', type: 'password', id: 'admin-pass', autocomplete: 'off', 'aria-label': 'Senha do administrador', placeholder: 'Senha', enterkeyhint: 'go' });
  const enter = () => {
    if (formcfg.checkPassword(input.value)) { adminOk = true; screenAdmin(); return; }
    msg.hidden = false; input.value = ''; input.focus();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') enter(); });
  mount(h('main', { class: 'screen' },
    topbar({ title: 'Editar formulário', back: '#/' }),
    h('div', { class: 'content' },
      h('div', { class: 'card stack' },
        h('h2', null, 'Acesso do administrador'),
        h('p', { class: 'note' }, 'Digite a senha para adicionar, remover ou renomear perguntas dos setores.'),
        input, msg,
        h('button', { class: 'btn primary lg block', type: 'button', id: 'admin-enter', onclick: enter }, icon('check'), 'Entrar')),
      credit())));
  input.focus();
}

const sectorEdits = (cfg, id) => {
  const c = cfg.sectors[id];
  return c ? c.removed.length + Object.keys(c.labels).length + c.added.length : 0;
};

function screenAdmin() {
  const cfg = formcfg.getConfig();
  const fileIn = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, id: 'cfg-file', onchange: async (e) => {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    try {
      const c = formcfg.parseConfigText(await f.text());
      if (!(await confirmDialog({ title: 'Importar configuração?', message: 'A configuração atual do formulário será substituída pela do arquivo (somente neste aparelho).', confirmText: 'Importar' }))) return;
      formcfg.setConfig(c); toast('Configuração importada', 'ok'); screenAdmin();
    } catch (err) { toast(err.message || 'Não foi possível importar.', 'error'); }
  } });
  mount(h('main', { class: 'screen' },
    topbar({ title: 'Editar formulário', sub: `Em uso: ${formcfg.configSource()}`, back: '#/',
      right: h('button', { class: 'linkbtn', type: 'button', id: 'admin-exit', onclick: () => { adminOk = false; go('#/'); } }, 'Sair') }),
    h('div', { class: 'content' },
      h('p', { class: 'note' }, 'Escolha um setor para renomear, remover ou adicionar perguntas. As alterações valem neste aparelho assim que você as faz.'),
      h('div', { class: 'sectors' }, SECTORS.map((sec, i) => {
        const n = sectorEdits(cfg, sec.id);
        return h('a', { class: 'sec done', href: `#/admin/${sec.id}`, id: `adm-${sec.id}` },
          h('span', { class: 'ico' }, icon(sec.icon)),
          h('span', { class: 'txt' }, h('span', { class: 'name' }, `${i + 1}. ${sec.title}`), h('span', { class: 'st' }, `${sec.fields.length} pergunta(s)${n ? ` · ${n} alteração(ões)` : ''}`)),
          icon('chevron', 'chev'));
      })),
      h('div', { class: 'card stack' },
        h('b', null, 'Valer para todos os aparelhos'),
        h('p', { class: 'note' }, 'Cada aparelho guarda a sua própria versão. Para que todos os enfermeiros recebam as mudanças: exporte o arquivo, substitua o `form-config.json` do projeto e publique de novo na Vercel.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn secondary', type: 'button', id: 'cfg-export', onclick: () => {
            downloadBlob(new Blob([formcfg.exportConfigText()], { type: 'application/json' }), 'form-config.json');
            toast('Arquivo form-config.json exportado', 'ok');
          } }, icon('download'), 'Exportar'),
          h('button', { class: 'btn secondary', type: 'button', id: 'cfg-import', onclick: () => fileIn.click() }, icon('upload'), 'Importar'), fileIn),
        h('button', { class: 'btn ghost', type: 'button', id: 'cfg-reset', onclick: async () => {
          if (!(await confirmDialog({ title: 'Restaurar formulário padrão?', message: 'Todas as perguntas adicionadas, removidas ou renomeadas voltam ao modelo original (neste aparelho). Respostas já registradas não são apagadas.', confirmText: 'Restaurar', danger: true }))) return;
          formcfg.setConfig(null); toast('Formulário padrão restaurado', 'ok'); screenAdmin();
        } }, icon('refresh'), 'Restaurar formulário padrão')),
      credit())));
}

function screenAdminSector(sector) {
  const cfg = formcfg.getConfig();
  const c = cfg.sectors[sector.id] || { removed: [], labels: {}, added: [] };
  const commit = (next, msg) => {
    cfg.sectors[sector.id] = next;
    if (!formcfg.setConfig(cfg)) toast('Não foi possível salvar neste aparelho.', 'error');
    else if (msg) toast(msg, 'ok');
  };
  const defs = defaultFields(sector.id);
  const rows = defs.map((f) => {
    const removed = c.removed.includes(f.id);
    const inp = h('input', { class: 'input', type: 'text', maxlength: '200', value: c.labels[f.id] || f.label, 'aria-label': `Texto da pergunta: ${f.label}`, 'data-fid': f.id, disabled: removed,
      onchange: (e) => {
        const v = e.target.value.trim();
        const labels = { ...c.labels };
        if (!v || v === f.label) delete labels[f.id]; else labels[f.id] = v;
        commit({ ...c, labels }, 'Salvo'); screenAdminSector(sector);
      } });
    return h('div', { class: `fieldcard admrow${removed ? ' removed' : ''}`, 'data-adm': f.id },
      h('div', { class: 'qrow' }, h('span', { class: 'state' }, `${TYPE_LABEL[f.type]}${f.showIf ? ' · condicional' : ''}${f.optional ? ' · opcional' : ''}`)),
      inp,
      h('button', { class: `btn ${removed ? 'secondary' : 'ghost'} small`, type: 'button', 'data-act': removed ? 'restore' : 'remove', onclick: () => {
        const removedList = removed ? c.removed.filter((x) => x !== f.id) : [...c.removed, f.id];
        commit({ ...c, removed: removedList }, removed ? 'Pergunta restaurada' : 'Pergunta removida'); screenAdminSector(sector);
      } }, icon(removed ? 'refresh' : 'trash'), removed ? 'Restaurar pergunta' : 'Remover pergunta'));
  });
  const addedRows = c.added.map((a) => {
    const inp = h('input', { class: 'input', type: 'text', maxlength: '200', value: a.label, 'aria-label': `Texto da pergunta: ${a.label}`, 'data-fid': a.id,
      onchange: (e) => {
        const v = e.target.value.trim();
        if (!v) { e.target.value = a.label; return; }
        commit({ ...c, added: c.added.map((x) => (x.id === a.id ? { ...x, label: v } : x)) }, 'Salvo'); screenAdminSector(sector);
      } });
    return h('div', { class: 'fieldcard admrow added', 'data-adm': a.id },
      h('div', { class: 'qrow' }, h('span', { class: 'state' }, `Nova · ${TYPE_LABEL[a.type]}${a.optional ? ' · opcional' : ''}`)),
      inp,
      h('button', { class: 'btn ghost small', type: 'button', 'data-act': 'delete', onclick: () => {
        commit({ ...c, added: c.added.filter((x) => x.id !== a.id) }, 'Pergunta excluída'); screenAdminSector(sector);
      } }, icon('trash'), 'Excluir pergunta'));
  });

  const nl = h('input', { class: 'input', type: 'text', maxlength: '200', id: 'new-label', placeholder: 'Texto da nova pergunta', 'aria-label': 'Texto da nova pergunta' });
  const nt = h('select', { class: 'select', id: 'new-type', 'aria-label': 'Tipo de resposta' }, Object.entries(TYPE_LABEL).map(([v, l]) => h('option', { value: v }, l)));
  const no = h('input', { type: 'checkbox', id: 'new-optional' });
  const add = () => {
    const label = nl.value.trim();
    if (!label) { toast('Digite o texto da pergunta.', 'error'); nl.focus(); return; }
    const id = `c_${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`;
    commit({ ...c, added: [...c.added, { id, label, type: nt.value, optional: no.checked }] }, 'Pergunta adicionada'); screenAdminSector(sector);
  };
  nl.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });

  mount(h('main', { class: 'screen' },
    topbar({ title: sector.title, sub: 'Editar perguntas', back: '#/admin' }),
    h('div', { class: 'content tight' },
      h('p', { class: 'note' }, 'Edite o texto, remova ou restaure perguntas. Perguntas novas entram antes de "Ocorrências relevantes". Remover não apaga respostas já registradas.'),
      rows, addedRows,
      h('div', { class: 'card stack', id: 'add-box' },
        h('b', null, 'Adicionar pergunta'), nl, nt,
        h('label', { class: 'checkrow' }, no, ' Opcional (não impede o setor de ficar preenchido)'),
        h('button', { class: 'btn primary block', type: 'button', id: 'btn-add-q', onclick: add }, icon('plus'), 'Adicionar pergunta')),
      credit())));
}

// =====================================================================
// Rotas
// =====================================================================
async function route() {
  document.querySelectorAll('.overlay').forEach((o) => { if (o.querySelector('.sheet')) o.remove(); });
  commitSector(true);
  await flush();
  const parts = (location.hash.replace(/^#/, '') || '/').split('/').filter(Boolean);
  try {
    if (!parts.length) return screenHome(await storage.listShifts());
    if (parts[0] === 'admin') return screenAdminRoute(parts[1]);
    if (parts[0] === 'novo') {
      const all = await storage.listShifts();
      return screenOpening(null, all, parts[1] ? all.find((x) => x.id === parts[1]) : undefined);
    }
    if (parts[0] === 'p' && parts[1]) {
      const shift = await storage.getShift(parts[1]);
      if (!shift) { toast('Plantão não encontrado.', 'error'); go('#/'); return; }
      const sub = parts[2];
      if (!sub) return screenPanel(shift);
      if (sub === 'abertura') return screenOpening(shift, []);
      if (sub === 'relatorio') return screenReport(shift);
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

// Uma vez por versão: textos de relatório editados/salvos com o modelo antigo (títulos numerados) voltam a ser gerados no padrão novo.
async function migrateSavedPreviews() {
  const FLAG = 'plantao-adm:preview-v3';
  try { if (localStorage.getItem(FLAG)) return; } catch { return; }
  try {
    const all = await storage.listShifts();
    const old = all.filter((s) => s.reportEdit && typeof s.reportEdit.text === 'string' && /^\*?\d{1,2}\. [A-ZÀ-Ú]/m.test(s.reportEdit.text));
    for (const s of old) s.reportEdit = null;
    if (old.length) await storage.saveMany(old);
    localStorage.setItem(FLAG, '1');
  } catch { /* tenta de novo na próxima abertura */ }
}

(async function start() {
  await formcfg.loadFormConfig();
  const st = await storage.init();
  if (!st.persistent) setSave('volatile');
  else await recoverJournal();
  await migrateSavedPreviews();
  await route();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    // Nova versão do app: recarrega uma única vez para aplicar os arquivos novos (sem perder dados do plantão).
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      try { if (sessionStorage.getItem('plantao-adm:reloaded') === '1') return; sessionStorage.setItem('plantao-adm:reloaded', '1'); } catch { return; }
      persistNow(); location.reload();
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((r) => r.update()).catch(() => { /* funciona sem service worker */ });
  }
})();
