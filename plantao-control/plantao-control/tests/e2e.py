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
        pg.click('#btn-next-sector'); pg.wait_for_url('**/relatorio'); pg.wait_for_selector('#report-text')
        check('No 13/13 o Próximo FINALIZA no relatório (não volta ao início)', pg.url.endswith('/relatorio'))

        # ---- relatório
        report = rawtext(pg)
        pg.screenshot(path=f'{SHOTS}/12-relatorio.png')
        check('Relatório: sem linhas em branco', '\n\n' not in report and not re.search(r'^\s*$', report, re.M), repr(report[:120]))
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
        check('Prévia WhatsApp: perguntas em negrito', 'Equipe completa?' in bold and 'Leitos disponíveis:' in bold and '1. PORTARIA/ACOLHIMENTO' in bold and 'Enf:' in bold, str(bold[:8]))
        pg.click('#tab-edit')
        pg.click('#btn-copy-report')
        clip = pg.evaluate('navigator.clipboard.readText()')
        check('Copiar: texto WhatsApp com negrito e sem linhas em branco', clip.startswith('*PLANTÃO ADMINISTRATIVO — NOTURNO*\n*Data:* 13/11/2026\n*Horário:* 19 às 07hrs\n*Enf:* Rubens e Alana\n*1. PORTARIA/ACOLHIMENTO*\n• *Equipe completa?* Sim') and '\n\n' not in clip and '*13. PRONTO ATENDIMENTO*' in clip, repr(clip[:200]))
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
        pg.click('#report-text'); pg.keyboard.press('Control+End'); pg.keyboard.type('\n*Obs. do plantão:* revisado manualmente')
        pg.wait_for_timeout(400)
        check('Edição: aparece "Editado" e "Restaurar texto original"', pg.locator('#edited-tag').is_visible() and pg.locator('#btn-restore').is_visible())
        pg.click('#btn-copy-report'); clip_ed = pg.evaluate('navigator.clipboard.readText()')
        check('Copiar envia exatamente o texto editado', clip_ed == clip + '\n*Obs. do plantão:* revisado manualmente', repr(clip_ed[-80:]))
        pg.evaluate('window.__opened=[]'); pg.click('#btn-wa-report')
        opened = pg.evaluate('window.__opened'); full = urllib.parse.unquote(opened[0].split('text=', 1)[1]) if opened else ''
        check('WhatsApp envia exatamente o texto editado', full == clip_ed)
        pg.click('#tab-fmt'); check('Prévia do WhatsApp reflete a edição', 'revisado manualmente' in pg.inner_text('#report-preview') and 'Obs. do plantão:' in pg.eval_on_selector_all('#report-preview strong', 'els => els.map(e => e.textContent)')); pg.click('#tab-edit')
        pg.reload(); pg.wait_for_selector('#report-text')
        check('Edição persiste ao recarregar', rawtext(pg) == clip_ed and pg.locator('#edited-tag').is_visible())
        # dados mudam depois da edição → aviso de texto desatualizado
        pg.goto(shift_url + '/s/rouparia'); pg.wait_for_selector('[data-field="quantidade"]')
        pg.fill('[data-field="quantidade"] input', '121'); pg.wait_for_timeout(500)
        pg.goto(shift_url + '/relatorio'); pg.wait_for_selector('#report-text')
        check('Dados mudaram após edição: avisa e mantém a versão editada', pg.locator('#stale-box').is_visible() and rawtext(pg) == clip_ed)
        pg.click('#btn-regen'); pg.wait_for_timeout(300)
        check('"Usar dados atuais" descarta a edição e atualiza o texto', 'Quantidade estimada disponível: 121' in plain(pg) and 'revisado manualmente' not in rawtext(pg) and not pg.locator('#stale-box').is_visible() and not pg.locator('#edited-tag').is_visible())
        pg.click('#report-text'); pg.keyboard.press('Control+End'); pg.keyboard.type(' X'); pg.wait_for_timeout(300)
        pg.click('#btn-restore'); pg.wait_for_selector('.dlg:has-text("Restaurar texto original?")'); pg.click('.dlg:has-text("Restaurar texto original?") .btn.primary'); pg.wait_for_timeout(300)
        check('Restaurar texto original volta ao texto gerado', not rawtext(pg).endswith(' X') and not pg.locator('#edited-tag').is_visible())
        pg.goto(shift_url + '/s/rouparia'); pg.wait_for_selector('[data-field="quantidade"]')
        pg.fill('[data-field="quantidade"] input', '120'); pg.wait_for_timeout(500)
        pg.goto(shift_url + '/relatorio'); pg.wait_for_selector('#report-text')
        pg.click('#report-text'); pg.keyboard.press('Control+A'); pg.keyboard.press('Delete'); pg.wait_for_timeout(300)
        pg.click('#btn-copy-report'); check('Texto apagado: Copiar avisa que o relatório está vazio', 'vazio' in pg.inner_text('#toast'))
        pg.reload(); pg.wait_for_selector('#report-text')
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
        pg.goto(shift_url + '/relatorio'); pg.wait_for_selector('#report-text')
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
        pg.goto(shift2 + '/relatorio'); pg.wait_for_selector('#report-text')
        r_unconf = plain(pg)
        check('Relatório antes de confirmar NÃO envia dados do plantão anterior (campos com "-")', 'Dr. Álvaro' not in r_unconf and 'Quantidade estimada disponível: -' in r_unconf and 'Bom dia' not in r_unconf and 'Não informado' not in r_unconf)
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
        pg.wait_for_selector('#report-text', timeout=8000)
        check('12 confirmações seguidas levam ao relatório (fluxo de poucos toques)', True)
        pg.goto(shift2); pg.wait_for_selector('#progress-label')
        check('Após confirmar: 13 de 13 preenchidos', '13 de 13' in pg.inner_text('#progress-label'), pg.inner_text('#progress-label'))
        pg.goto(shift2 + '/relatorio'); pg.wait_for_selector('#report-text')
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
        c3.close(); b.close()

    shutil.rmtree(tmp, ignore_errors=True)
    failed = [r for r in RESULTS if not r[1]]
    print(f'\n{len(RESULTS) - len(failed)}/{len(RESULTS)} verificações passaram')
    for n, _, d in failed: print('  FALHOU:', n, d)
    sys.exit(1 if failed else 0)

if __name__ == '__main__':
    main()
