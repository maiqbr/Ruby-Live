# Segurança

Não publique tokens, cookies, códigos OAuth, cabeçalhos de autenticação ou arquivos de ambiente em issues. Ao reportar uma falha, envie passos de reprodução com contas e dados fictícios. O mantenedor deve habilitar os avisos privados de segurança do GitHub antes de publicar o repositório.

O login ocorre no Discord com OAuth, PKCE e escopo `identify`. O site não pede a senha do usuário. A sessão usa cookie Secure, HttpOnly e SameSite, com prefixo `__Host-`. O Worker verifica a origem das conexões e a presença na call; as mensagens do bot usam HMAC com janela de tempo e identificação de evento.

Essas barreiras não tornam o serviço invulnerável. Mantenha dependências atualizadas, use HTTPS, proteja a conta Cloudflare e limite os servidores permitidos. Não coloque segredos em variáveis `VITE_*`, arquivos públicos ou no frontend.

A mídia usa WebRTC direto entre participantes. Isso pode revelar endereços IP aos pares; não oferece anonimato. Um espectador autorizado ainda pode gravar a tela. A integridade do servidor de sinalização e do JavaScript entregue continua importante.

O filtro `npm run check:public` é uma verificação complementar de arquivos e padrões conhecidos, não uma auditoria completa. Ele não examina histórico Git nem arquivos gerados. Revise `git diff --cached` antes de cada publicação e nunca force a inclusão de arquivos ignorados. Se um segredo for exposto, revogue-o: apagar o arquivo não o remove do histórico.
