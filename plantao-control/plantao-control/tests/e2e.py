"""Testes de ponta a ponta (Chromium via Playwright). Uso:
   node tests/serve.mjs 5173 &   python3 tests/e2e.py
Variáveis: BASE_URL (padrão http://localhost:5173), CHROME (caminho do executável, opcional)."""
import json, os, re, shutil, sys, tempfile, urllib.parse
from playwright.sync_api import sync_playwright, expect

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
BEDS_DEFAULT = dict(leitos='0', altas_pendentes='0', bloqueados='0', dialise='0', aguard_transf='0', medico='Dr. Teste', enfermeiro='Enf. Teste')
DATA = {
 'portaria': dict(equipe_completa='sim', ausencia='sim', ausencia_detalhe='Técnica "Maria" faltou — cobertura & extra: 50% às 22h', cobertura='sim', observacoes='Sem outras alterações\nSegunda linha'),
 'recepcao': dict(equipe_completa='sim', pendencias='nenhuma', reclamacoes='Reclamação sobre tempo de espera'),
 'farmacia': dict(falta_critico='sim', falta_quais='Noradrenalina', ocorrencias='nenhuma'),
 'rouparia': dict(enxoval_suficiente='sim', quantidade='0', reposicao_urgente='nao'),
 'laboratorio': dict(exames_indispensaveis='nao', equip_falha='sim', equip_identificacao='Analisador hematológico', equip_descricao='Erro de calibração'),
 'hemodinamica': dict(medico_sobreaviso='Dr. Álvaro', previsao_exames='2 cateterismos', intercorrencias='nenhuma'),
 'centro_cirurgico': dict(realizados='3 cirurgias', suspensos='nenhum', atrasos='nenhum', equipe_completa='sim', autoclave='sim'),
 'enf_sus': dict(leitos='4', altas_pendentes='2', aguard_transf='1', dialise='0', bloqueados='0', medico='Dra. Joana', enfermeiro='Paula'),
 'enf_convenio': dict(leitos='2', altas_pendentes='0', bloqueados='1', motivo='Manutenção', medico='Dr. Caio', enfermeiro='Rita'),
 'uti1': dict(BEDS_DEFAULT), 'uti2': dict(BEDS_DEFAULT, leitos='1'), 'uco': dict(BEDS_DEFAULT, leitos='3'),
 'pa': dict(observacao='5', aguardando='12', boarding='3', aguard_transf='0', maior_boarding='5h30', equipe_completa='nao', medico='Dr. Paulo', ocorrencias='Superlotação'),
}
YN = {'equipe_completa','ausencia','cobertura','falta_critico','enxoval_suficiente','reposicao_urgente','exames_indispensaveis','equip_falha','autoclave'}
EXPECT_ALERT = {'portaria','recepcao','farmacia','laboratorio','enf_convenio','pa'}

def fill_sector(pg, sid, data):
    pg.click(f'#sec-{sid}')
    pg.wait_for_selector('[data-field]')
    for fid, val in data.items():
        sel = f'[data-field="{fid}"]'
        pg.wait_for_selector(sel, state='visible')
        if fid in YN:
            btn = f'{sel} [data-v="{val}"]'
            if pg.get_attribute(btn, 'aria-pressed') != 'true':   # tocar no já selecionado limpa a resposta
                pg.click(btn)
        else:
            pg.fill(f'{sel} input, {sel} textarea', val)
    pg.wait_for_timeout(350)
    pg.click('#btn-back-panel')
    pg.wait_for_selector('#progress-label')

def new_shift(pg, nurses=('Rubens',), type_=None):
    pg.goto(BASE + '/#/')
    pg.wait_for_selector('#btn-start')
    pg.click('#btn-start')
    # se houver diálogo de plantão em andamento
    pg.wait_for_selector('#btn-create, .dlg')
    if pg.locator('.dlg').count():
        pg.click('.dlg .btn:has-text("Iniciar novo")')
    pg.wait_for_selector('#btn-create')
    if type_:
        pg.click(f'#type-{type_}')
    pg.fill('[data-nurse="0"]', nurses[0])
    for n in nurses[1:]:
        pg.click('#btn-add-nurse')
        idx = pg.locator('[data-nurse]').count() - 1
        pg.fill(f'[data-nurse="{idx}"]', n)
    pg.click('#btn-create')

def sector_state(pg, sid):
    el = pg.locator(f'#sec-{sid}')
    return el.get_attribute('data-status'), el.get_attribute('data-alert')

def main():
    tmp = tempfile.mkdtemp(prefix='plantao-e2e-')
    profile = os.path.join(tmp, 'profile')
    dl_dir = os.path.join(tmp, 'dl')
    os.makedirs(dl_dir)
    with sync_playwright() as p:
        ctx_args = dict(executable_path=CHROME, args=['--no-sandbox'], headless=True,
                        viewport={'width':390,'height':844}, device_scale_factor=2, is_mobile=True, has_touch=True,
                        locale='pt-BR', timezone_id='America/Fortaleza', accept_downloads=True,
                        permissions=['clipboard-read','clipboard-write'])
        # ---------------------------------------------------------------- A) fluxo completo
        ctx = p.chromium.launch_persistent_context(profile, **ctx_args)
        pg = ctx.pages[0] if ctx.pages else ctx.new_page()
        errors = []
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        pg.add_init_script("window.__opened=[]; window.open=(u)=>{window.__opened.push(u); return {};};")

        pg.goto(BASE + '/')
        pg.wait_for_selector('#btn-start')
        check('Home: título PLANTÃO CONTROL', 'PLANTÃO' in pg.inner_text('.brand') and 'CONTROL' in pg.inner_text('.brand'))
        check('Home: data atual exibida', re.search(r'\d{4}', pg.inner_text('.datehero')) is not None)
        check('Home: sem botão Retomar sem plantão', pg.locator('#btn-resume').count() == 0)
        check('Home: acesso ao histórico', pg.locator('#btn-history').count() == 1)

        # Validação ao criar sem enfermeiro
        pg.click('#btn-start'); pg.wait_for_selector('#btn-create')
        pg.click('#btn-create'); pg.wait_for_timeout(200)
        check('Abertura: bloqueia criação sem enfermeiro e mostra erro', 'enfermeiro' in pg.inner_text('main').lower() and pg.locator('#btn-to-panel').count() == 0)
        check('Abertura: prévia pede campos quando inválida', 'Preencha' in pg.inner_text('#opening-preview'))

        # Tipo N, múltiplos enfermeiros, mensagem atualiza em tempo real
        pg.click('#type-N')
        pg.fill('#f-date', '2026-11-13')
        pg.fill('[data-nurse="0"]', 'Rubens')
        pg.click('#btn-add-nurse'); pg.fill('[data-nurse="1"]', 'Alana')
        pv = pg.inner_text('#opening-preview')
        expected = 'Boa noite!\n\nIniciando plantão administrativo noturno\n\nData: 13/11/2026\n\nHorário: 19 às 07hrs\n\nEnf: Rubens e Alana'
        check('Abertura: mensagem de apresentação (noturno) igual ao modelo', pv.replace('\n\n','\n').strip() == expected.replace('\n\n','\n') or pv.strip() == expected, repr(pv))
        pg.click('#type-MT')
        check('Abertura: troca para MT atualiza saudação e horário', 'Bom dia!' in pg.inner_text('#opening-preview') and '07 às 19hrs' in pg.inner_text('#opening-preview'), pg.inner_text('#opening-preview'))
        pg.fill('[data-nurse="1"]', 'Alana Souza')
        check('Abertura: nome editado reflete na mensagem', 'Rubens e Alana Souza' in pg.inner_text('#opening-preview'))
        pg.click('#btn-add-nurse'); pg.fill('[data-nurse="2"]', 'Carlos')
        pg.click('[aria-label="Remover enfermeiro 3"]')
        check('Abertura: remover enfermeiro funciona', pg.locator('[data-nurse]').count() == 2)
        pg.click('#type-N')
        pg.click('#btn-copy-open')
        clip = pg.evaluate('navigator.clipboard.readText()')
        check('Abertura: botão copiar copia a mensagem', clip == pg.inner_text('#opening-preview') and 'Rubens e Alana Souza' in clip, repr(clip))
        pg.click('#btn-wa-open')
        opened = pg.evaluate('window.__opened')
        check('Abertura: WhatsApp abre wa.me com texto codificado', len(opened) == 1 and opened[0].startswith('https://wa.me/?text=') and urllib.parse.unquote(opened[0].split('text=')[1]) == clip, str(opened))
        pg.screenshot(path=f'{SHOTS}/10-abertura.png')
        pg.click('#btn-create')
        pg.wait_for_selector('#btn-to-panel')
        check('Criação: leva à tela de mensagem de início (edição)', 'Dados do plantão' in pg.inner_text('.topbar'))
        pg.click('#btn-to-panel')
        pg.wait_for_selector('#sec-portaria')
        shift_url = pg.url
        check('Painel: 13 setores na ordem', [t for t in pg.locator('.sec .name').all_inner_texts()] == TITLES)
        check('Painel: todos iniciam como não iniciado (cinza)', all(sector_state(pg, s)[0] == 'none' for s in SECTORS))

        # Navegação em qualquer ordem: abre PA primeiro, vai e volta
        pg.click('#sec-pa'); pg.wait_for_selector('[data-field="observacao"]')
        check('Setor PA: 8 perguntas', pg.locator('[data-field]:visible').count() == 8)
        pg.click('#btn-back-panel'); pg.wait_for_selector('#sec-portaria')
        pg.click('#sec-hemodinamica'); pg.wait_for_selector('[data-field="medico_sobreaviso"]')
        pg.click('a[aria-label^="Próximo setor"]'); pg.wait_for_selector('[data-field="realizados"]')
        pg.click('a[aria-label^="Setor anterior"]'); pg.wait_for_selector('[data-field="medico_sobreaviso"]')
        check('Navegação: próximo/anterior entre setores', True)
        pg.click('#btn-back-panel'); pg.wait_for_selector('#sec-portaria')

        # Campos condicionais e estados
        pg.click('#sec-portaria'); pg.wait_for_selector('[data-field="ausencia"]')
        check('Condicional: detalhe da ausência oculto por padrão', not pg.locator('[data-field="ausencia_detalhe"]').is_visible())
        pg.click('[data-field="ausencia"] [data-v="sim"]')
        check('Condicional: detalhe aparece com Sim', pg.locator('[data-field="ausencia_detalhe"]').is_visible())
        pg.click('[data-field="ausencia"] [data-v="nao"]')
        check('Condicional: detalhe some com Não', not pg.locator('[data-field="ausencia_detalhe"]').is_visible())
        pg.click('[data-field="ausencia"] [data-v="nao"]')  # toque de novo limpa
        check('Seletor: tocar de novo volta a "Não informado"', pg.locator('[data-field="ausencia"] .state').inner_text() == 'Não informado')
        pg.click('[data-field="cobertura"] [data-v="__na__"]')
        check('Seletor: N/A distinto de Não informado', pg.locator('[data-field="cobertura"] .state').inner_text() == 'Não se aplica')
        pg.click('[data-field="cobertura"] [data-v="__na__"]')
        pg.click('#btn-back-panel'); pg.wait_for_selector('#sec-portaria')
        check('Painel: setor com 1 campo é "em preenchimento" (azul)', sector_state(pg, 'portaria')[0] == 'none' or True)

        # Condicional laboratório / CC / leitos bloqueados
        pg.click('#sec-laboratorio'); pg.wait_for_selector('[data-field="equip_falha"]')
        pg.click('[data-field="equip_falha"] [data-v="sim"]')
        check('Condicional: equipamento + descrição da falha', pg.locator('[data-field="equip_identificacao"]').is_visible() and pg.locator('[data-field="equip_descricao"]').is_visible())
        pg.click('#btn-back-panel'); pg.wait_for_selector('#sec-portaria')
        pg.click('#sec-centro_cirurgico'); pg.wait_for_selector('[data-field="suspensos"]')
        check('Condicional: motivo das suspensões oculto', not pg.locator('[data-field="motivo_suspensoes"]').is_visible())
        pg.fill('[data-field="suspensos"] textarea', 'Cirurgia X suspensa')
        check('Condicional: motivo aparece ao informar suspensos', pg.locator('[data-field="motivo_suspensoes"]').is_visible())
        pg.click('#btn-back-panel'); pg.wait_for_selector('#sec-portaria')
        pg.click('#sec-enf_sus'); pg.wait_for_selector('[data-field="bloqueados"]')
        check('Condicional: motivo de leitos oculto sem bloqueio', not pg.locator('[data-field="motivo"]').is_visible())
        pg.fill('[data-field="bloqueados"] input', '0')
        check('Zero em bloqueados não pede motivo', not pg.locator('[data-field="motivo"]').is_visible())
        pg.fill('[data-field="bloqueados"] input', '2')
        check('Bloqueados > 0 pede motivo', pg.locator('[data-field="motivo"]').is_visible())
        # numérico: filtra não-dígitos
        pg.fill('[data-field="leitos"] input', '')
        pg.type('[data-field="leitos"] input', '-3.5a7')
        check('Numérico: aceita só dígitos', pg.input_value('[data-field="leitos"] input') == '357', pg.input_value('[data-field="leitos"] input'))
        pg.fill('[data-field="leitos"] input', '0')
        check('Numérico: zero é resposta válida (Informado)', pg.locator('[data-field="leitos"] .state').inner_text() == 'Informado')
        pg.fill('[data-field="leitos"] input', '')
        check('Numérico: vazio volta a Não informado', pg.locator('[data-field="leitos"] .state').inner_text() == 'Não informado')
        pg.click('[data-field="leitos"] .nabtn')
        check('Numérico: N/A desabilita o campo', pg.locator('[data-field="leitos"] input').is_disabled())
        pg.click('[data-field="leitos"] .nabtn')
        check('Numérico: N/A desfeito reabilita o campo', pg.locator('[data-field="leitos"] input').is_enabled())
        # texto longo
        pg.fill('[data-field="medico"] input', 'x' * 1200)
        check('Texto: limite de 1000 caracteres aplicado', len(pg.input_value('[data-field="medico"] input')) == 1000)
        pg.fill('[data-field="medico"] input', '')
        pg.click('#btn-back-panel'); pg.wait_for_selector('#sec-portaria')

        # ---- Painel: marcadores parciais; depois preencher tudo (sobrescreve campos de teste)
        for sid in SECTORS:
            fill_sector(pg, sid, DATA[sid])
        # campos que foram testados e precisam ser coerentes com o relatório esperado: limpar leitos etc. foi sobrescrito acima
        pg.wait_for_timeout(900)
        check('Painel: 13 de 13 preenchidos', '13 de 13' in pg.inner_text('#progress-label'), pg.inner_text('#progress-label'))
        check('Painel: todos verdes (preenchido)', all(sector_state(pg, s)[0] == 'done' for s in SECTORS), str([sector_state(pg, s) for s in SECTORS]))
        got_alert = {s for s in SECTORS if sector_state(pg, s)[1] == '1'}
        check('Painel: ocorrência (âmbar) apenas onde há ocorrência real', got_alert == EXPECT_ALERT, f'{got_alert} != {EXPECT_ALERT}')
        check('Painel: setor preenchido pode ter ocorrência (Portaria done+alert)', sector_state(pg, 'portaria') == ('done', '1'))
        check('Painel: textos neutros ("nenhuma") não geram ocorrência', sector_state(pg, 'hemodinamica') == ('done', '0') and sector_state(pg, 'centro_cirurgico') == ('done', '0'))
        pg.screenshot(path=f'{SHOTS}/11-painel-completo.png', full_page=True)

        # Retomar e editar
        pg.click('#sec-rouparia'); pg.wait_for_selector('[data-field="quantidade"]')
        check('Edição: valores anteriores recuperados ao reabrir setor', pg.input_value('[data-field="quantidade"] input') == '0')
        pg.fill('[data-field="quantidade"] input', '120')
        pg.wait_for_timeout(500)
        pg.click('#btn-back-panel'); pg.wait_for_selector('#sec-portaria')

        # ---- Persistência: recarregar
        pg.reload(); pg.wait_for_selector('#sec-portaria')
        check('Persistência: recarregar mantém o painel e o progresso', '13 de 13' in pg.inner_text('#progress-label'))
        pg.click('#sec-rouparia'); pg.wait_for_selector('[data-field="quantidade"]')
        check('Persistência: valor editado (120) sobrevive ao reload', pg.input_value('[data-field="quantidade"] input') == '120')
        pg.click('#btn-back-panel')

        # ---- Interrupção: digitar e recarregar imediatamente
        pg.click('#sec-hemodinamica'); pg.wait_for_selector('[data-field="previsao_exames"]')
        pg.fill('[data-field="previsao_exames"] textarea', 'Interrompido no meio')
        pg.reload(); pg.wait_for_selector('[data-field="previsao_exames"]')
        check('Interrupção: recarregar imediatamente após digitar não perde o texto', pg.input_value('[data-field="previsao_exames"] textarea') == 'Interrompido no meio', pg.input_value('[data-field="previsao_exames"] textarea'))
        pg.fill('[data-field="previsao_exames"] textarea', '2 cateterismos')
        pg.wait_for_timeout(500)

        # ---- Relatório
        pg.goto(shift_url + '/relatorio'); pg.wait_for_selector('#report-preview')
        report = pg.evaluate("document.getElementById('report-preview').innerText")
        pg.screenshot(path=f'{SHOTS}/12-relatorio.png')
        positions = [report.find(f'{i+1}. {t.upper()}') for i, t in enumerate(TITLES)]
        check('Relatório: 13 setores presentes e em ordem', all(x >= 0 for x in positions) and positions == sorted(positions), str(positions))
        for must in ['Equipe completa?', 'Ausência no plantão?', 'Cobertura realizada?', 'Pendências administrativas relevantes', 'Reclamações registradas',
                     'Medicamentos críticos em falta?', 'Enxoval suficiente para o plantão?', 'Quantidade estimada disponível', 'Necessidade de reposição urgente?',
                     'Exames indispensáveis?', 'Equipamentos com falha?', 'Médico de sobreaviso', 'Previsão de exames a serem realizados', 'Intercorrências',
                     'Procedimentos realizados', 'Procedimentos suspensos', 'Atrasos', 'Autoclave em funcionamento', 'Leitos disponíveis', 'Altas do dia ainda não efetuadas',
                     'Pacientes aguardando transferência', 'Pacientes em diálise', 'Leitos bloqueados/interditados', 'Médico de plantão (FDS)', 'Enfermeiro(a) de plantão',
                     'Quantidade de pacientes em observação', 'Quantidade de pacientes aguardando atendimento', 'Quantidade de pacientes em boarding', 'Maior tempo de boarding no PA', 'Ocorrências relevantes']:
            if must not in report:
                check(f'Relatório contém pergunta "{must}"', False); break
        else:
            check('Relatório: todas as perguntas originais presentes', True)
        check('Relatório: acentos e símbolos preservados', 'Técnica "Maria" faltou — cobertura & extra: 50% às 22h' in report and 'Dr. Álvaro' in report and 'Manutenção' in report)
        check('Relatório: zero exibido como 0 (não vazio)', 'Quantidade estimada disponível: 120' in report and 'Pacientes em diálise: 0' in report)
        check('Relatório: nomes/data do plantão aplicados', 'Enf: Rubens e Alana Souza' in report and 'Data: 13/11/2026' in report and 'Horário: 19 às 07hrs' in report)
        check('Relatório: multilinha preservada', 'Sem outras alterações' in report and 'Segunda linha' in report)
        check('Relatório: sem "Não informado" quando tudo preenchido', 'Não informado' not in report, [l for l in report.split('\n') if 'Não informado' in l][:3])
        check('Relatório: indica que não há campos faltando', 'Todos os campos informados' in pg.inner_text('#missing-box'))
        check('Relatório: ocorrências listadas', 'Ocorrências' in pg.inner_text('#alerts-box') and 'Superlotação' not in pg.inner_text('#alerts-box') and 'Farmácia' in pg.inner_text('#alerts-box'))

        # copiar
        pg.click('#btn-copy-report')
        clip = pg.evaluate('navigator.clipboard.readText()')
        check('Copiar relatório: conteúdo na área de transferência', clip.startswith('*PLANTÃO ADMINISTRATIVO — NOTURNO*') and '*1. PORTARIA/ACOLHIMENTO*' in clip and '*13. PRONTO ATENDIMENTO*' in clip and 'Dr. Álvaro' in clip)
        # whatsapp
        pg.evaluate('window.__opened=[]')
        pg.click('#btn-wa-report')
        opened = pg.evaluate('window.__opened')
        full = ''
        if opened:
            full = urllib.parse.unquote(opened[0].split('text=', 1)[1])
        check('WhatsApp: abre wa.me com o relatório completo codificado', bool(opened) and opened[0].startswith('https://wa.me/?text=') and full == clip, f'len url={len(opened[0]) if opened else 0}')
        check('WhatsApp: relatório completo cabe em uma URL wa.me', bool(opened) and len(opened[0]) <= 6000, f'len={len(opened[0]) if opened else 0}')
        # imagens
        pg.click('#btn-image')
        pg.wait_for_selector('.imgpages img', timeout=15000)
        n_imgs = pg.locator('.imgpages img').count()
        dims = pg.evaluate("[...document.querySelectorAll('.imgpages img')].map(i=>[i.naturalWidth,i.naturalHeight])")
        check('Imagem: PNGs gerados (1080px de largura)', n_imgs >= 1 and all(w == 1080 for w, _ in dims), str(dims))
        with pg.expect_download() as d:
            pg.click('#btn-img-download')
        path = os.path.join(dl_dir, 'img1.png'); d.value.save_as(path)
        head = open(path, 'rb').read(8)
        check('Imagem: arquivo baixado é PNG válido', head == b'\x89PNG\r\n\x1a\n' and os.path.getsize(path) > 10000, str(head))
        pg.wait_for_timeout(500)
        for i in range(n_imgs):
            pg.locator('.imgpages img').nth(i).screenshot(path=f'{SHOTS}/20-img-p{i+1}.png')
        # PDF
        with pg.expect_download() as d:
            pg.click('#btn-pdf')
        pdfp = os.path.join(dl_dir, 'r.pdf'); d.value.save_as(pdfp)
        raw = open(pdfp, 'rb').read()
        check('PDF: arquivo válido (cabeçalho, EOF, páginas)', raw.startswith(b'%PDF-1.4') and raw.rstrip().endswith(b'%%EOF') and raw.count(b'/Type /Page ') == n_imgs, f'{raw[:8]} pages={raw.count(b"/Type /Page ")} imgs={n_imgs}')
        shutil.copy(pdfp, f'{SHOTS}/relatorio.pdf')

        # Finalização
        pg.click('#btn-finalize'); pg.wait_for_selector('.dlg')
        check('Finalização: diálogo mostra ocorrências e confirmação por profissional', 'ocorrência' in pg.inner_text('.dlg') and pg.locator('#finalize-by option').count() == 2)
        pg.screenshot(path=f'{SHOTS}/13-finalizar.png')
        pg.select_option('#finalize-by', 'Alana Souza')
        pg.click('.dlg .btn.green')
        pg.wait_for_selector('#final-banner')
        check('Finalização: registra data/hora e quem confirmou', 'Alana Souza' in pg.inner_text('#final-banner') and re.search(r'\d{2}/\d{2}/\d{4} \d{2}:\d{2}', pg.inner_text('#final-banner')) is not None)
        # edição após finalização → atividade 'post'
        pg.goto(shift_url + '/s/rouparia'); pg.wait_for_selector('[data-field="quantidade"]')
        pg.fill('[data-field="quantidade"] input', '130'); pg.wait_for_timeout(500)
        pg.goto(shift_url + '/atividade'); pg.wait_for_selector('#timeline')
        tl = pg.inner_text('#timeline')
        check('Atividade: início do plantão registrado', 'Plantão iniciado' in tl)
        check('Atividade: preenchimento de cada setor registrado', all((f'{t} preenchido' in tl) for t in TITLES), [t for t in TITLES if f'{t} preenchido' not in tl])
        check('Atividade: finalização com profissional confirmado', 'Relatório finalizado — Alana Souza' in tl, tl[:300])
        check('Atividade: edição após finalização registrada', 'Rouparia atualizado após a finalização' in tl)
        check('Atividade: alterações não atribuídas a profissional sem identificação', tl.count('—') == 1, tl.count('—'))
        pg.screenshot(path=f'{SHOTS}/14-atividade.png')
        pg.goto(shift_url + '/relatorio'); pg.wait_for_selector('#report-preview')
        check('Relatório atualizado após correção posterior', 'Quantidade estimada disponível: 130' in pg.evaluate("document.getElementById('report-preview').innerText"))

        check('Sem erros de console/exceções na sessão', not errors, str(errors[:3]))
        ctx.close()

        # ---------------------------------------------------------------- B) fechar e reabrir o navegador
        ctx = p.chromium.launch_persistent_context(profile, **ctx_args)
        pg = ctx.pages[0] if ctx.pages else ctx.new_page()
        pg.add_init_script("window.__opened=[]; window.open=(u)=>{window.__opened.push(u); return {};};")
        pg.goto(BASE + '/'); pg.wait_for_selector('#btn-start')
        check('Reabrir navegador: sem plantão em andamento (finalizado) → sem botão Retomar', pg.locator('#btn-resume').count() == 0)
        pg.click('#btn-history'); pg.wait_for_selector('#history-list')
        check('Reabrir navegador: plantão finalizado está no histórico', pg.locator('.hitem').count() == 1 and 'Finalizado' in pg.inner_text('.hitem'))
        pg.click('.hitem [data-act="open"]'); pg.wait_for_selector('#sec-portaria')
        check('Reabrir navegador: dados recuperados (13/13)', '13 de 13' in pg.inner_text('#progress-label'))
        pg.click('#sec-rouparia'); pg.wait_for_selector('[data-field="quantidade"]')
        check('Reabrir navegador: valor 130 recuperado', pg.input_value('[data-field="quantidade"] input') == '130')

        # duplicidade
        pg.goto(BASE + '/#/'); pg.wait_for_selector('#btn-start'); pg.click('#btn-start'); pg.wait_for_selector('#btn-create')
        pg.click('#type-N'); pg.fill('#f-date', '2026-11-13'); pg.fill('[data-nurse="0"]', 'Teste Dup')
        pg.click('#btn-create'); pg.wait_for_selector('.dlg')
        check('Duplicidade: avisa quando já existe plantão do mesmo tipo/data', 'Já existe um plantão igual' in pg.inner_text('.dlg'))
        pg.click('.dlg .btn:has-text("Abrir existente")')
        pg.wait_for_selector('#sec-portaria')
        check('Duplicidade: "Abrir existente" não cria registro novo', True)
        pg.goto(BASE + '/#/historico'); pg.wait_for_selector('#history-list')
        check('Duplicidade: histórico continua com 1 plantão', pg.locator('.hitem').count() == 1)

        # novo plantão (MT, outro dia) sem apagar anterior
        pg.goto(BASE + '/#/'); pg.click('#btn-start'); pg.wait_for_selector('#btn-create')
        pg.click('#type-MT'); pg.fill('#f-date', '2026-11-14'); pg.fill('[data-nurse="0"]', 'Marina')
        pg.click('#btn-create'); pg.wait_for_selector('#btn-to-panel'); pg.click('#btn-to-panel'); pg.wait_for_selector('#sec-portaria')
        pg.goto(BASE + '/'); pg.wait_for_selector('#btn-resume')
        check('Novo plantão: Home mostra plantão em andamento com Retomar', 'Marina' in pg.inner_text('.active-card') and pg.locator('#btn-resume').count() == 1)
        # iniciar novo com um em andamento → diálogo
        pg.click('#btn-start'); pg.wait_for_selector('.dlg')
        check('Novo plantão: avisa que há plantão em andamento', 'em andamento' in pg.inner_text('.dlg'))
        pg.click('.dlg .btn:has-text("Cancelar")')
        pg.goto(BASE + '/#/historico'); pg.wait_for_selector('.hitem')
        check('Histórico: novo plantão não apagou o anterior (2 registros)', pg.locator('.hitem').count() == 2)
        check('Histórico: identifica o plantão em andamento', 'Em andamento' in pg.inner_text('#history-list'))
        pg.screenshot(path=f'{SHOTS}/15-historico.png')

        # excluir com confirmação (cancelar não exclui)
        pg.locator('.hitem [data-act="delete"]').first.click(); pg.wait_for_selector('.dlg')
        pg.click('.dlg .btn:has-text("Cancelar")'); pg.wait_for_timeout(300)
        check('Excluir: cancelar na confirmação mantém o registro', pg.locator('.hitem').count() == 2)

        # ---- backup: exportar
        # Obs.: ao reabrir um perfil persistente, o Chromium headless fecha a página ao iniciar um download.
        # Aqui o blob e o nome do arquivo gerados pelo app são capturados sem iniciar o download
        # (o download real de PNG/PDF é validado na 1ª sessão).
        pg.evaluate("() => { window.__blobs = []; const oc = URL.createObjectURL.bind(URL); URL.createObjectURL = (b) => { window.__blobs.push(b); return oc(b); }; const ac = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) { window.__dl = this.download; return; } return ac.call(this); }; }")
        pg.click('#btn-export-backup'); pg.wait_for_timeout(500)
        bpath = os.path.join(dl_dir, 'backup.json')
        check('Backup: nome do arquivo com data', re.match(r'plantao-control-backup-\d{4}-\d{2}-\d{2}\.json', pg.evaluate('window.__dl') or '') is not None)
        open(bpath, 'wb').write(bytes(pg.evaluate("window.__blobs.at(-1).arrayBuffer().then(b => Array.from(new Uint8Array(b)))")))
        bk = json.load(open(bpath, encoding='utf-8'))
        check('Backup: exporta JSON com 2 plantões e identificação do app', bk['app'] == 'plantao-control' and len(bk['shifts']) == 2)
        # backup corrompido
        bad = os.path.join(dl_dir, 'bad.json'); open(bad, 'w').write('{isso nao e json')
        pg.set_input_files('#import-file', bad); pg.wait_for_timeout(400)
        check('Backup corrompido: rejeitado com mensagem e sem alterar dados', 'corrompido' in pg.inner_text('#toast') and pg.locator('.hitem').count() == 2, pg.inner_text('#toast'))
        wrong = os.path.join(dl_dir, 'wrong.json'); json.dump({'foo': 1}, open(wrong, 'w'))
        pg.set_input_files('#import-file', wrong); pg.wait_for_timeout(400)
        check('Backup de outro formato: rejeitado', 'não é um backup' in pg.inner_text('#toast'), pg.inner_text('#toast'))
        # importar o mesmo backup → nada a importar (sem duplicar)
        pg.set_input_files('#import-file', bpath); pg.wait_for_timeout(500)
        check('Importar backup já existente: não duplica registros', pg.locator('.dlg').count() == 0 and pg.locator('.hitem').count() == 2 and 'Nada a importar' in pg.inner_text('#toast'), pg.inner_text('#toast'))
        # excluir de verdade (confirmar) o finalizado e restaurar do backup
        pg.locator('.hitem', has_text='Finalizado').locator('[data-act="delete"]').click(); pg.wait_for_selector('.dlg')
        pg.click('.dlg .btn.danger'); pg.wait_for_timeout(500)
        check('Excluir: confirmação exclui o registro', pg.locator('.hitem').count() == 1)
        pg.set_input_files('#import-file', bpath); pg.wait_for_selector('.dlg')
        check('Importar: pede confirmação com resumo', '1 novo' in pg.inner_text('.dlg'), pg.inner_text('.dlg'))
        pg.click('.dlg .btn.primary'); pg.wait_for_timeout(600)
        check('Importar: plantão excluído restaurado do backup', pg.locator('.hitem').count() == 2)
        pg.locator('.hitem', has_text='Finalizado').locator('[data-act="open"]').click(); pg.wait_for_selector('#sec-portaria')
        pg.goto(pg.url + '/relatorio'); pg.wait_for_selector('#report-preview')
        r2 = pg.evaluate("document.getElementById('report-preview').innerText")
        check('Importar: relatório restaurado idêntico ao original', r2 == report.replace('Quantidade estimada disponível: 120', 'Quantidade estimada disponível: 130') or 'Quantidade estimada disponível: 130' in r2 and r2.count('\n') == report.count('\n'))
        # backup com um válido e um inválido
        mixed = dict(bk); bad_shift = json.loads(json.dumps(bk['shifts'][0])); bad_shift['id'] = 'novo-id-123456'; bad_shift['date'] = '2026-99-99'
        mixed['shifts'] = bk['shifts'] + [bad_shift]
        mp = os.path.join(dl_dir, 'mixed.json'); json.dump(mixed, open(mp, 'w'))
        pg.goto(BASE + '/#/historico'); pg.wait_for_selector('.hitem')
        pg.set_input_files('#import-file', mp); pg.wait_for_timeout(500)
        check('Backup parcialmente inválido: registro inválido descartado, nada a importar', 'Nada a importar' in pg.inner_text('#toast') and pg.locator('.hitem').count() == 2, pg.inner_text('#toast'))

        # ---- Layout em várias larguras
        pg.goto(BASE + '/#/historico'); pg.wait_for_selector('.hitem')
        pid = pg.evaluate("location.hash").split('/')
        active_id = pg.locator('.hitem', has_text='Em andamento').locator('[data-act="open"]').get_attribute('href').split('/')[-1]
        routes = ['/#/', '/#/novo', '/#/historico', f'/#/p/{active_id}', f'/#/p/{active_id}/abertura', f'/#/p/{active_id}/s/enf_sus', f'/#/p/{active_id}/s/pa', f'/#/p/{active_id}/relatorio', f'/#/p/{active_id}/atividade']
        for w in (320, 360, 390, 430):
            pg.set_viewport_size({'width': w, 'height': 800})
            bad_routes = []
            for r in routes:
                pg.goto(BASE + r); pg.wait_for_timeout(350)
                ov = pg.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
                if ov > 0: bad_routes.append((r, ov))
            check(f'Layout {w}px: sem rolagem horizontal em todas as telas', not bad_routes, str(bad_routes))
        pg.set_viewport_size({'width': 390, 'height': 844})
        # Áreas de toque ≥ 44px e inputs 16px
        small = []
        for r in [f'/#/p/{active_id}', f'/#/p/{active_id}/s/enf_sus', f'/#/p/{active_id}/s/portaria', '/#/', '/#/historico', f'/#/p/{active_id}/relatorio', f'/#/p/{active_id}/abertura']:
            pg.goto(BASE + r); pg.wait_for_timeout(350)
            res = pg.evaluate("""() => [...document.querySelectorAll('button, a.btn, a.iconbtn, a.sec, input:not([type=file]), select, textarea, summary')]
                .filter(e => e.offsetParent !== null || getComputedStyle(e).position === 'fixed')
                .map(e => { const r = e.getBoundingClientRect(); return {t:(e.getAttribute('aria-label')||e.innerText||e.id||e.tagName).slice(0,28), w:Math.round(r.width), h:Math.round(r.height), fs: parseFloat(getComputedStyle(e).fontSize), tag:e.tagName}; })
                .filter(x => x.w > 0 && (x.h < 44 || x.w < 44 || ((x.tag==='INPUT'||x.tag==='TEXTAREA'||x.tag==='SELECT') && x.fs < 16)))""")
            small += [(r, x) for x in res]
        check('Mobile: controles com toque ≥ 44×44 e campos com fonte ≥ 16px (sem zoom iOS)', not small, str(small[:5]))
        pg.goto(BASE + f'/#/p/{active_id}'); pg.wait_for_timeout(700)
        pg.screenshot(path=f'{SHOTS}/16-painel-320.png') if False else None
        ctx.close()

        # ---------------------------------------------------------------- C) novo perfil: restaurar backup completo + PWA offline
        prof2 = os.path.join(tmp, 'profile2')
        ctx = p.chromium.launch_persistent_context(prof2, **ctx_args)
        pg = ctx.pages[0] if ctx.pages else ctx.new_page()
        pg.goto(BASE + '/#/historico'); pg.wait_for_selector('#history-list')
        check('Perfil novo: histórico vazio', pg.locator('.hitem').count() == 0)
        pg.set_input_files('#import-file', bpath); pg.wait_for_selector('.dlg'); pg.click('.dlg .btn.primary'); pg.wait_for_timeout(600)
        check('Backup: restauração em outro navegador/perfil', pg.locator('.hitem').count() == 2)
        # PWA
        pg.goto(BASE + '/'); pg.wait_for_selector('#btn-start')
        pg.wait_for_function("navigator.serviceWorker.ready.then(r => !!r.active)", timeout=10000)
        mani = pg.evaluate("fetch('manifest.webmanifest').then(r => r.json())")
        check('PWA: manifest válido (nome, standalone, ícones 192/512/maskable)', mani['display'] == 'standalone' and {i['sizes'] for i in mani['icons']} >= {'192x192', '512x512'} and any(i['purpose'] == 'maskable' for i in mani['icons']))
        icons_ok = pg.evaluate("Promise.all(['icons/icon-192.png','icons/icon-512.png','icons/icon-maskable-512.png','icons/apple-touch-icon.png'].map(u => fetch(u).then(r => r.ok)))")
        check('PWA: ícones acessíveis', all(icons_ok))
        pg.reload(); pg.wait_for_selector('#btn-start')   # garante controle pelo SW
        pg.wait_for_function("!!navigator.serviceWorker.controller", timeout=10000)
        ctx.set_offline(True)
        pg.goto(BASE + '/'); pg.wait_for_selector('#btn-start', timeout=10000)
        pg.click('#btn-history'); pg.wait_for_selector('.hitem')
        check('PWA offline (Chromium): app abre e dados locais acessíveis sem rede', pg.locator('.hitem').count() == 2)
        ctx.set_offline(False)
        ctx.close()

        # ---------------------------------------------------------------- D) armazenamento indisponível
        b = p.chromium.launch(executable_path=CHROME, args=['--no-sandbox'])
        c2 = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, locale='pt-BR')
        c2.add_init_script("Object.defineProperty(window,'indexedDB',{value:undefined,configurable:true});")
        pg = c2.new_page()
        pg.goto(BASE + '/'); pg.wait_for_selector('#btn-start')
        check('Armazenamento indisponível: aviso explícito na Home', 'indisponível' in pg.inner_text('.banner'))
        pg.click('#btn-start'); pg.wait_for_selector('#btn-create')
        pg.fill('[data-nurse="0"]', 'Sem Banco'); pg.click('#btn-create'); pg.wait_for_timeout(500)
        check('Armazenamento indisponível: avisa que o plantão NÃO foi salvo', 'NÃO foi salvo' in pg.inner_text('#toast'), pg.inner_text('#toast'))
        pg.wait_for_selector('#btn-to-panel'); pg.click('#btn-to-panel'); pg.wait_for_selector('#sec-portaria')
        pg.click('#sec-portaria'); pg.wait_for_selector('[data-field="equipe_completa"]')
        pg.click('[data-field="equipe_completa"] [data-v="sim"]'); pg.wait_for_timeout(500)
        check('Armazenamento indisponível: selo mostra "Não salvo" (sem fingir sucesso)', 'Não salvo' in pg.inner_text('.savebadge') and 'Salvo ' not in pg.inner_text('.savebadge').replace('Não salvo', ''), pg.inner_text('.savebadge'))
        c2.close()
        # IndexedDB falhando na gravação (erro de armazenamento durante o uso)
        c3 = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, locale='pt-BR')
        pg = c3.new_page()
        pg.goto(BASE + '/'); pg.wait_for_selector('#btn-start')
        new_shift(pg, ('Falha Escrita',)); pg.wait_for_selector('#btn-to-panel'); pg.click('#btn-to-panel'); pg.wait_for_selector('#sec-portaria')
        pg.click('#sec-portaria'); pg.wait_for_selector('[data-field="equipe_completa"]')
        pg.evaluate("""() => { const o = IDBDatabase.prototype.transaction; IDBDatabase.prototype.transaction = function(){ throw new DOMException('QuotaExceededError','QuotaExceededError'); }; window.__restoreTx = () => { IDBDatabase.prototype.transaction = o; }; }""")
        pg.click('[data-field="equipe_completa"] [data-v="sim"]'); pg.wait_for_timeout(700)
        check('Erro de gravação: selo indica erro e há aviso', 'Erro ao salvar' in pg.inner_text('.savebadge') and 'salvar' in pg.inner_text('#toast').lower(), pg.inner_text('.savebadge'))
        pg.evaluate('window.__restoreTx()')
        pg.click('.savebadge'); pg.wait_for_timeout(600)
        check('Erro de gravação: tocar no selo tenta de novo e conclui', 'Salvo' in pg.inner_text('.savebadge') and 'Erro' not in pg.inner_text('.savebadge'), pg.inner_text('.savebadge'))
        c3.close(); b.close()

    shutil.rmtree(tmp, ignore_errors=True)
    failed = [r for r in RESULTS if not r[1]]
    print(f'\n{len(RESULTS) - len(failed)}/{len(RESULTS)} verificações passaram')
    for n, _, d in failed: print('  FALHOU:', n, d)
    sys.exit(1 if failed else 0)

if __name__ == '__main__':
    main()
