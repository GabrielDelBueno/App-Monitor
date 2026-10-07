# APP Monitor

Aplicação de controle de dispositivos escolares baseada na interface do Protótipo V5 e nos fluxos da Sistema Real Base 1. As telas usam a API real, com SQLite na demonstração local e PostgreSQL na hospedagem. Frontend e API são servidos juntos, sem configurar CORS ou um segundo servidor.

## Requisitos

- Node.js **24 ou superior** (usa `node:sqlite`).
- npm. Para os testes de navegador, Chromium.
- Uma única instância da aplicação. Na hospedagem gratuita, PostgreSQL do Neon; localmente, SQLite em disco persistente.

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

## Publicar gratuitamente

A configuração pronta usa **Render Free + Neon Free**, com endereço HTTPS do Render e banco externo persistente. Siga [o passo a passo de publicação](deploy/README.md). Não precisa comprar domínio nem obter acesso GOV.BR.

[Iniciar configuração no Render](https://render.com/deploy?repo=https://github.com/GabrielDelBueno/App-Monitor/tree/app-monitor-funcional).

A publicação ainda não foi executada: faltam suas contas gratuitas e a configuração privada do Neon no Render. O site pode demorar para abrir após inatividade, conforme os limites dos planos Free.

## Instalar no celular pelo navegador

Abra o endereço HTTPS do seu App Monitor. O botão **Instalar App Monitor** mostra as instruções e, quando disponível, abre a instalação do navegador.

- **Android:** no Chrome, abra o menu ⋮ e escolha **Instalar aplicativo** ou **Adicionar à tela inicial**.
- **iPhone/iPad:** no Safari, toque em **Compartilhar → Adicionar à Tela de Início → Adicionar**. Se aparecer **Abrir como App**, mantenha ativado.
- **Computador:** use a opção de instalação do Chrome ou Edge na barra de endereço ou no menu.

Abra pelo ícone e use seu e-mail e senha da escola. A instalação não cria outro banco nem altera os cadastros. O app precisa de internet para consultar e registrar dados; sem conexão, apresenta uma tela de aviso. O service worker guarda somente esse aviso público e nunca armazena respostas da API, relatórios ou dados de usuários no cache offline. As páginas online são buscadas na rede para receber atualizações.

A publicação de atualizações continua pelo Render. Aguarde a nova versão ficar **Live** e reabra o app. Os testes de navegador cobrem manifesto, ícones, registro do service worker, aviso offline, retorno à conexão e ausência de dados autenticados no cache; a instalação física em Android/iOS deve ser conferida nesses aparelhos.

## Instalação local com dados reais

```sh
npm ci
cp .env.example .env
```

Edite `.env` localmente e defina `ADMIN_EMAIL`, `ADMIN_NAME` e uma `ADMIN_PASSWORD` exclusiva com pelo menos 12 caracteres. Não compartilhe nem envie esse arquivo para GitHub.

```sh
npm run bootstrap
npm start
```

Depois do bootstrap, remova `ADMIN_PASSWORD` do arquivo/ambiente. O bootstrap cria apenas o primeiro administrador e recusa sobrescrever contas existentes. O administrador cadastra professores, TI e outros administradores na tela **Usuários**. Deixar a senha em branco gera uma senha provisória, mostrada somente uma vez. Entregue-a por um canal privado. As contas criadas pelo administrador precisam trocá-la no primeiro login. **Redefinir senha** encerra as sessões do usuário e gera outra senha provisória; não há envio automático de e-mail. Cada pessoa pode alterar sua própria senha em **Conta**.

O banco padrão é `data/app-monitor.sqlite`. `DATABASE_PATH` permite indicar outro caminho; use um disco persistente. Se `DATABASE_URL` estiver definida, `npm start` e `npm run bootstrap` usam PostgreSQL com TLS verificado. Na hospedagem, `SETUP_TOKEN` permite criar o primeiro administrador pela tela de instalação; remova-o depois. `PORT` define a porta (padrão 3333). Em produção com HTTPS, defina `COOKIE_SECURE=true`. Não use a porta HTTP diretamente para acesso público.

## Cadastro dos professores e edição de usuários

Na tela de entrada, **Sou professor — criar minha conta** permite informar **nome completo**, e-mail, senha própria e confirmação. Nome e sobrenome são obrigatórios. O servidor aceita somente perfil **Professor** nessa rota; tentativas de enviar TI, Administrador ou outros campos são rejeitadas. O cadastro fica disponível depois que a escola tem um administrador e limita tentativas por endereço de rede. O e-mail é usado para login, sem envio automático nem verificação de propriedade.

O professor entra com a senha escolhida. Contas anteriores permanecem preservadas; um e-mail já cadastrado não é sobrescrito. Se o professor já tem conta, deve entrar com ela ou pedir redefinição ao administrador.

O administrador mantém **Usuários**, com **Editar** para nome, e-mail e perfil, além de desativação/reativação e redefinição de senha. Troca de e-mail ou perfil encerra as sessões da conta para aplicar o novo acesso. O administrador pode editar seu próprio nome e e-mail, mas não desativar ou retirar o perfil administrador da própria conta.

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
# Com Docker e OpenSSL, valida PostgreSQL real com TLS em contêiner temporário:
npm run test:postgres
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

Não foi feita publicação em hospedagem durante este desenvolvimento. Na opção gratuita, crie contas no Render e no Neon e siga `deploy/README.md`. Para servidor próprio com Caddy, use `deploy/VPS.md`. Recuperação por e-mail não está implementada; o administrador pode redefinir a senha pela tela.

### Backup

Pare a instância antes de copiar o banco e os arquivos auxiliares `-wal` / `-shm`, se existirem, ou use o mecanismo de backup do SQLite. Não copie apenas o arquivo principal enquanto houver gravações. Em Docker, preserve e faça backup do volume `monitor-data`; `docker compose down -v` remove os dados. Faça um teste de restauração antes de usar dados reais.

## Autenticação e limites desta versão

- E-mail e senha; senhas armazenadas com scrypt e salt aleatório. Sessões de 8 horas em cookies HttpOnly/SameSite, sem token em localStorage. Tentativas de login são limitadas por origem de rede, com contador em memória (reinicia com o processo).
- Cada professor acessa apenas seus agendamentos, movimentações e notificações. TI gerencia equipamentos e empréstimos; apenas o administrador gerencia usuários e consulta auditoria.
- As assinaturas são manuscritas associadas à conta e ao horário. **Não são certificadas ICP-Brasil.** O servidor valida o formato PNG; não consegue provar que o desenho corresponde à assinatura civil.
- GOV.BR: o cliente OIDC está implementado e testado com provedor isolado, mas **a homologação oficial e a ativação continuam pendentes**. Exigem credenciamento e credenciais da instituição. Veja `docs/GOVBR.md`.
- Recuperação de senha por e-mail, importação em lote e integração com sistemas escolares ainda não estão implementadas.
- PostgreSQL é usado quando `DATABASE_URL` está definida, sem Prisma. SQLite continua disponível para execução local. O modelo original foi preservado em `docs/modelo-original.prisma` como referência. Esta implantação usa uma única instância e serializa as operações para proteger as validações do fluxo.

## Publicação com HTTPS e ativação GOV.BR

Consulte [o guia de publicação](deploy/README.md) e [o guia GOV.BR](docs/GOVBR.md). Não publique contas de demonstração. A integração oficial permanece desligada até haver credenciamento e homologação.

## Estrutura

- `frontend/`: interface responsiva baseada na V5, com estados reais, tema, câmera e impressão.
- `backend/src/server.js`: API, autenticação, autorização e regras.
- `backend/src/database.js`: esquema SQLite, transações e senhas.
- `backend/src/postgres.js`: PostgreSQL, migração inicial e transações.
- `render.yaml`: publicação gratuita sem disco local.
- `backend/src/bootstrap.js`: primeiro administrador.
- `backend/src/demo.js`: demonstração local isolada.
- `tests/`: testes de integração e navegador.

As versões ZIP originais não foram alteradas.

### Build atrás de um proxy com CA própria

Em redes que exigem um proxy e uma autoridade certificadora adicional, o Dockerfile aceita a CA via secret de build, sem incorporá-la à imagem. Passe `HTTP_PROXY`, `HTTPS_PROXY` e `NO_PROXY` com os mecanismos de build do Docker e o arquivo confiável como `--secret id=npm_ca,src=/caminho/ca.pem`. Dependendo da rede, o hostname do proxy também precisa ser resolvido dentro do build. Não desative a verificação TLS.
