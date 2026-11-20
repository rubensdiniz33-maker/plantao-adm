// Geração das mensagens (apresentação e relatório) a partir dos dados do plantão.
import { SECTORS, visibleFields, isAnswered, splitNames, sectorProgress, sectorAlerts, sectorStatus, effectiveAnswers, NA } from './sectors.js';

const pad = (n) => String(n).padStart(2, '0');

export function formatDateBR(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

export function formatHour(hhmm) {
  const [h, m] = hhmm.split(':');
  return m === '00' ? pad(Number(h)) : `${pad(Number(h))}:${m}`;
}

export function joinNames(names) {
  const n = names.filter(Boolean);
  if (n.length <= 1) return n[0] || '';
  return `${n.slice(0, -1).join(', ')} e ${n[n.length - 1]}`;
}

export function greeting(start) {
  const h = Number(start.split(':')[0]);
  if (h >= 5 && h < 12) return 'Bom dia';
  if (h >= 12 && h < 18) return 'Boa tarde';
  return 'Boa noite';
}

export const shiftLabel = (type) => (type === 'N' ? 'noturno' : 'diurno');
export const shiftName = (type) => (type === 'N' ? 'Noturno (N)' : 'Manhã/Tarde (MT)');
export const hoursText = (s) => `${formatHour(s.start)} às ${formatHour(s.end)}hrs`;

// Mensagem de apresentação: sem linhas em branco; destaques em negrito (*...*) do WhatsApp.
export function openingMessage(s) {
  return [
    `${greeting(s.start)}!`,
    `*Iniciando plantão administrativo ${shiftLabel(s.type)}*`,
    `*Data:* ${formatDateBR(s.date)}`,
    `*Horário:* ${hoursText(s)}`,
    `*Enf:* ${joinNames(s.nurses)}`,
  ].join('\n');
}

const YN_TEXT = { sim: 'Sim', nao: 'Não' };

// Valor de exibição de um campo: { text, kind } — kind: 'sim'|'nao'|'na'|'ni'|'val'
// Regras: número não digitado = 0; "Não se aplica" = "-"; demais campos vazios = "-".
export function displayValue(field, v) {
  if (v === NA) return { text: '-', kind: 'na' };
  if (!isAnswered(v)) return field.type === 'num' ? { text: '0', kind: 'val' } : { text: '-', kind: 'ni' };
  if (field.type === 'yn') return { text: YN_TEXT[v], kind: v };
  if (field.type === 'multi') return { text: splitNames(v).join(', ') || '-', kind: 'val' };
  return { text: String(v).trim(), kind: 'val' };
}

// Modelo estruturado — única fonte para texto, prévia, imagem e PDF.
// Setor copiado do plantão anterior e ainda não confirmado NÃO vai para o relatório (evita enviar dado velho).
export function reportModel(shift) {
  return SECTORS.map((sector, i) => {
    const answers = effectiveAnswers(shift, sector.id);
    return {
      id: sector.id,
      index: i + 1,
      title: sector.title,
      status: sectorStatus(shift, sector),
      alerts: sectorAlerts(sector, answers),
      rows: visibleFields(sector, answers).map((f) => ({
        label: f.label,
        indent: !!f.showIf,
        optional: !!f.optional,
        ...displayValue(f, answers[f.id]),
      })),
    };
  });
}

export function reportHeader(shift) {
  return {
    title: `PLANTÃO ADMINISTRATIVO — ${shiftLabel(shift.type).toUpperCase()}`,
    date: formatDateBR(shift.date),
  };
}

// ---------- Formatação personalizável (preferência do usuário; padrão = modelo WhatsApp atual) ----------
export const BULLETS = [['•', '•'], ['-', '-'], ['▪', '▪'], ['➤', '➤'], ['', 'Nenhum']];
export const DEFAULT_FORMAT = Object.freeze({
  bullet: '•', boldQuestions: true, boldTitles: true, upperTitles: true, numberTitles: false, blankBetween: true, showDate: true,
});
export function normalizeFormat(raw) {
  const f = { ...DEFAULT_FORMAT };
  if (!raw || typeof raw !== 'object') return f;
  if (typeof raw.bullet === 'string' && BULLETS.some(([v]) => v === raw.bullet)) f.bullet = raw.bullet;
  for (const k of ['boldQuestions', 'boldTitles', 'upperTitles', 'numberTitles', 'blankBetween', 'showDate']) if (typeof raw[k] === 'boolean') f[k] = raw[k];
  return f;
}
export const isDefaultFormat = (f) => Object.keys(DEFAULT_FORMAT).every((k) => f[k] === DEFAULT_FORMAT[k]);

// Texto para WhatsApp. Padrão: linha em branco só ENTRE os setores; perguntas e títulos em *negrito*.
// Valores: número vazio = 0; N/A e demais vazios = "-". A ORDEM dos setores é sempre a original (não depende da preferência de navegação).
export function reportText(shift, fmtRaw = DEFAULT_FORMAT) {
  const fmt = normalizeFormat(fmtRaw);
  const bold = (t, on) => (on ? `*${t}*` : t);
  const h = reportHeader(shift);
  const lines = [bold(h.title, fmt.boldTitles)];
  if (fmt.showDate) lines.push(`${bold('Data:', fmt.boldTitles)} ${h.date}`);
  const child = fmt.bullet ? '◦ ' : '';
  const top = fmt.bullet ? `${fmt.bullet} ` : '';
  for (const sec of reportModel(shift)) {
    if (fmt.blankBetween) lines.push('');
    const title = `${fmt.numberTitles ? `${sec.index}. ` : ''}${fmt.upperTitles ? sec.title.toUpperCase() : sec.title}`;
    lines.push(bold(title, fmt.boldTitles));
    for (const r of sec.rows) {
      const pre = r.indent ? `   ${child}` : top;
      const lab = bold(`${r.label}${r.label.endsWith('?') ? '' : ':'}`, fmt.boldQuestions);
      if (r.kind === 'val' && r.text.includes('\n')) {
        lines.push(`${pre}${lab}`);
        for (const l of r.text.split('\n')) if (l.trim()) lines.push(`      ${l.trim()}`);
      } else lines.push(`${pre}${lab} ${r.text}`);
    }
  }
  return lines.join('\n');
}

// Pendências de preenchimento, por setor
export function missingList(shift) {
  const out = [];
  for (const sector of SECTORS) {
    const status = sectorStatus(shift, sector);
    if (status === 'review') { out.push({ id: sector.id, title: sector.title, status, labels: ['Aguardando revisão (dados do plantão anterior ainda não confirmados)'] }); continue; }
    const answers = shift.answers?.[sector.id] || {};
    const p = sectorProgress(sector, answers);
    const labels = p.status === 'none'
      ? visibleFields(sector, answers).filter((f) => !f.optional && f.type !== 'num').map((f) => f.label)
      : p.missing.map((f) => f.label);
    if (labels.length) out.push({ id: sector.id, title: sector.title, status: p.status, labels });
  }
  return out;
}

export function alertsList(shift) {
  return reportModel(shift)
    .filter((s) => s.alerts.length)
    .map((s) => ({ id: s.id, title: s.title, alerts: s.alerts }));
}

// Pré-visualização segura: escapa HTML e converte *negrito* e _itálico_.
export function whatsappToHtml(textValue) {
  const esc = textValue.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc
    .replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(>])_([^_\n]+)_(?=$|[\s).,;:<])/g, '$1<em>$2</em>');
}

// Texto final do relatório: a versão editada à mão (se houver) ou o texto gerado.
// reportEdit = { text, base } — base é o texto gerado no momento da edição; se os dados mudarem depois, a edição fica "desatualizada".
export function finalReportText(shift, fmt = DEFAULT_FORMAT) {
  const auto = reportText(shift, fmt);
  const e = shift.reportEdit;
  if (e && typeof e.text === 'string' && e.text.trim()) return { text: e.text, auto, edited: true, stale: e.base !== auto };
  return { text: auto, auto, edited: false, stale: false };
}
