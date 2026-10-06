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
