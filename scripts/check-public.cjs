const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ignored = new Set(['node_modules', '.git', 'dist', '.wrangler', '.wrangler-dry-run', 'coverage']);
const rules = [
  ['chave privada', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['token Discord', /\b(?:mfa\.[\w-]{60,}|[\w-]{24,28}\.[\w-]{6}\.[\w-]{27,110})\b/],
  ['token GitHub', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['credencial em URL', /https?:\/\/[^\s/:]+:[^\s/@]+@/],
  ['caminho pessoal Windows', /[A-Z]:[\\/]Users[\\/][^\s]+/i],
];
let files = 0;
let failed = false;
function report(file, reason) {
  failed = true;
  console.error(`${path.relative(root, file)}: ${reason}`);
}
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) { report(file, 'link simbólico: confira o destino'); continue; }
    if (entry.isDirectory()) { walk(file); continue; }
    files += 1;
    if ((/^\.(env|dev\.vars)(\.|$)/.test(entry.name) && !entry.name.endsWith('.example'))
        || /\.(?:pem|key|sqlite\w*|db|log)$/i.test(entry.name)) {
      report(file, 'arquivo privado/local não deve acompanhar a distribuição');
    }
    if (file === __filename || /\.(png|jpg|webp|ico)$/i.test(entry.name)) continue;
    const content = fs.readFileSync(file, 'utf8');
    for (const [label, pattern] of rules) if (pattern.test(content)) report(file, label);
  }
}
walk(root);
console.log(`${files} arquivos verificados. Builds, caches, dependências e histórico Git não são auditados por este comando.`);
if (failed) process.exitCode = 1;
