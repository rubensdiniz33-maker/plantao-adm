import test from 'node:test';
import assert from 'node:assert/strict';
import { SECTORS, NA, sectorProgress, sectorAlerts, visibleFields, isMeaningfulText, shiftSummary } from '../js/sectors.js';
import { openingMessage, reportText, reportModel, missingList, greeting, joinNames, whatsappToHtml } from '../js/report.js';
import { normalizeShift, parseBackup, buildBackup, validateIdentification, isValidDate, sanitizeAnswers } from '../js/validation.js';

const baseShift = (over = {}) => ({
  id: 'abcdef12-3456', type: 'N', date: '2026-11-13', start: '19:00', end: '07:00', nurses: ['Rubens', 'Alana'],
  status: 'em_andamento', createdAt: '2026-11-13T22:00:00.000Z', updatedAt: '2026-11-13T22:00:00.000Z',
  answers: {}, sectorMeta: {}, activity: [], ...over,
});

test('13 setores na ordem institucional', () => {
  assert.deepEqual(SECTORS.map((s) => s.title), [
    'Portaria/Acolhimento', 'Recepção', 'Farmácia', 'Rouparia', 'Laboratório', 'Hemodinâmica', 'Centro Cirúrgico',
    'Enfermaria SUS', 'Enfermaria Convênio/Particular', 'UTI 1', 'UTI 2', 'UCO', 'Pronto Atendimento',
  ]);
});

test('todas as perguntas originais preservadas (rótulos exatos, na ordem)', () => {
  const expected = {
    portaria: ['Equipe completa?', 'Ausência no plantão?', 'Cobertura realizada?', 'Observações'],
    recepcao: ['Equipe completa?', 'Pendências administrativas relevantes', 'Reclamações registradas'],
    farmacia: ['Medicamentos críticos em falta?', 'Ocorrências relacionadas ao abastecimento/dispensação'],
    rouparia: ['Enxoval suficiente para o plantão?', 'Quantidade estimada disponível', 'Necessidade de reposição urgente?'],
    laboratorio: ['Exames indispensáveis?', 'Se sim, quais?', 'Equipamentos com falha?'],
    hemodinamica: ['Médico de sobreaviso', 'Previsão de exames a serem realizados', 'Intercorrências'],
    centro_cirurgico: ['Procedimentos realizados', 'Procedimentos suspensos', 'Motivo das suspensões', 'Atrasos', 'Equipe completa?', 'Autoclave em funcionamento'],
    enf_sus: ['Leitos disponíveis', 'Altas do dia ainda não efetuadas', 'Pacientes aguardando transferência', 'Pacientes em diálise', 'Leitos bloqueados/interditados', 'Motivo', 'Médico de plantão (FDS)', 'Enfermeiro(a) de plantão'],
    enf_convenio: ['Leitos disponíveis', 'Altas do dia ainda não efetuadas', 'Leitos bloqueados/interditados', 'Motivo', 'Médico de plantão (FDS)', 'Enfermeiro(a) de plantão'],
    uti1: ['Leitos disponíveis', 'Altas do dia ainda não efetuadas', 'Leitos bloqueados/interditados', 'Motivo', 'Pacientes em diálise', 'Pacientes aguardando transferência', 'Médico de plantão', 'Enfermeiro(a) de plantão'],
    pa: ['Quantidade de pacientes em observação', 'Quantidade de pacientes aguardando atendimento', 'Quantidade de pacientes em boarding', 'Pacientes aguardando transferência', 'Maior tempo de boarding no PA', 'Equipe completa?', 'Médico de plantão', 'Ocorrências relevantes'],
  };
  expected.uti2 = expected.uti1;
  expected.uco = expected.uti1;
  for (const s of SECTORS) {
    // originais = todos exceto os complementares acrescentados (added:true)
    const orig = s.fields.filter((f) => !f.added).map((f) => f.label);
    const exp = expected[s.id];
    assert.deepEqual(orig, exp, `setor ${s.id}`);
  }
});

test('campos condicionais aparecem/ocultam conforme a resposta', () => {
  const por = SECTORS.find((s) => s.id === 'portaria');
  assert.ok(!visibleFields(por, {}).some((f) => f.id === 'ausencia_detalhe'));
  assert.ok(!visibleFields(por, { ausencia: 'nao' }).some((f) => f.id === 'ausencia_detalhe'));
  assert.ok(visibleFields(por, { ausencia: 'sim' }).some((f) => f.id === 'ausencia_detalhe'));
  const lab = SECTORS.find((s) => s.id === 'laboratorio');
  const ids = (a) => visibleFields(lab, a).map((f) => f.id);
  assert.ok(ids({ equip_falha: 'sim' }).includes('equip_identificacao') && ids({ equip_falha: 'sim' }).includes('equip_descricao'));
  assert.ok(!ids({ equip_falha: 'nao' }).includes('equip_identificacao'));
  const sus = SECTORS.find((s) => s.id === 'enf_sus');
  assert.ok(!visibleFields(sus, { bloqueados: '0' }).some((f) => f.id === 'motivo'), 'zero bloqueados não pede motivo');
  assert.ok(visibleFields(sus, { bloqueados: '2' }).some((f) => f.id === 'motivo'));
  assert.ok(!visibleFields(sus, {}).some((f) => f.id === 'motivo'), 'vazio não é tratado como bloqueado');
});

test('zero é resposta válida; vazio nunca vira zero/Não', () => {
  const sus = SECTORS.find((s) => s.id === 'enf_sus');
  const p = sectorProgress(sus, { leitos: '0' });
  assert.equal(p.status, 'progress');
  assert.ok(!p.missing.some((f) => f.id === 'leitos'));
  assert.ok(p.missing.some((f) => f.id === 'dialise'));
  const sh = baseShift({ answers: { enf_sus: { leitos: '0' } } });
  const sec = reportModel(sh).find((s) => s.id === 'enf_sus');
  assert.equal(sec.rows.find((r) => r.label === 'Leitos disponíveis').text, '0');
  assert.equal(sec.rows.find((r) => r.label === 'Pacientes em diálise').text, 'Não informado');
});

test('preenchimento x ocorrência são independentes (setor preenchido com ocorrência)', () => {
  const por = SECTORS.find((s) => s.id === 'portaria');
  const a = { equipe_completa: 'nao', ausencia: 'sim', ausencia_detalhe: 'Técnico faltou', cobertura: 'sim' };
  assert.equal(sectorProgress(por, a).status, 'done');
  assert.deepEqual(sectorAlerts(por, a), ['Equipe incompleta', 'Ausência no plantão']);
  assert.equal(sectorProgress(por, {}).status, 'none');
  assert.deepEqual(sectorAlerts(por, {}), []);
});

test('N/A conta como respondido e é diferente de Não informado', () => {
  const rou = SECTORS.find((s) => s.id === 'rouparia');
  const p = sectorProgress(rou, { enxoval_suficiente: NA, quantidade: NA, reposicao_urgente: 'nao' });
  assert.equal(p.status, 'done');
  const sh = baseShift({ answers: { rouparia: { enxoval_suficiente: NA } } });
  const rows = reportModel(sh).find((s) => s.id === 'rouparia').rows;
  assert.equal(rows[0].text, 'Não se aplica');
  assert.equal(rows[1].text, 'Não informado');
});

test('texto neutro ("nenhuma", "0") não gera ocorrência', () => {
  for (const t of ['nenhuma', 'Nenhum', 'nada', 'sem ocorrências', 'Sem pendências.', '-', '0', 'não', '  ']) assert.equal(isMeaningfulText(t), false, t);
  for (const t of ['Paciente caiu da maca', 'Atraso de 2h', 'Falta de lençol']) assert.equal(isMeaningfulText(t), true, t);
});

test('mensagem de apresentação segue o modelo', () => {
  assert.equal(openingMessage(baseShift()),
    'Boa noite!\n\nIniciando plantão administrativo noturno\n\nData: 13/11/2026\n\nHorário: 19 às 07hrs\n\nEnf: Rubens e Alana');
  const mt = openingMessage(baseShift({ type: 'MT', start: '07:00', end: '19:00', nurses: ['Ana'] }));
  assert.match(mt, /^Bom dia!/);
  assert.match(mt, /plantão administrativo diurno/);
  assert.match(mt, /Horário: 07 às 19hrs/);
  assert.match(mt, /Enf: Ana$/);
  assert.equal(greeting('13:00'), 'Boa tarde');
  assert.equal(joinNames(['A', 'B', 'C']), 'A, B e C');
});

test('relatório contém os 13 setores na ordem e todas as perguntas', () => {
  const text = reportText(baseShift());
  let last = -1;
  SECTORS.forEach((s, i) => {
    const title = `*${i + 1}. ${s.title.toUpperCase()}*`;
    const pos = text.indexOf(title);
    assert.ok(pos > last, `ordem do setor ${s.title}`);
    last = pos;
  });
  // vazio: cada pergunta visível aparece como Não informado
  assert.ok(text.includes('• Equipe completa?: _Não informado_'));
  assert.ok(text.includes('• Leitos bloqueados/interditados: _Não informado_'));
  // nada de dados fixos do exemplo vazando
  const other = reportText(baseShift({ nurses: ['Zélia'], date: '2027-01-02' }));
  assert.ok(!other.includes('Rubens') && !other.includes('Alana') && !other.includes('13/11/2026'));
  assert.ok(other.includes('Enf: Zélia') && other.includes('02/01/2027'));
});

test('relatório preenchido: respostas, acentos, caracteres especiais e texto longo', () => {
  const long = 'Á'.repeat(900) + ' fim';
  const sh = baseShift({
    answers: {
      portaria: { equipe_completa: 'sim', ausencia: 'sim', ausencia_detalhe: 'Técnica "João" faltou — cobertura & plantão extra: 50% às 22h', cobertura: 'sim', observacoes: 'linha 1\nlinha 2' },
      farmacia: { falta_critico: 'sim', falta_quais: 'Noradrenalina, Amiodarona', ocorrencias: long },
      uti1: { leitos: '0', altas_pendentes: '3', bloqueados: '1', motivo: 'Manutenção do ar-condicionado', dialise: '0', aguard_transf: '2', medico: 'Dr. José', enfermeiro: 'Conceição' },
    },
  });
  const t = reportText(sh);
  assert.ok(t.includes('• Equipe completa?: *Sim*'));
  assert.ok(t.includes('◦ Detalhamento da ausência: Técnica "João" faltou — cobertura & plantão extra: 50% às 22h'));
  assert.ok(t.includes('Observações:\n    linha 1\n    linha 2'));
  assert.ok(t.includes('Noradrenalina, Amiodarona'));
  assert.ok(t.includes(long));
  assert.ok(t.includes('• Leitos disponíveis: 0'));
  assert.ok(t.includes('◦ Motivo: Manutenção do ar-condicionado') || t.includes('• Motivo: Manutenção do ar-condicionado'));
  // URL do WhatsApp preserva acentos e símbolos
  const url = `https://wa.me/?text=${encodeURIComponent(t)}`;
  assert.equal(decodeURIComponent(url.split('text=')[1]), t);
});

test('pendências listam o que falta sem preencher artificialmente', () => {
  const sh = baseShift({ answers: { portaria: { equipe_completa: 'sim' } } });
  const m = missingList(sh);
  assert.equal(m.length, 13);
  const por = m.find((x) => x.id === 'portaria');
  assert.deepEqual(por.labels, ['Ausência no plantão?', 'Cobertura realizada?']); // Observações é opcional
  const sum = shiftSummary(sh);
  assert.equal(sum.done, 0);
  assert.equal(sum.progress, 1);
});

test('prévia: escapa HTML e converte negrito', () => {
  assert.equal(whatsappToHtml('*Sim* <b>x</b> & _Não informado_'), '<strong>Sim</strong> &lt;b&gt;x&lt;/b&gt; &amp; <em>Não informado</em>');
});

test('validação de identificação', () => {
  assert.deepEqual(Object.keys(validateIdentification({ type: 'N', date: '2026-11-13', start: '19:00', end: '07:00', nurses: ['A'] })), []);
  const e = validateIdentification({ type: 'X', date: '2026-02-31', start: '25:00', end: '', nurses: ['  ', ''] });
  assert.deepEqual(Object.keys(e).sort(), ['date', 'end', 'nurses', 'start', 'type']);
  assert.equal(isValidDate('2026-02-29'), false);
  assert.equal(isValidDate('2028-02-29'), true);
});

test('backup: exportar e importar ida e volta', () => {
  const s = baseShift({ answers: { portaria: { equipe_completa: 'sim' }, enf_sus: { leitos: '0' } } });
  const { shifts, rejected } = parseBackup(buildBackup([s]));
  assert.equal(rejected, 0);
  assert.equal(shifts.length, 1);
  assert.equal(shifts[0].answers.enf_sus.leitos, '0');
  assert.equal(reportText(shifts[0]), reportText(s));
});

test('backup inválido/corrompido é rejeitado com mensagem clara', () => {
  assert.throws(() => parseBackup(''), /vazio/);
  assert.throws(() => parseBackup('{corrompido'), /corrompido/);
  assert.throws(() => parseBackup('[]'), /não é um backup/);
  assert.throws(() => parseBackup(JSON.stringify({ app: 'plantao-control', schema: 99, shifts: [] })), /Versão/);
  assert.throws(() => parseBackup(JSON.stringify({ app: 'plantao-control', schema: 1 })), /lista de plantões/);
  assert.throws(() => parseBackup(JSON.stringify({ app: 'plantao-control', schema: 1, shifts: [{ id: 'x' }] })), /Nenhum plantão válido/);
});

test('backup parcialmente inválido importa só o válido e deduplica ids', () => {
  const good = baseShift();
  const dup = baseShift();
  const bad = { ...baseShift({ id: 'zzzzzzzz-9999' }), date: '2026-13-45' };
  const r = parseBackup(JSON.stringify({ app: 'plantao-control', schema: 1, shifts: [good, dup, bad] }));
  assert.equal(r.shifts.length, 1);
  assert.equal(r.rejected, 2);
});

test('sanitização remove campos desconhecidos, valores inválidos e trunca textos', () => {
  const a = sanitizeAnswers({
    portaria: { equipe_completa: 'talvez', ausencia: 'sim', cobertura: NA, observacoes: 'x'.repeat(5000), campo_inventado: 'a' },
    enf_sus: { leitos: '-3', dialise: '1.5', altas_pendentes: '12' },
    setor_falso: { a: 'b' },
  });
  assert.equal(a.portaria.equipe_completa, undefined);
  assert.equal(a.portaria.ausencia, 'sim');
  assert.equal(a.portaria.cobertura, NA);
  assert.equal(a.portaria.observacoes.length, 1000);
  assert.equal(a.portaria.campo_inventado, undefined);
  assert.deepEqual(a.enf_sus, { altas_pendentes: '12' });
  assert.equal(a.setor_falso, undefined);
});

test('normalizeShift rejeita registros malformados', () => {
  assert.throws(() => normalizeShift(null));
  assert.throws(() => normalizeShift({ ...baseShift(), type: 'Z' }));
  assert.throws(() => normalizeShift({ ...baseShift(), nurses: [] }));
  assert.throws(() => normalizeShift({ ...baseShift(), start: '7h' }));
  assert.doesNotThrow(() => normalizeShift(baseShift()));
});
