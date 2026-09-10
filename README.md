# Ruby Live

Tela e webcam para pessoas que estão na mesma call do Discord. O usuário entra com o Discord, o bot identifica a call e o site reúne seus participantes. Cada pessoa escolhe quais transmissões assistir.

O frontend e a sinalização rodam em um Cloudflare Worker com Durable Objects SQLite. A mídia passa diretamente entre navegadores por WebRTC: não passa pela hospedagem do bot nem por um servidor de vídeo deste projeto.

## Estrutura

- `site/src`: interface, seleção de transmissões, câmeras e controles de qualidade.
- `site/worker`: login, sessões, autorização e sinalização.
- `bot/src`: bot independente e sincronização de voz;
- `site/tests`: testes de mídia, escopo de sincronização e recuo após erros.
- `scripts/check-public.cjs`: filtro complementar para preparar uma publicação.

## Requisitos

- Node.js 22.13 ou posterior e npm.
- Uma aplicação no Discord Developer Portal, com bot adicionado ao servidor.
- Conta Cloudflare com Workers e Durable Objects SQLite disponíveis.
- Hospedagem capaz de manter o processo Node do bot conectado ao Discord.
- HTTPS para a instalação pública. Domínio próprio é opcional: pode usar `workers.dev`.

## 1. Instalar

Abra o terminal na raiz deste repositório:

```sh
npm ci
```

O repositório usa npm workspaces: esse comando instala o site e o bot. Não copie `node_modules` de outra instalação.

## 2. Configurar o Discord

No [Discord Developer Portal](https://discord.com/developers/applications), crie uma aplicação e adicione um bot. Guarde três valores diferentes:

| Valor | Destino |
| --- | --- |
| Application ID | `DISCORD_CLIENT_ID` do Worker |
| OAuth2 Client Secret | `DISCORD_CLIENT_SECRET` do Worker |
| Bot Token | `DISCORD_TOKEN` do bot |

Adicione o bot ao servidor pelo instalador da aplicação, com escopo `bot` e permissão para visualizar os canais relevantes. Não é necessário Administrador, Message Content, Guild Members nem conectar o bot a uma call. O código usa os intents `Guilds` e `GuildVoiceStates`.

Em OAuth2, cadastre exatamente o redirect abaixo, substituindo a origem pela sua:

```text
https://example.com/api/auth/callback
```

O login do site pede somente `identify`. Não é o mesmo link usado para convidar o bot. Veja a [documentação OAuth2 do Discord](https://docs.discord.com/developers/platform/oauth2-and-permissions).

## 3. Configurar o Worker

Edite `site/wrangler.jsonc`:

- `name`: um nome exclusivo para a sua instalação; não reutilize o nome de outro Worker importante.
- `vars.PUBLIC_ORIGIN`: a origem HTTPS pública, sem caminho.
- `vars.ALLOWED_GUILD_IDS`: ID do seu servidor Discord. Para vários, separe por vírgula.
- `vars.MAINTENANCE_MODE`: use `true` para exibir manutenção manualmente e `false` para usar a detecção automática.

Os campos do exemplo não são credenciais funcionais. APIs retornam indisponível enquanto faltarem configurações válidas. No Discord, ative o modo desenvolvedor para copiar o ID do servidor.

Para usar `workers.dev`, a origem será `https://NOME-DO-WORKER.SEUSUBDOMINIO.workers.dev`. O painel Cloudflare informa seu subdomínio. Para domínio próprio, adicione o domínio como Custom Domain nas configurações do Worker e use essa mesma origem em `PUBLIC_ORIGIN` e no redirect OAuth.

Gere **dois segredos diferentes**, executando este comando duas vezes:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Um será `SESSION_SECRET`. O outro será `LIVE_SYNC_SECRET`, compartilhado apenas entre Worker e bot. Não use os textos `INSIRA_...` como segredo.

Dentro de `site`, autentique e cadastre os valores:

```sh
npx wrangler login
npx wrangler secret put DISCORD_CLIENT_ID
npx wrangler secret put DISCORD_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET
npx wrangler secret put LIVE_SYNC_SECRET
```

Se o Wrangler perguntar se deve criar o Worker que ainda não existe, confira o nome e confirme. Os valores são solicitados interativamente; não os inclua em comandos, commits ou prints. [Segredos no Workers](https://developers.cloudflare.com/workers/configuration/secrets/).

Volte à raiz e publique:

```sh
npm run deploy
```

O build gera a configuração final usada pelo Wrangler. Não edite `dist` manualmente nem publique apenas os arquivos estáticos: o backend do Worker é necessário. As migrations criam o Durable Object; não é preciso exportar banco de outra instalação.

## 4. Iniciar o bot

Copie `bot/.env.example` para `bot/.env`. No PowerShell:

```powershell
Copy-Item bot/.env.example bot/.env
```

Preencha o arquivo:

```dotenv
DISCORD_TOKEN=INSIRA_O_TOKEN_DO_BOT_DISCORD
LIVE_SYNC_URL=https://live.example.com/api/internal/voice-sync
LIVE_SYNC_SECRET=INSIRA_EXATAMENTE_O_MESMO_SEGREDO_DO_WORKER
LIVE_SYNC_GUILD_IDS=INSIRA_O_MESMO_ID_DE_SERVIDOR_CONFIGURADO_NO_WORKER
LIVE_SYNC_BLOCKED_CHANNEL_IDS=
LIVE_SYNC_BLOCKED_CATEGORY_IDS=
LIVE_SYNC_BROADCAST_ROLE_IDS=
LIVE_SYNC_UNRESTRICTED_CHANNEL_IDS=
LIVE_SYNC_UNRESTRICTED_CATEGORY_IDS=
```

As três últimas opções são listas de IDs separadas por vírgula:

- `LIVE_SYNC_BLOCKED_CHANNEL_IDS`: calls que não criam sala no site.
- `LIVE_SYNC_BLOCKED_CATEGORY_IDS`: categorias cujas calls, inclusive temporárias, não criam sala.
- `LIVE_SYNC_BROADCAST_ROLE_IDS`: cargos que podem transmitir tela ou câmera. Vazio mantém a transmissão liberada para todos.
- `LIVE_SYNC_UNRESTRICTED_CHANNEL_IDS`: calls que dispensam os cargos acima.
- `LIVE_SYNC_UNRESTRICTED_CATEGORY_IDS`: categorias cujas calls dispensam os cargos acima, inclusive canais criados depois.

Canais bloqueados têm prioridade sobre canais sem restrição. O bot precisa estar no servidor e usar o intent de estados de voz para validar os cargos presentes no evento. Reinicie o bot depois de alterar essas listas.

Troque a URL pela sua. Execute da raiz:

```sh
npm run start:bot
```

Na hospedagem, mantenha esse processo ativo com o supervisor oferecido pelo provedor. Se o provedor injeta variáveis e você não usa `.env`, execute `node bot/src/index.cjs` da raiz. Use apenas **uma instância** do sincronizador por instalação; não rode este bot e outro sincronizador para o mesmo Worker ao mesmo tempo.

O bot observa os eventos de voz localmente, mas envia snapshots apenas dos usuários ativos solicitados pelo site. O polling padrão ocorre a cada cinco segundos. Snapshots inalterados não são gravados novamente. Há polling periódico, verificação de saúde, manutenção e autenticação: tráfego e gravações não são zero quando poucas pessoas estão usando.

## Usar

1. Entre numa call de um servidor permitido.
2. Acesse o site e escolha entrar com Discord.
3. Aguarde a identificação da call. O polling do bot pode levar alguns segundos.
4. Ative tela ou câmera e ajuste qualidade/FPS conforme sua conexão.
5. Escolha na lateral a transmissão que quer assistir; câmeras e telas podem ser recolhidas separadamente.

As telas oferecem layouts automático, grade, cinema, faixa horizontal e lista vertical, além de destaque individual e tela cheia. As câmeras oferecem automático, faixa, grade e destaque. Resolução, FPS e bitrate recebidos são calculados por `RTCPeerConnection.getStats()` e exibidos somente no navegador; essas métricas não são enviadas ao Worker.

O compartilhamento de tela usa o content hint `detail` e solicita ao navegador que preserve resolução quando faltar banda. Essas opções são preferências WebRTC: cada navegador ainda pode adaptar a mídia conforme rede e capacidade do dispositivo.

A página pública mostra apenas `Online` ou `Manutenção`. Ela verifica o heartbeat ao abrir e depois a cada cinco minutos.

Compartilhamento de áudio do sistema depende do navegador, sistema operacional e fonte escolhida. A webcam não captura microfone: a conversa continua no Discord. Duas abas com a mesma conta são bloqueadas para evitar sessões conflitantes.

## Desenvolvimento e testes

```sh
npm run typecheck
npm test
npm run build
npm run check:public
npm run dev
```

Para variáveis locais, copie `site/.dev.vars.example` para `site/.dev.vars` e preencha com credenciais de desenvolvimento. O preview serve para desenvolver a interface. Para validar OAuth, cookies seguros, captura e dois navegadores, use uma instalação de testes HTTPS com redirect próprio; não remova `Secure` dos cookies para contornar problemas de ambiente. Os testes automatizados simulam Discord/Cloudflare e não substituem um teste real entre dois participantes.

Personalize o nome da comunidade em `site/src/config.ts`, textos em `site/src/App.tsx`, estilo em `site/src/styles.css` e artes em `site/public`. Os SVGs incluídos no template estão descritos em [VISUAL_ASSETS.md](VISUAL_ASSETS.md).

## Custos e limites

Não há TURN, SFU ou serviço pago de vídeo configurado. O upload e download da mídia ficam com os participantes. Redes corporativas, NATs e firewalls restritivos podem impedir a conexão; este projeto aceita essa limitação.

Isso **não garante uso ilimitado ou custo zero em qualquer configuração**. Workers e Durable Objects têm cotas; no plano gratuito, excedê-las pode bloquear o serviço até a renovação. Mais usuários, eventos de voz e conexões podem elevar o consumo. Não ative um plano pago esperando que este código imponha um teto financeiro. Confira [preços e cotas de Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/).

Várias transmissões simultâneas exigem CPU e banda. Cada assinante adicional pode aumentar o upload do transmissor. O site não grava a mídia, mas espectadores autorizados ainda podem fazer suas próprias gravações.

## Problemas comuns

| Sintoma | Verifique |
| --- | --- |
| `service_unavailable` | Segredos, placeholders, origem HTTPS e IDs do Worker. |
| Sync 401 | Mesmo `LIVE_SYNC_SECRET` nos dois lados e relógio correto no host. |
| Sync 403 | IDs permitidos no bot e no Worker correspondem ao servidor. |
| Sync 400 | Versões compatíveis do bot e Worker; não envie payloads de uma implementação antiga. |
| `discord_token_failed` | Client ID, OAuth Client Secret e redirect exato, inclusive HTTPS/caminho. |
| Call não identificada | Bot conectado, canal visível, servidor permitido e sync saudável. |
| Tela preta | Permissão de captura, fonte selecionada e conectividade P2P; teste outra rede. |
| Cota esgotada | Uso no painel e horário de reset UTC; apagar dados não devolve a cota de gravações consumida. |

## Licença

O código é distribuído sob a [licença MIT](LICENSE). Os SVGs genéricos de `site/public/` são disponibilizados separadamente sob CC0, conforme [VISUAL_ASSETS.md](VISUAL_ASSETS.md).
