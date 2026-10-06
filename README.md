# APP Monitor

Aplicação de controle de dispositivos escolares baseada na interface do Protótipo V5 e nos fluxos da Sistema Real Base 1. As telas usam a API real, com persistência em SQLite. Frontend e API são servidos juntos, sem configurar CORS ou um segundo servidor.

## Requisitos

- Node.js **24 ou superior** (usa `node:sqlite`).
- npm. Para os testes de navegador, Chromium.
- Disco persistente para o banco. A aplicação funciona em uma única instância; múltiplas réplicas exigem adaptar a persistência para PostgreSQL.

## Experimentar com dados fictícios

Na raiz do repositório:

```sh
npm ci
npm run demo
```

A demonstração atende na porta 3333, apenas na interface de loopback. Contas exclusivas da demonstração:

| Perfil | E-mail | Senha de demonstração |
| --- | --- | --- |
| Administrador | admin@demo.local | Demo-Monitor-2026! |
| TI | ti@demo.local | Demo-Monitor-2026! |
| Professor | professor@demo.local | Demo-Monitor-2026! |

O banco `data/demo.sqlite` é separado do banco real. Na primeira execução são criadas três contas e 30 tablets, incluindo um em manutenção. Execuções seguintes preservam os dados. **Não publique a demonstração nem use essas contas com dados reais.**

## Instalação com dados reais

```sh
npm ci
cp .env.example .env
```

Edite `.env` localmente e defina `ADMIN_EMAIL`, `ADMIN_NAME` e uma `ADMIN_PASSWORD` exclusiva com pelo menos 12 caracteres. Não compartilhe nem envie esse arquivo para GitHub.

```sh
npm run bootstrap
npm start
```

Depois do bootstrap, remova `ADMIN_PASSWORD` do arquivo/ambiente. O bootstrap cria apenas o primeiro administrador e recusa sobrescrever contas existentes. O administrador cadastra professores e TI na tela **Usuários**. Cada pessoa pode alterar a própria senha em **Conta**.

O banco padrão é `data/app-monitor.sqlite`. `DATABASE_PATH` permite indicar outro caminho; use um disco persistente. `PORT` define a porta (padrão 3333). Em produção com HTTPS, defina `COOKIE_SECURE=true`. Não use a porta HTTP diretamente para acesso público.

## Fluxo operacional

1. Cadastre professores, TI e equipamentos. A tela de inventário gera etiquetas QR para impressão.
2. O professor solicita entre 1 e 25 dispositivos para uma data entre hoje e os próximos 14 dias. Datas são interpretadas no fuso `America/Sao_Paulo`.
3. TI aprova e libera a quantidade exata no dia agendado. Equipamentos em uso, manutenção ou quebrados não podem ser liberados. A seleção pode usar câmera, leitor USB, entrada manual ou caixas de seleção. A câmera requer HTTPS ou um contexto local autorizado.
4. O professor associa alunos a todos os aparelhos. Pode fazer um único pedido extra de até 5 aparelhos; TI libera esses extras separadamente.
5. O professor envia o relato obrigatório de devolução. Até a conferência física, os aparelhos continuam indisponíveis.
6. TI confere todos os itens e registra comentários quando o estado muda. A conferência atualiza o inventário e libera os aparelhos em bom estado para outras aulas.
7. Professor e TI assinam pela própria conta. O relatório é concluído quando tem as duas assinaturas. Um professor com relatório conferido e ainda sem sua assinatura fica impedido de criar pedidos ou receber novas liberações.
8. Consulte o histórico e use **Imprimir / salvar PDF** para exportar pelo diálogo de impressão do navegador.

Pedidos podem ser editados ou cancelados antes da liberação; editar exige nova aprovação. A exclusão de equipamento é lógica, preservando os registros anteriores. Usuários podem ser desativados pelo administrador, encerrando suas sessões. A auditoria registra ações administrativas e operacionais.

## Verificação

```sh
npm run check
npm test
npm run test:e2e
```

Os testes de integração usam bancos temporários e cobrem autenticação, acesso por perfil, QR, inventário, agendamento, liberação atômica, extras, devolução, assinaturas, notificações e persistência. O teste de navegador percorre o fluxo real pelas telas, verifica assinaturas e layout móvel, usando banco em memória.

Os testes de navegador usam `/usr/bin/chromium` por padrão. Para outro executável:

```sh
CHROMIUM_PATH=/caminho/do/chromium npm run test:e2e
```

A câmera física não é exercitada automaticamente. A leitura usa `@zxing/browser`, servida localmente; não depende de CDN.

## Publicação com Docker

O `Dockerfile` fornece uma execução sem dependências de desenvolvimento. O `compose.yaml` mantém o banco em volume persistente e expõe a porta somente localmente para um proxy HTTPS.

```sh
docker compose build
docker compose run --rm -e ADMIN_EMAIL -e ADMIN_NAME -e ADMIN_PASSWORD app npm run bootstrap
docker compose up -d
```

Antes do bootstrap, defina as três variáveis no seu ambiente de forma segura. Configure um proxy reverso HTTPS no domínio escolhido, encaminhando para a porta 3333 e preservando o cabeçalho `Host`. O compose já define cookies seguros, portanto o login via HTTP direto não é o fluxo de produção. O endpoint `GET /health` verifica acesso ao banco.

Não foi feita publicação em hospedagem durante este desenvolvimento. Domínio, TLS, volume persistente, backups e e-mail de recuperação precisam ser definidos para a implantação da escola.

### Backup

Pare a instância antes de copiar o banco e os arquivos auxiliares `-wal` / `-shm`, se existirem, ou use o mecanismo de backup do SQLite. Não copie apenas o arquivo principal enquanto houver gravações. Em Docker, preserve e faça backup do volume `monitor-data`; `docker compose down -v` remove os dados. Faça um teste de restauração antes de usar dados reais.

## Autenticação e limites desta versão

- E-mail e senha; senhas armazenadas com scrypt e salt aleatório. Sessões de 8 horas em cookies HttpOnly/SameSite, sem token em localStorage. Tentativas de login são limitadas por origem de rede, com contador em memória (reinicia com o processo).
- Cada professor acessa apenas seus agendamentos, movimentações e notificações. TI gerencia equipamentos e empréstimos; apenas o administrador gerencia usuários e consulta auditoria.
- As assinaturas são manuscritas associadas à conta e ao horário. **Não são certificadas ICP-Brasil.** O servidor valida o formato PNG; não consegue provar que o desenho corresponde à assinatura civil.
- GOV.BR **não está integrado**: exige credenciamento e configuração oficial. A simulação de entrada foi removida.
- Recuperação de senha por e-mail, importação em lote e integração com sistemas escolares ainda não estão implementadas.
- PostgreSQL/Prisma não são usados nesta execução. O modelo recebido foi preservado em `docs/modelo-original.prisma` como referência, sem migrações executáveis. SQLite simplifica o primeiro uso; uma implantação com várias instâncias precisará da migração de banco.

## Estrutura

- `frontend/`: interface responsiva baseada na V5, com estados reais, tema, câmera e impressão.
- `backend/src/server.js`: API, autenticação, autorização e regras.
- `backend/src/database.js`: banco, transações e senhas.
- `backend/src/bootstrap.js`: primeiro administrador.
- `backend/src/demo.js`: demonstração local isolada.
- `tests/`: testes de integração e navegador.

As versões ZIP originais não foram alteradas.

### Build atrás de um proxy com CA própria

Em redes que exigem um proxy e uma autoridade certificadora adicional, o Dockerfile aceita a CA via secret de build, sem incorporá-la à imagem. Passe `HTTP_PROXY`, `HTTPS_PROXY` e `NO_PROXY` com os mecanismos de build do Docker e o arquivo confiável como `--secret id=npm_ca,src=/caminho/ca.pem`. Dependendo da rede, o hostname do proxy também precisa ser resolvido dentro do build. Não desative a verificação TLS.
