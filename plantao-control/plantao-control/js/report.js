// Geração das mensagens (apresentação e relatório) a partir dos dados do plantão.
import { SECTORS, NA, visibleFields, isAnswered, sectorProgress, sectorAlerts } from './sectors.js';

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

export function openingMessage(s) {
  return [
    `${greeting(s.start)}!`,
    '',
    `Iniciando plantão administrativo ${shiftLabel(s.type)}`,
    '',
    `Data: ${formatDateBR(s.date)}`,
    '',
    `Horário: ${hoursText(s)}`,
    '',
    `Enf: ${joinNames(s.nurses)}`,
  ].join('\n');
}

const YN_TEXT = { sim: 'Sim', nao: 'Não' };

// Valor de exibição de um campo: { text, kind } — kind: 'sim'|'nao'|'na'|'ni'|'val'
export function displayValue(field, v) {
  if (!isAnswered(v)) return { text: 'Não informado', kind: 'ni' };
  if (v === NA) return { text: 'Não se aplica', kind: 'na' };
  if (field.type === 'yn') return { text: YN_TEXT[v], kind: v };
  return { text: String(v).trim(), kind: 'val' };
}

// Modelo estruturado — única fonte para texto, prévia, imagem e PDF.
export function reportModel(shift) {
  return SECTORS.map((sector, i) => {
    const answers = shift.answers?.[sector.id] || {};
    const prog = sectorProgress(sector, answers);
    return {
      id: sector.id,
      index: i + 1,
      title: sector.title,
      status: prog.status,
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
    hours: hoursText(shift),
    nurses: joinNames(shift.nurses),
  };
}

// Texto para WhatsApp: *negrito*, _itálico_ para "Não informado".
export function reportText(shift) {
  const h = reportHeader(shift);
  const lines = [
    `*${h.title}*`,
    `Data: ${h.date}`,
    `Horário: ${h.hours}`,
    `Enf: ${h.nurses}`,
  ];
  for (const sec of reportModel(shift)) {
    lines.push('', `*${sec.index}. ${sec.title.toUpperCase()}*`);
    for (const r of sec.rows) {
      const pre = r.indent ? '   ◦ ' : '• ';
      let val = r.text;
      if (r.kind === 'ni') val = '_Não informado_';
      else if (r.kind === 'na') val = 'Não se aplica';
      else if (r.kind === 'sim' || r.kind === 'nao') val = `*${r.text}*`;
      if (r.kind === 'val' && r.text.includes('\n')) {
        const body = r.text.split('\n').map((l) => `    ${l.trim()}`).join('\n');
        lines.push(`${pre}${r.label}:\n${body}`);
      } else {
        lines.push(`${pre}${r.label}: ${val}`);
      }
    }
  }
  return lines.join('\n');
}

// Pendências de preenchimento, por setor
export function missingList(shift) {
  const out = [];
  for (const sector of SECTORS) {
    const answers = shift.answers?.[sector.id] || {};
    const p = sectorProgress(sector, answers);
    const labels = p.status === 'none'
      ? visibleFields(sector, answers).filter((f) => !f.optional).map((f) => f.label)
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
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,;:])/g, '$1<em>$2</em>');
}
