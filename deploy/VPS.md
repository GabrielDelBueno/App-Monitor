# Publicação do App Monitor

Esta configuração prepara uma única instância com SQLite persistente, HTTPS automático via Caddy e espaço separado para backups. Ela não cria uma conta de hospedagem nem compra domínio. A publicação pública não foi executada: falta indicar servidor/provedor e domínio e fornecer o acesso de implantação pelo meio seguro do provedor.

## Antes de iniciar

Use um servidor Linux com Docker e Docker Compose v2, disco persistente e DNS para um domínio da instituição. Direcione o registro A (e AAAA somente se IPv6 estiver corretamente configurado) para o servidor e permita entrada nas portas 80 e 443. Não exponha a porta 3333. Se preferir hospedagem gerenciada, ela precisa oferecer disco persistente e suportar uma única instância; não use um plano cujo disco seja apagado a cada publicação.

No servidor, clone o repositório e use a branch `app-monitor-funcional`. Não substitua banco ou arquivos privados existentes ao atualizar o código.

```sh
cp deploy/.env.example deploy/.env
```

Edite `deploy/.env` com o domínio real e o e-mail para renovação de certificados. Deixe `GOVBR_ENABLED=false` até obter credenciamento e concluir a homologação. O Compose básico funciona sem nenhum segredo GOV.BR.

```sh
docker compose -p app-monitor --env-file deploy/.env -f deploy/compose.production.yaml build
```

Crie o primeiro administrador usando `ADMIN_EMAIL`, `ADMIN_NAME` e uma senha exclusiva `ADMIN_PASSWORD` no ambiente do terminal do servidor. Entre com os valores por um mecanismo privado, sem colocá-los no histórico de comandos ou no GitHub. Não reutilize as contas da demonstração.

```sh
docker compose -p app-monitor --env-file deploy/.env -f deploy/compose.production.yaml run --rm -e ADMIN_EMAIL -e ADMIN_NAME -e ADMIN_PASSWORD app npm run bootstrap
```

Remova `ADMIN_PASSWORD` do ambiente após a criação. O comando se recusa a sobrescrever um administrador existente. Então inicie:

```sh
docker compose -p app-monitor --env-file deploy/.env -f deploy/compose.production.yaml up -d
```

O Caddy solicita o certificado HTTPS e o renova enquanto o domínio aponta para o servidor e as portas necessárias continuam acessíveis. Valide `https://SEU-DOMINIO/health`, entre com a conta real e faça um fluxo de empréstimo com equipamentos de teste. Nunca use `npm run demo` para publicação.

O app confia em um único proxy, o Caddy, e fica acessível somente na rede Docker interna. Se mudar a topologia, revise `TRUST_PROXY` e `PUBLIC_BASE_URL`; não habilite confiança irrestrita em cabeçalhos enviados pelo usuário.

## Backups e atualização

Crie backups consistentes mesmo com o app rodando. Escolha sempre um nome novo:

```sh
docker compose -p app-monitor --env-file deploy/.env -f deploy/compose.production.yaml exec app npm run backup -- /app/backups/monitor-AAAA-MM-DD.sqlite
```

O comando inclui alterações do WAL e verifica a integridade do backup. Os backups ficam no volume `monitor-backups`; copie-os para armazenamento privado fora do servidor e defina a frequência de acordo com a operação da escola. O volume no mesmo servidor não é uma cópia de segurança contra perda do servidor.

Para restaurar, pare o app, preserve o banco anterior, coloque uma cópia validada do backup no caminho `DATABASE_PATH` e ajuste as permissões para o usuário `node`. Arquivos WAL/SHM do banco anterior devem ser preservados com ele, não misturados à restauração. Se GOV.BR estiver habilitado, restaure também a chave privada de proteção de identidade descrita no guia GOV.BR. Teste a restauração em uma instância separada antes de trocar o banco real.

Para atualizar, faça backup, atualize o código da branch e execute `up -d --build` com os mesmos nomes de projeto e volumes. Uma instância com SQLite pode ficar indisponível brevemente durante a troca. Nunca execute `down -v` no ambiente real: esse comando apaga os volumes.

## Habilitar GOV.BR posteriormente

Siga [GOVBR.md](../docs/GOVBR.md), preencha as configurações aprovadas e use o arquivo adicional `compose.govbr.yaml`:

```sh
docker compose -p app-monitor --env-file deploy/.env -f deploy/compose.production.yaml -f deploy/compose.govbr.yaml up -d --build
```

Os segredos serão montados como arquivos privados. Não envie esses arquivos, o banco, backups, logs com dados pessoais ou `.env` para o repositório.

## Estado da entrega

O código e os testes locais foram preparados. O fluxo OIDC foi testado contra um provedor de teste isolado, não contra o ambiente oficial GOV.BR. A emissão de um certificado público, DNS do domínio, acesso externo ao site e credenciamento GOV.BR dependem dos acessos da instituição. Homologação e produção são etapas distintas.
