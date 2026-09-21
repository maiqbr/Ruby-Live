# Segurança

Esta política trata de vulnerabilidades no código mantido neste repositório. Ela não constitui serviço de monitoramento, moderação ou resposta a incidentes para instalações operadas por terceiros.

Não publique tokens, cookies, códigos OAuth, cabeçalhos de autenticação ou arquivos de ambiente em issues. Ao reportar uma falha, envie passos de reprodução com contas e dados fictícios. O mantenedor deve habilitar os avisos privados de segurança do GitHub antes de publicar o repositório.

O login ocorre no Discord com OAuth, PKCE e escopo `identify`. O site não pede a senha do usuário. A sessão usa cookie Secure, HttpOnly e SameSite, com prefixo `__Host-`. O Worker verifica a origem das conexões e a presença na call; as mensagens do bot usam HMAC com janela de tempo e identificação de evento.

Essas barreiras não tornam o serviço invulnerável. Mantenha dependências atualizadas, use HTTPS, proteja a conta Cloudflare e limite os servidores permitidos. Não coloque segredos em variáveis `VITE_*`, arquivos públicos ou no frontend.

A mídia usa WebRTC direto entre participantes. Isso pode revelar endereços IP aos pares; não oferece anonimato. Um espectador autorizado ainda pode gravar a tela. A integridade do servidor de sinalização e do JavaScript entregue continua importante.

O filtro `npm run check:public` é uma verificação complementar de arquivos e padrões conhecidos, não uma auditoria completa. Ele não examina histórico Git nem arquivos gerados. Revise `git diff --cached` antes de cada publicação e nunca force a inclusão de arquivos ignorados. Se um segredo for exposto, revogue-o: apagar o arquivo não o remove do histórico.

Cada implantação é independente. Os mantenedores não possuem necessariamente acesso à infraestrutura, aos dados ou aos usuários de terceiros e não podem bloquear contas, remover conteúdo ou interromper uma instalação que não controlam. Abusos ocorridos em uma instância independente devem ser reportados ao operador dessa instância, ao provedor de hospedagem, à plataforma envolvida ou às autoridades competentes.

Consulte também o [aviso de responsabilidade](DISCLAIMER.md), que complementa esta política sem alterar os termos da licença MIT.
