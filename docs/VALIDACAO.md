# Validação — 6 de outubro de 2026

- `npm ci`: instalação reproduzível pelo lockfile concluída com Node 24.
- `npm run check`: JavaScript do servidor e da interface validado.
- `npm test`: **21 testes passaram**, nenhum falhou ou foi ignorado. Inclui cadastro inicial, senhas provisórias para todos os perfis, troca obrigatória, redefinição e revogação de sessões, fluxo de empréstimos, backup SQLite e OIDC com provedor isolado.
- `npm run test:postgres`: **11 testes passaram**, nenhum falhou ou foi ignorado. Usa PostgreSQL 17 real em contêiner temporário, com TLS e uma CA privada de teste confiável. Verifica autenticação, perfis, inventário, empréstimos, extras, devolução, assinaturas, persistência ao reabrir, rollback, transações concorrentes, inicialização repetível e rejeição de certificado não confiável.
- `npm run test:e2e`: **2 testes passaram** no Chromium. Cobre criação do administrador, cadastro com senha gerada, troca obrigatória, redefinição e ciclo escolar completo pelas telas, QR, duas assinaturas, relatório e layout móvel.
- `npm audit --omit=dev`: nenhuma vulnerabilidade reportada nas dependências de produção.
- Docker: imagem de produção construída com verificação TLS mantida e dependências pelo lockfile.
- `npm run test:deployment`: HTTPS local com Caddy passou, com certificado verificado pela CA de teste, cookies Secure, login, API autenticada e backup/restauração SQLite.
- Planos de hospedagem consultados nas páginas oficiais do Render e Neon: Render Free tem disco temporário; Neon Free é permanente, sujeito a cotas. `render.yaml` usa banco externo e não solicita plano ou disco pago.

A aplicação fica em uma única instância. PostgreSQL é selecionado por `DATABASE_URL`; a demonstração continua isolada em SQLite. O projeto não copia contas ou equipamentos fictícios para a hospedagem.

**Ainda não executados:** publicação em contas reais Render/Neon, conexão ao banco real da escola, acesso público/HTTPS do endereço fornecido pelo Render, backup/restauração desse banco real, câmera física e homologação GOV.BR. GOV.BR permanece desligado por padrão; o usuário escolheu o acesso administrado por e-mail e senha. Não há alegação de assinatura certificada.

As instruções de instalação e inicialização do ambiente Codex foram salvas em rascunho. Salvar esse rascunho não publica o site, e a restauração em uma nova tarefa da plataforma não foi validada.

## Atualização: instalação pelo navegador

`npm run check` e os 21 testes de integração passaram. Os 3 testes Chromium passaram, incluindo o novo teste de manifesto/ícones, instruções de instalação, service worker, aviso offline, retorno à conexão e comprovação de que apenas `/offline.html` fica no cache. Nenhum banco ou cadastro foi alterado para essa atualização. A instalação física em Android/iPhone e a atualização do serviço público no Render ainda precisam ser conferidas nos aparelhos e no painel do provedor.

## Atualização: autocadastro de professores

22 testes de integração e 4 testes Chromium passaram. O novo fluxo exige nome completo, permite somente Professor no cadastro público, rejeita campos de perfil privilegiado e e-mails duplicados, e impede professores de editar usuários. A edição administrativa de nome/e-mail, a revogação de sessões e a desativação foram verificadas. O navegador percorreu cadastro público e edição pelo administrador. Nenhuma migração ou exclusão de registros é necessária.

## Atualização: interface estática e tela de conexão

`npm run build:static` e `npm run check` passaram. Passaram os 22 testes de integração e os 5 testes Chromium. O novo teste usa frontend separado, simula HTML do cold start na API e verifica tela AM, recuperação, login com cookie, sessão após recarregar, logout e bloqueio de origem externa não autorizada. Nenhum registro do banco foi migrado ou excluído. O novo Static Site e o encaminhamento real do Render ainda precisam ser publicados e verificados no provedor.

## Atualização: leitor QR e códigos de barras

`npm run check`, 22 testes de integração e os 8 testes Chromium da suíte completa passaram. Depois, os 4 testes específicos do leitor passaram, incluindo um teste adicional de detecção nativa simulada que mantém a câmera após código recusado. Imagens reais de QR e Code 39 foram decodificadas pelo ZXing usando vídeo de canvas; o encerramento das trilhas de câmera, inclusive após fechamento durante permissão pendente, foi verificado. Os demais formatos configurados não foram exercitados individualmente. O intervalo de tentativas do ZXing foi reduzido de 500 para 120 ms; velocidade e foco em câmera física ainda precisam ser medidos no celular. Nenhuma migração ou exclusão de dados. Publicação no Render depende da atualização do Static Site.

## Atualização: mira central da câmera

A janela continua com 330 px de altura. A moldura central ocupa 80% da largura e 60% da altura, com linha vermelha horizontal. Os dois leitores recebem apenas o recorte correspondente à moldura, compensando `object-fit: cover`, sem ampliar a imagem. A suíte completa de 9 testes Chromium e a verificação de sintaxe passaram; o teste adicional de exclusão de QR fora da moldura foi executado separadamente. A versão anterior é `ef6911a`, permitindo desfazer somente esta mudança sem restaurar ou excluir dados do banco. O comportamento com etiquetas físicas próximas ainda deve ser conferido no celular.

## Atualização: inventário escolar e números de série

A planilha .xls fornecida é uma tabela HTML UTF-8 com 445 registros. Foram selecionados 201 com status Disponível: Tablet 124, Notebook Sala de Aula 45, Notebook Básico Educacional 7 e Smartphone 25. Há 2 selecionados sem série; não há duplicatas de série não vazia ou de controle interno entre os selecionados. Nenhuma linha Danificado ou Inservível entra na importação. A disponibilidade e avaliação técnica são as declaradas na planilha, não uma inspeção física.

Passaram a verificação de sintaxe, 24 testes Node, 14 testes do executor PostgreSQL com TLS verificado e 12 testes Chromium, incluindo a importação dos 201 aparelhos reais em SQLite isolado. Foram verificados prévia sem gravação, seleção por categoria/status, preservação de zeros, busca e seleção por controle/série, QR alternativo, repetição sem duplicatas, autorização exclusiva do administrador, conflitos sem gravação parcial, edição dos metadados e migrações de SQLite/PostgreSQL antigos com preservação dos registros e aceitação de Celular. O teste adicional de edição e pedido de Celular foi executado após a suíte inicial.

Nenhuma informação da planilha foi incorporada ao Git ou aos arquivos públicos. Não foi acessado ou alterado o banco Neon da escola. A publicação exige atualizar primeiro app-monitor e depois app-monitor-interface; a carga do banco real é feita pelo administrador em Inventário → Importar planilha. A versão anterior com mira central está no commit 5397e1f. A mira e o recorte de leitura não foram alterados nesta atualização. A etiqueta física de barras deve conter a série ou outro identificador cadastrado; a planilha não permite determinar o conteúdo codificado ou a simbologia da etiqueta.
