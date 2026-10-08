# Abrir o App Monitor com sua própria tela de conexão

O backend gratuito do Render continua dormindo após inatividade. A interface estática abre sem aguardar esse backend e mostra o logo AM com **Conectando ao servidor…**. A primeira consulta ao banco ainda pode demorar. Não se usa um monitor externo para manter o serviço artificialmente acordado.

O projeto atual é HTML/CSS/JavaScript; não é necessário migrá-lo para Vite. `npm run build:static` gera `public-static/` com somente arquivos públicos, incluindo o leitor QR local. Não copia banco, senhas, configuração privada ou código do servidor.

## 1. Atualizar o backend existente

No Render, abra o serviço **app-monitor** e execute **Manual Deploy → Deploy latest commit** da branch **app-monitor-funcional**. Aguarde **Live**. Mantenha o projeto do Neon e **DATABASE_URL** exatamente como estão. Não exclua o serviço existente, não crie outro banco e não restaure um banco de demonstração.

Essa atualização acrescenta a tela de conexão e o reconhecimento de uma origem estática explícita. O endereço antigo continua funcionando, mas ainda pode exibir a página do Render antes de entregar a interface; é necessário usar o novo endereço do próximo passo para evitar essa página.

## 2. Criar somente a nova interface estática

No Render, use **New → Blueprint** e selecione `GabrielDelBueno/App-Monitor`.

Preencha:

| Campo | Valor |
|---|---|
| Blueprint Name | `app-monitor-interface` |
| Branch | `app-monitor-funcional` |
| Blueprint Path | `deploy/render-static.yaml` |

Crie esse **novo Blueprint separado**, mantendo o Blueprint e o serviço anteriores. O arquivo cria apenas um Static Site, não outro backend ou banco. Revise para confirmar que não há recurso pago. Não copie DATABASE_URL, SETUP_TOKEN, senhas ou credenciais para o site estático.

A configuração usa:

- Build Command: `npm ci --omit=dev && npm run build:static`.
- Publish Directory: `public-static`.
- Node 24.
- Rewrite `/api/*` → `https://app-monitor-iuz8.onrender.com/api/*`, mantendo a URL da interface no navegador.
- Rewrite `/auth/*` → o mesmo backend; GOV.BR continua desligado na implantação escolhida.
- Cache-Control `no-store` para respostas de `/api/*`.

As regras são **Rewrite**, não Redirect. Mudar para Redirect envia o navegador ao backend e prejudica a proposta e os cookies. Não coloque uma URL de API externa no JavaScript do frontend: as chamadas permanecem na mesma origem da interface, preservando cookies HttpOnly/SameSite.

A configuração usa o endereço de backend que você informou. Se mudar esse endereço no futuro, atualize as duas regras de destino no arquivo.

## 3. Autorizar o novo endereço no backend

Quando o Static Site ficar **Live**, copie seu novo endereço HTTPS completo. Ele pode receber um sufixo automático; use o endereço efetivamente mostrado pelo Render.

No serviço antigo **app-monitor → Environment**, acrescente:

- **Key:** `FRONTEND_ORIGIN`
- **Value:** o endereço HTTPS da nova interface, sem caminho, por exemplo `https://NOME-REAL.onrender.com`.

Salve e aguarde a atualização do backend. Não mude **DATABASE_URL** nem o banco. O backend passa a aceitar requisições originadas desse endereço exato, além do endereço original. Não use `*`, listas de domínios ou uma URL inventada.

## 4. Conferir e passar a usar o novo endereço

1. Abra o novo site. Deve aparecer a tela AM enquanto o backend conecta, seguida do login.
2. Entre com sua conta existente. Abra Usuários/inventário e confira seus registros.
3. Recarregue a página para verificar que a sessão permanece autenticada. Saia e confira que o logout funciona.
4. Depois de um período sem uso, abra o novo endereço novamente: a interface deve permanecer visível durante a espera, sem navegar para a página de carregamento do backend.
5. Compartilhe o **novo endereço** com professores/TI e reinstale o atalho/app a partir dele. O atalho antigo aponta para o serviço antigo. As contas e os registros são os mesmos, mas é necessário entrar na nova origem.

Se a tela de conexão nunca avançar, confira o destino e o tipo das regras. Se o login retornar **Origem não autorizada**, confira **FRONTEND_ORIGIN**. Se o login não persistir ou houver respostas pessoais em cache, interrompa o uso da interface nova e revise o encaminhamento de Set-Cookie e Cache-Control antes de disponibilizá-la à escola; o endereço original continua disponível.

## Validação realizada e limites

O teste Chromium usa uma interface estática separada e um proxy de mesma origem. Simula a página HTML do Render na primeira tentativa, confirma que somente a tela AM fica visível e verifica login, cookies, recarregamento, logout e rejeição de origem não autorizada. Também passaram os testes de contas, PWA e fluxo escolar.

A publicação efetiva do novo Static Site, o encaminhamento e os cookies na infraestrutura real do Render precisam ser conferidos após criar o serviço. A configuração usa as regras documentadas em [Redirects/Rewrites](https://render.com/docs/redirects-rewrites) e [Static Sites](https://render.com/docs/static-sites). O código não elimina o tempo de inicialização do backend nem garante disponibilidade acima dos limites gratuitos.

GOV.BR não é ativado por essa mudança. Uma ativação futura precisa usar o endereço correto de callback e passar por homologação própria antes do uso.
