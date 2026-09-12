const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  EmbedBuilder,
  AuditLogEvent,
  PermissionsBitField
} = require('discord.js');
const { DatabaseSync } = require('node:sqlite');

// ============================================
// NMR LOGS V3 ULTIMATE - DEEP SERVER LOGGER
// ============================================

const CONFIG = {
  token: process.env.TOKEN?.trim(),
  sourceGuildId: process.env.SOURCE_GUILD_ID?.trim(),
  logGuildId: process.env.LOG_GUILD_ID,
  footerIcon: 'https://i.postimg.cc/qRBtmgzD/download-20260819-160352.gif',
  logBotMessages: process.env.LOG_BOT_MESSAGES === 'true',

  channels: {
    logs: process.env.LOGS_CHANNEL_ID,
    roles: process.env.ROLES_CHANNEL_ID,
    voice: process.env.VOICE_CHANNEL_ID,
    bans: process.env.BANS_CHANNEL_ID,
    kicks: process.env.KICKS_CHANNEL_ID,
    botState: process.env.BOT_STATE_CHANNEL_ID
  }
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildEmojisAndStickers
  ],
  partials: [
    Partials.User,
    Partials.Channel,
    Partials.GuildMember,
    Partials.Message,
    Partials.Reaction
  ]
});

const messageCache = new Map();
const inviteCache = new Map();
const auditEntryCache = new Map();
// Cache fresh voice-related audit entries so VoiceStateUpdate can resolve the real executor.
const voiceAuditCache = new Map();
const voiceAuditQueue = new Map();
const consumedAuditEntries = new Map();

// Persistent message database: deleted messages can still be recovered after cache expiry/restart.
// Uses Node's built-in SQLite support (Node 22.5+ / Node 24+) so no native sqlite3 package is required.
const messageDb = new DatabaseSync(path.join(__dirname, 'messages.db'));

messageDb.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    channel_id TEXT,
    channel_name TEXT,
    author_id TEXT,
    author_tag TEXT,
    avatar TEXT,
    content TEXT,
    attachments TEXT,
    embeds TEXT,
    stickers TEXT,
    components TEXT,
    message_type INTEGER,
    reference TEXT,
    created_timestamp INTEGER,
    updated_timestamp INTEGER
  )
`);

// Upgrade existing databases created by older NMR versions.
for (const [column, definition] of [
  ['stickers', "TEXT DEFAULT '[]'"],
  ['components', "TEXT DEFAULT '[]'"],
  ['message_type', 'INTEGER DEFAULT 0'],
  ['reference', "TEXT DEFAULT '{}'" ]
]) {
  try {
    messageDb.exec(`ALTER TABLE messages ADD COLUMN ${column} ${definition}`);
  } catch {}
}

function dbRun(sql, params = []) {
  const stmt = messageDb.prepare(sql);
  return stmt.run(...params);
}

function dbGet(sql, params = []) {
  const stmt = messageDb.prepare(sql);
  return stmt.get(...params);
}

async function saveMessageToDb(message) {
  if (!message?.guild || !message.id) return;

  const stickers = [...(message.stickers?.values?.() || [])].map(st => ({
    id: st.id,
    name: st.name,
    format: st.format,
    url: st.url
  }));

  const attachments = [...(message.attachments?.values?.() || [])].map(a => ({
    id: a.id,
    name: a.name,
    url: a.url,
    proxyURL: a.proxyURL,
    contentType: a.contentType,
    size: a.size,
    width: a.width,
    height: a.height,
    spoiler: a.spoiler
  }));

  const embeds = [...(message.embeds || [])].map(e => ({
    title: e.title,
    description: e.description,
    url: e.url,
    fields: (e.fields || []).map(f => ({
      name: f.name,
      value: f.value,
      inline: f.inline
    })),
    author: e.author
      ? {
          name: e.author.name,
          url: e.author.url,
          iconURL: e.author.iconURL
        }
      : null,
    footer: e.footer
      ? {
          text: e.footer.text,
          iconURL: e.footer.iconURL
        }
      : null
  }));

  const components = [...(message.components || [])].map(row => ({
    type: row.type,
    components: [...(row.components || [])].map(c => ({
      type: c.type, customId: c.customId, label: c.label, style: c.style,
      url: c.url, disabled: c.disabled,
      emoji: c.emoji ? { id: c.emoji.id, name: c.emoji.name, animated: c.emoji.animated } : null
    }))
  }));

  const reference = message.reference ? {
    messageId: message.reference.messageId,
    channelId: message.reference.channelId,
    guildId: message.reference.guildId
  } : null;

  dbRun(`
    INSERT INTO messages (
      id,
      guild_id,
      channel_id,
      channel_name,
      author_id,
      author_tag,
      avatar,
      content,
      attachments,
      embeds,
      stickers,
      components,
      message_type,
      reference,
      created_timestamp,
      updated_timestamp
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      channel_id=excluded.channel_id,
      channel_name=excluded.channel_name,
      author_id=excluded.author_id,
      author_tag=excluded.author_tag,
      avatar=excluded.avatar,
      content=excluded.content,
      attachments=excluded.attachments,
      embeds=excluded.embeds,
      stickers=excluded.stickers,
      components=excluded.components,
      message_type=excluded.message_type,
      reference=excluded.reference,
      updated_timestamp=excluded.updated_timestamp
  `, [
    message.id,
    message.guild.id,
    message.channel?.id || null,
    message.channel?.name || null,
    message.author?.id || null,
    message.author?.tag || null,
    message.author?.displayAvatarURL?.() || null,
    message.content || '',
    JSON.stringify(attachments),
    JSON.stringify(embeds),
    JSON.stringify(stickers),
    JSON.stringify(components),
    message.type ?? 0,
    JSON.stringify(reference),
    message.createdTimestamp || Date.now(),
    Date.now()
  ]);
}

const saveMessage = saveMessageToDb;

async function getMessageFromDb(messageId) {
  if (!messageId) return null;

  const row = dbGet(
    'SELECT * FROM messages WHERE id = ?',
    [messageId]
  );

  if (!row) return null;

  return {
    id: row.id,
    content: row.content || '',
    authorId: row.author_id,
    authorTag: row.author_tag,
    avatar: row.avatar,
    channelId: row.channel_id,
    channelName: row.channel_name,
    attachments: JSON.parse(row.attachments || '[]'),
    embeds: JSON.parse(row.embeds || '[]'),
    stickers: JSON.parse(row.stickers || '[]'),
    components: JSON.parse(row.components || '[]'),
    messageType: row.message_type ?? 0,
    reference: JSON.parse(row.reference || '{}'),
    createdTimestamp: row.created_timestamp
  };
}

// Keep deleted-message records permanently so their content remains available after deletion/restart.
async function deleteMessageFromDb(messageId) {
  // Intentionally not deleting rows. Kept for compatibility with the existing code path.
  return;
}

const COLORS = {
  info: 0x5865F2,
  success: 0x57F287,
  warning: 0xFEE75C,
  danger: 0xED4245,
  purple: 0x9B59B6,
  voice: 0x3498DB,
  role: 0xE91E63
};

function isSource(guild) {
  return guild && guild.id === CONFIG.sourceGuildId;
}

function timestamp() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Cairo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  }).format(new Date());
}

function trim(text, max = 1000) {
  if (text === null || text === undefined || text === '') {
    return 'لا يوجد';
  }

  text = String(text);

  return text.length > max
    ? `${text.slice(0, max - 3)}...`
    : text;
}

function code(text, max = 900) {
  return `\`\`\`\n${trim(text, max)}\n\`\`\``;
}

function userInfo(user) {
  if (!user) return 'لم يتم تحديد المستخدم';

  return `${user.tag || user.username}\n<@${user.id}> • \`${user.id}\``;
}

async function executorInfo(entry, fallbackUser = null) {
  const executorId =
    entry?.executorId ||
    entry?.executor?.id ||
    null;

  if (executorId) {
    const executor =
      entry?.executor ||
      await client.users.fetch(executorId).catch(() => null);

    if (executor) {
      return userInfo(executor);
    }

    return `<@${executorId}>`;
  }

  if (fallbackUser?.id) {
    return userInfo(fallbackUser);
  }

  return fallbackUser?.id ? userInfo(fallbackUser) : 'غير محدد';
}

function memberInfo(member) {
  if (!member) return 'لم يتم تحديد العضو';

  return `${member.user.tag}\n<@${member.id}> • \`${member.id}\``;
}

// اسم الرول كنص عادي فقط - بدون @Role mention
function roleInfo(role, fallbackId) {
  if (!role) {
    return `Unknown Role\n\`${fallbackId || 'Unknown'}\``;
  }

  return `**${role.name}**\n\`${role.id}\``;
}

function targetUserInfo(memberOrUser) {
  const user = memberOrUser?.user || memberOrUser;

  if (!user) return 'لم يتم تحديد العضو';

  return `<@${user.id}>\n\`${user.id}\``;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getChannel(type) {
  const id =
    CONFIG.channels[type] ||
    (type === 'roles' ? CONFIG.channels.logs : null);

  if (!id) return null;

  const guild = client.guilds.cache.get(CONFIG.logGuildId);

  if (!guild) return null;

  const channel =
    guild.channels.cache.get(id) ||
    await guild.channels.fetch(id).catch(() => null);

  return channel?.isTextBased() ? channel : null;
}

async function sendLog(type, options = {}) {
  const channel = await getChannel(type);

  if (!channel) {
    console.log(
      `[NMR LOGS] Missing ${type.toUpperCase()} channel ID in .env`
    );
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(options.color ?? COLORS.info)
    .setTitle(options.title ?? 'NMR LOG')
    .setDescription(
      trim(
        options.description ?? 'حدث جديد في السيرفر',
        4096
      )
    )
    .setTimestamp()
    .setFooter({
      text: `𝓝𝓜𝓡 𝓛𝓞𝓖𝓢 | ${timestamp()}`,
      iconURL: CONFIG.footerIcon
    });

  if (options.author) {
    embed.setAuthor({
      name: trim(options.author.name, 256),
      iconURL: options.author.iconURL || undefined
    });
  }

  if (options.thumbnail) {
    embed.setThumbnail(options.thumbnail);
  }

  if (options.image) {
    embed.setImage(options.image);
  }

  if (options.fields?.length) {
    embed.addFields(
      options.fields.slice(0, 25).map(field => ({
        name: trim(field.name, 256),
        value: trim(field.value, 1024),
        inline: Boolean(field.inline)
      }))
    );
  }

  try {
    await channel.send({
      embeds: [embed]
    });
  } catch (error) {
    console.error(
      '[NMR LOGS SEND ERROR]',
      error.message
    );
  }
}

async function findAudit(
  guild,
  type,
  targetId,
  maxAge = 15000,
  changeKey = null,
  options = {}
) {
  if (!guild) return null;

  const types = Array.isArray(type) ? type : [type];
  const now = Date.now();
  const minAge = options.minAge ?? -3000;
  const consume = options.consume !== false;

  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt) await wait(450);

    for (const auditType of types) {
      try {
        const logs = await guild.fetchAuditLogs({
          type: auditType,
          limit: 50
        });

        const entries = [...logs.entries.values()]
          .filter(entry => {
            if (!entry) return false;

            const age = now - entry.createdTimestamp;
            if (age < minAge || age > maxAge) return false;

            if (targetId && entry.targetId !== targetId) return false;

            if (
              changeKey &&
              !entry.changes?.some(change => change.key === changeKey)
            ) {
              return false;
            }

            const consumedUntil = consumedAuditEntries.get(
              `${guild.id}:${entry.id}`
            );

            if (consumedUntil && consumedUntil > Date.now()) {
              return false;
            }

            return true;
          })
          .sort((a, b) => b.createdTimestamp - a.createdTimestamp);

        if (!entries.length) continue;

        const entry = entries[0];

        if (consume) {
          consumedAuditEntries.set(
            `${guild.id}:${entry.id}`,
            Date.now() + 8000
          );
        }

        auditEntryCache.set(`${guild.id}:${entry.id}`, entry);
        setTimeout(() => {
          auditEntryCache.delete(`${guild.id}:${entry.id}`);
          consumedAuditEntries.delete(`${guild.id}:${entry.id}`);
        }, 15000);

        return entry;
      } catch (error) {
        // Do not break logging because one audit request failed.
      }
    }
  }

  return null;
}
// Strict resolver for member role changes.
// IMPORTANT: This intentionally returns null when Discord did not provide
// a matching audit entry. We never guess an executor for a role change.
function auditChangeRoleIds(change) {
  const value = change?.new ?? change?.old ?? change?.value;
  if (value == null) return [];

  const list = Array.isArray(value) ? value : [value];
  const ids = [];

  for (const item of list) {
    if (!item) continue;

    if (typeof item === 'string' || typeof item === 'number') {
      ids.push(String(item));
      continue;
    }

    if (item.id) {
      ids.push(String(item.id));
      continue;
    }

    if (item.roleId) {
      ids.push(String(item.roleId));
      continue;
    }

    if (item.id?.id) {
      ids.push(String(item.id.id));
    }
  }

  return ids;
}

async function findStrictMemberRoleAudit(
  guild,
  memberId,
  roleIds,
  actionKey,
  maxAge = 30000
) {
  if (!guild || !memberId || !roleIds?.size) return null;

  const wantedRoleIds = new Set(
    [...roleIds].map(id => String(id))
  );

  // Audit logs can arrive shortly after guildMemberUpdate.
  // Retry for a few seconds, but only accept an exact target + exact role match.
  for (let attempt = 0; attempt < 10; attempt++) {
    if (attempt) await wait(500);

    try {
      const logs = await guild.fetchAuditLogs({
        type: AuditLogEvent.MemberRoleUpdate,
        limit: 50
      });

      const now = Date.now();
      const candidates = [...logs.entries.values()]
        .filter(entry => {
          if (!entry) return false;
          if (entry.targetId !== memberId) return false;

          const age = now - entry.createdTimestamp;
          if (age < -3000 || age > maxAge) return false;

          if (consumedAuditEntries.has(`${guild.id}:${entry.id}`)) {
            return false;
          }

          const relevantChanges = (entry.changes || [])
            .filter(change => !actionKey || change.key === actionKey);

          if (!relevantChanges.length) return false;

          return relevantChanges.some(change => {
            const ids = auditChangeRoleIds(change);
            return ids.some(id => wantedRoleIds.has(id));
          });
        })
        .sort((a, b) => b.createdTimestamp - a.createdTimestamp);

      if (!candidates.length) continue;

      const entry = candidates[0];
      consumedAuditEntries.set(
        `${guild.id}:${entry.id}`,
        Date.now() + 10000
      );
      auditEntryCache.set(`${guild.id}:${entry.id}`, entry);

      setTimeout(() => {
        auditEntryCache.delete(`${guild.id}:${entry.id}`);
        consumedAuditEntries.delete(`${guild.id}:${entry.id}`);
      }, 15000);

      return entry;
    } catch {
      // If Discord temporarily refuses/doesn't return audit logs, retry.
    }
  }

  // Deliberately no fallback here.
  return null;
}

// ============================================
// BOT STATE / PROCESS STATUS
// ============================================

let botReady = false;
let shuttingDown = false;

async function sendBotState(
  title,
  description,
  color = COLORS.info,
  extraFields = []
) {
  try {
    await sendLog('botState', {
      title,
      description,
      color,
      fields: [
        {
          name: '🤖 البوت',
          value: client.user
            ? `${client.user.tag}\n\`${client.user.id}\``
            : 'NMR LOGS'
        },
        {
          name: '🕒 الوقت',
          value: `<t:${Math.floor(Date.now() / 1000)}:F>`
        },
        ...extraFields
      ]
    });
  } catch (error) {
    console.error(
      '[BOT STATE]',
      error.message
    );
  }
}

async function gracefulExit(signal, exitCode = 0) {
  if (shuttingDown) return;

  shuttingDown = true;

  if (botReady) {
    await sendBotState(
      signal === 'CRASH'
        ? '💥 BOT CRASHED'
        : '🛑 BOT STOPPED',
      signal === 'CRASH'
        ? '**البوت حصل له Crash وسيتم إغلاق العملية**'
        : `**تم إيقاف البوت بشكل منظم (${signal})**`,
      signal === 'CRASH'
        ? COLORS.danger
        : COLORS.warning
    );
  }

  try {
    client.destroy();
  } catch {}

  process.exit(exitCode);
}

// Voice audit entries can have no direct targetId for MOVE/DISCONNECT.
// Search recent entries by action + channel/count and fall back to the newest fresh entry.
// ============================================
// VOICE AUDIT RESOLVERS
// ============================================

function voiceAuditCacheKey(guildId, action, memberId) {
  return `${guildId}:${action}:${memberId}`;
}

function isFreshAudit(entry, maxAge = 30000) {
  if (!entry) return false;
  const age = Date.now() - entry.createdTimestamp;
  return age >= -3000 && age <= maxAge;
}

function markAuditConsumed(guild, entry, ttl = 10000) {
  if (!guild || !entry) return;
  consumedAuditEntries.set(
    `${guild.id}:${entry.id}`,
    Date.now() + ttl
  );
  auditEntryCache.set(`${guild.id}:${entry.id}`, entry);
  setTimeout(() => {
    auditEntryCache.delete(`${guild.id}:${entry.id}`);
    consumedAuditEntries.delete(`${guild.id}:${entry.id}`);
  }, 15000);
}

// Voice MOVE / DISCONNECT resolver.
// Discord may omit target_id for these audit entries and instead provide channel_id/count.
function voiceAuditActionKey(guildId, action) {
  return `${guildId}:${action}`;
}

function getAuditChannelId(entry) {
  const extra = entry?.extra || {};
  return extra.channelId || extra.channel_id || extra.channel?.id || null;
}

function getAuditCount(entry) {
  const raw = entry?.extra?.count;
  if (raw === undefined || raw === null) return 1;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 1;
}

function queueVoiceAuditEntry(guild, entry) {
  if (!guild || !entry?.executorId) return;
  if (![AuditLogEvent.MemberMove, AuditLogEvent.MemberDisconnect].includes(entry.action)) return;
  const key = voiceAuditActionKey(guild.id, entry.action);
  const list = (voiceAuditQueue.get(key) || []).filter(e => isFreshAudit(e, 15000));
  list.unshift(entry);
  voiceAuditQueue.set(key, list.slice(0, 20));
  setTimeout(() => {
    const current = (voiceAuditQueue.get(key) || []).filter(e => e.id !== entry.id && isFreshAudit(e, 15000));
    if (current.length) voiceAuditQueue.set(key, current);
    else voiceAuditQueue.delete(key);
  }, 16000);
}

function getQueuedVoiceAudits(guild, action) {
  const key = voiceAuditActionKey(guild.id, action);
  const list = (voiceAuditQueue.get(key) || []).filter(e => isFreshAudit(e, 15000));
  if (list.length) voiceAuditQueue.set(key, list);
  else voiceAuditQueue.delete(key);
  return list;
}

async function findVoiceAudit(guild, type, memberId, channelId, maxAge = 15000) {
  if (!guild || !memberId) return null;
  const types = Array.isArray(type) ? type : [type];

  const matches = entry => {
    if (!entry?.executorId) return false;
    if (!isFreshAudit(entry, maxAge)) return false;
    if (entry.executorId === memberId) return false;
    const consumedUntil = consumedAuditEntries.get(`${guild.id}:${entry.id}`);
    if (consumedUntil && consumedUntil > Date.now()) return false;

    const auditChannel = getAuditChannelId(entry);
    const targetId = entry.targetId ? String(entry.targetId) : null;
    const wantedMemberId = String(memberId);

    if (channelId && auditChannel && String(auditChannel) !== String(channelId)) return false;

    // Exact target is the strongest correlation. Discord may omit target_id
    // for MEMBER_DISCONNECT/MEMBER_MOVE and expose only channel_id/count.
    if (targetId) return targetId === wantedMemberId;

    // When target_id is missing, accept only a single-member audit action.
    // Prefer the exact old channel when Discord provides it. If Discord omits
    // channel_id as well, the fresh single-member entry is still usable because
    // the VoiceStateUpdate itself identifies the member that just left.
    if (getAuditCount(entry) !== 1) return false;
    if (channelId && auditChannel) return String(auditChannel) === String(channelId);
    return true;
  };

  for (const action of types) {
    const cached = voiceAuditCache.get(voiceAuditCacheKey(guild.id, action, memberId));
    if (matches(cached)) {
      markAuditConsumed(guild, cached, 10000);
      return cached;
    }
  }

  for (const action of types) {
    const candidates = getQueuedVoiceAudits(guild, action).filter(matches).sort((a,b) => b.createdTimestamp - a.createdTimestamp);
    if (candidates.length) {
      const entry = candidates[0];
      markAuditConsumed(guild, entry, 10000);
      return entry;
    }
  }

  for (let attempt = 0; attempt < 20; attempt++) {
    if (attempt) await wait(350);
    for (const action of types) {
      try {
        const logs = await guild.fetchAuditLogs({ type: action, limit: 50 });
        const candidates = [...logs.entries.values()].filter(matches).sort((a,b) => b.createdTimestamp - a.createdTimestamp);
        if (!candidates.length) continue;
        const entry = candidates[0];
        markAuditConsumed(guild, entry, 10000);
        queueVoiceAuditEntry(guild, entry);
        return entry;
      } catch {}
    }
  }
  return null;
}

// SERVER MUTE / SERVER DEAF / STAGE SUPPRESS are all MemberUpdate audit entries.
// We resolve the whole batch from one entry so a single Discord audit entry can
// legitimately explain more than one VoiceStateUpdate field.
async function findVoiceMemberUpdateAudit(
  guild,
  memberId,
  changeKeys,
  maxAge = 30000
) {
  if (!guild || !memberId) return null;

  const wanted = new Set(changeKeys);
  const action = AuditLogEvent.MemberUpdate;
  const cached = voiceAuditCache.get(
    voiceAuditCacheKey(guild.id, action, memberId)
  );

  if (
    isFreshAudit(cached, maxAge) &&
    cached.executorId &&
    (cached.changes || []).some(c => wanted.has(c.key))
  ) {
    markAuditConsumed(guild, cached, 10000);
    return cached;
  }

  for (let attempt = 0; attempt < 10; attempt++) {
    if (attempt) await wait(450);

    try {
      const logs = await guild.fetchAuditLogs({
        type: action,
        limit: 50
      });

      const candidates = [...logs.entries.values()]
        .filter(entry => {
          if (!entry || !entry.executorId) return false;
          if (entry.targetId !== memberId) return false;
          if (!isFreshAudit(entry, maxAge)) return false;

          const consumedUntil = consumedAuditEntries.get(
            `${guild.id}:${entry.id}`
          );
          if (consumedUntil && consumedUntil > Date.now()) return false;

          return (entry.changes || []).some(c => wanted.has(c.key));
        })
        .sort((a, b) => b.createdTimestamp - a.createdTimestamp);

      if (candidates.length) {
        const entry = candidates[0];
        markAuditConsumed(guild, entry, 10000);
        return entry;
      }
    } catch {}
  }

  return null;
}

// For message deletion, Discord's audit entry target is the message author.
// Never reuse an old entry: the same author can have many deleted messages.
async function findMessageDeleteAudit(
  guild,
  authorId,
  channelId,
  deletedAt = Date.now()
) {
  if (!guild || !authorId) return null;

  const cacheKey =
    `${guild.id}:${authorId}`;

  const matches = entry => {
    if (
      !entry ||
      entry.action !== AuditLogEvent.MessageDelete
    ) {
      return false;
    }

    if (
      entry.targetId &&
      entry.targetId !== authorId
    ) {
      return false;
    }

    const age =
      deletedAt - entry.createdTimestamp;

    if (age < -5000 || age > 15000) {
      return false;
    }

    const extra = entry.extra || {};

    const auditChannel =
      extra.channelId ||
      extra.channel_id ||
      extra.channel?.id;

    if (
      channelId &&
      auditChannel &&
      auditChannel !== channelId
    ) {
      return false;
    }

    return true;
  };

  const cached =
    messageDeleteAuditCache.get(cacheKey);

  if (matches(cached)) {
    return cached;
  }

  for (let attempt = 0; attempt < 10; attempt++) {
    if (attempt) {
      await wait(350);
    }

    try {
      const logs =
        await guild.fetchAuditLogs({
          type: AuditLogEvent.MessageDelete,
          limit: 50
        });

      const candidates =
        [...logs.entries.values()]
          .filter(matches)
          .sort(
            (a, b) =>
              b.createdTimestamp -
              a.createdTimestamp
          );

      if (candidates.length) {
        const exact = candidates[0];

        messageDeleteAuditCache.set(
          cacheKey,
          exact
        );

        setTimeout(() => {
          const current =
            messageDeleteAuditCache.get(
              cacheKey
            );

          if (
            current?.id === exact.id
          ) {
            messageDeleteAuditCache.delete(
              cacheKey
            );
          }
        }, 10000);

        return exact;
      }
    } catch {}
  }

  return null;
}

// ============================================
// HISTORICAL MESSAGE SYNC
// ============================================
// On startup, import all messages currently accessible to the bot into SQLite.
// This lets MessageDelete recover old text, embeds, attachments and stickers
// even after Discord's in-memory message cache has been lost.
let historicalSyncRunning = false;

async function syncHistoricalMessages(guild) {
  if (!guild || !isSource(guild) || historicalSyncRunning) return;
  historicalSyncRunning = true;

  try {
    const channels = [...guild.channels.cache.values()]
      .filter(channel => {
        try {
          return channel.isTextBased?.() &&
            !channel.isDMBased?.() &&
            typeof channel.messages?.fetch === 'function';
        } catch {
          return false;
        }
      })
      .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0));

    let channelCount = 0;
    let messageCount = 0;

    console.log(`[NMR] Historical message sync started: ${channels.length} text channels.`);

    for (const channel of channels) {
      channelCount++;
      let before;
      let channelMessages = 0;

      while (true) {
        let batch;
        try {
          batch = await channel.messages.fetch({
            limit: 100,
            ...(before ? { before } : {})
          });
        } catch (error) {
          console.warn(`[NMR] Could not sync #${channel.name || channel.id}: ${error.message}`);
          break;
        }

        if (!batch?.size) break;

        // Oldest -> newest makes DB timestamps easier to follow.
        for (const message of [...batch.values()].reverse()) {
          if (!message.guild || message.guild.id !== guild.id) continue;
          try {
            await saveMessageToDb(message);
            messageCache.set(message.id, message);
            channelMessages++;
            messageCount++;
          } catch (error) {
            console.warn(`[NMR] Failed to save message ${message.id}: ${error.message}`);
          }
        }

        const oldest = batch.last();
        if (!oldest || batch.size < 100) break;
        before = oldest.id;
      }

      console.log(`[NMR] Synced #${channel.name || channel.id}: ${channelMessages} messages (${channelCount}/${channels.length}).`);
    }

    console.log(`[NMR] Historical message sync completed: ${messageCount} messages across ${channelCount} channels.`);
  } catch (error) {
    console.error('[NMR] Historical message sync failed:', error);
  } finally {
    historicalSyncRunning = false;
  }
}

// ============================================
// MESSAGE LOGS - CACHE EVERYTHING
// ============================================

client.on(
  Events.MessageCreate,
  async message => {
    if (
      !message.guild ||
      !isSource(message.guild)
    ) {
      return;
    }

    // Always persist messages including bot embeds.
    await saveMessage(message);
  }
);

client.on(
  Events.MessageDelete,
  async message => {
    if (
      !message.guild ||
      !isSource(message.guild)
    ) {
      return;
    }

    const cached =
      messageCache.get(message.id);

    const saved =
      cached ||
      await getMessageFromDb(
        message.id
      ).catch(() => null);

    if (message.partial) {
      await message
        .fetch()
        .catch(() => null);
    }

    const authorId =
      message.author?.id ||
      saved?.authorId;

    const deletedAt = Date.now();

    const audit =
      await findMessageDeleteAudit(
        message.guild,
        authorId,
        message.channelId ||
          saved?.channelId,
        deletedAt
      );

    let deleteExecutor =
      audit?.executor || null;

    if (
      !deleteExecutor &&
      audit?.executorId
    ) {
      deleteExecutor =
        await client.users.fetch(
          audit.executorId
        ).catch(() => null);
    }

    let content =
      message.content ||
      saved?.content ||
      '';

    if (
      !content &&
      saved?.embeds?.length
    ) {
      const embedParts =
        saved.embeds
          .slice(0, 10)
          .map((e, i) => {
            const parts = [];

            if (e.title) {
              parts.push(
                `**${e.title}**`
              );
            }

            if (e.description) {
              parts.push(
                e.description
              );
            }

            if (e.fields?.length) {
              parts.push(
                e.fields
                  .slice(0, 10)
                  .map(
                    f =>
                      `**${f.name}**: ${f.value}`
                  )
                  .join('\n')
              );
            }

            if (e.url) {
              parts.push(e.url);
            }

            return (
              parts
                .filter(Boolean)
                .join('\n') ||
              `Embed ${i + 1}`
            );
          });

      content =
        embedParts.join('\n\n');
    }

    if (!content) {
      content =
        'تعذر استرجاع محتوى الرسالة (لم يتم حفظ محتواها قبل الحذف)';
    }

    const attachments =
      message.attachments?.size
        ? [
            ...message.attachments.values()
          ]
        : (
            saved?.attachments || []
          );

    await sendLog('logs', {
      title: '🗑️ MESSAGE DELETED',
      description:
        '**تم حذف رسالة من السيرفر**',
      color: COLORS.danger,
      thumbnail:
        message.author?.displayAvatarURL() ||
        saved?.avatar,
      fields: [
        {
          name: '👤 صاحب الرسالة',
          value: message.author
            ? userInfo(message.author)
            : `${saved?.authorTag || 'بيانات غير متاحة'}\n\`${saved?.authorId || 'غير متاح'}\``
        },

        {
          name: '📍 الروم',
          value: message.channel
            ? `<#${message.channel.id}> • \`${message.channel.id}\``
            : `#${saved?.channelName || 'بيانات الروم غير متاحة'}`
        },

        {
          name: '💬 الرسالة المحذوفة',
          value: code(content)
        },

        {
          name: '🛡️ تم الحذف بواسطة',

          // لو Discord أعطانا Audit Log نستخدم الشخص الحقيقي.
          // لو مفيش Audit Log، يبقى الرسالة اتمسحت بواسطة صاحبها.
          value: deleteExecutor
            ? userInfo(deleteExecutor)
            : message.author
              ? userInfo(message.author)
              : saved?.authorId
                ? `<@${saved.authorId}>`
                : 'غير محدد (لا توجد عملية إدارية مطابقة)'
        }
      ]
    });

    if (attachments.length) {
      await sendLog('logs', {
        title:
          '📎 DELETED MESSAGE ATTACHMENTS',
        description:
          '**ملفات كانت موجودة في الرسالة المحذوفة**',
        color: COLORS.warning,
        fields:
          attachments
            .slice(0, 10)
            .map((a, i) => ({
              name: `📎 ملف ${i + 1}`,
              value:
                `[${a.name || 'Attachment'}](${a.url})`
            }))
      });
    }

    messageCache.delete(
      message.id
    );
  }
);

client.on(
  Events.MessageDeleteBulk,
  async messages => {
    const first =
      messages.first();

    if (
      !first?.guild ||
      !isSource(first.guild)
    ) {
      return;
    }

    const rows =
      await Promise.all(
        messages.map(
          async msg => {
            const saved =
              messageCache.get(
                msg.id
              ) ||
              await getMessageFromDb(
                msg.id
              ).catch(() => null);

            return `• **${msg.author?.tag || saved?.authorTag || 'Unknown'}**: ${trim(msg.content || saved?.content || 'بدون نص', 180)}`;
          }
        )
      );

    const list =
      rows.join('\n');

    const audit = await findAudit(
      first.guild,
      AuditLogEvent.MessageBulkDelete,
      first.channelId,
      20000
    );

    await sendLog('logs', {
      title:
        '🗑️ BULK MESSAGE DELETE',
      description:
        `**تم حذف ${messages.size} رسالة مرة واحدة**`,
      color: COLORS.danger,
      fields: [
        {
          name: '📍 الروم',
          value: `${first.channel}`
        },
        {
          name: '💬 الرسائل',
          value: trim(list, 1000)
        },
        {
          name: '🛡️ بواسطة',
          value: await executorInfo(audit)
        }
      ]
    });
  }
);

client.on(
  Events.MessageUpdate,
  async (
    oldMessage,
    newMessage
  ) => {
    if (
      !newMessage.guild ||
      !isSource(newMessage.guild)
    ) {
      return;
    }

    if (
      newMessage.author?.bot &&
      !CONFIG.logBotMessages
    ) {
      return;
    }

    if (oldMessage.partial) {
      await oldMessage
        .fetch()
        .catch(() => null);
    }

    if (newMessage.partial) {
      await newMessage
        .fetch()
        .catch(() => null);
    }

    const cached =
      messageCache.get(
        newMessage.id
      );

    const oldContent =
      oldMessage.content ??
      cached?.content ??
      '';

    const newContent =
      newMessage.content ?? '';

    if (
      oldContent === newContent
    ) {
      return;
    }

    await sendLog('logs', {
      title:
        '✏️ MESSAGE EDITED',
      description:
        '**تم تعديل رسالة**',
      color: COLORS.warning,
      thumbnail:
        newMessage.author?.displayAvatarURL(),
      fields: [
        {
          name: '👤 العضو',
          value:
            newMessage.author
              ? userInfo(
                  newMessage.author
                )
              : 'بيانات صاحب الرسالة غير متاحة'
        },

        {
          name: '📍 الروم',
          value:
            `<#${newMessage.channel.id}> • \`${newMessage.channel.id}\``
        },

        {
          name:
            '⬅️ الرسالة القديمة',
          value:
            code(
              oldContent ||
                'بدون نص'
            )
        },

        {
          name:
            '➡️ الرسالة الجديدة',
          value:
            code(
              newContent ||
                'بدون نص'
            )
        },

        {
          name:
            '🔗 رابط الرسالة',
          value:
            newMessage.url ||
            'غير متاح'
        }
      ]
    });

    await saveMessage(
      newMessage
    );
  }
);

// ============================================
// REACTIONS
// ============================================

client.on(
  Events.MessageReactionAdd,
  async (
    reaction,
    user
  ) => {
    if (reaction.partial) {
      await reaction
        .fetch()
        .catch(() => null);
    }

    const message =
      reaction.message;

    if (
      !message.guild ||
      !isSource(message.guild)
    ) {
      return;
    }

    await sendLog('logs', {
      title:
        '➕ REACTION ADDED',
      description:
        '**تم إضافة رياكشن**',
      color: COLORS.success,
      thumbnail:
        user.displayAvatarURL(),
      fields: [
        {
          name: '👤 العضو',
          value: userInfo(user)
        },

        {
          name: '😀 الرياكشن',
          value:
            reaction.emoji.toString()
        },

        {
          name: '📍 الروم',
          value: `${message.channel}`
        },

        {
          name: '💬 الرسالة',
          value:
            code(
              message.content ||
                'بدون نص',
              400
            )
        },

        {
          name:
            '🔗 رابط الرسالة',
          value:
            `[اضغط هنا للذهاب للرسالة](${message.url})`
        }
      ]
    });
  }
);

client.on(
  Events.MessageReactionRemove,
  async (
    reaction,
    user
  ) => {
    if (reaction.partial) {
      await reaction
        .fetch()
        .catch(() => null);
    }

    const message =
      reaction.message;

    if (
      !message.guild ||
      !isSource(message.guild)
    ) {
      return;
    }

    await sendLog('logs', {
      title:
        '➖ REACTION REMOVED',
      description:
        '**تم إزالة رياكشن**',
      color: COLORS.warning,
      thumbnail:
        user.displayAvatarURL(),
      fields: [
        {
          name: '👤 العضو',
          value: userInfo(user)
        },

        {
          name: '😀 الرياكشن',
          value:
            reaction.emoji.toString()
        },

        {
          name: '📍 الروم',
          value: `${message.channel}`
        },

        {
          name:
            '🔗 رابط الرسالة',
          value:
            `[اضغط هنا للذهاب للرسالة](${message.url})`
        }
      ]
    });
  }
);

// ============================================
// VOICE - COMPLETE STATE LOGGING
// ============================================

client.on(
  Events.VoiceStateUpdate,
  async (oldState, newState) => {
    const guild = newState.guild || oldState.guild;
    if (!guild || !isSource(guild)) return;

    const member = newState.member || oldState.member;
    const user = member?.user;
    if (!user) return;

    const channel = newState.channel || oldState.channel;
    const base = [
      {
        name: '👤 العضو',
        value: userInfo(user)
      }
    ];

    const channelText = state =>
      state?.channel
        ? `${state.channel} • \`${state.channelId}\``
        : 'لا يوجد';

    const joined = !oldState.channelId && Boolean(newState.channelId);
    const disconnected = Boolean(oldState.channelId) && !newState.channelId;
    const moved =
      Boolean(oldState.channelId) &&
      Boolean(newState.channelId) &&
      oldState.channelId !== newState.channelId;

    // ------------------------------
    // JOIN
    // ------------------------------
    if (joined) {
      await sendLog('voice', {
        title: '🔊 VOICE JOIN',
        description: '**دخل عضو روم صوتي**',
        color: COLORS.voice,
        thumbnail: user.displayAvatarURL(),
        fields: [
          ...base,
          {
            name: '📍 الروم',
            value: channelText(newState)
          },
          {
            name: '🛡️ بواسطة',
            value: userInfo(user)
          }
        ]
      });
    }

    // ------------------------------
    // DISCONNECT
    // ------------------------------
    if (disconnected) {
      const audit = await findVoiceAudit(
        guild,
        AuditLogEvent.MemberDisconnect,
        user.id,
        oldState.channelId,
        15000
      );

      const executor = audit?.executorId
        ? (audit.executor || await client.users.fetch(audit.executorId).catch(() => null))
        : null;

      if (!audit) {
        console.warn(`[NMR VOICE] No MemberDisconnect audit match for ${user.id} in ${oldState.channelId || 'unknown-channel'}.`);
      }

      // Admin disconnect: show the real executor.
      if (executor) {
        await sendLog('voice', {
          title: '📤 VOICE DISCONNECT',
          description: '**تم فصل العضو من الروم الصوتي**',
          color: COLORS.warning,
          thumbnail: user.displayAvatarURL(),
          fields: [
            ...base,
            {
              name: '📍 الروم السابق',
              value: channelText(oldState)
            },
            {
              name: '🛡️ بواسطة',
              value: userInfo(executor)
            }
          ]
        });
      } else {
        // Normal user leave.
        await sendLog('voice', {
          title: '📤 VOICE LEAVE',
          description: '**العضو خرج من الروم الصوتي**',
          color: COLORS.warning,
          thumbnail: user.displayAvatarURL(),
          fields: [
            ...base,
            {
              name: '📍 الروم السابق',
              value: channelText(oldState)
            },
            {
              name: '🛡️ بواسطة',
              value: userInfo(user)
            }
          ]
        });
      }
    }

    // ------------------------------
    // MOVE
    // ------------------------------
    if (moved) {
      const audit = await findVoiceAudit(
        guild,
        AuditLogEvent.MemberMove,
        user.id,
        newState.channelId,
        30000
      );

      const executor = audit?.executorId
        ? (audit.executor || await client.users.fetch(audit.executorId).catch(() => null))
        : null;

      await sendLog('voice', {
        title: '🔁 VOICE MOVE',
        description: executor
          ? '**تم نقل العضو بين الرومات الصوتية**'
          : '**العضو انتقل بين الرومات الصوتية**',
        color: COLORS.voice,
        thumbnail: user.displayAvatarURL(),
        fields: [
          ...base,
          {
            name: '⬅️ من',
            value: channelText(oldState)
          },
          {
            name: '➡️ إلى',
            value: channelText(newState)
          },
          {
            name: '🛡️ بواسطة',
            value: executor
              ? userInfo(executor)
              : userInfo(user)
          }
        ]
      });
    }

    // Join/move/disconnect are channel transitions; continue with other state
    // changes only when they actually changed.
    if (joined || disconnected || moved) {
      // Do not return: Discord can deliver a channel transition together with
      // mute/deaf/video changes in the same VoiceStateUpdate.
    }

    // ------------------------------
    // SERVER-SIDE VOICE ACTIONS
    // ------------------------------
    const adminChanges = [
      ['serverMute', 'mute', '🔇 SERVER MUTE', 'تم تغيير Server Mute للعضو'],
      ['serverDeaf', 'deaf', '🎧 SERVER DEAF', 'تم تغيير Server Deaf للعضو'],
      ['suppress', 'suppress', '🔕 STAGE SUPPRESS', 'تم تغيير حالة Stage Suppress للعضو']
    ];

    const changedAdminKeys = adminChanges
      .filter(([key]) => oldState[key] !== newState[key])
      .map(([key]) => key);

    if (changedAdminKeys.length) {
      const audit = await findVoiceMemberUpdateAudit(
        guild,
        user.id,
        changedAdminKeys.map(key =>
          key === 'serverMute'
            ? 'mute'
            : key === 'serverDeaf'
              ? 'deaf'
              : 'suppress'
        ),
        30000
      );

      for (const [key, auditKey, title, description] of adminChanges) {
        if (oldState[key] === newState[key]) continue;

        // For server-side actions, do NOT send a log without an identified
        // executor. This prevents false staff attribution.
        if (!audit?.executorId) continue;

        await sendLog('voice', {
          title,
          description,
          color: newState[key] ? COLORS.danger : COLORS.success,
          thumbnail: user.displayAvatarURL(),
          fields: [
            ...base,
            {
              name: '📍 الروم',
              value: channelText(newState)
            },
            {
              name: '📊 الحالة',
              value: newState[key]
                ? 'تم التفعيل 🔴'
                : 'تم الإلغاء 🟢'
            },
            {
              name: '🛡️ بواسطة',
              value: userInfo(audit.executor)
            }
          ]
        });
      }
    }

    // ------------------------------
    // SELF / CLIENT STATE
    // ------------------------------
    const selfChanges = [
      ['selfMute', '🔇 SELF MUTE', 'العضو قام بتغيير حالة المايك', COLORS.warning],
      ['selfDeaf', '🎧 SELF DEAF', 'العضو قام بتغيير حالة الصوت', COLORS.warning],
      ['streaming', '🖥️ SCREEN SHARE / STREAM', 'العضو قام بتغيير حالة الـ Stream / Screen Share', COLORS.purple],
      ['selfVideo', '📹 CAMERA', 'العضو قام بتغيير حالة الكاميرا', COLORS.voice]
    ];

    for (const [key, title, description, color] of selfChanges) {
      if (Boolean(oldState[key]) === Boolean(newState[key])) continue;

      await sendLog('voice', {
        title,
        description,
        color,
        thumbnail: user.displayAvatarURL(),
        fields: [
          ...base,
          {
            name: '📍 الروم',
            value: channelText(newState)
          },
          {
            name: '📊 الحالة',
            value: newState[key] ? 'ON / ENABLED ✅' : 'OFF / DISABLED ❌'
          },
          {
            name: '🛡️ بواسطة',
            value: userInfo(user)
          }
        ]
      });
    }

    // ------------------------------
    // REQUEST TO SPEAK
    // ------------------------------
    if (
      oldState.requestToSpeakTimestamp?.valueOf() !==
      newState.requestToSpeakTimestamp?.valueOf()
    ) {
      const requested = Boolean(newState.requestToSpeakTimestamp);

      await sendLog('voice', {
        title: requested ? '🎤 REQUEST TO SPEAK' : '🎤 REQUEST TO SPEAK CLEARED',
        description: requested
          ? '**العضو طلب التحدث في Stage**'
          : '**تم إلغاء طلب التحدث في Stage**',
        color: COLORS.voice,
        thumbnail: user.displayAvatarURL(),
        fields: [
          ...base,
          {
            name: '📍 الروم',
            value: channelText(newState)
          },
          {
            name: '🛡️ بواسطة',
            value: userInfo(user)
          }
        ]
      });
    }
  }
);

// ============================================
// BAN / UNBAN
// ============================================

client.on(
  Events.GuildBanAdd,
  async ban => {
    if (
      !isSource(ban.guild)
    ) {
      return;
    }

    const audit =
      await findAudit(
        ban.guild,
        AuditLogEvent.MemberBanAdd,
        ban.user.id
      );

    await sendLog('bans', {
      title:
        '🔨 MEMBER BANNED',
      description:
        '**تم حظر عضو من السيرفر**',
      color:
        COLORS.danger,
      thumbnail:
        ban.user.displayAvatarURL(),
      fields: [
        {
          name: '👤 العضو',
          value:
            userInfo(ban.user)
        },

        {
          name:
            '🛡️ بواسطة',
          value:
            await executorInfo(audit)
        },

        {
          name:
            '📝 السبب',
          value:
            audit?.reason ||
            'لا يوجد سبب'
        }
      ]
    });
  }
);

client.on(
  Events.GuildBanRemove,
  async ban => {
    if (
      !isSource(ban.guild)
    ) {
      return;
    }

    const audit =
      await findAudit(
        ban.guild,
        AuditLogEvent.MemberBanRemove,
        ban.user.id
      );

    await sendLog('bans', {
      title:
        '🔓 MEMBER UNBANNED',
      description:
        '**تم فك حظر عضو**',
      color:
        COLORS.success,
      thumbnail:
        ban.user.displayAvatarURL(),
      fields: [
        {
          name: '👤 العضو',
          value:
            userInfo(ban.user)
        },

        {
          name:
            '🛡️ بواسطة',
          value:
            await executorInfo(audit)
        }
      ]
    });
  }
);


// ============================================
// CHANNEL TYPE DISPLAY
// ============================================

function channelTypeName(type) {
  const types = {
    0: 'Text',
    2: 'Voice',
    4: 'Category',
    5: 'Announcement',
    10: 'Announcement Thread',
    11: 'Thread Public',
    12: 'Thread Private',
    13: 'Stage',
    15: 'Forum'
  };

  return types[type] || `Unknown (${type})`;
}

function channelMention(channel) {
  return channel?.id ? `<#${channel.id}>` : 'غير متاح';
}

// ============================================
// CHANNEL LOGS
// ============================================

client.on(
  Events.ChannelCreate,
  async channel => {
    if (
      !channel.guild ||
      !isSource(channel.guild)
    ) {
      return;
    }

    const audit =
      await findAudit(
        channel.guild,
        AuditLogEvent.ChannelCreate,
        channel.id
      );

    await sendLog('logs', {
      title:
        '➕ CHANNEL CREATED',
      description:
        '**تم إنشاء روم جديد**',
      color:
        COLORS.success,
      fields: [
        {
          name: '📍 الروم',
          value: channelMention(channel)
        },
        {
          name: '📌 اسم الروم',
          value: `\`${channel.name}\``
        },
        {
          name: '📂 نوع الروم',
          value: `\`${channelTypeName(channel.type)}\``
        },
        {
          name:
            '🛡️ بواسطة',
          value:
            await executorInfo(audit)
        }
      ]
    });
  }
);

client.on(
  Events.ChannelDelete,
  async channel => {
    if (
      !channel.guild ||
      !isSource(channel.guild)
    ) {
      return;
    }

    const audit =
      await findAudit(
        channel.guild,
        AuditLogEvent.ChannelDelete,
        channel.id
      );

    await sendLog('logs', {
      title:
        '🗑️ CHANNEL DELETED',
      description:
        '**تم حذف روم**',
      color:
        COLORS.danger,
      fields: [
        {
          name: '📌 الاسم',
          value: `\`${channel.name}\``
        },
        {
          name: '📂 النوع',
          value: `\`${channelTypeName(channel.type)}\``
        },
        {
          name:
            '🛡️ بواسطة',
          value:
            await executorInfo(audit)
        }
      ]
    });
  }
);

client.on(
  Events.ChannelUpdate,
  async (
    oldChannel,
    newChannel
  ) => {
    if (
      !newChannel.guild ||
      !isSource(newChannel.guild)
    ) {
      return;
    }

    const changes = [];

    if (
      oldChannel.name !==
      newChannel.name
    ) {
      changes.push(
        `**الاسم:** ${oldChannel.name} ➜ ${newChannel.name}`
      );
    }

    if (
      oldChannel.topic !==
      newChannel.topic
    ) {
      changes.push(
        `**Topic:** ${oldChannel.topic || 'لا يوجد'} ➜ ${newChannel.topic || 'لا يوجد'}`
      );
    }

    if (
      oldChannel.nsfw !==
      newChannel.nsfw
    ) {
      changes.push(
        `**NSFW:** ${oldChannel.nsfw} ➜ ${newChannel.nsfw}`
      );
    }

    if (
      oldChannel.rateLimitPerUser !==
      newChannel.rateLimitPerUser
    ) {
      changes.push(
        `**Slowmode:** ${oldChannel.rateLimitPerUser}s ➜ ${newChannel.rateLimitPerUser}s`
      );
    }

    if (
      oldChannel.bitrate !==
      newChannel.bitrate
    ) {
      changes.push(
        `**Bitrate:** ${oldChannel.bitrate} ➜ ${newChannel.bitrate}`
      );
    }

    if (
      oldChannel.userLimit !==
      newChannel.userLimit
    ) {
      changes.push(
        `**User Limit:** ${oldChannel.userLimit} ➜ ${newChannel.userLimit}`
      );
    }

    // Voice channel RTC region override. Discord exposes this as rtcRegion.
    // null means automatic/default region.
    if (oldChannel.rtcRegion !== newChannel.rtcRegion) {
      const oldRegion = oldChannel.rtcRegion || 'Automatic';
      const newRegion = newChannel.rtcRegion || 'Automatic';
      changes.push(
        `**RTC Region Override:** \`${oldRegion}\` ➜ \`${newRegion}\``
      );
    }

    const overwriteChanges =
      diffOverwrites(
        oldChannel,
        newChannel
      );

    if (
      !changes.length &&
      !overwriteChanges.length
    ) {
      return;
    }

    const cacheKey =
      `${newChannel.guild.id}:${newChannel.id}`;

    const cachedAudit =
      channelUpdateAuditCache.get(
        cacheKey
      );

    const cachedFresh =
      cachedAudit &&
      (
        Date.now() -
        cachedAudit.createdTimestamp <=
        30000
      );

    const audit =
      (
        cachedFresh
          ? cachedAudit
          : null
      ) ||
      await findAudit(
        newChannel.guild,
        [
          AuditLogEvent.ChannelUpdate,
          AuditLogEvent.ChannelOverwriteCreate,
          AuditLogEvent.ChannelOverwriteUpdate,
          AuditLogEvent.ChannelOverwriteDelete
        ].filter(Boolean),
        newChannel.id,
        30000
      );

    await sendLog('logs', {
      title:
        '✏️ CHANNEL UPDATED',
      description:
        '**تم تعديل روم**',
      color:
        COLORS.warning,
      fields: [
        {
          name: '📍 الروم',
          value: channelMention(newChannel)
        },
        {
          name: '📌 اسم الروم',
          value: `\`${newChannel.name}\``
        },
        {
          name: '📂 نوع الروم',
          value: `\`${channelTypeName(newChannel.type)}\``
        },

        ...(changes.length
          ? [
              {
                name:
                  '📝 التغييرات',
                value:
                  trim(
                    changes.join('\n'),
                    1000
                  )
              }
            ]
          : []),

        ...(overwriteChanges.length
          ? [
              {
                name:
                  '🔐 تغييرات صلاحيات الروم',
                value:
                  trim(
                    overwriteChanges.join('\n'),
                    1024
                  )
              }
            ]
          : []),

        {
          name:
            '🛡️ بواسطة',
          value:
            await executorInfo(audit)
        }
      ]
    });
  }
);

// ============================================
// PERMISSION DIFF HELPERS
// ============================================

const permissionNames =
  Object.fromEntries(
    Object.entries(
      PermissionsBitField.Flags
    ).map(
      ([name, bit]) => [
        bit.toString(),
        name
      ]
    )
  );

function diffPermissions(
  oldPerms,
  newPerms
) {
  const oldSet =
    new PermissionsBitField(
      oldPerms
    ).toArray();

  const newSet =
    new PermissionsBitField(
      newPerms
    ).toArray();

  const added =
    newSet.filter(
      x => !oldSet.includes(x)
    );

  const removed =
    oldSet.filter(
      x => !newSet.includes(x)
    );

  return {
    added,
    removed
  };
}

function permissionText(list) {
  return list.length
    ? list
        .map(
          (p, i) =>
            `**${i + 1}.** \`${p}\``
        )
        .join('\n')
    : 'لا يوجد';
}

function diffOverwrites(
  oldChannel,
  newChannel
) {
  const oldMap =
    oldChannel.permissionOverwrites.cache;

  const newMap =
    newChannel.permissionOverwrites.cache;

  const lines = [];

  const targetName = (
    overwrite,
    id
  ) => {
    if (overwrite.type === 0) {
      const role =
        newChannel.guild.roles.cache.get(
          id
        );

      return role
        ? `**${role.name}**`
        : `**Unknown Role**`;
    }

    const member =
      newChannel.guild.members.cache.get(
        id
      );

    return member
      ? `**${member.user.tag}**`
      : `**Unknown User**`;
  };

  for (const [id, nw] of newMap) {
    const ow =
      oldMap.get(id);

    const target =
      targetName(nw, id);

    if (!ow) {
      const added =
        nw.allow.toArray();

      const denied =
        nw.deny.toArray();

      const parts = [];

      if (added.length) {
        parts.push(
          `➕ ${added.map(x => '`' + x + '`').join(', ')}`
        );
      }

      if (denied.length) {
        parts.push(
          `🚫 ${denied.map(x => '`' + x + '`').join(', ')}`
        );
      }

      lines.push(
        `➕ **Permission Override جديد:** ${target}${parts.length ? ` — ${parts.join(' | ')}` : ''}`
      );

      continue;
    }

    const add =
      nw.allow
        .toArray()
        .filter(
          x => !ow.allow.has(x)
        );

    const rem =
      ow.allow
        .toArray()
        .filter(
          x => !nw.allow.has(x)
        );

    if (
      add.length ||
      rem.length
    ) {
      const parts = [];

      if (add.length) {
        parts.push(
          `➕ ${add.map(x => '`' + x + '`').join(', ')}`
        );
      }

      if (rem.length) {
        parts.push(
          `➖ ${rem.map(x => '`' + x + '`').join(', ')}`
        );
      }

      lines.push(
        `${target}: ${parts.join(' | ')}`
      );
    }
  }

  for (
    const [id, ow]
    of oldMap
  ) {
    if (!newMap.has(id)) {
      lines.push(
        `🗑️ **Permission Override تم حذفه:** ${targetName(ow, id)}`
      );
    }
  }

  return lines;
}

// ============================================
// ROLE LOGS - DEEP
// ============================================

client.on(
  Events.GuildRoleCreate,
  async role => {
    if (
      !isSource(role.guild)
    ) {
      return;
    }

    const audit =
      await findAudit(
        role.guild,
        AuditLogEvent.RoleCreate,
        role.id,
        20000
      );

    await sendLog('roles', {
      title:
        '➕ ROLE CREATED',
      description:
        '**تم إنشاء رتبة جديدة**',
      color:
        COLORS.success,
      fields: [
        {
          name: '🎭 الاسم',
          value:
            role.name
        },

        {
          name: '🆔 ID',
          value:
            `\`${role.id}\``
        },

        {
          name: '🎨 اللون',
          value:
            role.hexColor
        },

        {
          name:
            '📌 الترتيب',
          value:
            `\`${role.position}\``
        },

        {
          name:
            '🛡️ بواسطة',
          value:
            await executorInfo(audit)
        }
      ]
    });
  }
);

client.on(
  Events.GuildRoleDelete,
  async role => {
    if (
      !isSource(role.guild)
    ) {
      return;
    }

    const audit =
      await findAudit(
        role.guild,
        AuditLogEvent.RoleDelete,
        role.id,
        20000
      );

    await sendLog('roles', {
      title:
        '🗑️ ROLE DELETED',
      description:
        '**تم حذف رتبة**',
      color:
        COLORS.danger,
      fields: [
        {
          name: '🎭 الاسم',
          value:
            role.name
        },

        {
          name: '🆔 ID',
          value:
            `\`${role.id}\``
        },

        {
          name: '🎨 اللون',
          value:
            role.hexColor
        },

        {
          name:
            '🛡️ بواسطة',
          value:
            await executorInfo(audit)
        }
      ]
    });
  }
);

client.on(
  Events.GuildRoleUpdate,
  async (
    oldRole,
    newRole
  ) => {
    if (
      !isSource(newRole.guild)
    ) {
      return;
    }

    const changes = [];

    if (
      oldRole.name !==
      newRole.name
    ) {
      changes.push(
        `📝 **الاسم:** ${oldRole.name} ➜ ${newRole.name}`
      );
    }

    if (
      oldRole.hexColor !==
      newRole.hexColor
    ) {
      changes.push(
        `🎨 **اللون:** ${oldRole.hexColor} ➜ ${newRole.hexColor}`
      );
    }

    if (
      oldRole.hoist !==
      newRole.hoist
    ) {
      changes.push(
        `📌 **إظهار الرتبة:** ${oldRole.hoist ? 'نعم' : 'لا'} ➜ ${newRole.hoist ? 'نعم' : 'لا'}`
      );
    }

    if (
      oldRole.mentionable !==
      newRole.mentionable
    ) {
      changes.push(
        `🔔 **قابلة للمنشن:** ${oldRole.mentionable ? 'نعم' : 'لا'} ➜ ${newRole.mentionable ? 'نعم' : 'لا'}`
      );
    }

    const permissionDiff =
      diffPermissions(
        oldRole.permissions,
        newRole.permissions
      );

    if (
      permissionDiff.added.length ||
      permissionDiff.removed.length
    ) {
      changes.push(
        '🔐 **تم تعديل صلاحيات الرتبة**'
      );
    }

    if (!changes.length) {
      return;
    }

    const audit =
      await findAudit(
        newRole.guild,
        AuditLogEvent.RoleUpdate,
        newRole.id,
        20000
      );

    await sendLog('roles', {
      title:
        '✏️ ROLE UPDATED',
      description:
        '**تم تعديل رتبة**',
      color:
        COLORS.role,
      fields: [
        {
          name: '🎭 الرتبة',
          value:
            roleInfo(newRole)
        },

        {
          name:
            '📝 التغييرات',
          value:
            trim(
              changes.join('\n'),
              1000
            )
        },

        ...(permissionDiff.added.length
          ? [
              {
                name:
                  `➕ صلاحيات تمت إضافتها (${permissionDiff.added.length})`,
                value:
                  trim(
                    permissionText(
                      permissionDiff.added
                    ),
                    1024
                  )
              }
            ]
          : []),

        ...(permissionDiff.removed.length
          ? [
              {
                name:
                  `➖ صلاحيات تمت إزالتها (${permissionDiff.removed.length})`,
                value:
                  trim(
                    permissionText(
                      permissionDiff.removed
                    ),
                    1024
                  )
              }
            ]
          : []),

        {
          name:
            '🛡️ بواسطة',
          value:
            await executorInfo(audit)
        }
      ]
    });
  }
);

// ============================================
// MEMBER ROLE ASSIGN / REMOVE LOGS
// ============================================

client.on(
  Events.GuildMemberUpdate,
  async (
    oldMember,
    newMember
  ) => {
    if (
      !isSource(newMember.guild)
    ) {
      return;
    }

    // Nickname changes
    if (oldMember.nickname !== newMember.nickname) {
      const audit = await findAudit(
        newMember.guild,
        AuditLogEvent.MemberUpdate,
        newMember.id,
        20000,
        'nick'
      );

      await sendLog('logs', {
        title: '✏️ NICKNAME UPDATED',
        description: '**تم تغيير اسم العضو داخل السيرفر**',
        color: COLORS.warning,
        thumbnail: newMember.user.displayAvatarURL(),
        fields: [
          { name: '👤 العضو', value: memberInfo(newMember) },
          {
            name: '⬅️ الاسم القديم',
            value: oldMember.nickname || oldMember.user.username
          },
          {
            name: '➡️ الاسم الجديد',
            value: newMember.nickname || newMember.user.username
          },
          {
            name: '🛡️ بواسطة',
            value: await executorInfo(audit, newMember.user)
          }
        ]
      });
    }

    // Timeout changes
    const oldTimeout = oldMember.communicationDisabledUntilTimestamp || null;
    const newTimeout = newMember.communicationDisabledUntilTimestamp || null;

    if (oldTimeout !== newTimeout) {
      const audit = await findAudit(
        newMember.guild,
        AuditLogEvent.MemberUpdate,
        newMember.id,
        20000,
        'communication_disabled_until'
      );

      await sendLog('logs', {
        title: newTimeout ? '⏳ MEMBER TIMEOUT' : '✅ TIMEOUT REMOVED',
        description: newTimeout
          ? '**تم إعطاء العضو Timeout**'
          : '**تم إزالة Timeout من العضو**',
        color: newTimeout ? COLORS.danger : COLORS.success,
        thumbnail: newMember.user.displayAvatarURL(),
        fields: [
          { name: '👤 العضو', value: memberInfo(newMember) },
          {
            name: '⏱️ المدة',
            value: newTimeout
              ? `<t:${Math.floor(newTimeout / 1000)}:F>`
              : 'تم الإلغاء'
          },
          {
            name: '🛡️ بواسطة',
            value: await executorInfo(audit, newMember.user)
          }
        ]
      });
    }

    const added =
      newMember.roles.cache.filter(
        r =>
          !oldMember.roles.cache.has(
            r.id
          )
      );

    const removed =
      oldMember.roles.cache.filter(
        r =>
          !newMember.roles.cache.has(
            r.id
          )
      );

    if (
      !added.size &&
      !removed.size
    ) {
      return;
    }

    // Strict role attribution: if Discord did not expose the matching
    // Audit Log entry (executor + target + changed role), do NOT send a log.
    let audit = null;

    try {
      const actionKey = added.size && !removed.size
        ? '$add'
        : removed.size && !added.size
          ? '$remove'
          : null;

      const changedRoleIds = new Set([
        ...added.keys(),
        ...removed.keys()
      ]);

      audit = await findStrictMemberRoleAudit(
        newMember.guild,
        newMember.id,
        changedRoleIds,
        actionKey,
        30000
      );
    } catch {}

    // No Discord audit entry = no role log. This prevents false executor logs.
    if (!audit?.executorId && !audit?.executor?.id) {
      return;
    }

    const fields = [
      {
        name: '👤 العضو',
        value:
          memberInfo(newMember)
      }
    ];

    if (added.size) {
      fields.push({
        name:
          `➕ الرولات المضافة (${added.size})`,
        value:
          trim(
            [
              ...added.values()
            ]
              .map(
                r =>
                  `• **${r.name}**\n\`${r.id}\``
              )
              .join('\n'),
            1024
          )
      });
    }

    if (removed.size) {
      fields.push({
        name:
          `➖ الرولات المحذوفة (${removed.size})`,
        value:
          trim(
            [
              ...removed.values()
            ]
              .map(
                r =>
                  `• **${r.name}**\n\`${r.id}\``
              )
              .join('\n'),
            1024
          )
      });
    }

    fields.push({
      name:
        '🛡️ بواسطة',
      value:
        await executorInfo(audit)
    });

    await sendLog('roles', {
      title:
        added.size &&
        removed.size
          ? '🔄 MEMBER ROLES UPDATED'
          : added.size
            ? '➕ ROLE ADDED TO MEMBER'
            : '➖ ROLE REMOVED FROM MEMBER',

      description:
        '**تم تغيير رولات عضو**',

      color:
        added.size
          ? COLORS.success
          : COLORS.danger,

      fields
    });
  }
);

// ============================================
// MEMBER JOIN / LEAVE + INVITE TRACKING
// ============================================

async function refreshInviteCache(guild) {
  if (
    !guild ||
    !isSource(guild)
  ) {
    return null;
  }

  const invites =
    await guild.invites
      .fetch()
      .catch(() => null);

  if (!invites) {
    return null;
  }

  const map = new Map();

  for (
    const invite
    of invites.values()
  ) {
    map.set(
      invite.code,
      {
        uses:
          invite.uses ?? 0,
        inviterId:
          invite.inviter?.id ||
          null,
        inviterTag:
          invite.inviter?.tag ||
          null
      }
    );
  }

  inviteCache.set(
    guild.id,
    map
  );

  return map;
}

async function findUsedInvite(guild) {
  const oldInvites =
    inviteCache.get(
      guild.id
    ) || new Map();

  const newInvites =
    await guild.invites
      .fetch()
      .catch(() => null);

  if (!newInvites) {
    return null;
  }

  let usedInvite = null;

  for (
    const invite
    of newInvites.values()
  ) {
    const old =
      oldInvites.get(
        invite.code
      );

    const oldUses =
      old?.uses ?? 0;

    const newUses =
      invite.uses ?? 0;

    if (
      newUses > oldUses
    ) {
      usedInvite =
        invite;
      break;
    }
  }

  const newCache =
    new Map();

  for (
    const invite
    of newInvites.values()
  ) {
    newCache.set(
      invite.code,
      {
        uses:
          invite.uses ?? 0,
        inviterId:
          invite.inviter?.id ||
          null,
        inviterTag:
          invite.inviter?.tag ||
          null
      }
    );
  }

  inviteCache.set(
    guild.id,
    newCache
  );

  return usedInvite;
}

client.on(
  Events.ClientReady,
  async () => {
    botReady = true;

    await sendBotState(
      '🟢 BOT ONLINE',
      '**البوت اشتغل واتصل بـ Discord بنجاح.**',
      COLORS.success
    );

    for (
      const guild
      of client.guilds.cache.values()
    ) {
      if (
        isSource(guild)
      ) {
        await refreshInviteCache(
          guild
        );
      }
    }

    const sourceGuild = client.guilds.cache.get(CONFIG.sourceGuildId);
    if (sourceGuild) {
      await syncHistoricalMessages(sourceGuild);
    }
  }
);

client.on(
  Events.GuildMemberAdd,
  async member => {
    if (
      !isSource(member.guild)
    ) {
      return;
    }

    const invite =
      await findUsedInvite(
        member.guild
      );

    let inviterText =
      '⚠️ لم يتم تحديد صاحب الدعوة';

    if (invite?.inviter) {
      inviterText =
        userInfo(
          invite.inviter
        );
    } else if (
      invite?.inviterId
    ) {
      inviterText =
        `<@${invite.inviterId}>`;
    }

    await sendLog('logs', {
      title:
        '📥 MEMBER JOINED',

      description:
        '**عضو جديد دخل السيرفر**',

      color:
        COLORS.success,

      thumbnail:
        member.user.displayAvatarURL(),

      fields: [
        {
          name: '👤 العضو',
          value:
            userInfo(member.user)
        },

        {
          name:
            '🔗 تمت دعوته بواسطة',
          value:
            inviterText
        },

        {
          name:
            '🔑 كود الدعوة',
          value:
            invite?.code
              ? `\`${invite.code}\``
              : 'غير متاح'
        },

        {
          name:
            '🕒 وقت الدخول',
          value:
            `<t:${Math.floor(Date.now() / 1000)}:F>`
        }
      ]
    });
  }
);

client.on(
  Events.GuildMemberRemove,
  async member => {
    if (
      !isSource(member.guild)
    ) {
      return;
    }

    // Kick/Ban already have dedicated logs. Do not create a fake "left server" log.
    const kickAudit = await findAudit(
      member.guild,
      AuditLogEvent.MemberKick,
      member.id,
      12000,
      null,
      { consume: false }
    );

    if (kickAudit) return;

    const banAudit = await findAudit(
      member.guild,
      AuditLogEvent.MemberBanAdd,
      member.id,
      12000,
      null,
      { consume: false }
    );

    if (banAudit) return;

    await sendLog('logs', {
      title:
        '📤 MEMBER LEFT',

      description:
        '**عضو خرج من السيرفر**',

      color:
        COLORS.warning,

      thumbnail:
        member.user.displayAvatarURL(),

      fields: [
        {
          name: '👤 العضو',
          value:
            userInfo(member.user)
        },

        {
          name:
            '🕒 وقت الخروج',
          value:
            `<t:${Math.floor(Date.now() / 1000)}:F>`
        }
      ]
    });
  }
);

// ============================================
// INVITES / EMOJIS / STICKERS
// ============================================

client.on(
  Events.InviteCreate,
  async invite => {
    if (
      !invite.guild ||
      !isSource(invite.guild)
    ) {
      return;
    }

    const invites =
      await invite.guild.invites
        .fetch()
        .catch(() => null);

    if (invites) {
      inviteCache.set(
        invite.guild.id,
        new Map(
          invites.map(
            i => [
              i.code,
              i.uses
            ]
          )
        )
      );
    }

    await sendLog('logs', {
      title:
        '🔗 INVITE CREATED',
      description:
        '**تم إنشاء دعوة جديدة**',
      color:
        COLORS.success,
      fields: [
        {
          name:
            '🔗 الدعوة',
          value:
            `\`discord.gg/${invite.code}\``
        },

        {
          name:
            '👤 بواسطة',
          value:
            invite.inviter
              ? userInfo(
                  invite.inviter
                )
              : '⚠️ Discord لم يرسل بيانات منشئ الدعوة'
        },

        {
          name:
            '📍 الروم',
          value:
            invite.channel
              ? `${invite.channel}`
              : 'بيانات الروم غير متاحة'
        },

        {
          name:
            '⏳ تنتهي بعد',
          value:
            invite.maxAge
              ? `${invite.maxAge} ثانية`
              : 'لا تنتهي'
        },

        {
          name:
            '🔢 الحد الأقصى',
          value:
            invite.maxUses
              ? `${invite.maxUses}`
              : 'غير محدود'
        }
      ]
    });
  }
);

client.on(
  Events.InviteDelete,
  async invite => {
    if (
      !invite.guild ||
      !isSource(invite.guild)
    ) {
      return;
    }

    const audit = await findAudit(
      invite.guild,
      AuditLogEvent.InviteDelete,
      invite.code,
      20000
    );

    await sendLog('logs', {
      title:
        '🗑️ INVITE DELETED',
      description:
        '**تم حذف دعوة**',
      color:
        COLORS.danger,
      fields: [
        {
          name:
            '🔗 Code',
          value:
            `${invite.code}`
        }
      ]
    });
  }
);

client.on(
  Events.GuildEmojiCreate,
  async emoji => {
    if (
      !isSource(emoji.guild)
    ) {
      return;
    }

    const audit = await findAudit(emoji.guild, AuditLogEvent.EmojiCreate, emoji.id, 20000);

    await sendLog('logs', {
      title:
        '😀 EMOJI CREATED',
      description:
        '**تم إضافة Emoji**',
      color:
        COLORS.success,
      thumbnail:
        emoji.url,
      fields: [
        {
          name:
            '😀 Emoji',
          value:
            emoji.toString()
        },

        {
          name:
            '📌 الاسم',
          value:
            emoji.name
        },

        {
          name:
            '🆔 ID',
          value:
            `\`${emoji.id}\``
        },
        { name: '🛡️ بواسطة', value: await executorInfo(audit) }
      ]
    });
  }
);

client.on(
  Events.GuildEmojiDelete,
  async emoji => {
    if (
      !isSource(emoji.guild)
    ) {
      return;
    }

    await sendLog('logs', {
      title:
        '🗑️ EMOJI DELETED',
      description:
        '**تم حذف Emoji**',
      color:
        COLORS.danger,
      fields: [
        {
          name:
            '📌 الاسم',
          value:
            emoji.name
        },

        {
          name:
            '🆔 ID',
          value:
            `\`${emoji.id}\``
        }
      ]
    });
  }
);

client.on(
  Events.GuildStickerCreate,
  async sticker => {
    if (
      !isSource(sticker.guild)
    ) {
      return;
    }

    await sendLog('logs', {
      title:
        '🎟️ STICKER CREATED',
      description:
        '**تم إضافة Sticker**',
      color:
        COLORS.success,
      fields: [
        {
          name:
            '📌 الاسم',
          value:
            sticker.name
        },

        {
          name:
            '🆔 ID',
          value:
            `\`${sticker.id}\``
        }
      ]
    });
  }
);

client.on(
  Events.GuildStickerDelete,
  async sticker => {
    if (
      !isSource(sticker.guild)
    ) {
      return;
    }

    await sendLog('logs', {
      title:
        '🗑️ STICKER DELETED',
      description:
        '**تم حذف Sticker**',
      color:
        COLORS.danger,
      fields: [
        {
          name:
            '📌 الاسم',
          value:
            sticker.name
        },

        {
          name:
            '🆔 ID',
          value:
            `\`${sticker.id}\``
        }
      ]
    });
  }
);

// ============================================
// KICKS + EXTRA AUDIT EVENTS
// ============================================

const auditSeen =
  new Set();

const channelUpdateAuditCache =
  new Map();

const messageDeleteAuditCache =
  new Map();

client.on(
  Events.GuildAuditLogEntryCreate,
  async (
    entry,
    guild
  ) => {
    if (
      !isSource(guild)
    ) {
      return;
    }

    const key =
      `${guild.id}-${entry.id}`;

    if (
      auditSeen.has(key)
    ) {
      return;
    }

    auditSeen.add(key);

    setTimeout(
      () =>
        auditSeen.delete(key),
      60000
    );

    if (
      entry.action ===
        AuditLogEvent.MessageDelete &&
      entry.targetId
    ) {
      messageDeleteAuditCache.set(
        `${guild.id}:${entry.targetId}`,
        entry
      );

      setTimeout(() => {
        const current =
          messageDeleteAuditCache.get(
            `${guild.id}:${entry.targetId}`
          );

        if (
          current?.id ===
          entry.id
        ) {
          messageDeleteAuditCache.delete(
            `${guild.id}:${entry.targetId}`
          );
        }
      }, 60000);
    }

    if (
      [
        AuditLogEvent.ChannelUpdate,
        AuditLogEvent.ChannelOverwriteCreate,
        AuditLogEvent.ChannelOverwriteUpdate,
        AuditLogEvent.ChannelOverwriteDelete
      ]
        .filter(Boolean)
        .includes(entry.action) &&
      entry.targetId
    ) {
      channelUpdateAuditCache.set(
        `${guild.id}:${entry.targetId}`,
        entry
      );

      setTimeout(
        () =>
          channelUpdateAuditCache.delete(
            `${guild.id}:${entry.targetId}`
          ),
        60000
      );
    }


    // Cache voice-related audit entries immediately. This greatly reduces the
    // race between VoiceStateUpdate and Discord's audit-log propagation.
    if (
      [
        AuditLogEvent.MemberMove,
        AuditLogEvent.MemberDisconnect,
        AuditLogEvent.MemberUpdate
      ].filter(Boolean).includes(entry.action) &&
      entry.targetId &&
      entry.executorId
    ) {
      voiceAuditCache.set(
        voiceAuditCacheKey(guild.id, entry.action, entry.targetId),
        entry
      );

      setTimeout(() => {
        const key = voiceAuditCacheKey(guild.id, entry.action, entry.targetId);
        const current = voiceAuditCache.get(key);
        if (current?.id === entry.id) {
          voiceAuditCache.delete(key);
        }
      }, 60000);
    }

    queueVoiceAuditEntry(guild, entry);

    const webhookActions = [
      AuditLogEvent.WebhookCreate,
      AuditLogEvent.WebhookUpdate,
      AuditLogEvent.WebhookDelete
    ].filter(Boolean);

    if (webhookActions.includes(entry.action)) {
      const webhookNames = {
        [AuditLogEvent.WebhookCreate]: '➕ WEBHOOK CREATED',
        [AuditLogEvent.WebhookUpdate]: '✏️ WEBHOOK UPDATED',
        [AuditLogEvent.WebhookDelete]: '🗑️ WEBHOOK DELETED'
      };

      await sendLog('logs', {
        title: webhookNames[entry.action] || '🔗 WEBHOOK ACTION',
        description: '**تم تنفيذ عملية على Webhook**',
        color: entry.action === AuditLogEvent.WebhookDelete
          ? COLORS.danger
          : entry.action === AuditLogEvent.WebhookCreate
            ? COLORS.success
            : COLORS.warning,
        fields: [
          {
            name: '🆔 Webhook ID',
            value: entry.targetId ? "`" + entry.targetId + "`" : 'غير متاح'
          },
          {
            name: '🛡️ بواسطة',
            value: await executorInfo(entry)
          },
          {
            name: '📝 السبب',
            value: entry.reason || 'لم يتم تقديم سبب'
          }
        ]
      });
    }

    if (
      entry.action ===
      AuditLogEvent.MemberKick
    ) {
      await sendLog('kicks', {
        title:
          '👢 MEMBER KICKED',

        description:
          '**تم طرد عضو من السيرفر**',

        color:
          COLORS.danger,

        fields: [
          {
            name:
              '👤 الشخص الذي تم طرده',

            value:
              entry.target
                ? targetUserInfo(
                    entry.target
                  )
                : `\`${entry.targetId}\``
          },

          {
            name:
              '🛡️ تم الطرد بواسطة',

            value:
              entry.executor
                ? targetUserInfo(
                    entry.executor
                  )
                : (
                    entry.executorId
                      ? `<@${entry.executorId}>`
                      : '⚠️ Discord لم يرسل بيانات منفذ العملية'
                  )
          },

          {
            name:
              '📝 سبب الطرد',

            value:
              entry.reason ||
              'لم يتم تقديم سبب'
          }
        ]
      });
    }
  }
);

// ============================================
// ERROR HANDLING + BOT STATE
// ============================================

client.on(
  Events.Error,
  async error => {
    console.error(
      '[DISCORD ERROR]',
      error
    );

    if (botReady) {
      await sendBotState(
        '⚠️ BOT ERROR',
        `حدث خطأ في اتصال Discord أو البوت:\n\`${trim(error?.message || error, 800)}\``,
        COLORS.warning
      );
    }
  }
);

process.on(
  'SIGINT',
  () =>
    gracefulExit(
      'SIGINT',
      0
    )
);

process.on(
  'SIGTERM',
  () =>
    gracefulExit(
      'SIGTERM',
      0
    )
);

process.on(
  'unhandledRejection',
  async error => {
    console.error(
      '[UNHANDLED REJECTION]',
      error
    );

    if (botReady) {
      await sendBotState(
        '⚠️ UNHANDLED ERROR',
        `حدث خطأ غير متوقع:\n\`${trim(error?.message || error, 800)}\``,
        COLORS.warning
      );
    }
  }
);

process.on(
  'uncaughtException',
  async error => {
    console.error(
      '[UNCAUGHT EXCEPTION]',
      error
    );

    if (botReady) {
      try {
        await sendBotState(
          '💥 BOT CRASHED',
          `حدث Crash:\n\`${trim(error?.stack || error?.message || error, 900)}\``,
          COLORS.danger
        );
      } catch {}
    }

    setTimeout(
      () =>
        gracefulExit(
          'CRASH',
          1
        ),
      800
    );
  }
);

if (
  !CONFIG.sourceGuildId ||
  !CONFIG.logGuildId
) {
  console.warn(
    '⚠️ SOURCE_GUILD_ID or LOG_GUILD_ID is missing in .env'
  );
}

if (!CONFIG.token) {
  console.error(
    '❌ TOKEN is missing in .env'
  );

  process.exit(1);
}

client.login(
  CONFIG.token
);

// ============================================
// DEEP SERVER SETTINGS LOGS
// ============================================

client.on(
  Events.GuildUpdate,
  async (
    oldGuild,
    newGuild
  ) => {
    if (
      !isSource(newGuild)
    ) {
      return;
    }

    const changes = [];

    if (
      oldGuild.name !==
      newGuild.name
    ) {
      changes.push(
        `📝 **الاسم:** ${oldGuild.name} ➜ ${newGuild.name}`
      );
    }

    if (
      oldGuild.icon !==
      newGuild.icon
    ) {
      changes.push(
        '🖼️ **تم تغيير صورة السيرفر**'
      );
    }

    if (
      oldGuild.banner !==
      newGuild.banner
    ) {
      changes.push(
        '🎨 **تم تغيير Banner السيرفر**'
      );
    }

    if (
      oldGuild.splash !==
      newGuild.splash
    ) {
      changes.push(
        '✨ **تم تغيير Splash السيرفر**'
      );
    }

    if (
      oldGuild.vanityURLCode !==
      newGuild.vanityURLCode
    ) {
      changes.push(
        `🔗 **Vanity Link:** ${oldGuild.vanityURLCode || 'لا يوجد'} ➜ ${newGuild.vanityURLCode || 'لا يوجد'}`
      );
    }

    if (
      oldGuild.description !==
      newGuild.description
    ) {
      changes.push(
        '📄 **تم تغيير وصف السيرفر**'
      );
    }

    if (
      oldGuild.verificationLevel !==
      newGuild.verificationLevel
    ) {
      changes.push(
        '🛡️ **تم تغيير Verification Level**'
      );
    }

    if (
      oldGuild.defaultMessageNotifications !==
      newGuild.defaultMessageNotifications
    ) {
      changes.push(
        '🔔 **تم تغيير Message Notifications**'
      );
    }

    if (
      oldGuild.explicitContentFilter !==
      newGuild.explicitContentFilter
    ) {
      changes.push(
        '🔞 **تم تغيير Content Filter**'
      );
    }

    if (
      oldGuild.afkChannelId !==
      newGuild.afkChannelId
    ) {
      changes.push(
        '💤 **تم تغيير AFK Channel**'
      );
    }

    if (
      oldGuild.afkTimeout !==
      newGuild.afkTimeout
    ) {
      changes.push(
        `⏱️ **AFK Timeout:** ${oldGuild.afkTimeout} ➜ ${newGuild.afkTimeout}`
      );
    }

    if (!changes.length) {
      return;
    }

    const audit =
      await findAudit(
        newGuild,
        AuditLogEvent.GuildUpdate,
        newGuild.id,
        30000
      );

    await sendLog('logs', {
      title:
        '⚙️ SERVER UPDATED',

      description:
        '**تم تعديل إعدادات أو بيانات السيرفر**',

      color:
        COLORS.warning,

      thumbnail:
        newGuild.iconURL({
          size: 512
        }) || null,

      image:
        oldGuild.banner !==
          newGuild.banner &&
        newGuild.bannerURL
          ? newGuild.bannerURL({
              size: 1024
            })
          : null,

      fields: [
        {
          name:
            '🏠 السيرفر',
          value:
            `**${newGuild.name}** • \`${newGuild.id}\``
        },

        {
          name:
            '📝 التعديلات',
          value:
            trim(
              changes.join('\n'),
              1024
            )
        },

        {
          name:
            '🛡️ تم بواسطة',
          value:
            await executorInfo(audit)
        }
      ]
    });
  }
);
