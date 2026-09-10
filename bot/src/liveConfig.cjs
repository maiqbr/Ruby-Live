const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ContainerBuilder,
  MessageFlags,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  SeparatorBuilder,
  SlashCommandBuilder,
  TextDisplayBuilder,
} = require('discord.js');

const databasePath = path.resolve(process.env.LIVE_DB_PATH || path.join(__dirname, '..', 'data', 'live.db'));
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
const db = new Database(databasePath);
db.pragma('journal_mode = WAL');
db.prepare(`
  CREATE TABLE IF NOT EXISTS live_config (
    guild_id TEXT PRIMARY KEY,
    blocked_channel_ids TEXT NOT NULL DEFAULT '[]',
    blocked_category_ids TEXT NOT NULL DEFAULT '[]',
    broadcast_role_ids TEXT NOT NULL DEFAULT '[]',
    unrestricted_channel_ids TEXT NOT NULL DEFAULT '[]',
    unrestricted_category_ids TEXT NOT NULL DEFAULT '[]'
  )
`).run();

const defaults = {
  blocked_channel_ids: [],
  blocked_category_ids: [],
  broadcast_role_ids: [],
  unrestricted_channel_ids: [],
  unrestricted_category_ids: [],
};
const fields = {
  live_blocked_channels: 'blocked_channel_ids',
  live_blocked_categories: 'blocked_category_ids',
  live_broadcast_roles: 'broadcast_role_ids',
  live_free_channels: 'unrestricted_channel_ids',
  live_free_categories: 'unrestricted_category_ids',
};

function parseList(value) {
  try {
    const list = JSON.parse(value || '[]');
    return Array.isArray(list) ? list.filter(id => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function getConfig(guildId) {
  const row = db.prepare('SELECT * FROM live_config WHERE guild_id = ?').get(guildId);
  if (!row) return { guild_id: guildId, ...defaults };
  return {
    guild_id: guildId,
    blocked_channel_ids: parseList(row.blocked_channel_ids),
    blocked_category_ids: parseList(row.blocked_category_ids),
    broadcast_role_ids: parseList(row.broadcast_role_ids),
    unrestricted_channel_ids: parseList(row.unrestricted_channel_ids),
    unrestricted_category_ids: parseList(row.unrestricted_category_ids),
  };
}

function updateConfig(guildId, patch) {
  const next = { ...getConfig(guildId), ...patch };
  db.prepare(`
    INSERT INTO live_config
      (guild_id, blocked_channel_ids, blocked_category_ids, broadcast_role_ids, unrestricted_channel_ids, unrestricted_category_ids)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      blocked_channel_ids = excluded.blocked_channel_ids,
      blocked_category_ids = excluded.blocked_category_ids,
      broadcast_role_ids = excluded.broadcast_role_ids,
      unrestricted_channel_ids = excluded.unrestricted_channel_ids,
      unrestricted_category_ids = excluded.unrestricted_category_ids
  `).run(guildId, ...Object.keys(defaults).map(field => JSON.stringify(next[field])));
}

function mentions(values, role = false) {
  if (!values.length) return '*nenhum*';
  return values.map(id => role ? `<@&${id}>` : `<#${id}>`).join(', ');
}

function channelSelect(customId, placeholder, channelType, values) {
  const menu = new ChannelSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .addChannelTypes(channelType)
    .setMinValues(0)
    .setMaxValues(25);
  if (values.length) menu.setDefaultChannels(values.slice(0, 25));
  return new ActionRowBuilder().addComponents(menu);
}

function panel(guildId) {
  const config = getConfig(guildId);
  const roles = new RoleSelectMenuBuilder()
    .setCustomId('live_broadcast_roles')
    .setPlaceholder('Cargos necessários para transmitir')
    .setMinValues(0)
    .setMaxValues(25);
  if (config.broadcast_role_ids.length) roles.setDefaultRoles(config.broadcast_role_ids.slice(0, 25));

  const container = new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `## Configuração — Ruby Live\n` +
      `**Canais ignorados:** ${mentions(config.blocked_channel_ids)}\n` +
      `**Categorias ignoradas:** ${mentions(config.blocked_category_ids)}\n` +
      `**Cargos para transmitir:** ${mentions(config.broadcast_role_ids, true)}\n` +
      `**Canais sem restrição:** ${mentions(config.unrestricted_channel_ids)}\n` +
      `**Categorias sem restrição:** ${mentions(config.unrestricted_category_ids)}\n` +
      `-# Canais e categorias ignoradas têm prioridade. Sem cargos configurados, todos podem transmitir.`,
    ))
    .addSeparatorComponents(new SeparatorBuilder())
    .addActionRowComponents(channelSelect('live_blocked_channels', 'Canais de voz ignorados pelo site', ChannelType.GuildVoice, config.blocked_channel_ids))
    .addActionRowComponents(channelSelect('live_blocked_categories', 'Categorias ignoradas pelo site', ChannelType.GuildCategory, config.blocked_category_ids))
    .addActionRowComponents(new ActionRowBuilder().addComponents(roles))
    .addActionRowComponents(channelSelect('live_free_channels', 'Canais sem restrição de cargo', ChannelType.GuildVoice, config.unrestricted_channel_ids))
    .addActionRowComponents(channelSelect('live_free_categories', 'Categorias sem restrição de cargo', ChannelType.GuildCategory, config.unrestricted_category_ids))
    .addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('live_clear').setLabel('Limpar todas as regras').setStyle(ButtonStyle.Danger),
    ));
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

const command = new SlashCommandBuilder()
  .setName('liveconfig')
  .setDescription('Configura canais, categorias e cargos da Ruby Live.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

async function handleInteraction(interaction, sync) {
  if (interaction.isChatInputCommand() && interaction.commandName === 'liveconfig') {
    if (!interaction.guild) return interaction.reply({ content: 'Use este comando em um servidor.', flags: MessageFlags.Ephemeral });
    return interaction.reply({ ...panel(interaction.guild.id), flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
  }
  const isConfigComponent = interaction.isButton() ? interaction.customId === 'live_clear'
    : interaction.isAnySelectMenu?.() && Object.hasOwn(fields, interaction.customId);
  if (!isConfigComponent) return false;
  if (!interaction.guild || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: 'Você precisa da permissão Gerenciar Servidor.', flags: MessageFlags.Ephemeral });
    return true;
  }
  if (interaction.customId === 'live_clear') db.prepare('DELETE FROM live_config WHERE guild_id = ?').run(interaction.guild.id);
  else updateConfig(interaction.guild.id, { [fields[interaction.customId]]: interaction.values });
  await interaction.update(panel(interaction.guild.id));
  void sync.sendFullSnapshot(true).catch(error => console.error('[live-config] falha ao aplicar configuração:', error));
  return true;
}

module.exports = { command, getConfig, handleInteraction };
