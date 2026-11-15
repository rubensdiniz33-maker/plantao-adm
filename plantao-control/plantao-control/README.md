# PLANTÃO ADM — versão 2.1

Gerenciador de plantão administrativo hospitalar, mobile-first (PWA), sem backend, sem login e sem serviços externos.
**Prioridade de uso:** o objetivo final é **Copiar** o relatório ou **encaminhá-lo ao WhatsApp** — esses são os dois botões principais (fixos no rodapé do relatório). Imagem/PDF são secundários.
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
| `index.html`, `css/styles.css` | Entrada e estilos (tema claro vermelho/verde, mobile-first) |
| `js/sectors.js` | Dados dos 13 setores, perguntas, regras condicionais, estados e ocorrências |
| `js/validation.js` | Validação de plantão, respostas e arquivos de backup |
| `js/storage.js` | IndexedDB (com aviso explícito se indisponível) |
| `js/report.js` | Mensagem de apresentação e relatório (texto WhatsApp, modelo estruturado) |
| `js/export.js` | Copiar, WhatsApp (`wa.me`), imagens PNG multipágina, PDF |
| `js/formconfig.js`, `form-config.json`, `tools-hash.mjs` | Edição do formulário, senha do admin e arquivo publicado com a configuração |
| `js/app.js`, `js/ui.js` | Telas, rotas, salvamento automático, componentes |
| `manifest.webmanifest`, `sw.js`, `icons/` | PWA |
| `fonts/` | Plus Jakarta Sans (local; licença OFL em `PLUS-JAKARTA-LICENSE.txt`) |
| `tests/` | Testes unitários (Node) e de ponta a ponta (Playwright/Chromium) |

## Novidades da versão 2.1

- **Ocorrências relevantes em todos os 13 setores** (campo de texto opcional, último de cada setor; preenchido de verdade, ele marca o setor com ocorrência).
- **Relatório final:** uma **linha em branco entre os setores** (dentro do setor continua sem espaços) e **sem enfermeiro e horário** (já vão na mensagem de apresentação). Imagem/PDF também.
- **Relatório abre na exibição do WhatsApp** (negrito real, sem asteriscos); o texto cru fica na aba **Editar texto**.
- **Editar o formulário (admin):** ícone de ajustes no canto da Home → senha → renomear, remover/restaurar e adicionar perguntas em cada setor (Sim/Não/N/A, número, texto curto ou longo; opcional ou não). Perguntas novas entram antes de "Ocorrências relevantes". Remover uma pergunta **não apaga respostas já registradas**; se remover uma pergunta "pai", as condicionais dela somem junto.
- **Crédito discreto:** "Desenvolvido por Enfermeiro Rubens Diniz" no rodapé da Home e do admin.

### Senha e alcance das alterações do formulário

- **Senha inicial: `hc2026`** (não diferencia maiúsculas). Ela é só uma **trava de uso**: o app é estático e sem servidor, então quem inspecionar o código consegue contorná-la. Não use como segurança forte.
- **Trocar a senha:** `node tools-hash.mjs NOVA_SENHA` imprime um código; cole-o em `ADMIN_HASH` no arquivo `js/formconfig.js` e publique de novo.
- **As alterações ficam no aparelho em que foram feitas.** Para valerem para todos: no admin toque em **Exportar**, substitua o arquivo `form-config.json` da raiz do projeto pelo exportado e publique na Vercel. Cada aparelho usa a versão mais nova entre o arquivo publicado e a edição local. "Restaurar formulário padrão" limpa a edição do aparelho.
- Relatórios de plantões antigos passam a usar o formulário atual ao serem reabertos (perguntas removidas deixam de aparecer neles).

## Novidades da versão 2.0

- **Nome:** Plantão ADM. **Favicon:** o coração do app (SVG, PNG 32 e ICO), além dos ícones de instalação.
- **Home enxuta:** só o botão grande **INICIAR PLANTÃO** (mais um atalho discreto para retomar, "Último plantão" e "Backup").
- **Próximo corrigido:** o contador mostra a **posição** (ex.: `9/13`), cada toque avança um setor, e no 13º o botão vira **Ver relatório** (sem voltar ao início).
- **Campos vazios:** aparecem como **`-`** no relatório (nada de "Não informado").
- **Formulário limpo:** topo compacto (voltar, setor, selo de salvamento, seletor `n/13`) com só um filete de progresso; avisos de ocorrência e de revisão ficam discretos **no fim** do formulário.
- **Relatório editável:** o texto fica em um campo de edição; o que estiver ali é exatamente o que **Copiar** e **Enviar no WhatsApp** usam. A edição é salva; se os setores mudarem depois, um aviso oferece "Usar dados atuais"; "Restaurar texto original" descarta a edição. A aba "Como fica no WhatsApp" mostra a prévia formatada.
- **Imagem e PDF** ficam recolhidos em "Outros formatos" e seguem os dados dos setores (não incluem texto digitado à mão).

## Como funciona

- **Fluxo:** Home → Iniciar plantão → (pergunta "Continuar a partir do último plantão?") → dados do plantão e mensagem de apresentação → Painel com os 13 setores → formulários → Relatório (editar, **Copiar / WhatsApp**) → Finalizar.
- **Continuar do último plantão (praticidade):** ao iniciar, se já existe um plantão anterior, o app pergunta *Sim/Não*. Com **Sim**, as respostas do plantão mais recente são copiadas para o novo e **todos os setores entram como "Revisar"**. Em cada setor o enfermeiro vê os valores já preenchidos, altera só o que mudou e toca **Confirmar e seguir**, que já abre o próximo setor pendente. **Dado copiado e não confirmado nunca entra no relatório** (sai com "-" e é avisado), para não enviar informação velha. O plantão original não é alterado.
- **Seletor de setores:** no formulário, o botão com a posição (ex.: `5/13`) abre a lista dos 13 setores com o estado de cada um, para pular direto para qualquer setor (a lista mostra "X de 13 preenchidos"). **Próximo** segue a ordem; no último setor leva ao relatório. No Painel, **Continuar** abre o próximo setor ainda pendente.
- **Estados do setor:** cinza (não iniciado), azul (em preenchimento / revisar), verde (preenchido). **Ocorrência** (âmbar) é independente do preenchimento.
- **Campos:** Sim / Não / N/A (não se aplica) / vazio = **`-`** no relatório. Vazio nunca vira 0 ou "Não"; `0` é resposta válida. Campos numéricos têm botões − e + e aceitam só dígitos.
- **Mensagens para WhatsApp:** sem linhas em branco entre os itens; títulos e perguntas em *negrito* (`*texto*`), campo vazio como `-`. Ao copiar texto selecionado da prévia, o app devolve a sintaxe do WhatsApp (os asteriscos).
- **Relatório parcial:** a finalização nunca é bloqueada por campos vazios; eles aparecem como `-` e são listados antes de finalizar.
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
npm test                              # 28 testes de lógica (Node)
node tests/serve.mjs 5173 &           # servidor
python3 tests/e2e.py                  # 156 verificações no Chromium (Playwright)
CSP=1 node tests/serve.mjs 5174 &     # mesma suíte sob os cabeçalhos/CSP do vercel.json:
BASE_URL=http://localhost:5174 python3 tests/e2e.py
```

### Relatório de testes executados (14/11/2026, versão 2.1)

**Versão 2.1 — executado e aprovado** (28/28 unitários e 156/156 de ponta a ponta, também sob a CSP da Vercel): ocorrências relevantes nos 13 setores; 13 linhas em branco só entre setores; relatório sem enfermeiro/horário; abertura em modo WhatsApp sem asteriscos; crédito e ícone de admin na Home; senha errada recusada / correta aceita / sair tranca; remover, renomear e adicionar pergunta refletidos no formulário e no relatório; persistência ao recarregar; exportar/importar/restaurar a configuração; respostas de perguntas removidas preservadas; 320 px sem rolagem horizontal.
**Não testado na 2.1:** aparelho real; o fluxo "publicar `form-config.json` na Vercel e abrir em outro aparelho" (testei exportar e importar o arquivo, não a publicação).

#### Resultado da versão 2.0

**Executados e aprovados** (Chrome headless emulando iPhone 390×844, toque e `pt-BR`; 24/24 unitários e 131/131 de ponta a ponta, também sob a CSP do `vercel.json`):
- **Revisão 2:** nome e favicon declarados e acessíveis; Home com botão ≥ 80 px e poucos elementos; contador por posição 8/13→13/13 na Enfermaria SUS, setores em ordem, e Próximo no 13/13 abrindo o relatório; campos vazios com `-` e nenhuma ocorrência de "Não informado"; cabeçalho do formulário ≤ 72 px, primeiro campo no topo e avisos de ocorrência/revisão no fim; relatório editável (Copiar e WhatsApp enviam exatamente o texto editado, edição persiste ao recarregar, aviso de texto desatualizado, usar dados atuais, restaurar original, texto apagado); Copiar e WhatsApp fixos no rodapé, visíveis sem rolar, ≥ 56 px.
- **Mantidos:** formatação (sem linhas em branco, negrito, asteriscos balanceados); continuar do último plantão (Sim/Não, revisão, confirmar, dado não confirmado fora do relatório); 13 setores e perguntas, condicionais, zero/vazio/N/A; persistência (recarregar, fechar e reabrir, interromper ao digitar); PNG (1080 px) e PDF; finalização; backup (corrompido, formato errado, duplicado, restauração em outro perfil); falhas de armazenamento; sem rolagem horizontal em 320–430 px; toques ≥ 44 px; PWA e abertura offline (Chromium).

**NÃO testado (limitações reais do ambiente):**
- Safari no iPhone e Chrome em Android físicos; teclado virtual real (inclusive edição do texto do relatório com o teclado); instalação na tela inicial; o favicon como aparece em cada navegador/aba real; IndexedDB do Safari em modo privado ou após inatividade.
- Abertura real do WhatsApp e envio: o teste confirma apenas a URL/texto gerados. O app não escolhe o grupo.
- Compartilhamento nativo de imagens (sem suporte no Chromium headless; o app baixa os arquivos).
- No teste de reabertura do navegador, o download do backup foi verificado capturando o arquivo gerado (limitação do Playwright).

### Problemas encontrados nos testes e correções (v2.0)

1. Selo de salvamento compacto exibia a palavra "null" (visto em captura de tela) → corrigido e coberto por teste.
2. Campo de edição do relatório com fonte de 14,5 px (o iOS daria zoom ao tocar) → 16 px.
3. Selo compacto com 32 px de largura → 44 px.

## Limitações conhecidas

- A senha do admin é apenas uma trava (ver acima). Alterações do formulário são por aparelho, a menos que o `form-config.json` seja publicado.
- Imagem e PDF não incluem alterações digitadas à mão no relatório (usam os dados dos setores).

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
- [ ] Criar plantão; no relatório, editar uma linha do texto e tocar em **Enviar no WhatsApp**, escolher a conversa e conferir que o texto chega **sem linhas em branco e com negrito**.
- [ ] Finalizar um plantão; iniciar outro e responder **Sim** em "Continuar a partir do último plantão": revisar, alterar e **Confirmar e seguir** em alguns setores.
- [ ] Usar o botão de setores (contador no topo) para pular para outro setor e ver a barra de progresso avançar.
- [ ] Preencher com o teclado virtual: campos numéricos abrem teclado numérico; nada fica atrás do teclado; sem zoom automático; botões − e + confortáveis com uma mão.
- [ ] Fechar o app/navegador por completo e reabrir: plantão e respostas continuam lá.
- [ ] Modo avião: o app abre e os dados aparecem.
- [ ] Conferir o ícone/favicon do coração na aba e na tela inicial.
- [ ] Passar de 1/13 até 13/13 com **Próximo** e confirmar que o último leva ao relatório.
- [ ] Relatório completo → **Copiar** → colar no WhatsApp: formatação correta.
- [ ] **Gerar imagens** (páginas legíveis, cores) e **Exportar PDF**.
- [ ] Exportar backup pela Home, e importar em outro navegador.
