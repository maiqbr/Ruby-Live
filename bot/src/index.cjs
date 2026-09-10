const { Client, Events, GatewayIntentBits } = require('discord.js');

function validateEnvironment() {
  for (const name of ['DISCORD_TOKEN', 'LIVE_SYNC_URL', 'LIVE_SYNC_SECRET', 'LIVE_SYNC_GUILD_IDS']) {
    if (!process.env[name] || process.env[name].includes('INSIRA_')) {
      throw new Error(`Configure ${name} no ambiente do bot.`);
    }
  }
  if (Buffer.byteLength(process.env.LIVE_SYNC_SECRET) < 32) {
    throw new Error('LIVE_SYNC_SECRET deve ter pelo menos 32 bytes aleatórios.');
  }
  const url = new URL(process.env.LIVE_SYNC_URL);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || url.pathname !== '/api/internal/voice-sync' || url.hostname.endsWith('example.com')) {
    throw new Error('LIVE_SYNC_URL deve apontar para o endpoint HTTPS da sua instalação.');
  }
  if (!process.env.LIVE_SYNC_GUILD_IDS.split(',').every(id => /^\d{17,20}$/.test(id.trim()))) {
    throw new Error('LIVE_SYNC_GUILD_IDS deve conter IDs de servidores separados por vírgula.');
  }
}

try {
  validateEnvironment();
} catch (error) {
  console.error(error instanceof TypeError ? 'LIVE_SYNC_URL inválida.' : error.message);
  process.exit(1);
}

const sync = require('./liveSyncService.cjs');
const liveConfig = require('./liveConfig.cjs');
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

client.once(Events.ClientReady, async () => {
  try {
    await client.application.commands.set([liveConfig.command.toJSON()]);
  } catch {
    console.error('[live-config] não foi possível registrar o comando /liveconfig.');
  }
  sync.start(client).catch(() => console.error('[live-sync] falha ao iniciar a sincronização.'));
});
client.on(Events.InteractionCreate, interaction => {
  Promise.resolve(liveConfig.handleInteraction(interaction, sync)).catch(error => {
    console.error('[live-config] falha ao processar interação:', error);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      void interaction.reply({ content: 'Não foi possível atualizar a configuração.', ephemeral: true }).catch(() => {});
    }
  });
});
client.on(Events.VoiceStateUpdate, (before, after) => {
  Promise.resolve(sync.handleVoiceStateUpdate(before, after)).catch(() => {
    console.error('[live-sync] falha ao processar atualização de voz.');
  });
});
client.on(Events.Error, () => console.error('[discord] erro de conexão; verifique a configuração e a rede.'));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { client.destroy(); process.exit(0); });
}

client.login(process.env.DISCORD_TOKEN).catch(() => {
  console.error('[discord] não foi possível conectar. Verifique o token do bot e os intents.');
  process.exit(1);
});
