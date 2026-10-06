# Colocar o App Monitor no ar gratuitamente

A opção preparada é **Render Free para o site + Neon Free para o banco PostgreSQL**. O endereço HTTPS fornecido pelo Render dispensa comprar domínio. Os dados ficam no Neon e sobrevivem a reinícios e atualizações do site. O acesso usa e-mail e senha; GOV.BR fica desligado.

O código está na branch **app-monitor-funcional**. A publicação pública ainda depende de criar suas contas e configurar o banco no painel privado do Render. Nenhuma conta desses serviços foi criada por este projeto.

## 1. Criar o banco no Neon

1. Abra [Neon](https://console.neon.tech/) e crie sua conta, usando seu GitHub se preferir.
2. Escolha o plano **Free** e crie um projeto chamado `app-monitor`. Para esta configuração, escolha uma região dos EUA próxima da hospedagem em Oregon, se disponível.
3. Abra **Connect** e copie a **connection string** PostgreSQL. Ela começa com `postgresql://` e contém uma senha. Use o endereço de conexão direta; com uma única instância e até cinco conexões não precisamos do pooler externo.
4. Guarde esse valor para o próximo passo. **Não envie a connection string no chat, em screenshots ou no GitHub.**

Não crie um banco Free no Render: na documentação consultada em 06/10/2026, ele expira depois de 30 dias. O Neon Free não é um teste com essa expiração.

## 2. Criar o site no Render

Abra [a configuração pronta de publicação](https://render.com/deploy?repo=https://github.com/GabrielDelBueno/App-Monitor/tree/app-monitor-funcional).

1. Crie sua conta no Render e conecte o GitHub, autorizando o repositório `GabrielDelBueno/App-Monitor`.
2. Confira a branch **app-monitor-funcional**. O Render deve carregar o arquivo `render.yaml` dessa branch.
3. Confira que o serviço está no plano **Free**, sem disco e sem banco do Render. A configuração usa Docker e uma única instância.
4. No campo **DATABASE_URL**, cole a connection string que você copiou do Neon. Esse campo deve ficar privado no painel do serviço.
5. Inicie a publicação. Espere o serviço aparecer como **Live** e abra o endereço HTTPS fornecido pelo Render, como `https://nome-do-servico.onrender.com`.

Se a configuração pronta não abrir, entre no painel do Render, use **New → Blueprint**, escolha o repositório e a branch indicados acima e mantenha `render.yaml` como caminho da configuração.

O Render gera automaticamente **SETUP_TOKEN**, um código privado para criar o primeiro administrador. `RENDER_EXTERNAL_URL` é fornecido pelo próprio Render e permite validar a origem do site. Não precisa preencher `PUBLIC_BASE_URL` para o endereço padrão. Se futuramente mudar para um domínio próprio, defina essa variável com a origem HTTPS do domínio.

## 3. Criar seu administrador

1. No painel do serviço no Render, abra **Environment** e consulte o valor privado de **SETUP_TOKEN**. Não compartilhe esse código.
2. Ao abrir o site pela primeira vez, aparecerá **Configuração inicial**.
3. Preencha o código, seu nome, seu e-mail e uma senha própria de pelo menos 12 caracteres.
4. Após criar o administrador, remova **SETUP_TOKEN** do painel e salve a alteração. Não é mais necessário; a API também recusa outra instalação quando já existe administrador.

Esse banco começa vazio. Os usuários e tablets fictícios que você testou no computador não são copiados para a escola.

## 4. Cadastrar professores e TI

Entre como administrador e abra **Usuários**. Informe nome, e-mail e perfil: **Professor**, **TI** ou **Administrador**. Pode deixar a senha em branco para gerar uma senha provisória automaticamente.

A senha aparece uma única vez após o cadastro. Copie e entregue à pessoa por um canal privado. No primeiro login, ela precisa escolher uma nova senha antes de usar o app. O sistema usa o e-mail como identificação, mas não envia mensagens automaticamente nem verifica a propriedade desse e-mail.

Se alguém esquecer a senha, use **Redefinir senha** na lista de usuários. Isso encerra as sessões daquela conta e gera outra senha provisória. O usuário deve trocá-la novamente. Você altera sua própria senha em **Conta**.

Cadastre os equipamentos no inventário e faça um empréstimo de teste completo. Confira também o endereço do site com `/health` no final: ele deve responder `ok: true`. Feche e reabra o site e confirme que os registros continuam presentes.

## Limites gratuitos

Os planos Free têm limites de uso. Segundo [Render](https://render.com/docs/free) e [Neon](https://neon.com/pricing), consultados em 06/10/2026:

- O site no Render dorme após cerca de 15 minutos sem uso e pode levar aproximadamente um minuto para abrir novamente.
- O Neon também suspende o processamento após inatividade; os dados permanecem no banco.
- Ao atingir as cotas gratuitas, o serviço pode ficar indisponível até a renovação da cota. Acompanhe **Usage** nos dois painéis; não ative plano pago ou upgrade automático.
- Arquivos gravados no disco do Render são temporários. Os usuários, equipamentos, movimentações e assinaturas do app são gravados no PostgreSQL, não nesse disco.

A disponibilidade e os limites dependem dos provedores. Essa configuração mantém o custo gratuito enquanto você permanece dentro dos planos e cotas Free.

## Atualizações e cópias do banco

Publicações futuras devem manter a mesma **DATABASE_URL** e o mesmo projeto do Neon. Não exclua o projeto ou banco ao atualizar o código. A estrutura das tabelas é inicializada de forma repetível, preservando os registros existentes.

Para uma cópia independente, use `pg_dump` da versão do PostgreSQL do Neon ou superior em um computador privado. Configure `PGHOST`, `PGUSER`, `PGDATABASE` e `PGPORT=5432` com os dados indicados em **Connect**, e `PGSSLMODE=verify-full`. Não inclua a senha no comando: `-W` solicita a senha sem exibi-la.

```sh
pg_dump -W --format=custom --no-owner --no-acl --file=monitor-AAAA-MM-DD.dump
```

Guarde o arquivo fora do GitHub e teste a restauração num banco separado e vazio. Com as variáveis acima apontando para esse banco separado:

```sh
pg_restore -W --no-owner --no-acl --dbname="$PGDATABASE" monitor-AAAA-MM-DD.dump
```

Esses comandos de exemplo são para Bash. O arquivo contém dados da escola e precisa ficar em armazenamento privado. O comando `npm run backup` do projeto é exclusivo da instalação SQLite local; ele não exporta o Neon. O teste automatizado valida rollback e reabertura do PostgreSQL local, mas um backup/restauração no seu projeto real precisa ser verificado depois da publicação.

A alternativa de servidor próprio com SQLite e Caddy está em [VPS.md](VPS.md). Ela exige servidor e, em geral, custos; não é o caminho gratuito recomendado aqui.
