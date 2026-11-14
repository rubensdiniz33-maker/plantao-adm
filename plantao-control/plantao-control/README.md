# PLANTÃO CONTROL — versão 1.1

Gerenciador de plantão administrativo hospitalar, mobile-first (PWA), sem backend, sem login e sem serviços externos.
Substitui o preenchimento manual da mensagem de WhatsApp: o enfermeiro abre o plantão (podendo **continuar a partir do último plantão**), confirma/ajusta os 13 setores no celular, e o app monta a mensagem de apresentação e o relatório completo (texto, imagens PNG e PDF).

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
| `fonts/` | Plus Jakarta Sans (local; licença OFL em `PLUS-JAKARTA-LICENSE.txt`) |
| `tests/` | Testes unitários (Node) e de ponta a ponta (Playwright/Chromium) |

## Como funciona

- **Fluxo:** Home → Iniciar plantão → (pergunta "Continuar a partir do último plantão?") → dados do plantão e mensagem de apresentação → Painel com os 13 setores → formulários → Relatório → Finalizar.
- **Continuar do último plantão (praticidade):** ao iniciar, se já existe um plantão anterior, o app pergunta *Sim/Não*. Com **Sim**, as respostas do plantão mais recente são copiadas para o novo e **todos os setores entram como "Revisar"**. Em cada setor o enfermeiro vê os valores já preenchidos, altera só o que mudou e toca **Confirmar e seguir**, que já abre o próximo setor pendente. **Dado copiado e não confirmado nunca entra no relatório** (sai como "Não informado" e é avisado), para não enviar informação velha. O plantão original não é alterado.
- **Seletor de setores:** no formulário, o botão com o contador (ex.: `5/13`) abre a lista dos 13 setores com o estado de cada um, para pular direto para qualquer setor. Uma barra de progresso fixa mostra "X de 13 preenchidos". **Próximo** pula os setores já prontos; quando não há mais pendências leva ao relatório.
- **Estados do setor:** cinza (não iniciado), azul (em preenchimento / revisar), verde (preenchido). **Ocorrência** (âmbar) é independente do preenchimento.
- **Campos:** Sim / Não / N/A (não se aplica) / vazio = **Não informado**. Vazio nunca vira 0 ou "Não"; `0` é resposta válida. Campos numéricos têm botões − e + e aceitam só dígitos.
- **Mensagens para WhatsApp:** sem linhas em branco entre os itens; títulos e perguntas em *negrito* (`*texto*`), "Não informado" em itálico. Ao copiar texto selecionado da prévia, o app devolve a sintaxe do WhatsApp (os asteriscos).
- **Relatório parcial:** a finalização nunca é bloqueada por campos vazios; eles aparecem como "Não informado" e são listados antes de finalizar.
- **Salvamento:** automático (IndexedDB) a cada alteração, com selo (Salvando / Salvo / Erro / Não salvo). Se o armazenamento falhar ou estiver indisponível, o app avisa em vez de fingir que salvou. Um diário síncrono em `localStorage` protege alterações feitas segundos antes de fechar/recarregar.
- **Histórico:** não há tela de histórico. Os plantões continuam sendo guardados em segundo plano (com o registro de atividades), e a Home mostra o **Último plantão** com atalhos para o relatório e para edição.
- **Backup:** botão "Backup dos dados" na Home (exportar/importar JSON validado; mescla por identificador, nunca apaga plantões existentes).
- **Privacidade:** nenhum dado sai do aparelho; sem analytics; sem campos de paciente.

## Decisões de interpretação (confira se coincidem com o modelo institucional)

- Os rótulos das perguntas seguem exatamente o modelo recebido. Foram **acrescentados** apenas 4 campos condicionais pedidos no briefing: *Detalhamento da ausência* (Portaria), *Especificar os medicamentos em falta* (Farmácia), *Equipamento com falha* e *Descrição da falha* (Laboratório). Aparecem recuados e só quando a resposta pai é "Sim".
- "Se sim, quais?" (Laboratório) só aparece quando *Exames indispensáveis?* = Sim. "Motivo" (leitos) só com bloqueados > 0. "Motivo das suspensões" só quando *Procedimentos suspensos* tem conteúdo.
- **Ocorrência (âmbar)** é marcada por: Equipe completa = Não; Ausência = Sim; Medicamento crítico em falta = Sim; Enxoval insuficiente; Reposição urgente = Sim; Exames indispensáveis = Sim; Equipamento com falha = Sim; Autoclave = Não; leitos bloqueados > 0; e textos de ocorrência/pendência/reclamação/intercorrência/atraso/suspensão preenchidos (textos como "nenhuma", "nada", "sem ocorrências", "0" são ignorados). Ajuste em `js/sectors.js` (`alert`) se a regra do hospital for outra.
- *Observações* (Portaria) é opcional e não impede o setor de ficar "preenchido".
- MT = plantão diurno (saudação pelo horário de início: Bom dia / Boa tarde / Boa noite).

## Testes

```bash
npm test                              # 21 testes de lógica (Node)
node tests/serve.mjs 5173 &           # servidor
python3 tests/e2e.py                  # 108 verificações no Chromium (Playwright)
CSP=1 node tests/serve.mjs 5174 &     # mesma suíte sob os cabeçalhos/CSP do vercel.json:
BASE_URL=http://localhost:5174 python3 tests/e2e.py
```

### Relatório de testes executados (14/11/2026, versão 1.1)

**Executados e aprovados** (Chrome headless emulando iPhone 390×844, toque e `pt-BR`; 21/21 unitários e 108/108 de ponta a ponta, também sob a CSP do `vercel.json`):
- **Formatação das mensagens:** apresentação e relatório sem linhas em branco; negrito em títulos e perguntas; asteriscos balanceados; texto copiado idêntico ao enviado no link `wa.me`; cópia de texto selecionado preserva `*negrito*`.
- **Tema:** fundo branco, vermelho/verde, fonte Plus Jakarta Sans carregada localmente.
- **Continuar do último plantão:** pergunta Sim/Não; "Não" abre em branco; "Sim" copia tudo para revisão (13 setores "Revisar", contador 0/13); relatório não leva dado não confirmado; confirmar sobe o contador e abre o próximo; 12 confirmações seguidas levam ao relatório; plantão original intacto; atalhos de enfermeiros recentes.
- **Seletor e progresso:** lista de 13 setores, salto direto, contador e barra (100% ao completar), "Próximo" pulando setores prontos, botões − e +.
- **Mantidos da v1.0:** 13 setores e todas as perguntas, condicionais, zero/vazio/N/A, persistência (recarregar, fechar e reabrir, interromper ao digitar), relatório completo, PNG (1080 px, multipágina) e PDF, finalização com confirmação por profissional, edição após finalizar, backup (corrompido, formato errado, duplicado, restauração em outro perfil), falhas de armazenamento, sem rolagem horizontal em 320–430 px, toques ≥ 44 px, PWA e abertura offline (Chromium).

**NÃO testado (limitações reais do ambiente):**
- Safari no iPhone e Chrome em Android físicos; teclado virtual real; instalação na tela inicial; IndexedDB do Safari em modo privado ou após inatividade.
- Abertura real do WhatsApp e envio: o teste confirma apenas a URL/texto gerados. O app não escolhe o grupo.
- Compartilhamento nativo de imagens (sem suporte no Chromium headless; o app baixa os arquivos).
- No teste de reabertura do navegador, o download do backup foi verificado capturando o arquivo gerado (limitação do Playwright); o download real de PNG/PDF foi verificado na primeira sessão.

### Problemas encontrados nos testes e correções (v1.1)

1. Painel de Backup continuava aberto ao navegar para outra tela → painéis fecham ao trocar de tela.
2. Relatório não avisava explicitamente os setores "aguardando revisão" → aviso adicionado (tela e finalização).
3. Selo "Salvo" da faixa de progresso com área de toque de 28 px → 44 px.
4. Nomes longos quebrados no seletor de setores ("Enferma/ria") → status movido para baixo do nome.
5. Botão "Continuar: <setor>" truncado → texto com reticências; etiqueta "Revisar" redundante removida.
6. Data na Home com "De"/"Novembro" capitalizados → só a 1ª letra.

(Problemas da v1.0, já corrigidos: perda de dados ao recarregar logo após digitar, colisão de classes CSS que cortava cartões, e ajustes em telas de 320 px.)

## Limitações conhecidas

- Dados ficam **só neste aparelho e navegador** (sem sincronização). O iOS pode limpar dados de sites não instalados após longa inatividade: **instale na Tela de Início e exporte backups periodicamente**.
- Sem tela de histórico, não há como excluir plantões pela interface (eles ficam guardados em segundo plano).
- "Continuar do último plantão" usa o plantão mais recente por data/horário, independentemente de quem o preencheu.
- Duas abas editando o mesmo plantão ao mesmo tempo podem sobrescrever uma à outra (vale a última gravação).
- O PDF é composto por páginas-imagem (A4); o texto não é selecionável.
- Mensagens muito longas (> ~6.000 caracteres codificados) não cabem em um link `wa.me`: o app usa o compartilhamento nativo ou copia o texto para você colar.
- Asteriscos/underlines digitados nos campos de texto podem ser interpretados como formatação pelo WhatsApp.
- O service worker prioriza a rede e usa o cache só sem conexão; não há aviso de "nova versão disponível".

## Checklist de validação mobile (faça no seu aparelho antes do uso real)

- [ ] Abrir a URL da Vercel no Safari (iPhone) / Chrome (Android) e adicionar à Tela de Início; abrir pelo ícone.
- [ ] Criar plantão; tocar em **WhatsApp**, escolher a conversa e conferir que o texto chega **sem linhas em branco e com negrito**.
- [ ] Finalizar um plantão; iniciar outro e responder **Sim** em "Continuar a partir do último plantão": revisar, alterar e **Confirmar e seguir** em alguns setores.
- [ ] Usar o botão de setores (contador no topo) para pular para outro setor e ver a barra de progresso avançar.
- [ ] Preencher com o teclado virtual: campos numéricos abrem teclado numérico; nada fica atrás do teclado; sem zoom automático; botões − e + confortáveis com uma mão.
- [ ] Fechar o app/navegador por completo e reabrir: plantão e respostas continuam lá.
- [ ] Modo avião: o app abre e os dados aparecem.
- [ ] Relatório completo → **Copiar** → colar no WhatsApp: formatação correta.
- [ ] **Gerar imagens** (páginas legíveis, cores) e **Exportar PDF**.
- [ ] Exportar backup pela Home, e importar em outro navegador.
