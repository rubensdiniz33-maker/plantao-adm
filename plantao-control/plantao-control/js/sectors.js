// Dados dos setores e regras de preenchimento (sem dependência de DOM).
// Os rótulos preservam o texto das perguntas do modelo institucional.

export const NA = '__na__'; // "Não se aplica"

// Tipos de campo: yn (Sim/Não/N/A), num (inteiro >= 0), text (linha), area (observação multilinha)
const yn = (id, label, extra = {}) => ({ id, label, type: 'yn', ...extra });
const num = (id, label, extra = {}) => ({ id, label, type: 'num', ...extra });
const text = (id, label, extra = {}) => ({ id, label, type: 'text', ...extra });
const area = (id, label, extra = {}) => ({ id, label, type: 'area', ...extra });

// Condições: { field, eq: 'sim' } | { field, gt: 0 } | { field, filled: true }
// Alertas (ocorrência operacional): alert: 'sim' | 'nao' | 'gt0' | 'text'
const bloqueados = () => [
  num('bloqueados', 'Leitos bloqueados/interditados', { alert: 'gt0', alertMsg: 'Leitos bloqueados/interditados' }),
  text('motivo', 'Motivo', { showIf: { field: 'bloqueados', gt: 0 } }),
];

export const SECTORS = [
  {
    id: 'portaria', title: 'Portaria/Acolhimento', icon: 'door',
    fields: [
      yn('equipe_completa', 'Equipe completa?', { alert: 'nao', alertMsg: 'Equipe incompleta' }),
      yn('ausencia', 'Ausência no plantão?', { alert: 'sim', alertMsg: 'Ausência no plantão' }),
      area('ausencia_detalhe', 'Detalhamento da ausência', { showIf: { field: 'ausencia', eq: 'sim' }, added: true }),
      yn('cobertura', 'Cobertura realizada?'),
      area('observacoes', 'Observações', { optional: true }),
    ],
  },
  {
    id: 'recepcao', title: 'Recepção', icon: 'desk',
    fields: [
      yn('equipe_completa', 'Equipe completa?', { alert: 'nao', alertMsg: 'Equipe incompleta' }),
      area('pendencias', 'Pendências administrativas relevantes', { alert: 'text', alertMsg: 'Pendências administrativas' }),
      area('reclamacoes', 'Reclamações registradas', { alert: 'text', alertMsg: 'Reclamações registradas' }),
    ],
  },
  {
    id: 'farmacia', title: 'Farmácia', icon: 'pill',
    fields: [
      yn('falta_critico', 'Medicamentos críticos em falta?', { alert: 'sim', alertMsg: 'Medicamento crítico em falta' }),
      text('falta_quais', 'Especificar os medicamentos em falta', { showIf: { field: 'falta_critico', eq: 'sim' }, added: true }),
      area('ocorrencias', 'Ocorrências relacionadas ao abastecimento/dispensação', { alert: 'text', alertMsg: 'Ocorrência de abastecimento/dispensação' }),
    ],
  },
  {
    id: 'rouparia', title: 'Rouparia', icon: 'linen',
    fields: [
      yn('enxoval_suficiente', 'Enxoval suficiente para o plantão?', { alert: 'nao', alertMsg: 'Enxoval insuficiente' }),
      num('quantidade', 'Quantidade estimada disponível'),
      yn('reposicao_urgente', 'Necessidade de reposição urgente?', { alert: 'sim', alertMsg: 'Reposição urgente necessária' }),
    ],
  },
  {
    id: 'laboratorio', title: 'Laboratório', icon: 'flask',
    fields: [
      yn('exames_indispensaveis', 'Exames indispensáveis?', { alert: 'sim', alertMsg: 'Exames indispensáveis informados' }),
      text('exames_quais', 'Se sim, quais?', { showIf: { field: 'exames_indispensaveis', eq: 'sim' } }),
      yn('equip_falha', 'Equipamentos com falha?', { alert: 'sim', alertMsg: 'Equipamento com falha' }),
      text('equip_identificacao', 'Equipamento com falha', { showIf: { field: 'equip_falha', eq: 'sim' }, added: true }),
      area('equip_descricao', 'Descrição da falha', { showIf: { field: 'equip_falha', eq: 'sim' }, added: true }),
    ],
  },
  {
    id: 'hemodinamica', title: 'Hemodinâmica', icon: 'cath',
    fields: [
      text('medico_sobreaviso', 'Médico de sobreaviso'),
      area('previsao_exames', 'Previsão de exames a serem realizados'),
      area('intercorrencias', 'Intercorrências', { alert: 'text', alertMsg: 'Intercorrências' }),
    ],
  },
  {
    id: 'centro_cirurgico', title: 'Centro Cirúrgico', icon: 'scalpel',
    fields: [
      area('realizados', 'Procedimentos realizados'),
      area('suspensos', 'Procedimentos suspensos', { alert: 'text', alertMsg: 'Procedimentos suspensos' }),
      area('motivo_suspensoes', 'Motivo das suspensões', { showIf: { field: 'suspensos', filled: true } }),
      area('atrasos', 'Atrasos', { alert: 'text', alertMsg: 'Atrasos' }),
      yn('equipe_completa', 'Equipe completa?', { alert: 'nao', alertMsg: 'Equipe incompleta' }),
      yn('autoclave', 'Autoclave em funcionamento', { alert: 'nao', alertMsg: 'Autoclave fora de funcionamento' }),
    ],
  },
  {
    id: 'enf_sus', title: 'Enfermaria SUS', icon: 'bed',
    fields: [
      num('leitos', 'Leitos disponíveis'),
      num('altas_pendentes', 'Altas do dia ainda não efetuadas'),
      num('aguard_transf', 'Pacientes aguardando transferência'),
      num('dialise', 'Pacientes em diálise'),
      ...bloqueados(),
      text('medico', 'Médico de plantão (FDS)'),
      text('enfermeiro', 'Enfermeiro(a) de plantão'),
    ],
  },
  {
    id: 'enf_convenio', title: 'Enfermaria Convênio/Particular', icon: 'bed2',
    fields: [
      num('leitos', 'Leitos disponíveis'),
      num('altas_pendentes', 'Altas do dia ainda não efetuadas'),
      ...bloqueados(),
      text('medico', 'Médico de plantão (FDS)'),
      text('enfermeiro', 'Enfermeiro(a) de plantão'),
    ],
  },
  ...[
    ['uti1', 'UTI 1', 'monitor'],
    ['uti2', 'UTI 2', 'monitor'],
    ['uco', 'UCO', 'heart'],
  ].map(([id, title, icon]) => ({
    id, title, icon,
    fields: [
      num('leitos', 'Leitos disponíveis'),
      num('altas_pendentes', 'Altas do dia ainda não efetuadas'),
      ...bloqueados(),
      num('dialise', 'Pacientes em diálise'),
      num('aguard_transf', 'Pacientes aguardando transferência'),
      text('medico', 'Médico de plantão'),
      text('enfermeiro', 'Enfermeiro(a) de plantão'),
    ],
  })),
  {
    id: 'pa', title: 'Pronto Atendimento', icon: 'cross',
    fields: [
      num('observacao', 'Quantidade de pacientes em observação'),
      num('aguardando', 'Quantidade de pacientes aguardando atendimento'),
      num('boarding', 'Quantidade de pacientes em boarding'),
      num('aguard_transf', 'Pacientes aguardando transferência'),
      text('maior_boarding', 'Maior tempo de boarding no PA', { placeholder: 'Ex.: 5h30' }),
      yn('equipe_completa', 'Equipe completa?', { alert: 'nao', alertMsg: 'Equipe incompleta' }),
      text('medico', 'Médico de plantão'),
      area('ocorrencias', 'Ocorrências relevantes', { alert: 'text', alertMsg: 'Ocorrências relevantes' }),
    ],
  },
];

export const SECTOR_BY_ID = Object.fromEntries(SECTORS.map((s) => [s.id, s]));
export const MAX_TEXT = 1000;
export const MAX_NUM_DIGITS = 6;

// ---------- Valores ----------

export const isAnswered = (v) => v !== undefined && v !== null && v !== '';

const NEGATIVE_TEXT =
  /^\s*(nada|nenhum[a]?|nenhuma\s+(ocorr[eê]ncia|pend[eê]ncia|reclama[cç][aã]o|altera[cç][aã]o|intercorr[eê]ncia)|sem\s+(ocorr[eê]ncias?|pend[eê]ncias?|reclama[cç][oõ]es?|altera[cç][oõ]es?|intercorr[eê]ncias?|atrasos?)|n[aã]o(\s+h[aá])?|nada\s+a\s+relatar|-+|0+)\s*[.!]?\s*$/i;

// Texto que descreve algo de fato (não vazio, não N/A, não "nada"/"nenhum"/"0").
export function isMeaningfulText(v) {
  if (typeof v !== 'string' || v === NA) return false;
  const t = v.trim();
  return t !== '' && !NEGATIVE_TEXT.test(t);
}

export function conditionMet(cond, answers) {
  if (!cond) return true;
  const v = answers?.[cond.field];
  if ('eq' in cond) return v === cond.eq;
  if ('gt' in cond) return typeof v === 'string' && /^\d+$/.test(v) && Number(v) > cond.gt;
  if (cond.filled) return isMeaningfulText(v);
  return true;
}

export function visibleFields(sector, answers) {
  return sector.fields.filter((f) => conditionMet(f.showIf, answers));
}

// ---------- Estado do setor ----------

// 'none' | 'progress' | 'done'  (preenchimento; independe de ocorrência)
export function sectorProgress(sector, answers = {}) {
  const vis = visibleFields(sector, answers);
  const any = vis.some((f) => isAnswered(answers[f.id]));
  const missing = vis.filter((f) => !f.optional && !isAnswered(answers[f.id]));
  let status = 'none';
  if (any) status = missing.length === 0 ? 'done' : 'progress';
  return { status, missing, total: vis.filter((f) => !f.optional).length };
}

// Ocorrências operacionais (âmbar) — lista de mensagens
export function sectorAlerts(sector, answers = {}) {
  const out = [];
  for (const f of visibleFields(sector, answers)) {
    if (!f.alert) continue;
    const v = answers[f.id];
    let hit = false;
    if (f.alert === 'sim') hit = v === 'sim';
    else if (f.alert === 'nao') hit = v === 'nao';
    else if (f.alert === 'gt0') hit = typeof v === 'string' && /^\d+$/.test(v) && Number(v) > 0;
    else if (f.alert === 'text') hit = isMeaningfulText(v);
    if (hit) out.push(f.alertMsg || f.label);
  }
  return out;
}

// Respostas "em vigor": setor copiado do plantão anterior e ainda não confirmado conta como vazio.
export function effectiveAnswers(shift, id) {
  if (shift.sectorMeta?.[id]?.carried) return {};
  return shift.answers?.[id] || {};
}

// 'none' | 'progress' | 'review' | 'done'
export function sectorStatus(shift, sector) {
  if (shift.sectorMeta?.[sector.id]?.carried) return 'review';
  return sectorProgress(sector, shift.answers?.[sector.id] || {}).status;
}

// Próximo setor que ainda precisa de atenção (não "done"), depois de fromIdx e dando a volta; exclui o próprio.
export function nextAttention(shift, fromIdx = -1) {
  const after = SECTORS.map((_, i) => i).filter((i) => i > fromIdx);
  const before = SECTORS.map((_, i) => i).filter((i) => i < fromIdx);
  for (const i of [...after, ...before]) if (sectorStatus(shift, SECTORS[i]) !== 'done') return SECTORS[i];
  return null;
}

export function shiftSummary(shift) {
  let done = 0, progress = 0, none = 0, review = 0, alerts = 0, missing = 0;
  for (const s of SECTORS) {
    const st = sectorStatus(shift, s);
    const a = effectiveAnswers(shift, s.id);
    const p = sectorProgress(s, a);
    if (st === 'done') done++;
    else if (st === 'progress') progress++;
    else if (st === 'review') review++;
    else none++;
    if (sectorAlerts(s, a).length) alerts++;
    missing += st === 'done' ? 0 : (p.status === 'none' ? p.total : p.missing.length);
  }
  return { done, progress, none, review, alerts, missing, total: SECTORS.length };
}
