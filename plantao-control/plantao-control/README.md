# PLANTÃO CONTROL — versão 1.0

Gerenciador de plantão administrativo hospitalar, mobile-first (PWA), sem backend, sem login e sem serviços externos.
Substitui o preenchimento manual da mensagem de WhatsApp: o enfermeiro abre o plantão, preenche os 13 setores no celular, e o app monta a mensagem de apresentação e o relatório completo (texto, imagens PNG e PDF).

## Executar localmente

Requer apenas Node 18+ (para o servidor estático; o app em si não usa Node).

```bash
npm start            # http://localhost:5173
```

Abra no celular na mesma rede pelo IP do computador (o service worker/instalação PWA só funcionam em `localhost` ou HTTPS).
Não abra `index.html` direto por `file://` (módulos ES exigem HTTP).

## Implantar na Vercel

É um site estático, sem build.

1. Envie a pasta para um repositório Git (GitHub) e importe em vercel.com/new — *Framework Preset: Other*, sem comando de build e sem *output directory* (raiz).
   Ou, pela CLI: `npx vercel --prod` dentro da pasta.
2. O `vercel.json` já define cabeçalhos de segurança (CSP sem scripts externos), cache do service worker e tipo do manifest.
3. Abra a URL `https://…vercel.app` no Safari (iPhone) ou Chrome (Android) e use *Compartilhar → Adicionar à Tela de Início* / *Instalar app*.

## Estrutura

| Arquivo | Função |
|---|---|
| `index.html`, `css/styles.css` | Entrada e estilos (tema escuro, mobile-first) |
| `js/sectors.js` | Dados dos 13 setores, perguntas, regras condicionais, estados e ocorrências |
| `js/validation.js` | Validação de plantão, respostas e arquivos de backup |
| `js/storage.js` | IndexedDB (com aviso explícito se indisponível) |
| `js/report.js` | Mensagem de apresentação e relatório (texto WhatsApp, modelo estruturado) |
| `js/export.js` | Copiar, WhatsApp (`wa.me`), imagens PNG multipágina, PDF |
| `js/app.js`, `js/ui.js` | Telas, rotas, salvamento automático, componentes |
| `manifest.webmanifest`, `sw.js`, `icons/` | PWA |
| `fonts/` | Inter (local; licença OFL em `INTER-LICENSE.txt`) |
| `tests/` | Testes unitários (Node) e de ponta a ponta (Playwright/Chromium) |

## Como funciona

- **Fluxo:** Home → Novo plantão (tipo MT/N, data, horários, enfermeiros) → mensagem de apresentação (copiar / WhatsApp) → Painel com os 13 setores → formulários → Relatório → Finalizar.
- **Estados do setor:** cinza (não iniciado), azul (em preenchimento, com contagem de pendências), verde (preenchido). Uma **ocorrência** (âmbar) é independente do preenchimento: um setor pode estar preenchido *e* com ocorrência.
- **Respostas:** Sim / Não / N/A (não se aplica) / vazio = **Não informado**. Vazio nunca vira 0 ou "Não"; `0` é resposta válida.
- **Relatório parcial:** a finalização nunca é bloqueada por campos vazios; eles aparecem como "Não informado" e são listados antes de finalizar.
- **Salvamento:** automático (IndexedDB) a cada alteração, com selo de estado (Salvando / Salvo / Erro / Não salvo). Se o armazenamento falhar ou estiver indisponível, o app avisa em vez de fingir que salvou. Um diário síncrono em `localStorage` protege alterações feitas segundos antes de fechar/recarregar a página.
- **Histórico de atividades:** início, preenchimento/atualização de cada setor, alterações pós-finalização e finalização. Só a confirmação da finalização leva o nome de um profissional (escolhido na hora); as demais alterações não são atribuídas a ninguém.
- **Backup:** exportar/importar JSON validado (mescla por identificador; nunca apaga plantões existentes; só substitui um plantão se o do arquivo for mais recente).
- **Privacidade:** nenhum dado sai do aparelho; sem analytics; sem campos de paciente (há apenas um lembrete discreto para não registrar dados pessoais).

## Decisões de interpretação (confira se coincidem com o modelo institucional)

- Os rótulos das perguntas seguem exatamente o modelo recebido. Foram **acrescentados** apenas 4 campos condicionais pedidos no briefing: *Detalhamento da ausência* (Portaria), *Especificar os medicamentos em falta* (Farmácia), *Equipamento com falha* e *Descrição da falha* (Laboratório). Aparecem recuados e só quando a resposta pai é "Sim".
- "Se sim, quais?" (Laboratório) só aparece quando *Exames indispensáveis?* = Sim. "Motivo" (leitos) só com bloqueados > 0. "Motivo das suspensões" só quando *Procedimentos suspensos* tem conteúdo.
- **Ocorrência (âmbar)** é marcada por: Equipe completa = Não; Ausência = Sim; Medicamento crítico em falta = Sim; Enxoval insuficiente; Reposição urgente = Sim; Exames indispensáveis = Sim; Equipamento com falha = Sim; Autoclave = Não; leitos bloqueados > 0; e textos de ocorrência/pendência/reclamação/intercorrência/atraso/suspensão preenchidos (textos como "nenhuma", "nada", "sem ocorrências", "0" são ignorados). Ajuste em `js/sectors.js` (`alert`) se a regra do hospital for outra.
- *Observações* (Portaria) é opcional e não impede o setor de ficar "preenchido".
- MT = plantão diurno (saudação pelo horário de início: Bom dia / Boa tarde / Boa noite).

## Testes

```bash
npm test                              # 18 testes de lógica (Node)
node tests/serve.mjs 5173 &           # servidor
python3 tests/e2e.py                  # 105 verificações no Chromium (Playwright)
CSP=1 node tests/serve.mjs 5174 &     # mesma suíte sob os cabeçalhos/CSP do vercel.json:
BASE_URL=http://localhost:5174 python3 tests/e2e.py
```

### Relatório de testes executados (14/11/2026)

**Executados e aprovados** (Chromium/Chrome headless, emulando iPhone 390×844, toque e `pt-BR`):
- 18/18 testes unitários: 13 setores e ordem; **todas as perguntas originais com rótulo exato**; condicionais; zero vs. vazio; N/A; preenchimento × ocorrência; mensagem de apresentação igual ao modelo; relatório completo; acentuação/símbolos/texto longo; validação de datas/horários; backup (ida e volta, corrompido, parcial, duplicado); sanitização.
- 105/105 verificações de ponta a ponta, também sob a CSP do `vercel.json`:
  - **Navegação:** iniciar plantão, 13 setores em qualquer ordem, voltar/editar, retomar, próximo/anterior.
  - **Formulários:** Sim/Não/N/A, condicionais, zero, vazio, só dígitos nos numéricos, limite de 1000 caracteres, estados do painel (cinza/azul/verde/âmbar).
  - **Persistência:** recarregar a página; **fechar e reabrir o navegador** (perfil persistente); digitar e recarregar imediatamente; novo plantão preservando o histórico; aviso de plantão duplicado e de plantão em andamento.
  - **Relatório:** 13 setores na ordem, todas as perguntas, respostas conferidas, caracteres especiais; copiar (conteúdo real da área de transferência); URL `wa.me` com texto codificado idêntico ao relatório; PNGs de 1080 px (7 páginas no relatório completo de teste) e PDF válido (mesmo nº de páginas).
  - **Finalização:** prévia, ocorrências, pendências, confirmação por profissional, data/hora, edição posterior com relatório atualizado e registro na atividade.
  - **Falhas:** IndexedDB indisponível (aviso, selo "Não salvo"), erro de gravação (selo de erro, aviso e nova tentativa), backup corrompido, backup de outro formato, backup parcialmente inválido, importação duplicada (não duplica), exclusão com confirmação.
  - **Mobile:** sem rolagem horizontal em 320/360/390/430 px em todas as telas; controles ≥ 44×44 px; campos com fonte ≥ 16 px (evita zoom do iOS).
  - **PWA:** manifest e ícones válidos; service worker ativo; app abre **offline** (Chromium).

**NÃO testado (limitações reais do ambiente):**
- Safari no iPhone e Chrome em Android físicos; teclado virtual real; instalação na tela inicial; comportamento do IndexedDB do Safari em modo privado ou após inatividade.
- Abertura real do WhatsApp e o envio: o teste confirma apenas a URL gerada (`window.open` foi simulado). O app **não escolhe o grupo**; o usuário escolhe a conversa no WhatsApp.
- Compartilhamento nativo de imagens (`navigator.share` com arquivos): sem suporte no Chromium headless; o app cai para download.
- No teste de reabertura do navegador, o download do backup foi verificado capturando o arquivo gerado pelo app (limitação do Playwright ao baixar arquivos em perfil reaberto); o download real de PNG/PDF foi verificado na primeira sessão.

### Problemas encontrados nos testes e correções

1. **Perda de dados ao recarregar logo após digitar** (gravação assíncrona não concluía) → diário síncrono em `localStorage` + recuperação na abertura.
2. Rolagem horizontal de 2 px em 320 px na barra de ações do setor → botões passaram a encolher.
3. Selo "Salvo" com área de toque de 28 px → 44 px.
4. **Cartão de setor "em preenchimento" cortado** (colisão de classe CSS com a barra de progresso) → renomeada para `.pbar`.
5. Rótulo longo e etiquetas apertando o nome do setor em 320 px → etiquetas movidas para baixo do nome.
6. Título truncado no topo do painel em telas estreitas → título/subtítulo encurtados.

## Limitações conhecidas

- Dados ficam **só neste aparelho e navegador** (sem sincronização). O iOS pode limpar dados de sites não instalados após longa inatividade: **instale na Tela de Início e exporte backups periodicamente**.
- Duas abas editando o mesmo plantão ao mesmo tempo podem sobrescrever uma à outra (vale a última gravação).
- O PDF é composto por páginas-imagem (A4); o texto não é selecionável. A imagem/PDF seguem a proporção A4.
- Mensagens muito longas (> ~6.000 caracteres codificados) não cabem em um link `wa.me`: o app usa o compartilhamento nativo ou copia o texto para você colar.
- Asteriscos/underlines digitados nos campos de texto podem ser interpretados como formatação pelo WhatsApp.
- O service worker prioriza a rede (recebe atualizações) e usa o cache só sem conexão; não há aviso de "nova versão disponível".

## Checklist de validação mobile (faça no seu aparelho antes do uso real)

- [ ] Abrir a URL da Vercel no Safari (iPhone) / Chrome (Android) e adicionar à Tela de Início; abrir pelo ícone.
- [ ] Criar plantão; conferir a mensagem de apresentação; tocar em **WhatsApp**, escolher a conversa e conferir o texto.
- [ ] Preencher um setor com o teclado virtual: campos numéricos abrem teclado numérico; nada fica escondido atrás do teclado; sem zoom automático.
- [ ] Usar com uma mão: botões e barra de ações alcançáveis.
- [ ] Fechar o app/navegador por completo e reabrir: plantão e respostas continuam lá.
- [ ] Modo avião: o app abre e os dados aparecem.
- [ ] Relatório completo → **Copiar** → colar no WhatsApp: formatação (negrito/lista) correta.
- [ ] **Gerar imagens**: todas as páginas legíveis; compartilhar/salvar na galeria.
- [ ] **Exportar PDF** e abrir.
- [ ] Exportar backup, apagar um plantão de teste e importar o backup de volta.
- [ ] Finalizar plantão e corrigir um setor depois; conferir a atividade.
