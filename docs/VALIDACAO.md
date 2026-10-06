# Validação — 6 de outubro de 2026

- `npm ci`: instalação pelo lockfile concluída.
- `npm run check`: JavaScript do servidor e da interface validado.
- `npm test`: 10 testes passaram, nenhum falhou ou foi ignorado.
- `npm run test:e2e`: 1 teste completo passou no Chromium; cobre operações reais pela interface, decodificação de etiqueta QR, duas assinaturas, relatório e layout móvel. Nenhum erro JavaScript foi observado nesse fluxo.
- `npm audit --omit=dev`: nenhuma vulnerabilidade reportada nas dependências de produção na data da execução.
- `npm run demo`: login e inventário de 30 equipamentos validados no banco de demonstração.
- Docker: imagem construída com verificação TLS mantida; health, bootstrap, login e API autenticada passaram. Dados sobreviveram ao reinício e à remoção/recriação de contêiner com volume persistente.
- `docker compose config --quiet`: configuração validada.

Não executados: câmera física, integração GOV.BR, domínio/TLS público, publicação em hospedagem ou restauração em uma nova tarefa da plataforma. Não há alegação de assinatura certificada. O rascunho do ambiente recebeu `install_script` e `start_skill`; publicar o ambiente continua sendo uma ação do usuário.
