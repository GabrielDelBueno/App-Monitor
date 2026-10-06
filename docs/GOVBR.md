# Integração GOV.BR: implementação e ativação

O App Monitor possui um cliente OpenID Connect com Authorization Code, PKCE S256, `state`, `nonce` e validação criptográfica RS256/JWKS. O código foi testado com um provedor OIDC isolado, incluindo rejeição de respostas adulteradas e expiradas. **Isso não confirma homologação com GOV.BR e não concede credenciamento à escola.**

A documentação oficial não pôde ser acessada no ambiente de desenvolvimento: o proxy respondeu 403 aos domínios governamentais. Os domínios necessários foram adicionados ao rascunho da política de rede. Endpoints, metadados, algoritmos, escopos e requisitos de credenciamento precisam ser conferidos contra o roteiro oficial e o cadastro aprovado antes da ativação.

Referência oficial: https://acesso.gov.br/roteiro-tecnico/

## O que a instituição precisa fornecer

Um responsável autorizado deve solicitar a integração conforme os critérios oficiais. A aceitação da escola ou instituição depende desses critérios; não é automática. Depois da aprovação, o provedor fornecerá os dados do cliente de homologação e as regras para eventual acesso à produção.

São necessários:

- Domínio HTTPS público e URL de callback cadastrada: `https://SEU-DOMINIO/auth/govbr/callback`.
- `client_id` e `client_secret` do ambiente aprovado.
- Issuer e metadados oficiais, ou confirmação de que OpenID Discovery está disponível.
- Homologação com uma conta de teste autorizada e os escopos aprovados.

Não envie `client_secret`, senhas, CPF, tokens ou chaves no chat. Guarde o segredo no provedor de hospedagem ou em arquivo privado montado como Docker secret.

## Configuração

O GOV.BR permanece desligado por padrão. Quando habilitado, o backend exige HTTPS, cookies seguros e configuração completa; configurações incorretas não abrem um acesso alternativo.

| Variável | Uso |
| --- | --- |
| `GOVBR_ENABLED` | `true` somente após configurar o cliente |
| `GOVBR_ENVIRONMENT` | `homologacao` ou `producao`; nunca misture credenciais |
| `PUBLIC_BASE_URL` | Origem HTTPS pública do App Monitor, sem caminho |
| `COOKIE_SECURE` | Deve ser `true` |
| `GOVBR_CLIENT_ID` | Identificador aprovado |
| `GOVBR_CLIENT_SECRET_FILE` | Arquivo privado com o segredo do cliente |
| `GOVBR_SUBJECT_KEY_FILE` | Arquivo privado com a chave de proteção do identificador |
| `GOVBR_ISSUER` | Issuer exato dos metadados oficiais do ambiente |
| `GOVBR_METADATA_FILE` | Opcional: JSON com metadados oficiais, quando discovery não estiver disponível |

Também são aceitas as variáveis privadas diretas `GOVBR_CLIENT_SECRET` e `GOVBR_SUBJECT_KEY`. Não coloque seus valores em arquivos versionados. Leia apenas nomes e presença ao diagnosticar configurações.

O cliente usa autenticação `client_secret_basic`, scopes `openid profile email` e ID token RS256. Esses parâmetros precisam ser confirmados na homologação; se o cadastro oficial exigir outro perfil, ajuste a implementação e repita os testes antes de publicar.

Os issuers selecionados por padrão são `https://sso.staging.acesso.gov.br` para homologação e `https://sso.acesso.gov.br` para produção. `GOVBR_ISSUER` permite informar a forma exata aprovada, inclusive a barra final. Todos os endpoints do arquivo de metadados devem usar HTTPS e a origem do ambiente selecionado. O cliente não aceita um provedor arbitrário configurado por um visitante.

O arquivo opcional de metadados deve conter ao menos `issuer`, `authorization_endpoint`, `token_endpoint` e `jwks_uri`, com os valores oficiais. Não invente esses valores. Se usar Docker, monte o arquivo como somente leitura e informe `GOVBR_METADATA_FILE` no serviço `app`.

Para gerar a chave estável de proteção sem exibi-la:

```sh
npm run govbr:key
```

O comando cria `deploy/secrets/govbr-subject-key.txt` e se recusa a sobrescrever um arquivo existente. Em `deploy/.env`, configure `GOVBR_SUBJECT_KEY_PATH` e `GOVBR_SECRET_PATH`. O client_secret deve ser salvo pelo operador em um arquivo privado no caminho indicado. Não existe segredo de demonstração para uso no serviço oficial.

Preserve a chave de proteção junto com os backups privados. Os identificadores `sub` são armazenados por HMAC-SHA256; não guardamos o CPF/identificador em texto aberto. Perder ou trocar essa chave inutiliza os vínculos existentes e exige um procedimento de migração ou novo vínculo. Trocar apenas o client_secret do GOV.BR não altera os vínculos.

## Quem pode entrar

GOV.BR confirma identidade; o cadastro da escola concede acesso. O app não cria professores automaticamente e não associa contas por coincidência de e-mail.

1. O administrador cadastra o professor na escola.
2. O professor entra com sua conta escolar e abre **Conta → Vincular minha conta GOV.BR**.
3. Ele autentica no GOV.BR e confirma o vínculo com a mesma sessão escolar ainda válida.
4. Nos próximos acessos, usa **Entrar com GOV.BR**.

Uma identidade só pode se vincular a uma conta por issuer. Um vínculo não pode ser trocado silenciosamente; TI e Administrador continuam entrando pelo método escolar. Desativar o usuário na escola bloqueia também a entrada com GOV.BR. Homologação e produção possuem issuers distintos e, portanto, vínculos separados.

A cookie de fluxo OIDC é HttpOnly, Secure e SameSite=Lax, permitindo o retorno externo. Ela dura 10 minutos e cada fluxo é consumido uma única vez. A sessão do app continua HttpOnly/Secure/SameSite=Strict. Tokens do GOV.BR não são persistidos no banco nem expostos ao frontend; o app cria a própria sessão após validar o ID token.

## Conferência antes de ativar produção

No ambiente de homologação, confira o issuer exato, discovery/metadados, chave JWKS, callback, scopes, autenticação do cliente e compatibilidade de PKCE. Teste vínculo, login, cancelamento, expiração, usuário inativo e retorno em navegador real. Só depois solicite/ative produção conforme o procedimento oficial, trocando as credenciais e o ambiente de forma consistente.

`npm test` cobre o protocolo com provedor isolado. Não use esse resultado como prova de acesso ou aprovação do GOV.BR. A conta GOV.BR não transforma as assinaturas manuscritas dos relatórios em assinaturas certificadas ICP-Brasil.
