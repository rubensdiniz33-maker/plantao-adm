"""Testes de ponta a ponta (Chromium via Playwright). Uso:
   node tests/serve.mjs 5173 &   python3 tests/e2e.py
Variáveis: BASE_URL (padrão http://localhost:5173), CHROME (executável, opcional), SHOTS (pasta de capturas)."""
import json, os, re, shutil, sys, tempfile, urllib.parse
from playwright.sync_api import sync_playwright

BASE = os.environ.get('BASE_URL', 'http://localhost:5173')
CHROME = os.environ.get('CHROME', '/usr/bin/google-chrome')
SHOTS = os.environ.get('SHOTS', '/tmp/shots')
os.makedirs(SHOTS, exist_ok=True)
RESULTS = []

def check(name, cond, detail=''):
    RESULTS.append((name, bool(cond), detail))
    print(('PASS ' if cond else 'FAIL ') + name + (f'  -> {detail}' if (detail and not cond) else ''))

SECTORS = ['portaria','recepcao','farmacia','rouparia','laboratorio','hemodinamica','centro_cirurgico',
           'enf_sus','enf_convenio','uti1','uti2','uco','pa']
TITLES = ['Portaria/Acolhimento','Recepção','Farmácia','Rouparia','Laboratório','Hemodinâmica','Centro Cirúrgico',
          'Enfermaria SUS','Enfermaria Convênio/Particular','UTI 1','UTI 2','UCO','Pronto Atendimento']
BEDS = dict(leitos='0', altas_pendentes='0', bloqueados='0', dialise='0', aguard_transf='0', medico='Dr. Teste', enfermeiro='Enf. Teste')
DATA = {
 'portaria': dict(equipe_completa='sim', ausencia='sim', ausencia_detalhe='Técnica "Maria" faltou — cobertura & extra: 50% às 22h', cobertura='sim', observacoes='Sem outras alterações\nSegunda linha'),
 'recepcao': dict(equipe_completa='sim', pendencias='nenhuma', reclamacoes='Reclamação sobre tempo de espera'),
 'farmacia': dict(falta_critico='sim', falta_quais='Noradrenalina', ocorrencias='nenhuma'),
 'rouparia': dict(enxoval_suficiente='sim', quantidade='120', reposicao_urgente='nao'),
 'laboratorio': dict(exames_indispensaveis='nao', equip_falha='sim', equip_identificacao='Analisador hematológico', equip_descricao='Erro de calibração'),
 'hemodinamica': dict(medico_sobreaviso='Dr. Álvaro', previsao_exames='2 cateterismos', intercorrencias='nenhuma'),
 'centro_cirurgico': dict(realizados='3 cirurgias', suspensos='nenhum', atrasos='nenhum', equipe_completa='sim', autoclave='sim'),
 'enf_sus': dict(leitos='4', altas_pendentes='2', aguard_transf='1', dialise='0', bloqueados='0', medico='Dra. Joana', enfermeiro='Paula'),
 'enf_convenio': dict(leitos='2', altas_pendentes='0', bloqueados='1', motivo='Manutenção', medico='Dr. Caio', enfermeiro='Rita'),
 'uti1': dict(BEDS), 'uti2': dict(BEDS, leitos='1'), 'uco': dict(BEDS, leitos='3'),
 'pa': dict(observacao='5', aguardando='12', boarding='3', aguard_transf='0', maior_boarding='5h30', equipe_completa='nao', medico='Dr. Paulo', ocorrencias='Superlotação'),
}
YN = {'equipe_completa','ausencia','cobertura','falta_critico','enxoval_suficiente','reposicao_urgente','exames_indispensaveis','equip_falha','autoclave'}
EXPECT_ALERT = {'portaria','recepcao','farmacia','laboratorio','enf_convenio','pa'}

def fill_fields(pg, data):
    for fid, val in data.items():
        sel = f'[data-field="{fid}"]'
        pg.wait_for_selector(sel, state='visible')
        if fid in YN:
            btn = f'{sel} [data-v="{val}"]'
            if pg.get_attribute(btn, 'aria-pressed') != 'true':
                pg.click(btn)
        else:
            pg.fill(f'{sel} input, {sel} textarea', val)
    pg.wait_for_timeout(350)

def fill_sector(pg, sid, data):
    pg.click(f'#sec-{sid}')
    pg.wait_for_selector('[data-field]')
    fill_fields(pg, data)
    pg.click('#btn-back-panel')
    pg.wait_for_selector('#progress-label')

def rawtext(pg):
    return pg.input_value('#report-text')

def plain(pg):
    return rawtext(pg).replace('*', '')

def fmttext(pg):
    pg.click('#tab-fmt'); pg.wait_for_selector('#report-preview', state='visible')
    t = pg.evaluate("document.getElementById('report-preview').innerText")
    return t

def st(pg, sid):
    el = pg.locator(f'#sec-{sid}')
    return el.get_attribute('data-status'), el.get_attribute('data-alert')

def create_shift(pg, nurse, type_=None, date=None, base=False):
    pg.goto(BASE + '/#/'); pg.wait_for_selector('#btn-start'); pg.click('#btn-start')
    pg.wait_for_selector('#btn-create, .dlg')
    if pg.locator('.dlg').count():
        t = pg.inner_text('.dlg')
        if 'em andamento' in t: pg.click('.dlg .btn:has-text("Iniciar novo")'); pg.wait_for_selector('#btn-create, .dlg')
    if pg.locator('.dlg').count() and 'último plantão' in pg.inner_text('.dlg'):
        pg.click('.dlg .btn:has-text("Sim, continuar")' if base else '.dlg .btn:has-text("Não, em branco")')
    pg.wait_for_selector('#btn-create')
    if type_: pg.click(f'#type-{type_}')
    if date: pg.fill('#f-date', date)
    pg.fill('[data-nurse="0"]', nurse)
    pg.click('#btn-create'); pg.wait_for_selector('#btn-to-panel'); pg.click('#btn-to-panel'); pg.wait_for_selector('#sec-portaria')

def main():
    tmp = tempfile.mkdtemp(prefix='plantao-e2e-')
    profile = os.path.join(tmp, 'profile'); dl_dir = os.path.join(tmp, 'dl'); os.makedirs(dl_dir)
    with sync_playwright() as p:
        ctx_args = dict(executable_path=CHROME, args=['--no-sandbox'], headless=True, viewport={'width':390,'height':844}, device_scale_factor=2,
                        is_mobile=True, has_touch=True, locale='pt-BR', timezone_id='America/Fortaleza', accept_downloads=True,
                        permissions=['clipboard-read','clipboard-write'])
        # ============================ A) 1º plantão: fluxo completo
        ctx = p.chromium.launch_persistent_context(profile, **ctx_args)
        pg = ctx.pages[0] if ctx.pages else ctx.new_page()
        errors = []
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        pg.add_init_script("window.__opened=[]; window.open=(u)=>{window.__opened.push(u); return {};};")

        pg.goto(BASE + '/'); pg.wait_for_selector('#btn-start')
        check('Home: PLANTÃO ADM (sem "Control"), data e sem Retomar', 'ADM' in pg.inner_text('.brand') and 'CONTROL' not in pg.inner_text('body').upper() and re.search(r'\d{4}', pg.inner_text('.datehero')) and pg.locator('#btn-resume').count() == 0)
        check('Título da aba e manifesto: Plantão ADM', pg.title() == 'Plantão ADM' and pg.evaluate("fetch('manifest.webmanifest').then(r => r.json()).then(m => m.name + '|' + m.short_name)") == 'Plantão ADM|Plantão ADM')
        icons = pg.evaluate("[...document.querySelectorAll('link[rel~=icon]')].map(l => l.getAttribute('href'))")
        okf = pg.evaluate("Promise.all(['icons/favicon.svg','icons/favicon.ico','icons/favicon-32.png'].map(u => fetch(u).then(r => r.ok)))")
        svg = pg.evaluate("fetch('icons/favicon.svg').then(r => r.text())")
        check('Favicon: coração (svg/png/ico) declarado e acessível', 'icons/favicon.svg' in icons and 'icons/favicon.ico' in icons and all(okf) and 'M20.8 5.6' in svg, str(icons))
        hero = pg.locator('#btn-start').bounding_box()
        check('Home enxuta: INICIAR PLANTÃO em destaque (≥ 80px, largura total) e poucos elementos', hero['height'] >= 80 and hero['width'] >= 340 and pg.locator('main.home .card').count() == 0 and pg.locator('main.home button, main.home a').count() <= 3, f"{hero} {pg.locator('main.home button, main.home a').count()}")
        check('Home: data com "de" minúsculo', re.search(r'\d+ de [a-zç]+ de \d{4}', pg.inner_text('.datehero')) is not None, pg.inner_text('.datehero'))
        check('Histórico removido da interface (sem botão/rota)', pg.locator('#btn-history').count() == 0 and 'Histórico' not in pg.inner_text('body'))
        bg = pg.evaluate("getComputedStyle(document.body).backgroundColor"); fam = pg.evaluate("getComputedStyle(document.body).fontFamily")
        check('Tema: fundo branco e fonte Plus Jakarta Sans', bg == 'rgb(255, 255, 255)' and 'Plus Jakarta Sans' in fam, f'{bg} {fam}')
        red = pg.evaluate("getComputedStyle(document.querySelector('#btn-start')).backgroundColor")
        check('Tema: botão principal vermelho', red == 'rgb(200, 16, 46)', red)
        check('Fonte local carregada', pg.evaluate("document.fonts.check('16px \"Plus Jakarta Sans\"')"))
        pg.goto(BASE + '/#/historico'); pg.wait_for_selector('#btn-start')
        check('Rota antiga /historico redireciona para a Home', pg.url.endswith('#/'), pg.url)

        pg.click('#btn-start'); pg.wait_for_selector('#btn-create')
        check('1º plantão: sem pergunta de continuar (não há plantão anterior)', pg.locator('.dlg').count() == 0)
        pg.click('#btn-create'); pg.wait_for_timeout(200)
        check('Abertura: bloqueia sem enfermeiro', pg.locator('#btn-to-panel').count() == 0 and 'enfermeiro' in pg.inner_text('main').lower())
        pg.click('#type-N'); pg.fill('#f-date', '2026-11-13'); pg.fill('[data-nurse="0"]', 'Rubens')
        pg.click('#btn-add-nurse'); pg.fill('[data-nurse="1"]', 'Alana')
        pv = pg.inner_text('#opening-preview')
        check('Apresentação: mensagem sem parágrafos (sem linha em branco)', '\n\n' not in pv and pv.count('\n') == 4, repr(pv))
        check('Apresentação: conteúdo igual ao modelo', pv == 'Boa noite!\nIniciando plantão administrativo noturno\nData: 13/11/2026\nHorário: 19 às 07hrs\nEnf: Rubens e Alana', repr(pv))
        strongs = pg.eval_on_selector_all('#opening-preview strong', 'els => els.map(e => e.textContent)')
        check('Apresentação: destaques em negrito na prévia', strongs == ['Iniciando plantão administrativo noturno', 'Data:', 'Horário:', 'Enf:'], str(strongs))
        pg.click('#btn-copy-open')
        clip = pg.evaluate('navigator.clipboard.readText()')
        check('Apresentação: copiar entrega asteriscos do WhatsApp e sem linha em branco', clip == 'Boa noite!\n*Iniciando plantão administrativo noturno*\n*Data:* 13/11/2026\n*Horário:* 19 às 07hrs\n*Enf:* Rubens e Alana', repr(clip))
        pg.click('#btn-wa-open')
        opened = pg.evaluate('window.__opened')
        check('Apresentação: wa.me com texto codificado idêntico', len(opened) == 1 and urllib.parse.unquote(opened[0].split('text=')[1]) == clip)
        pg.click('#type-MT'); check('Abertura: MT muda saudação e horário', 'Bom dia!' in pg.inner_text('#opening-preview') and '07 às 19hrs' in pg.inner_text('#opening-preview')); pg.click('#type-N')
        pg.screenshot(path=f'{SHOTS}/10-abertura.png')
        pg.click('#btn-create'); pg.wait_for_selector('#btn-to-panel'); pg.click('#btn-to-panel'); pg.wait_for_selector('#sec-portaria')
        shift_url = pg.url
        check('Painel: 13 setores na ordem e todos cinza', pg.locator('.sec .name').all_inner_texts() == TITLES and all(st(pg, s)[0] == 'none' for s in SECTORS))
        check('Painel: botão "Continuar" aponta para o 1º setor pendente', 'Portaria/Acolhimento' in pg.inner_text('#btn-continue'))

        # ---- seletor de setores + contador + barra
        pg.click('#btn-continue'); pg.wait_for_selector('[data-field="equipe_completa"]')
        check('Setor: contador mostra a posição "1/13"', pg.inner_text('#sel-count') == '1/13')
        hh = pg.locator('.stickyhead').bounding_box()['height']
        top1 = pg.locator('.fieldcard:visible').first.bounding_box()['y']
        check('Setor: topo compacto (cabeçalho ≤ 72px, 1º campo logo abaixo, sem faixa nem avisos)', hh <= 72 and top1 <= 100 and pg.locator('#strip-label, .strip, .content > .banner').count() == 0, f'head={hh} first={top1}')
        check('Selo de salvamento compacto sem texto residual', 'null' not in pg.inner_text('.stickyhead') and pg.locator('.stickyhead .savebadge').count() == 1)
        rb_ = pg.locator('#btn-report-sector').bounding_box()
        check('"Relatório" visível em TODOS os setores (rodapé fixo, ≥ 44px)', pg.locator('#btn-report-sector').is_visible() and rb_['height'] >= 44 and rb_['y'] + rb_['height'] <= 844)
        check('Setor: só um filete fino de progresso (≤ 4px)', pg.locator('.stickyhead .pbar').count() == 1 and pg.locator('.stickyhead .pbar').bounding_box()['height'] <= 4)
        pg.click('#btn-sectors'); pg.wait_for_selector('.srow')
        check('Seletor: lista os 13 setores e marca o atual', pg.locator('.srow').count() == 13 and pg.locator('.srow[aria-current="true"]').count() == 1 and 'Portaria' in pg.inner_text('.srow[aria-current="true"]'))
        check('Seletor: título e contador de preenchidos visíveis', pg.locator('.sheethead h2').is_visible() and '0 de 13' in pg.inner_text('#sheet-count'))
        pg.click('#srow-pa'); pg.wait_for_selector('[data-field="observacao"]')
        check('Seletor: pula direto para outro setor (Pronto Atendimento)', 'Pronto Atendimento' in pg.inner_text('.topbar h1') and pg.locator('.overlay').count() == 0)
        # stepper
        pg.click('[data-field="observacao"] [data-step="1"]'); pg.click('[data-field="observacao"] [data-step="1"]'); pg.click('[data-field="observacao"] [data-step="1"]')
        check('Campo numérico: botão + incrementa', pg.input_value('[data-field="observacao"] input') == '3')
        pg.click('[data-field="observacao"] [data-step="-1"]')
        check('Campo numérico: botão − decrementa', pg.input_value('[data-field="observacao"] input') == '2')
        for _ in range(5): pg.click('[data-field="observacao"] [data-step="-1"]')
        check('Campo numérico: − para em zero e zero vale como informado', pg.input_value('[data-field="observacao"] input') == '0' and pg.locator('[data-field="observacao"].answered').count() == 1)
        pg.fill('[data-field="observacao"] input', '')
        check('Campo numérico: apagar volta a não respondido (sem rótulo "Não informado")', pg.locator('[data-field="observacao"].answered').count() == 0 and 'Não informado' not in pg.inner_text('[data-field="observacao"]'))
        pg.click('#btn-back-panel'); pg.wait_for_selector('#sec-portaria')

        # ---- condicionais / validações essenciais
        pg.click('#sec-portaria'); pg.wait_for_selector('[data-field="ausencia"]')
        check('Condicional: detalhe oculto → aparece com Sim', not pg.locator('[data-field="ausencia_detalhe"]').is_visible())
        pg.click('[data-field="ausencia"] [data-v="sim"]'); check('Condicional: detalhe aparece', pg.locator('[data-field="ausencia_detalhe"]').is_visible())
        ab, lastf = pg.locator('#sector-alerts').bounding_box(), pg.locator('.fieldcard:visible').last.bounding_box()
        check('Ocorrência: aviso discreto no FIM do formulário (não no topo) e baixo', pg.locator('#sector-alerts').is_visible() and ab['y'] > lastf['y'] and ab['height'] <= 70, f'{ab} {lastf}')
        pg.click('[data-field="ausencia"] [data-v="sim"]'); check('Seletor: tocar de novo limpa a resposta', pg.locator('[data-field="ausencia"].answered').count() == 0)
        pg.click('[data-field="cobertura"] [data-v="__na__"]'); check('N/A distinto de Não informado', pg.locator('[data-field="cobertura"] .state').inner_text() == 'Não se aplica')
        pg.click('[data-field="cobertura"] [data-v="__na__"]'); pg.click('#btn-back-panel'); pg.wait_for_selector('#sec-portaria')
        pg.click('#sec-enf_sus'); pg.wait_for_selector('[data-field="bloqueados"]')
        pg.fill('[data-field="bloqueados"] input', '0'); check('Zero bloqueados não pede motivo', not pg.locator('[data-field="motivo"]').is_visible())
        pg.fill('[data-field="bloqueados"] input', '2'); check('Bloqueados > 0 pede motivo', pg.locator('[data-field="motivo"]').is_visible())
        pg.fill('[data-field="leitos"] input', ''); pg.type('[data-field="leitos"] input', '-3.5a7')
        check('Numérico: só dígitos', pg.input_value('[data-field="leitos"] input') == '357')
        pg.fill('[data-field="medico"] input', 'x' * 1200); check('Texto: limite de 1000', len(pg.input_value('[data-field="medico"] input')) == 1000)
        pg.fill('[data-field="medico"] input', ''); pg.click('#btn-back-panel'); pg.wait_for_selector('#sec-portaria')

        # ---- preencher tudo (usando "Próximo" na ordem para validar a navegação)
        for sid in SECTORS:
            fill_sector(pg, sid, DATA[sid])
        pg.wait_for_timeout(900)
        check('Painel: 13 de 13 preenchidos, todos verdes', '13 de 13' in pg.inner_text('#progress-label') and all(st(pg, s)[0] == 'done' for s in SECTORS), str([st(pg, s) for s in SECTORS]))
        w = pg.evaluate("document.querySelector('.panelhead .pbar > i').style.width")
        check('Painel: barra de progresso em 100%', w == '100%', w)
        check('Painel: ocorrência só onde há ocorrência real', {s for s in SECTORS if st(pg, s)[1] == '1'} == EXPECT_ALERT)
        check('Painel: setor preenchido pode ter ocorrência; "nenhuma" não gera', st(pg, 'portaria') == ('done', '1') and st(pg, 'hemodinamica') == ('done', '0'))
        check('Painel: sem pendentes, botão principal vira "Ver relatório"', pg.locator('#btn-continue').count() == 0 and 'relatório' in pg.inner_text('.actionbar').lower())
        pg.screenshot(path=f'{SHOTS}/11-painel-completo.png', full_page=True)

        # fluxo "Próximo": sequencial, contador = posição, termina no relatório (sem voltar ao início)
        pg.click('#sec-portaria'); pg.wait_for_selector('#btn-next-sector')
        check('Próximo: 1º setor mostra 1/13 e há botão anterior desabilitado', pg.inner_text('#sel-count') == '1/13')
        pg.click('#btn-next-sector'); pg.wait_for_selector('[data-field="reclamacoes"]')
        check('"Próximo" da Portaria vai ao setor seguinte (Recepção), mesmo já preenchido', 'Recepção' in pg.inner_text('.topbar h1') and pg.inner_text('#sel-count') == '2/13')
        pg.goto(shift_url + '/s/enf_sus'); pg.wait_for_selector('[data-field="bloqueados"]')
        seq = [pg.inner_text('#sel-count')]
        titles_seen = [pg.inner_text('.topbar h1').split('\n')[0]]
        for _ in range(5):
            pg.click('#btn-next-sector'); pg.wait_for_timeout(250)
            seq.append(pg.inner_text('#sel-count')); titles_seen.append(pg.inner_text('.topbar h1').split('\n')[0])
        check('Enfermaria SUS: contador acompanha cada Próximo (8/13 → 13/13)', seq == ['8/13', '9/13', '10/13', '11/13', '12/13', '13/13'], str(seq))
        check('Setores percorridos em ordem', titles_seen == TITLES[7:], str(titles_seen))
        check('Último setor: botão vira "Ver relatório"', 'Ver relatório' in pg.inner_text('#btn-next-sector'))
        pg.click('#btn-next-sector'); pg.wait_for_url('**/relatorio'); pg.wait_for_selector('#report-text', state='attached')
        check('No 13/13 o Próximo FINALIZA no relatório (não volta ao início)', pg.url.endswith('/relatorio'))

        # ---- relatório
        report = rawtext(pg)
        pg.screenshot(path=f'{SHOTS}/12-relatorio.png')
        check('Relatório: linha em branco só ENTRE setores (13), nunca dentro do setor', report.count('\n\n') == 13 and '\n\n\n' not in report and all(report.split('\n\n')[i + 1].startswith(f'*{i + 1}. ') for i in range(13)), repr(report[:140]))
        check('Relatório: sem enfermeiro nem horário (já estão na apresentação)', 'Enf:' not in report and 'Horário' not in report and 'Rubens' not in report and 'Alana' not in report)
        check('Relatório: "Ocorrências relevantes" em todos os 13 setores', report.count('*Ocorrências relevantes:*') + report.count('*Ocorrências relevantes*') == 13, str(report.count('Ocorrências relevantes')))
        pos = [report.find(f'{i+1}. {t.upper()}') for i, t in enumerate(TITLES)]
        check('Relatório: 13 setores em ordem', all(x >= 0 for x in pos) and pos == sorted(pos), str(pos))
        faltando = [m for m in ['Equipe completa?','Ausência no plantão?','Cobertura realizada?','Pendências administrativas relevantes','Reclamações registradas','Medicamentos críticos em falta?','Enxoval suficiente para o plantão?','Quantidade estimada disponível','Necessidade de reposição urgente?','Exames indispensáveis?','Equipamentos com falha?','Médico de sobreaviso','Previsão de exames a serem realizados','Intercorrências','Procedimentos realizados','Procedimentos suspensos','Atrasos','Autoclave em funcionamento','Leitos disponíveis','Altas do dia ainda não efetuadas','Pacientes aguardando transferência','Pacientes em diálise','Leitos bloqueados/interditados','Médico de plantão (FDS)','Enfermeiro(a) de plantão','Quantidade de pacientes em observação','Quantidade de pacientes aguardando atendimento','Quantidade de pacientes em boarding','Maior tempo de boarding no PA','Ocorrências relevantes'] if m not in report]
        check('Relatório: todas as perguntas originais presentes', not faltando, str(faltando))
        check('Relatório: acentos e símbolos', 'Técnica "Maria" faltou — cobertura & extra: 50% às 22h' in report and 'Dr. Álvaro' in report)
        rp = report.replace('*', '')
        check('Relatório: zero e valores corretos', 'Pacientes em diálise: 0' in rp and 'Quantidade estimada disponível: 120' in rp)
        check('Relatório: sem "Não informado" quando completo', 'Não informado' not in report)
        # --- CTAs principais
        bc, bw = pg.locator('#btn-copy-report').bounding_box(), pg.locator('#btn-wa-report').bounding_box()
        pos_bar = pg.evaluate("getComputedStyle(document.querySelector('.actionbar.cta')).position")
        check('CTAs: Copiar e WhatsApp fixos no rodapé, visíveis sem rolar, ≥ 56px', pos_bar == 'sticky' and bc['height'] >= 56 and bw['height'] >= 56 and bc['y'] + bc['height'] <= 844 and bw['y'] + bw['height'] <= 844 and bc['y'] > 600, f'{bc} {bw}')
        colors = pg.evaluate("[getComputedStyle(document.querySelector('#btn-copy-report')).backgroundColor, getComputedStyle(document.querySelector('#btn-wa-report')).backgroundColor]")
        check('CTAs: Copiar (vermelho) e WhatsApp (verde) em destaque; imagem/PDF recolhidos', colors == ['rgb(200, 16, 46)', 'rgb(18, 148, 90)'] and not pg.locator('#btn-image').is_visible() and pg.locator('#more-formats').count() == 1)
        check('Relatório: texto editável (textarea)', pg.locator('#report-text').is_editable())
        pg.screenshot(path=f'{SHOTS}/13-relatorio-cta.png')
        # prévia formatada
        fm = fmttext(pg)
        bold = pg.eval_on_selector_all('#report-preview strong', 'els => els.map(e => e.textContent)')
        check('Prévia WhatsApp: perguntas em negrito', 'Equipe completa?' in bold and 'Leitos disponíveis:' in bold and '1. PORTARIA/ACOLHIMENTO' in bold and 'Enf:' not in bold, str(bold[:8]))
        pg.click('#tab-edit')
        pg.click('#btn-copy-report')
        clip = pg.evaluate('navigator.clipboard.readText()')
        check('Copiar: texto WhatsApp com negrito e parágrafo entre setores', clip.startswith('*PLANTÃO ADMINISTRATIVO — NOTURNO*\n*Data:* 13/11/2026\n\n*1. PORTARIA/ACOLHIMENTO*\n• *Equipe completa?* Sim') and '\n\n\n' not in clip and '*13. PRONTO ATENDIMENTO*' in clip, repr(clip[:200]))
        check('Copiar: asteriscos balanceados em todas as linhas', all(l.count('*') % 2 == 0 for l in clip.split('\n')))
        pg.click('#tab-fmt')
        pg.evaluate("() => { const r = document.createRange(); r.selectNodeContents(document.getElementById('report-preview')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }")
        pg.evaluate("document.execCommand('copy')")
        sel_clip = pg.evaluate('navigator.clipboard.readText()')
        check('Copiar texto selecionado da prévia mantém *negrito*', sel_clip == clip, repr(sel_clip[:120]))
        pg.click('#tab-edit')
        pg.evaluate('window.__opened=[]'); pg.click('#btn-wa-report')
        opened = pg.evaluate('window.__opened')
        full = urllib.parse.unquote(opened[0].split('text=', 1)[1]) if opened else ''
        check('WhatsApp: wa.me com relatório completo idêntico', bool(opened) and full == clip and len(opened[0]) <= 6000, f'len={len(opened[0]) if opened else 0}')

        # --- edição manual do relatório
        check('Edição: sem marca "Editado" antes de alterar', not pg.locator('#edited-tag').is_visible() and not pg.locator('#btn-restore').is_visible())
        pg.click('#tab-edit'); pg.click('#report-text'); pg.keyboard.press('Control+End'); pg.keyboard.type('\n*Obs. do plantão:* revisado manualmente')
        pg.wait_for_timeout(400)
        check('Edição: aparece "Editado" e "Restaurar texto original"', pg.locator('#edited-tag').is_visible() and pg.locator('#btn-restore').is_visible())
        pg.click('#btn-copy-report'); clip_ed = pg.evaluate('navigator.clipboard.readText()')
        check('Copiar envia exatamente o texto editado', clip_ed == clip + '\n*Obs. do plantão:* revisado manualmente', repr(clip_ed[-80:]))
        pg.evaluate('window.__opened=[]'); pg.click('#btn-wa-report')
        opened = pg.evaluate('window.__opened'); full = urllib.parse.unquote(opened[0].split('text=', 1)[1]) if opened else ''
        check('WhatsApp envia exatamente o texto editado', full == clip_ed)
        pg.click('#tab-fmt'); check('Prévia do WhatsApp reflete a edição', 'revisado manualmente' in pg.inner_text('#report-preview') and 'Obs. do plantão:' in pg.eval_on_selector_all('#report-preview strong', 'els => els.map(e => e.textContent)')); pg.click('#tab-edit')
        pg.reload(); pg.wait_for_selector('#report-text', state='attached')
        check('Edição persiste ao recarregar', rawtext(pg) == clip_ed and pg.locator('#edited-tag').is_visible())
        # dados mudam depois da edição → aviso de texto desatualizado
        pg.goto(shift_url + '/s/rouparia'); pg.wait_for_selector('[data-field="quantidade"]')
        pg.fill('[data-field="quantidade"] input', '121'); pg.wait_for_timeout(500)
        pg.goto(shift_url + '/relatorio'); pg.wait_for_selector('#report-text', state='attached')
        check('Dados mudaram após edição: avisa e mantém a versão editada', pg.locator('#stale-box').is_visible() and rawtext(pg) == clip_ed)
        pg.click('#btn-regen'); pg.wait_for_timeout(300)
        check('"Usar dados atuais" descarta a edição e atualiza o texto', 'Quantidade estimada disponível: 121' in plain(pg) and 'revisado manualmente' not in rawtext(pg) and not pg.locator('#stale-box').is_visible() and not pg.locator('#edited-tag').is_visible())
        pg.click('#tab-edit'); pg.click('#report-text'); pg.keyboard.press('Control+End'); pg.keyboard.type(' X'); pg.wait_for_timeout(300)
        pg.click('#btn-restore'); pg.wait_for_selector('.dlg:has-text("Restaurar texto original?")'); pg.click('.dlg:has-text("Restaurar texto original?") .btn.primary'); pg.wait_for_timeout(300)
        check('Restaurar texto original volta ao texto gerado', not rawtext(pg).endswith(' X') and not pg.locator('#edited-tag').is_visible())
        pg.goto(shift_url + '/s/rouparia'); pg.wait_for_selector('[data-field="quantidade"]')
        pg.fill('[data-field="quantidade"] input', '120'); pg.wait_for_timeout(500)
        pg.goto(shift_url + '/relatorio'); pg.wait_for_selector('#report-text', state='attached')
        pg.click('#tab-edit'); pg.click('#report-text'); pg.keyboard.press('Control+A'); pg.keyboard.press('Delete'); pg.wait_for_timeout(300)
        pg.click('#btn-copy-report'); check('Texto apagado: Copiar avisa que o relatório está vazio', 'vazio' in pg.inner_text('#toast'))
        pg.reload(); pg.wait_for_selector('#report-text', state='attached')
        check('Apagar tudo e recarregar volta ao texto gerado (não perde o relatório)', '1. PORTARIA/ACOLHIMENTO' in rawtext(pg))
        pg.click('#more-formats summary')
        pg.click('#btn-image'); pg.wait_for_selector('.imgpages img', timeout=15000)
        n_imgs = pg.locator('.imgpages img').count()
        dims = pg.evaluate("[...document.querySelectorAll('.imgpages img')].map(i=>[i.naturalWidth,i.naturalHeight])")
        check('Imagem: PNGs 1080px', n_imgs >= 1 and all(w == 1080 for w, _ in dims), str(dims))
        with pg.expect_download() as d: pg.click('#btn-img-download')
        path = os.path.join(dl_dir, 'img1.png'); d.value.save_as(path)
        check('Imagem: PNG baixado válido', open(path, 'rb').read(8) == b'\x89PNG\r\n\x1a\n' and os.path.getsize(path) > 10000)
        pg.wait_for_timeout(400)
        for i in range(n_imgs): pg.locator('.imgpages img').nth(i).screenshot(path=f'{SHOTS}/20-img-p{i+1}.png')
        with pg.expect_download() as d: pg.click('#btn-pdf')
        pdfp = os.path.join(dl_dir, 'r.pdf'); d.value.save_as(pdfp); raw = open(pdfp, 'rb').read()
        check('PDF: válido com mesmo nº de páginas', raw.startswith(b'%PDF-1.4') and raw.rstrip().endswith(b'%%EOF') and raw.count(b'/Type /Page ') == n_imgs)

        # ---- finalizar
        pg.click('#btn-finalize'); pg.wait_for_selector('.dlg')
        check('Finalização: mostra ocorrências e confirmação por profissional', 'ocorrência' in pg.inner_text('.dlg') and pg.locator('#finalize-by option').count() == 2)
        pg.select_option('#finalize-by', 'Alana'); pg.click('.dlg .btn.green'); pg.wait_for_selector('#final-banner')
        check('Finalização: data/hora e responsável', 'Alana' in pg.inner_text('#final-banner') and re.search(r'\d{2}/\d{2}/\d{4} \d{2}:\d{2}', pg.inner_text('#final-banner')) is not None)
        pg.goto(shift_url + '/s/rouparia'); pg.wait_for_selector('[data-field="quantidade"]')
        pg.fill('[data-field="quantidade"] input', '130'); pg.wait_for_timeout(500)
        pg.goto(shift_url + '/relatorio'); pg.wait_for_selector('#report-text', state='attached')
        check('Correção após finalizar atualiza o relatório', 'Quantidade estimada disponível: 130' in plain(pg))
        # atividade registrada em segundo plano (dados), sem tela
        stored = pg.evaluate("""() => new Promise((res) => { const r = indexedDB.open('plantao-control'); r.onsuccess = () => { const g = r.result.transaction('shifts').objectStore('shifts').getAll(); g.onsuccess = () => res(g.result.map(s => s.activity.map(a => a.text))); }; })""")
        flat = [t for s in stored for t in s]
        check('Atividade segue sendo gravada em segundo plano (sem tela)', any('Plantão iniciado' in t for t in flat) and any('Relatório finalizado' in t for t in flat) and any('após a finalização' in t for t in flat), str(flat[:5]))
        check('Sem erros de console na sessão A', not errors, str(errors[:3]))
        ctx.close()

        # ============================ B) 2º plantão: continuar do último
        ctx = p.chromium.launch_persistent_context(profile, **ctx_args)
        pg = ctx.pages[0] if ctx.pages else ctx.new_page()
        errors2 = []
        pg.on('pageerror', lambda e: errors2.append(str(e)))
        pg.add_init_script("window.__opened=[]; window.open=(u)=>{window.__opened.push(u); return {};};")
        pg.goto(BASE + '/'); pg.wait_for_selector('#btn-start')
        check('Reabrir navegador: dados persistidos (Último plantão disponível)', pg.locator('#btn-last').count() == 1 and pg.locator('#btn-resume').count() == 0)
        pg.click('#btn-last'); pg.wait_for_selector('#btn-last-open'); pg.click('#btn-last-open'); pg.wait_for_selector('#sec-portaria')
        check('Reabrir navegador: 13/13 e valor corrigido (130)', '13 de 13' in pg.inner_text('#progress-label'))
        pg.click('#sec-rouparia'); pg.wait_for_selector('[data-field="quantidade"]')
        check('Reabrir navegador: valor 130', pg.input_value('[data-field="quantidade"] input') == '130'); pg.goto(BASE + '/')
        pg.wait_for_selector('#btn-start'); pg.click('#btn-start'); pg.wait_for_selector('.dlg')
        check('Início: pergunta "Continuar a partir do último plantão?" com Sim/Não', 'Continuar a partir do último plantão' in pg.inner_text('.dlg') and pg.locator('.dlg .btn:has-text("Sim, continuar")').count() == 1 and pg.locator('.dlg .btn:has-text("Não, em branco")').count() == 1)
        pg.screenshot(path=f'{SHOTS}/30-pergunta-continuar.png')
        # Não → em branco
        pg.click('.dlg .btn:has-text("Não, em branco")'); pg.wait_for_selector('#btn-create')
        check('"Não": abre cadastro em branco, sem aviso de continuação', pg.locator('#carry-banner').count() == 0)
        pg.goto(BASE + '/'); pg.wait_for_selector('#btn-start'); pg.click('#btn-start'); pg.wait_for_selector('.dlg')
        pg.click('.dlg .btn:has-text("Sim, continuar")'); pg.wait_for_selector('#btn-create')
        check('"Sim": cadastro mostra aviso de continuação', 'Continuando do plantão anterior' in pg.inner_text('#carry-banner'))
        chips = pg.eval_on_selector_all('#recent-nurses .chip', 'els => els.map(e => e.textContent)')
        check('Enfermeiros recentes aparecem como atalhos', chips == ['Rubens', 'Alana'], str(chips))
        pg.click('#recent-nurses .chip[data-name="Alana"]')
        check('Atalho preenche o enfermeiro com um toque', pg.input_value('[data-nurse="0"]') == 'Alana' and pg.locator('#recent-nurses .chip[data-name="Alana"]').count() == 0)
        pg.click('#type-MT'); pg.fill('#f-date', '2026-11-14')
        pg.click('#btn-create'); pg.wait_for_selector('#btn-to-panel'); pg.click('#btn-to-panel'); pg.wait_for_selector('#sec-portaria')
        shift2 = pg.url
        sts = [st(pg, s)[0] for s in SECTORS]
        check('Plantão copiado: os 13 setores vêm como "Revisar" (nenhum preenchido)', sts == ['review'] * 13 and '0 de 13' in pg.inner_text('#progress-label'), str(sts))
        check('Plantão copiado: aviso e botão para continuar a revisão', pg.locator('#review-banner').count() == 1 and pg.get_attribute('#btn-continue', 'href').endswith('/s/portaria'))
        pg.screenshot(path=f'{SHOTS}/31-painel-revisar.png', full_page=True)
        # relatório antes de confirmar não leva dado velho
        pg.goto(shift2 + '/relatorio'); pg.wait_for_selector('#report-text', state='attached')
        r_unconf = plain(pg)
        check('Relatório antes de confirmar NÃO envia dados do plantão anterior (números 0 e texto "-")', 'Dr. Álvaro' not in r_unconf and 'Quantidade estimada disponível: 0' in r_unconf and 'Bom dia' not in r_unconf and 'Não informado' not in r_unconf)
        check('Relatório avisa setores aguardando revisão', '13 setor(es) ainda aguardam revisão' in pg.inner_text('#review-warn'))
        # revisar Portaria: valores copiados e botão confirmar
        pg.goto(shift2 + '/s/portaria'); pg.wait_for_selector('[data-field="equipe_completa"]')
        check('Revisão: valores do plantão anterior já preenchidos', pg.get_attribute('[data-field="equipe_completa"] [data-v="sim"]', 'aria-pressed') == 'true' and pg.locator('#review-note').is_visible())
        check('Revisão: botão "Confirmar e seguir" no lugar de "Próximo"', pg.locator('#btn-confirm-sector').is_visible() and not pg.locator('#btn-next-sector').is_visible())
        check('Revisão: contador de posição 1/13 e aviso discreto no fim do formulário', pg.inner_text('#sel-count') == '1/13' and pg.locator('#review-note').bounding_box()['y'] > pg.locator('[data-field="equipe_completa"]').bounding_box()['y'])
        pg.click('[data-field="equipe_completa"] [data-v="nao"]')   # altera o que mudou
        pg.click('#btn-confirm-sector'); pg.wait_for_selector('[data-field]'); pg.wait_for_timeout(500)
        check('Confirmar leva ao próximo setor a revisar (Recepção)', 'Recepção' in pg.inner_text('.topbar h1'))
        check('Confirmar: contador avança para 2/13', pg.inner_text('#sel-count') == '2/13')
        # confirmar todos os demais em sequência (só tocando)
        for i in range(12):
            pg.wait_for_selector('#btn-confirm-sector', state='visible', timeout=5000)
            pg.click('#btn-confirm-sector'); pg.wait_for_timeout(250)
        pg.wait_for_selector('#report-text', state='attached', timeout=8000)
        check('12 confirmações seguidas levam ao relatório (fluxo de poucos toques)', True)
        pg.goto(shift2); pg.wait_for_selector('#progress-label')
        check('Após confirmar: 13 de 13 preenchidos', '13 de 13' in pg.inner_text('#progress-label'), pg.inner_text('#progress-label'))
        pg.goto(shift2 + '/relatorio'); pg.wait_for_selector('#report-text', state='attached')
        r2 = plain(pg)
        check('Relatório do plantão copiado: dados confirmados e alteração aplicada', 'Dr. Álvaro' in r2 and re.search(r'Equipe completa\? Não', r2) and 'Bom dia' not in r2 and 'Não informado' not in r2, r2[:200])
        check('Relatório do plantão copiado: tipo MT/diurno', 'DIURNO' in r2.split('\n')[0])
        # plantão original intacto
        pg.goto(shift_url + '/s/portaria'); pg.wait_for_selector('[data-field="equipe_completa"]')
        check('Plantão original não foi alterado pela cópia', pg.get_attribute('[data-field="equipe_completa"] [data-v="sim"]', 'aria-pressed') == 'true')
        # retomar em andamento + nova pergunta sem finalizar
        pg.goto(BASE + '/'); pg.wait_for_selector('#btn-resume')
        check('Home: plantão em andamento com Retomar (discreto, sem competir com Iniciar)', 'Retomar' in pg.inner_text('#btn-resume') and pg.locator('#btn-start').bounding_box()['height'] > pg.locator('#btn-resume').bounding_box()['height'] * 1.5)
        pg.click('#btn-start'); pg.wait_for_selector('.dlg'); check('Iniciar com plantão em andamento: avisa antes', 'em andamento' in pg.inner_text('.dlg'))
        pg.click('.dlg .btn:has-text("Cancelar")')

        # ---- backup (exportar/importar via painel)
        pg.click('#btn-backup'); pg.wait_for_selector('#btn-export-backup')
        pg.evaluate("() => { window.__blobs = []; const oc = URL.createObjectURL.bind(URL); URL.createObjectURL = (b) => { window.__blobs.push(b); return oc(b); }; const ac = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) { window.__dl = this.download; return; } return ac.call(this); }; }")
        pg.click('#btn-export-backup'); pg.wait_for_timeout(500)
        bpath = os.path.join(dl_dir, 'backup.json')
        open(bpath, 'wb').write(bytes(pg.evaluate("window.__blobs.at(-1).arrayBuffer().then(b => Array.from(new Uint8Array(b)))")))
        bk = json.load(open(bpath, encoding='utf-8'))
        check('Backup: exporta 2 plantões com nome datado', bk['app'] == 'plantao-control' and len(bk['shifts']) == 2 and re.match(r'plantao-adm-backup-\d{4}-\d{2}-\d{2}\.json', pg.evaluate('window.__dl') or '') is not None)
        bad = os.path.join(dl_dir, 'bad.json'); open(bad, 'w').write('{isso nao e json')
        pg.set_input_files('#import-file', bad); pg.wait_for_timeout(400)
        check('Backup corrompido rejeitado', 'corrompido' in pg.inner_text('#toast'), pg.inner_text('#toast'))
        wrong = os.path.join(dl_dir, 'wrong.json'); json.dump({'foo': 1}, open(wrong, 'w'))
        pg.set_input_files('#import-file', wrong); pg.wait_for_timeout(400)
        check('Backup de outro formato rejeitado', 'não é um backup' in pg.inner_text('#toast'))
        pg.set_input_files('#import-file', bpath); pg.wait_for_timeout(500)
        check('Importar backup repetido não duplica', 'Nada a importar' in pg.inner_text('#toast') and pg.locator('.dlg:has-text("Importar backup?")').count() == 0)
        check('Sem erros de página na sessão B', not errors2, str(errors2[:3]))

        # ---- layout
        active_id = shift2.split('/p/')[1].split('/')[0]
        routes = ['/#/', '/#/novo', f'/#/novo/{shift_url.split("/p/")[1]}', f'/#/p/{active_id}', f'/#/p/{active_id}/abertura', f'/#/p/{active_id}/s/enf_sus', f'/#/p/{active_id}/s/pa', f'/#/p/{active_id}/relatorio']
        for w in (320, 360, 390, 430):
            pg.set_viewport_size({'width': w, 'height': 800}); bad_r = []
            for r in routes:
                pg.goto(BASE + r); pg.wait_for_timeout(350)
                ov = pg.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
                if ov > 0: bad_r.append((r, ov))
            check(f'Layout {w}px: sem rolagem horizontal', not bad_r, str(bad_r))
        pg.set_viewport_size({'width': 320, 'height': 800})
        pg.goto(BASE + f'/#/p/{active_id}/s/enf_sus'); pg.wait_for_selector('[data-field="leitos"]'); pg.wait_for_timeout(300)
        pg.screenshot(path=f'{SHOTS}/32-setor-320.png')
        pg.click('#btn-sectors'); pg.wait_for_selector('.srow'); pg.screenshot(path=f'{SHOTS}/33-seletor-320.png'); pg.click('.sheethead .iconbtn')
        pg.set_viewport_size({'width': 390, 'height': 844})
        small = []
        for r in ['/#/', f'/#/p/{active_id}', f'/#/p/{active_id}/s/enf_sus', f'/#/p/{active_id}/s/portaria', f'/#/p/{active_id}/relatorio', f'/#/p/{active_id}/abertura', f'/#/novo/{shift_url.split("/p/")[1]}']:
            pg.goto(BASE + r); pg.wait_for_timeout(350)
            res = pg.evaluate("""() => [...document.querySelectorAll('button, a.btn, a.iconbtn, a.sec, input:not([type=file]), select, textarea, summary')]
                .filter(e => e.offsetParent !== null || getComputedStyle(e).position === 'fixed')
                .map(e => { const r = e.getBoundingClientRect(); return {t:(e.getAttribute('aria-label')||e.innerText||e.id||e.tagName).slice(0,28), w:Math.round(r.width), h:Math.round(r.height), fs: parseFloat(getComputedStyle(e).fontSize), tag:e.tagName}; })
                .filter(x => x.w > 0 && (x.h < 44 || x.w < 44 || ((x.tag==='INPUT'||x.tag==='TEXTAREA'||x.tag==='SELECT') && x.fs < 16)))""")
            small += [(r, x) for x in res]
        check('Mobile: toque ≥ 44×44 e fonte de campos ≥ 16px', not small, str(small[:5]))
        ctx.close()

        # ============================ C) outro perfil: restaurar backup + PWA offline
        ctx = p.chromium.launch_persistent_context(os.path.join(tmp, 'profile2'), **ctx_args)
        pg = ctx.pages[0] if ctx.pages else ctx.new_page()
        pg.goto(BASE + '/'); pg.wait_for_selector('#btn-start')
        check('Perfil novo: sem "Último plantão"', pg.locator('#btn-last').count() == 0)
        pg.click('#btn-backup'); pg.wait_for_selector('#import-file', state='attached')
        pg.set_input_files('#import-file', bpath); pg.wait_for_selector('.dlg:has-text("Importar backup?")'); check('Importar pede confirmação com resumo', '2 novo(s)' in pg.inner_text('.dlg:has-text("Importar backup?")'), pg.inner_text('.dlg:has-text("Importar backup?")'))
        pg.click('.dlg:has-text("Importar backup?") .btn.primary'); pg.wait_for_selector('#btn-resume', timeout=5000)
        check('Backup restaurado em outro perfil (em andamento + último)', pg.locator('#btn-resume').count() == 1 and pg.locator('#btn-last').count() == 1)
        pg.click('#btn-resume'); pg.wait_for_selector('#sec-portaria')
        check('Backup restaurado: setores confirmados mantêm 13/13', '13 de 13' in pg.inner_text('#progress-label'))
        pg.goto(BASE + '/'); pg.wait_for_selector('#btn-start')
        pg.wait_for_function("navigator.serviceWorker.ready.then(r => !!r.active)", timeout=10000)
        mani = pg.evaluate("fetch('manifest.webmanifest').then(r => r.json())")
        check('PWA: manifest (standalone, branco, ícones 192/512/maskable)', mani['display'] == 'standalone' and mani['background_color'].lower() == '#ffffff' and {i['sizes'] for i in mani['icons']} >= {'192x192', '512x512'} and any(i['purpose'] == 'maskable' for i in mani['icons']))
        check('PWA: ícones acessíveis', all(pg.evaluate("Promise.all(['icons/icon-192.png','icons/icon-512.png','icons/icon-maskable-512.png','icons/apple-touch-icon.png','icons/favicon.ico'].map(u => fetch(u).then(r => r.ok)))")))
        pg.reload(); pg.wait_for_selector('#btn-start'); pg.wait_for_function("!!navigator.serviceWorker.controller", timeout=10000)
        ctx.set_offline(True); pg.goto(BASE + '/'); pg.wait_for_selector('#btn-start', timeout=10000)
        check('PWA offline (Chromium): abre e mostra dados locais', pg.locator('#btn-resume').count() == 1)
        ctx.set_offline(False); ctx.close()

        # ============================ D) falhas de armazenamento
        b = p.chromium.launch(executable_path=CHROME, args=['--no-sandbox'])
        c2 = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, locale='pt-BR')
        c2.add_init_script("Object.defineProperty(window,'indexedDB',{value:undefined,configurable:true});")
        pg = c2.new_page(); pg.goto(BASE + '/'); pg.wait_for_selector('#btn-start')
        check('Sem armazenamento: aviso na Home', 'indisponível' in pg.inner_text('.banner'))
        pg.click('#btn-start'); pg.wait_for_selector('#btn-create'); pg.fill('[data-nurse="0"]', 'Sem Banco'); pg.click('#btn-create'); pg.wait_for_timeout(500)
        check('Sem armazenamento: avisa que NÃO foi salvo', 'NÃO foi salvo' in pg.inner_text('#toast'))
        pg.wait_for_selector('#btn-to-panel'); pg.click('#btn-to-panel'); pg.click('#sec-portaria'); pg.wait_for_selector('[data-field="equipe_completa"]')
        pg.click('[data-field="equipe_completa"] [data-v="sim"]'); pg.wait_for_timeout(500)
        check('Sem armazenamento: selo "Não salvo" (não finge sucesso)', 'Não salvo' in pg.inner_text('.savebadge'), pg.inner_text('.savebadge'))
        c2.close()
        c3 = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, locale='pt-BR')
        pg = c3.new_page(); pg.goto(BASE + '/'); pg.wait_for_selector('#btn-start')
        create_shift(pg, 'Falha Escrita'); pg.click('#sec-portaria'); pg.wait_for_selector('[data-field="equipe_completa"]')
        pg.evaluate("""() => { const o = IDBDatabase.prototype.transaction; IDBDatabase.prototype.transaction = function(){ throw new DOMException('QuotaExceededError','QuotaExceededError'); }; window.__restoreTx = () => { IDBDatabase.prototype.transaction = o; }; }""")
        pg.click('[data-field="equipe_completa"] [data-v="sim"]'); pg.wait_for_timeout(700)
        check('Erro de gravação: selo e aviso de erro', 'Erro ao salvar' in pg.inner_text('.savebadge') and 'salvar' in pg.inner_text('#toast').lower())
        pg.evaluate('window.__restoreTx()'); pg.click('.savebadge'); pg.wait_for_timeout(600)
        check('Erro de gravação: nova tentativa conclui', 'Salvo' in pg.get_attribute('.savebadge', 'aria-label') and 'Erro' not in pg.get_attribute('.savebadge', 'aria-label'))
        # interrupção: digitar e recarregar na hora
        pg.fill('[data-field="observacoes"] textarea', 'Interrompido no meio'); pg.reload(); pg.wait_for_selector('[data-field="observacoes"]')
        check('Interrupção: recarregar logo após digitar não perde o texto', pg.input_value('[data-field="observacoes"] textarea') == 'Interrompido no meio')
        c3.close()

        # ============================ E) Revisão 3: relatório em modo WhatsApp, crédito e admin
        c4 = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, locale='pt-BR', accept_downloads=True)
        pg = c4.new_page(); errs4 = []
        pg.on('pageerror', lambda e: errs4.append(str(e))); pg.on('console', lambda m: errs4.append(m.text) if m.type == 'error' else None)
        pg.goto(BASE + '/'); pg.wait_for_selector('#btn-start')
        cr = pg.locator('#credit')
        check('Crédito discreto na Home: "Desenvolvido por Enfermeiro Rubens Diniz"', 'Desenvolvido por Enfermeiro Rubens Diniz' in cr.inner_text() and pg.evaluate("parseFloat(getComputedStyle(document.querySelector('#credit')).fontSize)") <= 12.5)
        check('Ícone de admin na Home (discreto, ≥ 44px)', pg.locator('#btn-admin').is_visible() and pg.locator('#btn-admin').bounding_box()['width'] >= 44)
        # relatório: padrão = exibição WhatsApp
        create_shift(pg, 'Rubens')
        rep_url = pg.url.split('/s/')[0].split('#')[0] + '#/' + pg.url.split('#/')[1]
        pg.goto(pg.url.split('#/')[0] + '#/' + '/'.join(pg.url.split('#/')[1].split('/')[:2]) + '/relatorio'); pg.wait_for_selector('#report-preview')
        vis_prev = pg.locator('#report-preview').is_visible(); vis_ta = pg.locator('#report-text').is_visible()
        ptxt = pg.inner_text('#report-preview')
        check('Relatório abre por padrão na exibição do WhatsApp (sem asteriscos), texto cru escondido', vis_prev and not vis_ta and '*' not in ptxt and pg.eval_on_selector_all('#report-preview strong', 'e => e.length') > 10, ptxt[:80])
        check('Aba "Como fica no WhatsApp" ativa e "Editar texto" disponível', pg.get_attribute('#tab-fmt', 'aria-selected') == 'true' and pg.locator('#tab-edit').is_visible())
        pg.click('#tab-edit'); check('Editar texto mostra o texto cru editável', pg.locator('#report-text').is_visible() and '*PLANTÃO ADMINISTRATIVO' in rawtext(pg))

        # ---- admin: senha
        pg.goto(BASE + '/#/admin'); pg.wait_for_selector('#admin-pass')
        check('Admin: pede senha (campo oculto) e não mostra o formulário', pg.get_attribute('#admin-pass', 'type') == 'password' and pg.locator('#adm-portaria').count() == 0)
        pg.fill('#admin-pass', 'errada'); pg.click('#admin-enter'); pg.wait_for_timeout(200)
        check('Admin: senha errada é recusada', pg.locator('#admin-error').is_visible() and pg.locator('#adm-portaria').count() == 0)
        pg.fill('#admin-pass', 'hc2026'); pg.keyboard.press('Enter'); pg.wait_for_selector('#adm-portaria')
        check('Admin: senha correta abre a lista dos 13 setores', pg.locator('.sectors a.sec').count() == 13)
        pg.screenshot(path=f'{SHOTS}/40-admin.png')
        # ---- admin: editar Portaria
        pg.click('#adm-portaria'); pg.wait_for_selector('[data-adm="cobertura"]')
        check('Admin setor: lista as perguntas do setor (com opção de remover) e Ocorrências relevantes', pg.locator('[data-adm]').count() == 6 and pg.locator('[data-adm="ocorrencias_relevantes"]').count() == 1)
        pg.click('[data-adm="cobertura"] [data-act="remove"]'); pg.wait_for_selector('[data-adm="cobertura"] [data-act="restore"]')
        pg.fill('[data-adm="equipe_completa"] input', 'Equipe 100% completa?'); pg.keyboard.press('Tab'); pg.wait_for_timeout(300)
        pg.fill('#new-label', 'Quantidade de macas disponíveis'); pg.select_option('#new-type', 'num'); pg.check('#new-optional'); pg.click('#btn-add-q'); pg.wait_for_selector('.admrow.added')
        check('Admin: remover, renomear e adicionar pergunta', pg.locator('[data-adm="cobertura"].removed').count() == 1 and pg.input_value('[data-adm="equipe_completa"] input') == 'Equipe 100% completa?' and pg.locator('.admrow.added').count() == 1)
        pg.screenshot(path=f'{SHOTS}/41-admin-setor.png', full_page=True)
        # ---- efeito no formulário e relatório
        pg.goto(BASE + '/#/'); pg.wait_for_selector('#btn-resume'); pg.click('#btn-resume'); pg.wait_for_selector('#sec-portaria'); pg.click('#sec-portaria'); pg.wait_for_selector('[data-field]')
        labels = pg.eval_on_selector_all('[data-field] .q', 'e => e.map(x => x.textContent)')
        check('Formulário reflete a edição: renomeada, removida e nova (antes de Ocorrências relevantes)', 'Equipe 100% completa?' in labels and 'Cobertura realizada?' not in labels and labels[-2] == 'Quantidade de macas disponíveis' and labels[-1] == 'Ocorrências relevantes', str(labels))
        check('Ocorrências relevantes é opcional (não bloqueia o setor)', pg.locator('[data-field="ocorrencias_relevantes"] .state').inner_text() == 'opcional')
        newid = pg.eval_on_selector('[data-field^="c_"]', 'e => e.dataset.field')
        pg.click('[data-field="equipe_completa"] [data-v="sim"]'); pg.click('[data-field="ausencia"] [data-v="nao"]'); pg.fill(f'[data-field="{newid}"] input', '5')
        pg.fill('[data-field="ocorrencias_relevantes"] textarea', 'Elevador em manutenção'); pg.wait_for_timeout(500)
        check('Setor com 4 obrigatórias preenchidas fica "Preenchido" e a ocorrência vira alerta', pg.inner_text('#sector-status') == 'Preenchido' and pg.locator('#sector-alerts').is_visible() and 'Ocorrências relevantes' in pg.inner_text('#sector-alerts'))
        pg.goto(BASE + '/#/'); pg.click('#btn-resume'); pg.wait_for_selector('#sec-portaria')
        pg.goto(pg.url.split('#/')[0] + '#/' + '/'.join(pg.url.split('#/')[1].split('/')[:2]) + '/relatorio'); pg.wait_for_selector('#report-preview')
        rt = rawtext(pg)
        check('Relatório usa o formulário editado', '• *Equipe 100% completa?* Sim' in rt and 'Cobertura realizada' not in rt and '• *Quantidade de macas disponíveis:* 5' in rt and '• *Ocorrências relevantes:* Elevador em manutenção' in rt, rt[:300])
        # persistência após recarregar
        pg.reload(); pg.wait_for_selector('#report-preview')
        check('Edição do formulário persiste ao recarregar', 'Quantidade de macas disponíveis' in rawtext(pg))
        # exportar / importar / restaurar
        pg.goto(BASE + '/#/admin'); pg.wait_for_selector('#admin-pass'); pg.fill('#admin-pass', 'HC2026'); pg.click('#admin-enter'); pg.wait_for_selector('#cfg-export')
        check('Admin: lista indica setor com alterações', 'alteração' in pg.inner_text('#adm-portaria'))
        pg.evaluate("() => { window.__blobs = []; const oc = URL.createObjectURL.bind(URL); URL.createObjectURL = (b) => { window.__blobs.push(b); return oc(b); }; const ac = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) { window.__dl = this.download; return; } return ac.call(this); }; }")
        pg.click('#cfg-export'); pg.wait_for_timeout(400)
        cfgp = os.path.join(dl_dir, 'form-config.json')
        open(cfgp, 'wb').write(bytes(pg.evaluate("window.__blobs.at(-1).arrayBuffer().then(b => Array.from(new Uint8Array(b)))")))
        cj = json.load(open(cfgp, encoding='utf-8'))
        check('Exportar gera form-config.json válido com a alteração', pg.evaluate('window.__dl') == 'form-config.json' and cj['version'] == 1 and cj['sectors']['portaria']['removed'] == ['cobertura'] and len(cj['sectors']['portaria']['added']) == 1)
        bad = os.path.join(dl_dir, 'badcfg.json'); json.dump({'foo': 1}, open(bad, 'w'))
        pg.set_input_files('#cfg-file', bad); pg.wait_for_timeout(300)
        check('Importar arquivo inválido é recusado', 'não é uma configuração' in pg.inner_text('#toast'))
        pg.click('#cfg-reset'); pg.wait_for_selector('.dlg:has-text("Restaurar formulário padrão?")'); pg.click('.dlg:has-text("Restaurar formulário padrão?") .btn.danger'); pg.wait_for_timeout(300)
        check('Restaurar padrão limpa as alterações', 'alteração' not in pg.inner_text('#adm-portaria') and 'padrão' in pg.inner_text('.topbar .sub'))
        pg.set_input_files('#cfg-file', cfgp); pg.wait_for_selector('.dlg:has-text("Importar configuração?")'); pg.click('.dlg:has-text("Importar configuração?") .btn.primary'); pg.wait_for_timeout(300)
        check('Importar o arquivo exportado reaplica a configuração', 'alteração' in pg.inner_text('#adm-portaria'))
        pg.click('#admin-exit'); pg.wait_for_selector('#btn-start'); pg.goto(BASE + '/#/admin'); pg.wait_for_selector('#admin-pass')
        check('Sair do admin tranca de novo (volta a pedir a senha)', pg.locator('#admin-pass').is_visible())
        # 320px sem rolagem horizontal nas telas novas
        pg.set_viewport_size({'width': 320, 'height': 800}); bad_r = []
        for r in ['/#/', '/#/admin']:
            pg.goto(BASE + r); pg.wait_for_timeout(300)
            if pg.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth") > 0: bad_r.append(r)
        check('Layout 320px: telas novas sem rolagem horizontal', not bad_r, str(bad_r))
        check('Sem erros de console na sessão E', not errs4, str(errs4[:3]))
        c4.close()

        # ============================ F) Revisão 4
        c5 = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, locale='pt-BR', accept_downloads=True)
        c5.grant_permissions(['clipboard-read', 'clipboard-write'], origin=BASE)
        pg = c5.new_page(); errs5 = []
        pg.on('pageerror', lambda e: errs5.append(str(e))); pg.on('console', lambda m: errs5.append(m.text) if m.type == 'error' else None)
        create_shift(pg, 'Rubens', 'N', '2026-11-16')
        base_url = pg.url.split('#/')[0] + '#/' + '/'.join(pg.url.split('#/')[1].split('/')[:2])
        pid = base_url.split('/p/')[1]

        # ---- número vazio = 0; N/A = "-"
        pg.goto(base_url + '/s/enf_sus'); pg.wait_for_selector('[data-field="leitos"]')
        pg.click('[data-field="leitos"] .nabtn'); pg.wait_for_timeout(300)
        pg.goto(base_url + '/relatorio'); pg.wait_for_selector('#report-text', state='attached')
        rt = plain(pg)
        check('Número não digitado sai como 0 no relatório', 'Pacientes em diálise: 0' in rt and 'Altas do dia ainda não efetuadas: 0' in rt)
        check('Marcar N/A sai como "-" (e não 0)', 'Leitos disponíveis: -' in rt and 'Não se aplica' not in rt and 'Não informado' not in rt)
        check('Texto vazio continua "-"', 'Médico de plantão (FDS): -' in rt)

        # ---- zoom ao tocar várias vezes em + / −
        pg.goto(base_url + '/s/rouparia'); pg.wait_for_selector('[data-field="quantidade"]')
        ta = pg.evaluate("[document.documentElement, ...document.querySelectorAll('.stepbtn, .nabtn, .seg button')].map(e => getComputedStyle(e).touchAction)")
        check('Botões e página com touch-action: manipulation (sem zoom por toque duplo)', all(x == 'manipulation' for x in ta), str(set(ta)))
        plus = '[data-field="quantidade"] [data-step="1"]'
        for _ in range(3): pg.tap(plus)
        pg.wait_for_timeout(300)
        scale = pg.evaluate('window.visualViewport.scale')
        check('Tocar 3x seguidas em + vai a 3 e a página NÃO dá zoom', pg.input_value('[data-field="quantidade"] input') == '3' and abs(scale - 1) < 0.01, f'scale={scale}')
        for _ in range(2): pg.tap('[data-field="quantidade"] [data-step="-1"]')
        check('Tocar 2x em − volta a 1', pg.input_value('[data-field="quantidade"] input') == '1')
        pg.fill('[data-field="quantidade"] input', '')

        # ---- PA: vários médicos
        pg.goto(base_url + '/s/pa'); pg.wait_for_selector('[data-field="medico"]')
        check('PA: um campo de médico e botão "Adicionar médico"', pg.locator('[data-field="medico"] input').count() == 1 and 'Adicionar médico' in pg.inner_text('#add-medico') and not pg.locator('[data-field="medico"] .rm').first.is_visible())
        pg.fill('[data-field="medico"] input >> nth=0', 'Dr. Paulo')
        pg.click('#add-medico'); pg.keyboard.type('Dra. Marta'); pg.click('#add-medico'); pg.keyboard.type('Dr. Caio'); pg.wait_for_timeout(350)
        check('PA: três médicos (novos campos já focados) e botão remover aparece', pg.locator('[data-field="medico"] input').count() == 3 and pg.locator('[data-field="medico"] .rm >> nth=1').is_visible())
        check('Botões remover/adicionar com toque ≥ 44px', pg.locator('[data-field="medico"] .rm >> nth=0').bounding_box()['width'] >= 44 and pg.locator('#add-medico').bounding_box()['height'] >= 40)
        pg.reload(); pg.wait_for_selector('[data-field="medico"]')
        check('PA: médicos persistem ao recarregar', pg.eval_on_selector_all('[data-field="medico"] input', 'e => e.map(x => x.value)') == ['Dr. Paulo', 'Dra. Marta', 'Dr. Caio'])
        pg.click('[data-field="medico"] .rm >> nth=1'); pg.wait_for_timeout(350)
        pg.goto(base_url + '/relatorio'); pg.wait_for_selector('#report-text', state='attached')
        check('Relatório lista os médicos do PA (sem o removido)', 'Médico de plantão: Dr. Paulo, Dr. Caio' in plain(pg) and 'Marta' not in plain(pg))
        pg.screenshot(path=f'{SHOTS}/50-pa-medicos.png')

        # ---- seletor: arrastar e reordenar (relatório fixo)
        orig_report = rawtext(pg)
        pg.goto(base_url + '/s/portaria'); pg.wait_for_selector('[data-field="equipe_completa"]'); pg.click('#btn-sectors'); pg.wait_for_selector('.srowwrap')
        order0 = pg.eval_on_selector_all('.srowwrap', 'e => e.map(x => x.dataset.wrap)')
        check('Seletor: 13 linhas com alça de arrastar (≥ 44px) e botão para o próximo pendente', len(order0) == 13 and pg.locator('.drag').first.bounding_box()['width'] >= 44 and pg.locator('#btn-sheet-next').count() == 1 and pg.locator('#btn-reset-order').is_hidden())
        hb = pg.locator('[data-drag="recepcao"]').bounding_box()
        x, y = hb['x'] + hb['width'] / 2, hb['y'] + hb['height'] / 2
        pg.mouse.move(x, y); pg.mouse.down()
        for dy in range(0, 215, 15): pg.mouse.move(x, y + dy); pg.wait_for_timeout(30)
        pg.mouse.up(); pg.wait_for_timeout(300)
        order1 = pg.eval_on_selector_all('.srowwrap', 'e => e.map(x => x.dataset.wrap)')
        check('Arrastar "Recepção" para baixo a reposiciona (3 a 5 posições)', 3 <= order1.index('recepcao') <= 5 and order1[0] == 'portaria' and len(set(order1)) == 13, str(order1))
        labels = pg.eval_on_selector_all('.srowwrap .t', 'e => e.map(x => x.textContent)')
        check('Números do seletor refletem a nova ordem', labels[0].startswith('1. ') and labels[order1.index('recepcao')].startswith(f'{order1.index("recepcao") + 1}. Recepção'))
        check('Botão "Ordem padrão" aparece', pg.locator('#btn-reset-order').is_visible())
        # teclado: sobe "Pronto Atendimento" uma posição
        pg.focus('[data-drag="pa"]'); pg.keyboard.press('ArrowUp'); pg.wait_for_timeout(200)
        order2 = pg.eval_on_selector_all('.srowwrap', 'e => e.map(x => x.dataset.wrap)')
        check('Setas do teclado também reordenam', order2.index('pa') == order1.index('pa') - 1, str(order2))
        pg.click('.sheethead .iconbtn'); pg.wait_for_timeout(250)
        check('Navegação segue a ordem do usuário: contador 1/13 na Portaria e Próximo abre o 2º da lista', pg.inner_text('#sel-count') == '1/13')
        pg.click('#btn-next-sector'); pg.wait_for_selector('.topbar h1'); pg.wait_for_timeout(300)
        second = order2[1]
        check('Próximo vai para o 2º setor da ordem personalizada', pg.url.endswith(f'/s/{second}') and pg.inner_text('#sel-count') == '2/13', pg.url)
        pg.click('#btn-prev-sector'); pg.wait_for_timeout(300)
        check('Anterior volta ao 1º', pg.url.endswith('/s/portaria') and pg.is_disabled('#btn-prev-sector'))
        pg.goto(base_url); pg.wait_for_selector('.sectors a.sec')
        panel_order = pg.eval_on_selector_all('.sectors a.sec', 'e => e.map(x => x.id.replace("sec-", ""))')
        check('Painel exibe a ordem personalizada', panel_order == order2, str(panel_order))
        pg.reload(); pg.wait_for_selector('.sectors a.sec')
        check('Ordem fica salva no navegador (recarregar)', pg.eval_on_selector_all('.sectors a.sec', 'e => e.map(x => x.id.replace("sec-", ""))') == order2)
        pg.goto(base_url + '/relatorio'); pg.wait_for_selector('#report-text', state='attached')
        check('Relatório final mantém EXATAMENTE a mesma ordem e texto', rawtext(pg) == orig_report)
        titles_pos = [rawtext(pg).find(f'{i + 1}. {t.upper()}') for i, t in enumerate(TITLES)]
        check('Relatório: Pronto Atendimento continua por último', titles_pos == sorted(titles_pos) and rawtext(pg).rfind('13. PRONTO ATENDIMENTO') > 0)
        pg.goto(base_url + '/s/portaria'); pg.wait_for_selector('[data-field]'); pg.click('#btn-sectors'); pg.wait_for_selector('#btn-reset-order'); pg.click('#btn-reset-order'); pg.wait_for_timeout(200)
        check('"Ordem padrão" restaura a sequência original', pg.eval_on_selector_all('.srowwrap', 'e => e.map(x => x.dataset.wrap)') == order0 and pg.locator('#btn-reset-order').is_hidden())
        pg.click('.sheethead .iconbtn')

        # ---- formatação da mensagem
        pg.goto(base_url + '/relatorio'); pg.wait_for_selector('#btn-format'); pg.click('#btn-format'); pg.wait_for_selector('#fmt-sheet')
        pg.click('#fmt-sheet [data-fmt="boldQuestions"]'); pg.click('#fmt-sheet [data-bullet="-"]'); pg.click('#fmt-sheet [data-fmt="blankBetween"]'); pg.wait_for_timeout(300)
        fr_ = rawtext(pg)
        check('Formatação: sem negrito nas perguntas, marcador "-" e sem linha em branco', '- Equipe completa?' in fr_ and '*Equipe completa?*' not in fr_ and '\n\n' not in fr_ and '*1. PORTARIA/ACOLHIMENTO*' in fr_, repr(fr_[:160]))
        check('Formatação: prévia atualizada ao vivo e conteúdo/ordem iguais', 'Equipe completa?' in pg.evaluate("document.getElementById('report-preview').innerText") and fr_.replace('- ', '• ').count('\n') < orig_report.count('\n'))
        pg.click('.sheethead .iconbtn'); pg.wait_for_timeout(250)
        pg.click('#btn-copy-report'); clipf = pg.evaluate('navigator.clipboard.readText()')
        check('Copiar usa a formatação escolhida', clipf == fr_)
        pg.reload(); pg.wait_for_selector('#report-text', state='attached')
        check('Formatação fica salva no navegador (recarregar)', '- Equipe completa?' in rawtext(pg))
        pg.goto(base_url); pg.goto(base_url + '/relatorio'); pg.wait_for_selector('#btn-format'); pg.click('#btn-format'); pg.wait_for_selector('#fmt-sheet')
        check('Controles refletem a preferência salva', pg.is_checked('#fmt-sheet [data-fmt="boldQuestions"]') is False and pg.get_attribute('#fmt-sheet [data-bullet="-"]', 'aria-pressed') == 'true')
        pg.click('#fmt-reset'); pg.wait_for_timeout(300); pg.click('.sheethead .iconbtn'); pg.wait_for_timeout(250)
        check('Restaurar formatação padrão volta ao modelo WhatsApp', rawtext(pg) == orig_report)
        pg.screenshot(path=f'{SHOTS}/51-relatorio-formato.png')

        # ---- persistência: iniciar do zero x iniciar a partir do anterior
        A = {'portaria': dict(equipe_completa='sim', ausencia='nao', cobertura='sim'), 'rouparia': dict(enxoval_suficiente='sim', quantidade='42', reposicao_urgente='nao')}
        for sid, d in A.items():
            pg.goto(base_url); pg.wait_for_selector('.sectors a.sec'); fill_sector(pg, sid, d)
        pg.reload(); pg.wait_for_selector('.sectors a.sec')
        check('Do zero: respostas persistem ao recarregar o painel', st(pg, 'portaria')[0] == 'done' and pg.evaluate("window.location.hash").endswith(pid))
        pg.goto(base_url + '/s/rouparia'); pg.wait_for_selector('[data-field="quantidade"]')
        check('Do zero: valores voltam nos campos', pg.input_value('[data-field="quantidade"] input') == '42' and pg.get_attribute('[data-field="enxoval_suficiente"] [data-v="sim"]', 'aria-pressed') == 'true')
        pg.goto(base_url + '/relatorio'); pg.wait_for_selector('#report-text', state='attached'); reportA = rawtext(pg)
        pg.click('#btn-finalize'); pg.wait_for_selector('.dlg'); pg.click('.dlg .btn.green'); pg.wait_for_selector('#final-banner')
        pg.goto(BASE + '/#/'); pg.wait_for_selector('#btn-start'); pg.click('#btn-start'); pg.wait_for_selector('.dlg')
        pg.click('.dlg .btn:has-text("Sim, continuar")'); pg.wait_for_selector('#btn-create'); pg.fill('[data-nurse="0"]', 'Alana'); pg.fill('#f-date', '2026-11-17')
        pg.click('#btn-create'); pg.wait_for_selector('#btn-to-panel'); pg.click('#btn-to-panel'); pg.wait_for_selector('#sec-portaria')
        base_b = pg.url.split('#/')[0] + '#/' + '/'.join(pg.url.split('#/')[1].split('/')[:2])
        pg.goto(base_b + '/s/pa'); pg.wait_for_selector('[data-field="medico"]')
        check('A partir do anterior: lista de médicos copiada (2 nomes) para revisão', pg.eval_on_selector_all('[data-field="medico"] input', 'e => e.map(x => x.value)') == ['Dr. Paulo', 'Dr. Caio'])
        pg.goto(base_b + '/s/rouparia'); pg.wait_for_selector('[data-field="quantidade"]')
        check('A partir do anterior: valores copiados nos campos', pg.input_value('[data-field="quantidade"] input') == '42')
        pg.fill('[data-field="quantidade"] input', '57'); pg.click('#btn-confirm-sector'); pg.wait_for_timeout(500)
        pg.reload(); pg.wait_for_selector('.topbar h1'); pg.goto(base_b + '/s/rouparia'); pg.wait_for_selector('[data-field="quantidade"]')
        check('A partir do anterior: edição e confirmação persistem ao recarregar', pg.input_value('[data-field="quantidade"] input') == '57' and pg.locator('#btn-confirm-sector').is_hidden())
        pg.goto(base_b + '/s/pa'); pg.wait_for_selector('[data-field="medico"]'); pg.click('#add-medico'); pg.keyboard.type('Dra. Nova'); pg.click('#btn-confirm-sector'); pg.wait_for_timeout(500)
        pg.goto(base_b + '/relatorio'); pg.wait_for_selector('#report-text', state='attached')
        rb = plain(pg)
        check('Plantão B: relatório com dados confirmados/alterados e médicos do PA', 'Quantidade estimada disponível: 57' in rb and 'Médico de plantão: Dr. Paulo, Dr. Caio, Dra. Nova' in rb)
        pg.goto(base_url + '/relatorio'); pg.wait_for_selector('#report-text', state='attached')
        check('Plantão A (original) não foi alterado pelo B', rawtext(pg) == reportA and 'Quantidade estimada disponível: 42' in plain(pg))
        pg.goto(BASE + '/'); pg.wait_for_selector('#btn-start')
        check('Sem erros de console na sessão F', not errs5, str(errs5[:3]))
        c5.close()


        b.close()

    shutil.rmtree(tmp, ignore_errors=True)
    failed = [r for r in RESULTS if not r[1]]
    print(f'\n{len(RESULTS) - len(failed)}/{len(RESULTS)} verificações passaram')
    for n, _, d in failed: print('  FALHOU:', n, d)
    sys.exit(1 if failed else 0)

if __name__ == '__main__':
    main()
