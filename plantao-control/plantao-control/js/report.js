// Geração das mensagens (apresentação e relatório) a partir dos dados do plantão.
import { SECTORS, visibleFields, isAnswered, sectorProgress, sectorAlerts, sectorStatus, effectiveAnswers, NA } from './sectors.js';

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
export function displayValue(field, v) {
  if (!isAnswered(v)) return { text: '-', kind: 'ni' };
  if (v === NA) return { text: 'Não se aplica', kind: 'na' };
  if (field.type === 'yn') return { text: YN_TEXT[v], kind: v };
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

// Texto para WhatsApp: linha em branco só ENTRE os setores (dentro do setor, sem). Perguntas e títulos em *negrito*; campo vazio = "-".
export function reportText(shift) {
  const h = reportHeader(shift);
  const lines = [
    `*${h.title}*`,
    `*Data:* ${h.date}`,
  ];
  // Horário e enfermeiro ficam só na mensagem de apresentação. Cada setor é separado por uma linha em branco.
  for (const sec of reportModel(shift)) {
    lines.push('');
    lines.push(`*${sec.index}. ${sec.title.toUpperCase()}*`);
    for (const r of sec.rows) {
      const pre = r.indent ? '   ◦ ' : '• ';
      const lab = `*${r.label}${r.label.endsWith('?') ? '' : ':'}*`;
      if (r.kind === 'ni') lines.push(`${pre}${lab} -`);
      else if (r.kind === 'val' && r.text.includes('\n')) {
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
    .replace(/(^|[\s(>])_([^_\n]+)_(?=$|[\s).,;:<])/g, '$1<em>$2</em>');
}

// Texto final do relatório: a versão editada à mão (se houver) ou o texto gerado.
// reportEdit = { text, base } — base é o texto gerado no momento da edição; se os dados mudarem depois, a edição fica "desatualizada".
export function finalReportText(shift) {
  const auto = reportText(shift);
  const e = shift.reportEdit;
  if (e && typeof e.text === 'string' && e.text.trim()) return { text: e.text, auto, edited: true, stale: e.base !== auto };
  return { text: auto, auto, edited: false, stale: false };
}
