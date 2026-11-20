import test from 'node:test';
import assert from 'node:assert/strict';
import { SECTORS, NA, applyFormConfig, sanitizeFormConfig, sectorProgress, sectorAlerts, visibleFields, isMeaningfulText, shiftSummary, sectorStatus, nextAttention, effectiveAnswers } from '../js/sectors.js';
import { finalReportText, openingMessage, reportText, DEFAULT_FORMAT, normalizeFormat, reportModel, missingList, greeting, joinNames, whatsappToHtml } from '../js/report.js';
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
    const orig = s.fields.filter((f) => !f.added && f.id !== 'ocorrencias_relevantes').map((f) => f.label);
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

test('número não digitado vale 0 (e não trava o setor); texto vazio continua "-"', () => {
  const sus = SECTORS.find((s) => s.id === 'enf_sus');
  const p = sectorProgress(sus, { leitos: '0' });
  assert.equal(p.status, 'progress');
  assert.ok(!p.missing.some((f) => f.id === 'leitos'));
  assert.ok(!p.missing.some((f) => f.id === 'dialise'), 'número vazio conta como 0');
  assert.ok(p.missing.some((f) => f.id === 'medico'), 'texto vazio continua pendente');
  const sh = baseShift({ answers: { enf_sus: { leitos: '0' } } });
  const sec = reportModel(sh).find((s) => s.id === 'enf_sus');
  assert.equal(sec.rows.find((r) => r.label === 'Leitos disponíveis').text, '0');
  assert.equal(sec.rows.find((r) => r.label === 'Pacientes em diálise').text, '0');
  assert.equal(sec.rows.find((r) => r.label === 'Médico de plantão (FDS)').text, '-');
});

test('preenchimento x ocorrência são independentes (setor preenchido com ocorrência)', () => {
  const por = SECTORS.find((s) => s.id === 'portaria');
  const a = { equipe_completa: 'nao', ausencia: 'sim', ausencia_detalhe: 'Técnico faltou', cobertura: 'sim' };
  assert.equal(sectorProgress(por, a).status, 'done');
  assert.deepEqual(sectorAlerts(por, a), ['Equipe incompleta', 'Ausência no plantão']);
  assert.equal(sectorProgress(por, {}).status, 'none');
  assert.deepEqual(sectorAlerts(por, {}), []);
});

test('N/A conta como respondido e aparece como "-"; número vazio aparece como 0', () => {
  const rou = SECTORS.find((s) => s.id === 'rouparia');
  const p = sectorProgress(rou, { enxoval_suficiente: NA, quantidade: NA, reposicao_urgente: 'nao' });
  assert.equal(p.status, 'done');
  const sh = baseShift({ answers: { rouparia: { enxoval_suficiente: NA } } });
  const rows = reportModel(sh).find((s) => s.id === 'rouparia').rows;
  assert.deepEqual([rows[0].text, rows[0].kind], ['-', 'na']);
  assert.equal(rows[1].text, '0');
});

test('texto neutro ("nenhuma", "0") não gera ocorrência', () => {
  for (const t of ['nenhuma', 'Nenhum', 'nada', 'sem ocorrências', 'Sem pendências.', '-', '0', 'não', '  ']) assert.equal(isMeaningfulText(t), false, t);
  for (const t of ['Paciente caiu da maca', 'Atraso de 2h', 'Falta de lençol']) assert.equal(isMeaningfulText(t), true, t);
});

test('mensagem de apresentação: sem linhas em branco e com negrito', () => {
  const m = openingMessage(baseShift());
  assert.equal(m, 'Boa noite!\n*Iniciando plantão administrativo noturno*\n*Data:* 13/11/2026\n*Horário:* 19 às 07hrs\n*Enf:* Rubens e Alana');
  assert.ok(!m.includes('\n\n'));
  const mt = openingMessage(baseShift({ type: 'MT', start: '07:00', end: '19:00', nurses: ['Ana'] }));
  assert.match(mt, /^Bom dia!/);
  assert.match(mt, /plantão administrativo diurno\*/);
  assert.match(mt, /\*Horário:\* 07 às 19hrs/);
  assert.match(mt, /\*Enf:\* Ana$/);
  assert.equal(greeting('13:00'), 'Boa tarde');
  assert.equal(joinNames(['A', 'B', 'C']), 'A, B e C');
});

test('relatório contém os 13 setores na ordem e todas as perguntas', () => {
  const text = reportText(baseShift());
  let last = -1;
  SECTORS.forEach((s, i) => {
    const title = `*${s.title.toUpperCase()}*`;
    const pos = text.indexOf(title);
    assert.ok(pos > last, `ordem do setor ${s.title}`);
    last = pos;
  });
  // vazio: cada pergunta visível aparece como Não informado
  assert.ok(text.includes('• *Equipe completa?* -'));
  assert.ok(text.includes('• *Leitos bloqueados/interditados:* 0'));
  assert.ok(!/\n\n\n/.test(text), 'no máximo uma linha em branco');
  assert.ok(!/\*\d+\. /.test(text), 'títulos sem numeração');
  // nada de dados fixos do exemplo vazando; relatório NÃO leva enfermeiro nem horário (ficam na apresentação)
  const other = reportText(baseShift({ nurses: ['Zélia'], date: '2027-01-02' }));
  assert.ok(!other.includes('Rubens') && !other.includes('Alana') && !other.includes('13/11/2026'));
  assert.ok(other.includes('02/01/2027') && !other.includes('Zélia') && !other.includes('Enf:') && !other.includes('Horário'));
});

test('relatório: uma linha em branco entre setores e nenhuma dentro do setor', () => {
  const lines = reportText(baseShift()).split('\n');
  SECTORS.forEach((s, i) => {
    const at = lines.indexOf(`*${s.title.toUpperCase()}*`);
    assert.equal(lines[at - 1], '', `linha em branco antes de ${s.title}`);
    assert.notEqual(lines[at + 1], '');
  });
  assert.equal(lines.filter((l) => l === '').length, SECTORS.length);
  assert.ok(!reportText(baseShift()).startsWith('\n') && !reportText(baseShift()).endsWith('\n'));
});

test('todos os setores têm "Ocorrências relevantes" por último e ela é opcional', () => {
  for (const s of SECTORS) {
    const last = s.fields.at(-1);
    assert.equal(last.label, 'Ocorrências relevantes', s.id);
    assert.ok(last.optional, s.id);
  }
  const t = reportText(baseShift());
  assert.equal(t.split('*Ocorrências relevantes:*').length - 1, 13);
});

test('config do formulário: renomear, remover (com filhos), adicionar e restaurar; respostas antigas preservadas', () => {
  const por = SECTORS.find((x) => x.id === 'portaria');
  const before = por.fields.map((f) => f.id);
  const cfg = applyFormConfig({ version: 1, sectors: { portaria: { removed: ['ausencia'], labels: { cobertura: 'Cobertura ok?' }, added: [{ id: 'c_abc123', label: 'Nova pergunta', type: 'num', optional: false }, { id: 'ruim', label: 'x', type: 'yn' }] } } });
  const ids = por.fields.map((f) => f.id);
  assert.ok(!ids.includes('ausencia') && !ids.includes('ausencia_detalhe'), 'pai e filho removidos');
  assert.equal(por.fields.find((f) => f.id === 'cobertura').label, 'Cobertura ok?');
  assert.equal(ids.at(-2), 'c_abc123'); assert.equal(ids.at(-1), 'ocorrencias_relevantes');
  assert.ok(!ids.includes('ruim'), 'id inválido descartado'); assert.equal(cfg.sectors.portaria.added.length, 1);
  const kept = sanitizeAnswers({ portaria: { ausencia: 'sim', c_abc123: '7' } });
  assert.equal(kept.portaria.ausencia, 'sim', 'resposta de pergunta removida é preservada'); assert.equal(kept.portaria.c_abc123, '7');
  const r = reportText(baseShift({ answers: { portaria: { c_abc123: '7' } } }));
  assert.ok(r.includes('• *Nova pergunta:* 7') && !r.includes('Ausência no plantão'));
  applyFormConfig(null);
  assert.deepEqual(por.fields.map((f) => f.id), before, 'restaurar volta ao padrão');
  assert.deepEqual(sanitizeFormConfig({ sectors: 5 }), { version: 1, sectors: {} });
});

test('senha do admin: aceita a correta (sem diferenciar maiúsculas/espaços) e recusa as demais', async () => {
  const { checkPassword } = await import('../js/formconfig.js');
  assert.ok(checkPassword('hc2026') && checkPassword('  HC2026 '));
  assert.ok(!checkPassword('') && !checkPassword('hc2025') && !checkPassword('admin'));
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
  assert.ok(t.includes('• *Equipe completa?* Sim'));
  assert.ok(t.includes('◦ *Detalhamento da ausência:* Técnica "João" faltou — cobertura & plantão extra: 50% às 22h'));
  assert.ok(t.includes('• *Observações:*\n      linha 1\n      linha 2'));
  assert.ok(t.includes('Noradrenalina, Amiodarona'));
  assert.ok(t.includes(long));
  assert.ok(t.includes('• *Leitos disponíveis:* 0'));
  assert.ok(t.includes('◦ *Motivo:* Manutenção do ar-condicionado'));
  // todo marcador de negrito está balanceado em cada linha
  for (const line of t.split('\n')) assert.equal((line.match(/\*/g) || []).length % 2, 0, line);
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
  assert.equal(sum.review, 0);
  assert.equal(sum.done, 0);
  assert.equal(sum.progress, 1);
});

test('prévia: escapa HTML e converte negrito', () => {
  assert.equal(whatsappToHtml('*Sim* <b>x</b> & _itálico_'), '<strong>Sim</strong> &lt;b&gt;x&lt;/b&gt; &amp; <em>itálico</em>');
  assert.equal(whatsappToHtml('• *Equipe completa?* -'), '• <strong>Equipe completa?</strong> -');
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

test('setor copiado do plantão anterior: estado "revisar", fora do relatório até confirmar', () => {
  const por = SECTORS.find((s) => s.id === 'portaria');
  const answers = { portaria: { equipe_completa: 'nao', ausencia: 'nao', cobertura: 'sim' } };
  const sh = baseShift({ answers, sectorMeta: { portaria: { firstAt: null, doneAt: null, carried: true } } });
  assert.equal(sectorStatus(sh, por), 'review');
  assert.deepEqual(effectiveAnswers(sh, 'portaria'), {});
  const sum = shiftSummary(sh);
  assert.equal(sum.review, 1);
  assert.equal(sum.done, 0);
  assert.equal(sum.alerts, 0, 'ocorrência antiga não conta até confirmar');
  const t = reportText(sh);
  assert.ok(t.includes('• *Equipe completa?* -'), 'dado não confirmado não vai para o relatório');
  assert.ok(missingList(sh).find((m) => m.id === 'portaria').labels[0].includes('Aguardando revisão'));
  // confirmado: passa a valer
  const ok = baseShift({ answers, sectorMeta: { portaria: { firstAt: null, doneAt: null, carried: false } } });
  assert.equal(sectorStatus(ok, por), 'done');
  assert.equal(shiftSummary(ok).done, 1);
  assert.equal(shiftSummary(ok).alerts, 1);
  assert.ok(reportText(ok).includes('• *Equipe completa?* Não'));
});

test('próximo setor pendente: pula preenchidos, dá a volta e retorna null quando tudo pronto', () => {
  const full = (id) => {
    const sec = SECTORS.find((s) => s.id === id); const a = {};
    for (const f of sec.fields) a[f.id] = f.type === 'yn' ? 'nao' : f.type === 'num' ? '0' : 'x';
    return a;
  };
  const answers = {};
  for (const s of SECTORS) answers[s.id] = full(s.id);
  const sh = baseShift({ answers });
  assert.equal(nextAttention(sh, -1), null);
  delete answers.recepcao; delete answers.uti2;
  assert.equal(nextAttention(sh, -1).id, 'recepcao');
  assert.equal(nextAttention(sh, 1).id, 'uti2');          // depois de Recepção → UTI 2
  assert.equal(nextAttention(sh, 10).id, 'recepcao');      // depois de UTI 2 dá a volta
  assert.equal(nextAttention(sh, 0).id, 'recepcao');
});

test('backup preserva setores a revisar e a origem do plantão', () => {
  const s = baseShift({ carriedFrom: 'zzzzzzzz-1111', answers: { portaria: { cobertura: 'sim' } }, sectorMeta: { portaria: { firstAt: null, doneAt: null, carried: true } } });
  const { shifts } = parseBackup(buildBackup([s]));
  assert.equal(shifts[0].sectorMeta.portaria.carried, true);
  assert.equal(shifts[0].carriedFrom, 'zzzzzzzz-1111');
});

test('campo vazio sai como traço e nunca como "Não informado"', () => {
  const t = reportText(baseShift());
  assert.ok(!/não informado/i.test(t), 'sem a expressão "Não informado"');
  assert.ok(/• \*Equipe completa\?\* -(\n|$)/.test(t));
  assert.ok(!t.includes('_'), 'sem itálico residual');
});

test('relatório editado: usa o texto manual e detecta quando os dados mudam depois', () => {
  const sh = baseShift();
  const auto = reportText(sh);
  assert.deepEqual({ e: finalReportText(sh).edited, s: finalReportText(sh).stale }, { e: false, s: false });
  sh.reportEdit = { text: auto + '\nObs manual', base: auto };
  let fr = finalReportText(sh);
  assert.ok(fr.edited && !fr.stale && fr.text.endsWith('Obs manual'));
  sh.answers = { portaria: { equipe_completa: 'sim' } };
  fr = finalReportText(sh);
  assert.ok(fr.edited && fr.stale, 'dados mudaram depois da edição');
});

test('reportEdit sobrevive a normalização e backup; edição vazia é descartada', () => {
  const sh = baseShift({ reportEdit: { text: 'texto manual', base: 'x' } });
  assert.equal(normalizeShift(JSON.parse(JSON.stringify(sh))).reportEdit.text, 'texto manual');
  const back = parseBackup(buildBackup([normalizeShift(sh)]));
  assert.equal(back.shifts[0].reportEdit.text, 'texto manual');
  assert.equal(normalizeShift({ ...sh, reportEdit: { text: '   ', base: '' } }).reportEdit, null);
});

test('N/A em número também sai como "-" (não 0)', () => {
  const sh = baseShift({ answers: { enf_sus: { leitos: NA } } });
  const t = reportText(sh);
  assert.ok(t.includes('• *Leitos disponíveis:* -') && t.includes('• *Pacientes em diálise:* 0'));
});

test('PA: vários médicos (lista de nomes) — uma por linha no dado, vírgulas no relatório', () => {
  const pa = SECTORS.find((x) => x.id === 'pa');
  assert.equal(pa.fields.find((f) => f.id === 'medico').type, 'multi');
  const a = sanitizeAnswers({ pa: { medico: ' Dr. A \n\n Dra. B \n' + 'x'.repeat(300) } });
  assert.equal(a.pa.medico.split('\n').length, 3); assert.equal(a.pa.medico.split('\n')[0], 'Dr. A'); assert.equal(a.pa.medico.split('\n')[2].length, 120);
  const t = reportText(baseShift({ answers: { pa: { medico: 'Dr. A\nDra. B' } } }));
  assert.ok(t.includes('• *Médico de plantão:* Dr. A, Dra. B'));
  assert.equal(sanitizeAnswers({ pa: { medico: ' \n ' } }).pa?.medico, undefined);
});

test('formatação personalizada: padrão = modelo atual; opções mudam só a aparência', () => {
  const sh = baseShift({ answers: { portaria: { equipe_completa: 'sim' } } });
  assert.equal(reportText(sh), reportText(sh, DEFAULT_FORMAT));
  const t = reportText(sh, { bullet: '-', boldQuestions: false, boldTitles: false, upperTitles: false, numberTitles: false, blankBetween: false, showDate: false });
  const lines = t.split('\n');
  assert.equal(lines[0], 'PLANTÃO ADMINISTRATIVO — NOTURNO');
  assert.equal(lines[1], 'Portaria/Acolhimento');
  assert.equal(lines[2], '- Equipe completa? Sim');
  assert.ok(!t.includes('*') && !t.includes('\n\n') && !t.includes('Data:'));
  assert.ok(reportText(sh, { bullet: '' }).includes('\nEquipe completa? Sim') === false); // negrito ainda ligado
  assert.ok(reportText(sh, { bullet: '' }).includes('\n*Equipe completa?* Sim'));
  // ordem dos setores NUNCA muda com a formatação
  const idx = SECTORS.map((x) => t.indexOf(x.title));
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b));
  assert.deepEqual(normalizeFormat({ bullet: '??', boldQuestions: 'x', upperTitles: false }), { ...DEFAULT_FORMAT, upperTitles: false });
});

test('ordem de navegação do usuário: validada, completa e sem efeito no relatório', async () => {
  const prefs = await import('../js/prefs.js');
  const ids = SECTORS.map((x) => x.id);
  prefs.setOrder(['pa', 'uti1', 'xxx', 'pa', ...ids.filter((i) => i !== 'pa' && i !== 'uti1')].slice(0, 6));
  const got = prefs.getOrder();
  assert.deepEqual(got.slice(0, 2), ['pa', 'uti1']); assert.equal(new Set(got).size, 13); assert.ok(prefs.isCustomOrder());
  const sh = baseShift({});
  const before = reportText(sh);
  assert.deepEqual(prefs.orderedSectors().map((x) => x.id), got);
  assert.equal(reportText(sh), before);
  // Próximo/Continuar seguem a ordem do usuário
  const nx = nextAttention(sh, -1, prefs.orderedSectors());
  assert.equal(nx.id, 'pa');
  prefs.resetOrder(); assert.deepEqual(prefs.getOrder(), ids); assert.ok(!prefs.isCustomOrder());
});
