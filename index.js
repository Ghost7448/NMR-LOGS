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
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (error) {
  console.error('[NMR DB] node:sqlite is unavailable. Node.js 22.5+ is required. Database logging will be disabled.');
}

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

// Persistent message database: deleted messages can still be recovered after cache expiry/restart.
// Uses Node's built-in SQLite support. If unavailable, the bot continues without the DB.
let messageDb = null;
try {
  if (DatabaseSync) {
    messageDb = new DatabaseSync(path.join(__dirname, 'messages.db'));
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
        created_timestamp INTEGER,
        updated_timestamp INTEGER
      )
    `);
  }
} catch (error) {
  console.error('[NMR DB INIT ERROR]', error?.stack || error?.message || error);
  messageDb = null;
}

function dbRun(sql, params = []) {
  if (!messageDb) return null;
  try {
    return messageDb.prepare(sql).run(...params);
  } catch (error) {
    console.error('[NMR DB WRITE ERROR]', error?.message || error);
    return null;
  }
}

function dbGet(sql, params = []) {
  if (!messageDb) return null;
  try {
    return messageDb.prepare(sql).get(...params);
  } catch (error) {
    console.error('[NMR DB READ ERROR]', error?.message || error);
    return null;
  }
}

async function saveMessageToDb(message) {
  if (!message?.guild || !message.id || !messageDb) return;

  try {
    const attachments = [...(message.attachments?.values?.() || [])].map(a => ({
      name: a.name, url: a.url, contentType: a.contentType
    }));
    const embeds = [...(message.embeds || [])].map(e => ({
      title: e.title,
      description: e.description,
      url: e.url,
      fields: (e.fields || []).map(f => ({ name: f.name, value: f.value, inline: f.inline })),
      author: e.author ? { name: e.author.name, url: e.author.url, iconURL: e.author.iconURL } : null,
      footer: e.footer ? { text: e.footer.text, iconURL: e.footer.iconURL } : null
    }));

    dbRun(`
      INSERT INTO messages (id, guild_id, channel_id, channel_name, author_id, author_tag, avatar, content, attachments, embeds, created_timestamp, updated_timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        channel_id=excluded.channel_id, channel_name=excluded.channel_name,
        author_id=excluded.author_id, author_tag=excluded.author_tag, avatar=excluded.avatar,
        content=excluded.content, attachments=excluded.attachments, embeds=excluded.embeds,
        updated_timestamp=excluded.updated_timestamp
    `, [
      message.id, message.guild.id, message.channel?.id || null, message.channel?.name || null,
      message.author?.id || null, message.author?.tag || null, message.author?.displayAvatarURL?.() || null,
      message.content || '', JSON.stringify(attachments), JSON.stringify(embeds),
      message.createdTimestamp || Date.now(), Date.now()
    ]);
  } catch (error) {
    console.error('[NMR MESSAGE SAVE ERROR]', error?.message || error);
  }
}

async function getMessageFromDb(messageId) {
  if (!messageId || !messageDb) return null;
  try {
    const row = dbGet('SELECT * FROM messages WHERE id = ?', [messageId]);
    if (!row) return null;
    return {
      id: row.id, content: row.content || '', authorId: row.author_id, authorTag: row.author_tag,
      avatar: row.avatar, channelId: row.channel_id, channelName: row.channel_name,
      attachments: JSON.parse(row.attachments || '[]'), embeds: JSON.parse(row.embeds || '[]'),
      createdTimestamp: row.created_timestamp
    };
  } catch (error) {
    console.error('[NMR MESSAGE READ ERROR]', error?.message || error);
    return null;
  }
}

async function deleteMessageFromDb(messageId) {
  // Keep records permanently so deleted-message content remains recoverable.
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
  if (text === null || text === undefined || text === '') return 'لا يوجد';
  text = String(text);
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function code(text, max = 900) {
  return `\`\`\`\n${trim(text, max)}\n\`\`\``;
}

function userInfo(user) {
  if (!user) return 'لم يتم تحديد المستخدم';
  return `${user.tag || user.username}\n<@${user.id}> • \`${user.id}\``;
}

async function executorInfo(entry, fallbackUser = null) {
  const executorId = entry?.executorId || entry?.executor?.id || null;
  if (executorId) {
    const executor = entry?.executor || await client.users.fetch(executorId).catch(() => null);
    if (executor) return userInfo(executor);
    return `<@${executorId}>`;
  }
  if (fallbackUser?.id) return userInfo(fallbackUser);
  return '⚠️ Discord لم يرسل بيانات منفذ العملية';
}

function memberInfo(member) {
  if (!member) return 'لم يتم تحديد العضو';
  return `${member.user.tag}\n<@${member.id}> • \`${member.id}\``;
}

// اسم الرول كنص عادي فقط - بدون @Role mention
function roleInfo(role, fallbackId) {
  if (!role) return `Unknown Role\n\`${fallbackId || 'Unknown'}\``;
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
  const id = CONFIG.channels[type] || (type === 'roles' ? CONFIG.channels.logs : null);
  if (!id) return null;

  const guild = client.guilds.cache.get(CONFIG.logGuildId);
  if (!guild) return null;

  const channel = guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null);
  return channel?.isTextBased() ? channel : null;
}

async function sendLog(type, options = {}) {
  try {
    const channel = await getChannel(type);

    if (!channel) {
      console.warn(`[NMR LOGS] Missing or inaccessible ${type.toUpperCase()} channel.`);
      return false;
    }

    const embed = new EmbedBuilder()
      .setColor(options.color ?? COLORS.info)
      .setTitle(options.title ?? 'NMR LOG')
      .setDescription(trim(options.description ?? 'حدث جديد في السيرفر', 4096))
      .setTimestamp()
      .setFooter({
        text: `𝓝𝓜𝓡 𝓛𝓞𝓖𝓢 | ${timestamp()}`,
        iconURL: CONFIG.footerIcon
      });

    if (options.author?.name) {
      embed.setAuthor({
        name: trim(options.author.name, 256),
        iconURL: options.author.iconURL || undefined
      });
    }

    if (options.thumbnail) embed.setThumbnail(options.thumbnail);
    if (options.image) embed.setImage(options.image);

    if (options.fields?.length) {
      embed.addFields(
        options.fields.slice(0, 25).map(field => ({
          name: trim(field.name, 256),
          value: trim(field.value, 1024),
          inline: Boolean(field.inline)
        }))
      );
    }

    await channel.send({ embeds: [embed] });
    return true;
  } catch (error) {
    console.error('[NMR LOGS SEND ERROR]', error?.stack || error?.message || error);
    return false;
  }
}

async function findAudit(guild, type, targetId, maxAge = 15000, changeKey = null) {
  const types = Array.isArray(type) ? type : [type];

  // Discord Audit Logs sometimes arrive slightly after the gateway event.
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await wait(700);

    for (const auditType of types) {
      try {
        const logs = await guild.fetchAuditLogs({ type: auditType, limit: 25 });
        const entry = logs.entries.find(entry => {
          const targetMatches = !targetId || entry.targetId === targetId;
          const fresh = Date.now() - entry.createdTimestamp <= maxAge;
          const changeMatches = !changeKey || entry.changes?.some(change => change.key === changeKey);
          return targetMatches && fresh && changeMatches;
        });
        if (entry) return entry;
      } catch {}
    }
  }
  return null;
}



// ============================================
// BOT STATE / PROCESS STATUS
// ============================================
let botReady = false;
let shuttingDown = false;

async function sendBotState(title, description, color = COLORS.info, extraFields = []) {
  try {
    await sendLog('botState', {
      title,
      description,
      color,
      fields: [
        { name: '🤖 البوت', value: client.user ? `${client.user.tag}\n\`${client.user.id}\`` : 'NMR LOGS' },
        { name: '🕒 الوقت', value: `<t:${Math.floor(Date.now() / 1000)}:F>` },
        ...extraFields
      ]
    });
  } catch (error) {
    console.error('[BOT STATE LOG ERROR]', error?.stack || error?.message || error);
  }
}

async function gracefulExit(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  if (botReady) {
    await sendBotState(
      signal === 'CRASH' ? '💥 BOT CRASHED' : '🛑 BOT STOPPED',
      signal === 'CRASH'
        ? '**البوت حصل له Crash وسيتم إغلاق العملية**'
        : `**تم إيقاف البوت بشكل منظم (${signal})**`,
      signal === 'CRASH' ? COLORS.danger : COLORS.warning
    );
  }

  try { client.destroy(); } catch {}
  process.exit(exitCode);
}

// Voice audit entries can have no direct targetId for MOVE/DISCONNECT.
// Search recent entries by action + channel/count and fall back to the newest fresh entry.
async function findVoiceAudit(guild, type, channelId, maxAge = 30000) {
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt) await wait(650);
    try {
      const logs = await guild.fetchAuditLogs({ type, limit: 50 });
      const fresh = [...logs.entries.values()].filter(e =>
        Date.now() - e.createdTimestamp <= maxAge
      );
      if (!fresh.length) continue;

      const channelMatch = fresh.find(e => {
        const extra = e.extra || {};
        const extraChannel = extra.channelId || extra.channel_id || extra.channel?.id;
        return !channelId || extraChannel === channelId;
      });

      return channelMatch || fresh[0] || null;
    } catch {}
  }
  return null;
}

// For message deletion, Discord's audit entry target is the message author.
// Never reuse an old entry: the same author can have many deleted messages.
async function findMessageDeleteAudit(guild, authorId, channelId, deletedAt = Date.now()) {
  if (!guild || !authorId) return null;

  const cacheKey = `${guild.id}:${authorId}`;
  const matches = (entry) => {
    if (!entry || entry.action !== AuditLogEvent.MessageDelete) return false;
    if (entry.targetId && entry.targetId !== authorId) return false;

    const age = deletedAt - entry.createdTimestamp;
    // Audit logs can arrive a little before/after MessageDelete.
    if (age < -5000 || age > 15000) return false;

    const extra = entry.extra || {};
    const auditChannel = extra.channelId || extra.channel_id || extra.channel?.id;
    if (channelId && auditChannel && auditChannel !== channelId) return false;
    return true;
  };

  const cached = messageDeleteAuditCache.get(cacheKey);
  if (matches(cached)) return cached;

  // Discord may commit the audit entry shortly after MessageDelete.
  for (let attempt = 0; attempt < 10; attempt++) {
    if (attempt) await wait(350);
    try {
      const logs = await guild.fetchAuditLogs({
        type: AuditLogEvent.MessageDelete,
        limit: 50
      });

      const candidates = [...logs.entries.values()]
        .filter(matches)
        .sort((a, b) => b.createdTimestamp - a.createdTimestamp);

      if (candidates.length) {
        const exact = candidates[0];
        // Keep the audit entry itself; executor may not be populated in every
        // gateway payload, so the MessageDelete handler resolves executorId.
        messageDeleteAuditCache.set(cacheKey, exact);
        setTimeout(() => {
          const current = messageDeleteAuditCache.get(cacheKey);
          if (current?.id === exact.id) messageDeleteAuditCache.delete(cacheKey);
        }, 10000);
        return exact;
      }
    } catch {}
  }
  return null;
}

// ============================================
// MESSAGE LOGS - CACHE EVERYTHING
// ============================================

client.on(Events.MessageCreate, async message => {
  if (!message.guild || !isSource(message.guild)) return;
  // Always persist messages (including bot embeds) so deleted-message logs
  // can recover their content even when bot-message logging is disabled.
  await saveMessage(message);
});

client.on(Events.MessageDelete, async message => {
  if (!message.guild || !isSource(message.guild)) return;

  const cached = messageCache.get(message.id);
  const saved = cached || await getMessageFromDb(message.id).catch(() => null);

  if (message.partial) {
    await message.fetch().catch(() => null);
  }

  const authorId = message.author?.id || saved?.authorId;
  const deletedAt = Date.now();
  const audit = await findMessageDeleteAudit(message.guild, authorId, message.channelId || saved?.channelId, deletedAt);
  if (!audit && message.guild.members.me?.permissions?.has?.('ViewAuditLog') === false) {
    console.warn(`[MESSAGE DELETE] Missing View Audit Log permission in guild ${message.guild.id}`);
  }

  // Resolve the actual executor from Audit Logs by ID. Do not use the
  // message author as a fallback: the person who wrote the message is not
  // necessarily the person who deleted it.
  let deleteExecutor = audit?.executor || null;
  if (!deleteExecutor && audit?.executorId) {
    deleteExecutor = await client.users.fetch(audit.executorId).catch(() => null);
  }
  // If Discord provides no MessageDelete audit entry, the reliable case we
  // can identify is the author deleting their own message. Prefer that user
  // instead of ever printing an "unknown" actor.
  if (!deleteExecutor && message.author?.id) {
    deleteExecutor = message.author;
  } else if (!deleteExecutor && saved?.authorId) {
    deleteExecutor = await client.users.fetch(saved.authorId).catch(() => null);
  }

  // Deleted bot embeds often have no text in message.content. Recover the
  // original embed data from the persistent DB when content is empty.
  let content = message.content || saved?.content || '';
  if (!content && saved?.embeds?.length) {
    const embedParts = saved.embeds.slice(0, 10).map((e, i) => {
      const parts = [];
      if (e.title) parts.push(`**${e.title}**`);
      if (e.description) parts.push(e.description);
      if (e.fields?.length) {
        parts.push(e.fields.slice(0, 10).map(f => `**${f.name}**: ${f.value}`).join('\n'));
      }
      if (e.url) parts.push(e.url);
      return parts.filter(Boolean).join('\n') || `Embed ${i + 1}`;
    });
    content = embedParts.join('\n\n');
  }
  if (!content) content = 'تعذر استرجاع محتوى الرسالة (لم يتم حفظ محتواها قبل الحذف)';
  const attachments = message.attachments?.size
    ? [...message.attachments.values()]
    : (saved?.attachments || []);

  await sendLog('logs', {
    title: '🗑️ MESSAGE DELETED',
    description: '**تم حذف رسالة من السيرفر**',
    color: COLORS.danger,
    thumbnail: message.author?.displayAvatarURL() || saved?.avatar,
    fields: [
      {
        name: '👤 صاحب الرسالة',
        value: message.author ? userInfo(message.author) : `${saved?.authorTag || 'بيانات غير متاحة'}\n\`${saved?.authorId || 'غير متاح'}\``
      },
      {
        name: '📍 الروم',
        value: message.channel ? `<#${message.channel.id}> • \`${message.channel.id}\`` : `#${saved?.channelName || 'بيانات الروم غير متاحة'}`
      },
      { name: '💬 الرسالة المحذوفة', value: code(content) },
      {
        name: '🛡️ تم الحذف بواسطة',
        // Only Audit Logs can identify a moderator/bot that deleted another
        // user's message. Never attribute a moderator deletion to the message author.
        value: deleteExecutor
          ? userInfo(deleteExecutor)
          : '⚠️ تعذر تحديد منفذ الحذف من بيانات Discord'
      }
    ]
  });

  if (attachments.length) {
    await sendLog('logs', {
      title: '📎 DELETED MESSAGE ATTACHMENTS',
      description: '**ملفات كانت موجودة في الرسالة المحذوفة**',
      color: COLORS.warning,
      fields: attachments.slice(0, 10).map((a, i) => ({
        name: `📎 ملف ${i + 1}`,
        value: `[${a.name || 'Attachment'}](${a.url})`
      }))
    });
  }

  // Keep the row in the DB intentionally; this is the permanent backup used by deleted-message logs.
  messageCache.delete(message.id);
});

client.on(Events.MessageDeleteBulk, async messages => {
  const first = messages.first();
  if (!first?.guild || !isSource(first.guild)) return;

  const rows = await Promise.all(messages.map(async msg => {
    const saved = messageCache.get(msg.id) || await getMessageFromDb(msg.id).catch(() => null);
    return `• **${msg.author?.tag || saved?.authorTag || 'Unknown'}**: ${trim(msg.content || saved?.content || 'بدون نص', 180)}`;
  }));
  const list = rows.join('\n');

  await sendLog('logs', {
    title: '🗑️ BULK MESSAGE DELETE',
    description: `**تم حذف ${messages.size} رسالة مرة واحدة**`,
    color: COLORS.danger,
    fields: [
      { name: '📍 الروم', value: `${first.channel}` },
      { name: '💬 الرسائل', value: trim(list, 1000) }
    ]
  });
});

client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  if (!newMessage.guild || !isSource(newMessage.guild)) return;
  if (newMessage.author?.bot && !CONFIG.logBotMessages) return;

  if (oldMessage.partial) await oldMessage.fetch().catch(() => null);
  if (newMessage.partial) await newMessage.fetch().catch(() => null);

  const cached = messageCache.get(newMessage.id);
  const oldContent = oldMessage.content ?? cached?.content ?? '';
  const newContent = newMessage.content ?? '';

  if (oldContent === newContent) return;

  await sendLog('logs', {
    title: '✏️ MESSAGE EDITED',
    description: '**تم تعديل رسالة**',
    color: COLORS.warning,
    thumbnail: newMessage.author?.displayAvatarURL(),
    fields: [
      { name: '👤 العضو', value: newMessage.author ? userInfo(newMessage.author) : 'بيانات صاحب الرسالة غير متاحة' },
      { name: '📍 الروم', value: `<#${newMessage.channel.id}> • \`${newMessage.channel.id}\`` },
      { name: '⬅️ الرسالة القديمة', value: code(oldContent || 'بدون نص') },
      { name: '➡️ الرسالة الجديدة', value: code(newContent || 'بدون نص') },
      { name: '🔗 رابط الرسالة', value: newMessage.url || 'غير متاح' }
    ]
  });

  await saveMessage(newMessage);
});

// ============================================
// REACTIONS
// ============================================

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (reaction.partial) await reaction.fetch().catch(() => null);
  const message = reaction.message;
  if (!message.guild || !isSource(message.guild)) return;

  await sendLog('logs', {
    title: '➕ REACTION ADDED',
    description: '**تم إضافة رياكشن**',
    color: COLORS.success,
    thumbnail: user.displayAvatarURL(),
    fields: [
      { name: '👤 العضو', value: userInfo(user) },
      { name: '😀 الرياكشن', value: reaction.emoji.toString() },
      { name: '📍 الروم', value: `${message.channel}` },
      { name: '💬 الرسالة', value: code(message.content || 'بدون نص', 400) },
      { name: '🔗 رابط الرسالة', value: `[اضغط هنا للذهاب للرسالة](${message.url})` }
    ]
  });
});

client.on(Events.MessageReactionRemove, async (reaction, user) => {
  if (reaction.partial) await reaction.fetch().catch(() => null);
  const message = reaction.message;
  if (!message.guild || !isSource(message.guild)) return;

  await sendLog('logs', {
    title: '➖ REACTION REMOVED',
    description: '**تم إزالة رياكشن**',
    color: COLORS.warning,
    thumbnail: user.displayAvatarURL(),
    fields: [
      { name: '👤 العضو', value: userInfo(user) },
      { name: '😀 الرياكشن', value: reaction.emoji.toString() },
      { name: '📍 الروم', value: `${message.channel}` },
      { name: '🔗 رابط الرسالة', value: `[اضغط هنا للذهاب للرسالة](${message.url})` }
    ]
  });
});

// ============================================
// VOICE - DEEP STATE LOGGING
// ============================================

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  if (!isSource(newState.guild)) return;

  const user = newState.member.user;
  const guild = newState.guild;
  const base = [{ name: '👤 العضو', value: userInfo(user) }];

  const joined = !oldState.channelId && newState.channelId;
  const disconnected = oldState.channelId && !newState.channelId;
  const moved = oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId;

  if (joined) {
    await sendLog('voice', {
      title: '🔊 VOICE JOIN',
      description: '**دخل عضو روم صوتي**',
      color: COLORS.voice,
      thumbnail: user.displayAvatarURL(),
      fields: [...base, { name: '📍 الروم', value: `${newState.channel} • \`${newState.channelId}\`` }]
    });
  }

  if (disconnected) {
    const audit = await findVoiceAudit(guild, AuditLogEvent.MemberDisconnect, user.id, 30000);
    await sendLog('voice', {
      title: '📤 VOICE DISCONNECT',
      description: audit ? '**تم فصل العضو من الروم الصوتي**' : '**العضو خرج من الروم الصوتي**',
      color: COLORS.warning,
      thumbnail: user.displayAvatarURL(),
      fields: [
        ...base,
        { name: '📍 الروم السابق', value: `${oldState.channel} • \`${oldState.channelId}\`` },
        { name: '🛡️ تم بواسطة', value: audit?.executor ? userInfo(audit.executor) : 'العضو خرج بنفسه' }
      ]
    });
  }

  if (moved) {
    const audit = await findVoiceAudit(guild, AuditLogEvent.MemberMove, user.id, 30000);
    await sendLog('voice', {
      title: '🔁 VOICE MOVE',
      description: audit ? '**تم نقل عضو بين الرومات الصوتية**' : '**العضو انتقل بين الرومات الصوتية**',
      color: COLORS.voice,
      thumbnail: user.displayAvatarURL(),
      fields: [
        ...base,
        { name: '⬅️ من', value: `${oldState.channel}` },
        { name: '➡️ إلى', value: `${newState.channel}` },
        { name: '🛡️ تم بواسطة', value: audit?.executor ? userInfo(audit.executor) : userInfo(user) }
      ]
    });
  }

  // مهم: عند دخول/خروج الروم Discord ممكن يرسل قيم Voice إضافية لأول مرة
  // لذلك لا نسجل Camera / Share / Deaf ... في نفس Event الخاص بالـ Join/Leave/Move.
  if (joined || disconnected || moved) return;

  // الإجراءات الإدارية فقط - ونجيب الشخص المنفذ من Audit Logs
  const adminChanges = [
    ['serverMute', 'mute', '🔇 SERVER MUTE', 'تم تغيير Server Mute للعضو'],
    ['serverDeaf', 'deaf', '🎧 SERVER DEAF', 'تم تغيير Server Deaf للعضو']
  ];

  for (const [key, auditKey, title, description] of adminChanges) {
    if (oldState[key] === newState[key]) continue;

    const audit = await findAudit(
      guild,
      AuditLogEvent.MemberUpdate,
      user.id,
      20000,
      auditKey
    );

    await sendLog('voice', {
      title,
      description,
      color: newState[key] ? COLORS.danger : COLORS.success,
      thumbnail: user.displayAvatarURL(),
      fields: [
        ...base,
        { name: '📍 الروم', value: `${newState.channel || oldState.channel || 'بيانات غير متاحة'}` },
        { name: '📊 الحالة', value: newState[key] ? 'تم التفعيل 🔴' : 'تم الإلغاء 🟢' },
        { name: '🛡️ تم بواسطة', value: await executorInfo(audit) }
      ]
    });
  }

  // الحالات الشخصية: لا نعتبرها عمليات إدارية ولا نرسلها عند تهيئة Voice لأول مرة
  const selfChanges = [
    ['selfMute', '🔇 SELF MUTE', 'العضو قام بتغيير حالة المايك', COLORS.warning],
    ['selfDeaf', '🎧 SELF DEAF', 'العضو قام بتغيير حالة الصوت', COLORS.warning],
    ['streaming', '🖥️ SCREEN SHARE / STREAM', 'العضو قام بتغيير حالة الـ Stream / Screen Share', COLORS.purple],
    ['selfVideo', '📹 CAMERA', 'العضو قام بتغيير حالة الكاميرا', COLORS.voice],
    ['suppress', '🔕 STAGE SUPPRESS', 'تم تغيير حالة Stage Suppress', COLORS.warning]
  ];

  for (const [key, title, description, color] of selfChanges) {
    if (oldState[key] === newState[key]) continue;

    await sendLog('voice', {
      title,
      description,
      color,
      thumbnail: user.displayAvatarURL(),
      fields: [
        ...base,
        { name: '📍 الروم', value: `${newState.channel || oldState.channel || 'بيانات غير متاحة'}` },
        { name: '📊 الحالة', value: newState[key] ? 'ON / ENABLED ✅' : 'OFF / DISABLED ❌' },
        { name: '🛡️ تم بواسطة', value: userInfo(user) }
      ]
    });
  }
});

// ============================================
// BAN / UNBAN
// ============================================

client.on(Events.GuildBanAdd, async ban => {
  if (!isSource(ban.guild)) return;

  const audit = await findAudit(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);

  await sendLog('bans', {
    title: '🔨 MEMBER BANNED',
    description: '**تم حظر عضو من السيرفر**',
    color: COLORS.danger,
    thumbnail: ban.user.displayAvatarURL(),
    fields: [
      { name: '👤 العضو', value: userInfo(ban.user) },
      { name: '🛡️ بواسطة', value: await executorInfo(audit) },
      { name: '📝 السبب', value: audit?.reason || 'لا يوجد سبب' }
    ]
  });
});

client.on(Events.GuildBanRemove, async ban => {
  if (!isSource(ban.guild)) return;

  const audit = await findAudit(ban.guild, AuditLogEvent.MemberBanRemove, ban.user.id);

  await sendLog('bans', {
    title: '🔓 MEMBER UNBANNED',
    description: '**تم فك حظر عضو**',
    color: COLORS.success,
    thumbnail: ban.user.displayAvatarURL(),
    fields: [
      { name: '👤 العضو', value: userInfo(ban.user) },
      { name: '🛡️ بواسطة', value: await executorInfo(audit) }
    ]
  });
});

// ============================================
// CHANNEL LOGS
// ============================================

client.on(Events.ChannelCreate, async channel => {
  if (!channel.guild || !isSource(channel.guild)) return;
  const audit = await findAudit(channel.guild, AuditLogEvent.ChannelCreate, channel.id);

  await sendLog('logs', {
    title: '➕ CHANNEL CREATED',
    description: '**تم إنشاء روم جديد**',
    color: COLORS.success,
    fields: [
      { name: '📌 الاسم', value: `${channel.name}` },
      { name: '🆔 ID', value: `\`${channel.id}\`` },
      { name: '📂 النوع', value: `${channel.type}` },
      { name: '🛡️ بواسطة', value: await executorInfo(audit) }
    ]
  });
});

client.on(Events.ChannelDelete, async channel => {
  if (!channel.guild || !isSource(channel.guild)) return;
  const audit = await findAudit(channel.guild, AuditLogEvent.ChannelDelete, channel.id);

  await sendLog('logs', {
    title: '🗑️ CHANNEL DELETED',
    description: '**تم حذف روم**',
    color: COLORS.danger,
    fields: [
      { name: '📌 الاسم', value: `${channel.name}` },
      { name: '🆔 ID', value: `\`${channel.id}\`` },
      { name: '🛡️ بواسطة', value: await executorInfo(audit) }
    ]
  });
});

client.on(Events.ChannelUpdate, async (oldChannel, newChannel) => {
  if (!newChannel.guild || !isSource(newChannel.guild)) return;

  const changes = [];
  if (oldChannel.name !== newChannel.name) changes.push(`**الاسم:** ${oldChannel.name} ➜ ${newChannel.name}`);
  if (oldChannel.topic !== newChannel.topic) changes.push(`**Topic:** ${oldChannel.topic || 'لا يوجد'} ➜ ${newChannel.topic || 'لا يوجد'}`);
  if (oldChannel.nsfw !== newChannel.nsfw) changes.push(`**NSFW:** ${oldChannel.nsfw} ➜ ${newChannel.nsfw}`);
  if (oldChannel.rateLimitPerUser !== newChannel.rateLimitPerUser) changes.push(`**Slowmode:** ${oldChannel.rateLimitPerUser}s ➜ ${newChannel.rateLimitPerUser}s`);
  if (oldChannel.bitrate !== newChannel.bitrate) changes.push(`**Bitrate:** ${oldChannel.bitrate} ➜ ${newChannel.bitrate}`);
  if (oldChannel.userLimit !== newChannel.userLimit) changes.push(`**User Limit:** ${oldChannel.userLimit} ➜ ${newChannel.userLimit}`);

  const overwriteChanges = diffOverwrites(oldChannel, newChannel);
  if (!changes.length && !overwriteChanges.length) return;

  const cacheKey = `${newChannel.guild.id}:${newChannel.id}`;
  const cachedAudit = channelUpdateAuditCache.get(cacheKey);
  const cachedFresh = cachedAudit && (Date.now() - cachedAudit.createdTimestamp <= 30000);
  // Channel permission overwrites are recorded by Discord as ChannelOverwrite* audit actions,
  // not always as ChannelUpdate. Check all relevant actions so the real executor is shown.
  const audit = (cachedFresh ? cachedAudit : null) || await findAudit(
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
    title: '✏️ CHANNEL UPDATED',
    description: '**تم تعديل روم**',
    color: COLORS.warning,
    fields: [
      { name: '📍 الروم', value: `${newChannel.name} • \`${newChannel.id}\`` },
      ...(changes.length ? [{ name: '📝 التغييرات', value: trim(changes.join('\n'), 1000) }] : []),
      ...(overwriteChanges.length ? [{ name: '🔐 تغييرات صلاحيات الروم', value: trim(overwriteChanges.join('\n'), 1024) }] : []),
      { name: '🛡️ بواسطة', value: await executorInfo(audit) }
    ]
  });
});

// ============================================
// PERMISSION DIFF HELPERS
// ============================================
const permissionNames = Object.fromEntries(
  Object.entries(PermissionsBitField.Flags).map(([name, bit]) => [bit.toString(), name])
);

function diffPermissions(oldPerms, newPerms) {
  const oldSet = new PermissionsBitField(oldPerms).toArray();
  const newSet = new PermissionsBitField(newPerms).toArray();
  const added = newSet.filter(x => !oldSet.includes(x));
  const removed = oldSet.filter(x => !newSet.includes(x));
  return { added, removed };
}

function permissionText(list) {
  return list.length ? list.map((p,i)=>`**${i+1}.** \`${p}\``).join('\n') : 'لا يوجد';
}

function diffOverwrites(oldChannel, newChannel) {
  const oldMap = oldChannel.permissionOverwrites.cache;
  const newMap = newChannel.permissionOverwrites.cache;
  const lines = [];

  const targetName = (overwrite, id) => {
    if (overwrite.type === 0) {
      const role = newChannel.guild.roles.cache.get(id);
      return role ? `**${role.name}**` : `**Unknown Role**`;
    }
    const member = newChannel.guild.members.cache.get(id);
    return member ? `**${member.user.tag}**` : `**Unknown User**`;
  };

  for (const [id, nw] of newMap) {
    const ow = oldMap.get(id);
    const target = targetName(nw, id);

    if (!ow) {
      const added = nw.allow.toArray();
      const denied = nw.deny.toArray();
      const parts = [];
      if (added.length) parts.push(`➕ ${added.map(x=>'`'+x+'`').join(', ')}`);
      if (denied.length) parts.push(`🚫 ${denied.map(x=>'`'+x+'`').join(', ')}`);
      lines.push(`➕ **Permission Override جديد:** ${target}${parts.length ? ` — ${parts.join(' | ')}` : ''}`);
      continue;
    }

    const add = nw.allow.toArray().filter(x => !ow.allow.has(x));
    const rem = ow.allow.toArray().filter(x => !nw.allow.has(x));

    if (add.length || rem.length) {
      const parts = [];
      if (add.length) parts.push(`➕ ${add.map(x=>'`'+x+'`').join(', ')}`);
      if (rem.length) parts.push(`➖ ${rem.map(x=>'`'+x+'`').join(', ')}`);
      lines.push(`${target}: ${parts.join(' | ')}`);
    }
  }

  for (const [id, ow] of oldMap) {
    if (!newMap.has(id)) {
      lines.push(`🗑️ **Permission Override تم حذفه:** ${targetName(ow, id)}`);
    }
  }

  return lines;
}

// ============================================
// ============================================
// ROLE LOGS - DEEP
// ============================================

client.on(Events.GuildRoleCreate, async role => {
  if (!isSource(role.guild)) return;
  const audit = await findAudit(role.guild, AuditLogEvent.RoleCreate, role.id, 20000);

  await sendLog('roles', {
    title: '➕ ROLE CREATED',
    description: '**تم إنشاء رتبة جديدة**',
    color: COLORS.success,
    fields: [
      { name: '🎭 الاسم', value: role.name },
      { name: '🆔 ID', value: `\`${role.id}\`` },
      { name: '🎨 اللون', value: role.hexColor },
      { name: '📌 الترتيب', value: `\`${role.position}\`` },
      { name: '🛡️ بواسطة', value: await executorInfo(audit) }
    ]
  });
});

client.on(Events.GuildRoleDelete, async role => {
  if (!isSource(role.guild)) return;
  const audit = await findAudit(role.guild, AuditLogEvent.RoleDelete, role.id, 20000);

  await sendLog('roles', {
    title: '🗑️ ROLE DELETED',
    description: '**تم حذف رتبة**',
    color: COLORS.danger,
    fields: [
      { name: '🎭 الاسم', value: role.name },
      { name: '🆔 ID', value: `\`${role.id}\`` },
      { name: '🎨 اللون', value: role.hexColor },
      { name: '🛡️ بواسطة', value: await executorInfo(audit) }
    ]
  });
});

client.on(Events.GuildRoleUpdate, async (oldRole, newRole) => {
  if (!isSource(newRole.guild)) return;

  const changes = [];
  if (oldRole.name !== newRole.name) changes.push(`📝 **الاسم:** ${oldRole.name} ➜ ${newRole.name}`);
  if (oldRole.hexColor !== newRole.hexColor) changes.push(`🎨 **اللون:** ${oldRole.hexColor} ➜ ${newRole.hexColor}`);
  if (oldRole.hoist !== newRole.hoist) changes.push(`📌 **إظهار الرتبة:** ${oldRole.hoist ? 'نعم' : 'لا'} ➜ ${newRole.hoist ? 'نعم' : 'لا'}`);
  if (oldRole.mentionable !== newRole.mentionable) changes.push(`🔔 **قابلة للمنشن:** ${oldRole.mentionable ? 'نعم' : 'لا'} ➜ ${newRole.mentionable ? 'نعم' : 'لا'}`);
  if (oldRole.position !== newRole.position) changes.push(`↕️ **الترتيب:** ${oldRole.position} ➜ ${newRole.position}`);

  const permissionDiff = diffPermissions(oldRole.permissions, newRole.permissions);
  if (permissionDiff.added.length || permissionDiff.removed.length) changes.push('🔐 **تم تعديل صلاحيات الرتبة**');
  if (!changes.length) return;

  const audit = await findAudit(newRole.guild, AuditLogEvent.RoleUpdate, newRole.id, 20000);

  await sendLog('roles', {
    title: '✏️ ROLE UPDATED',
    description: '**تم تعديل رتبة**',
    color: COLORS.role,
    fields: [
      { name: '🎭 الرتبة', value: roleInfo(newRole) },
      { name: '📝 التغييرات', value: trim(changes.join('\n'), 1000) },
      ...(permissionDiff.added.length ? [{
        name: `➕ صلاحيات تمت إضافتها (${permissionDiff.added.length})`,
        value: trim(permissionText(permissionDiff.added), 1024)
      }] : []),
      ...(permissionDiff.removed.length ? [{
        name: `➖ صلاحيات تمت إزالتها (${permissionDiff.removed.length})`,
        value: trim(permissionText(permissionDiff.removed), 1024)
      }] : []),
      { name: '🛡️ بواسطة', value: await executorInfo(audit) }
    ]
  });
});

// ============================================
// MEMBER ROLE ASSIGN / REMOVE LOGS
// ============================================

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  if (!isSource(newMember.guild)) return;

  const added = newMember.roles.cache.filter(r => !oldMember.roles.cache.has(r.id));
  const removed = oldMember.roles.cache.filter(r => !newMember.roles.cache.has(r.id));
  if (!added.size && !removed.size) return;

  let audit = null;
  try {
    audit = await findAudit(newMember.guild, AuditLogEvent.MemberRoleUpdate, newMember.id, 20000);
  } catch {}

  const fields = [
    { name: '👤 العضو', value: memberInfo(newMember) }
  ];

  if (added.size) {
    fields.push({
      name: `➕ الرولات المضافة (${added.size})`,
      value: trim([...added.values()].map(r => `• **${r.name}**\n\`${r.id}\``).join('\n'), 1024)
    });
  }

  if (removed.size) {
    fields.push({
      name: `➖ الرولات المحذوفة (${removed.size})`,
      value: trim([...removed.values()].map(r => `• **${r.name}**\n\`${r.id}\``).join('\n'), 1024)
    });
  }

  fields.push({ name: '🛡️ بواسطة', value: await executorInfo(audit) });

  await sendLog('roles', {
    title: added.size && removed.size ? '🔄 MEMBER ROLES UPDATED' : (added.size ? '➕ ROLE ADDED TO MEMBER' : '➖ ROLE REMOVED FROM MEMBER'),
    description: '**تم تغيير رولات عضو**',
    color: added.size ? COLORS.success : COLORS.danger,
    fields
  });
});

// ============================================
// INVITES / EMOJIS / STICKERS
// ============================================

client.on(Events.InviteCreate, async invite => {
  if (!invite.guild || !isSource(invite.guild)) return;

  const invites = await invite.guild.invites.fetch().catch(() => null);
  if (invites) inviteCache.set(invite.guild.id, new Map(invites.map(i => [i.code, i.uses])));

  await sendLog('logs', {
    title: '🔗 INVITE CREATED',
    description: '**تم إنشاء دعوة جديدة**',
    color: COLORS.success,
    fields: [
      { name: '🔗 الدعوة', value: `discord.gg/${invite.code}` },
      { name: '👤 بواسطة', value: invite.inviter ? userInfo(invite.inviter) : '⚠️ Discord لم يرسل بيانات منشئ الدعوة' },
      { name: '📍 الروم', value: invite.channel ? `${invite.channel}` : 'بيانات الروم غير متاحة' },
      { name: '⏳ تنتهي بعد', value: invite.maxAge ? `${invite.maxAge} ثانية` : 'لا تنتهي' },
      { name: '🔢 الحد الأقصى', value: invite.maxUses ? `${invite.maxUses}` : 'غير محدود' }
    ]
  });
});

client.on(Events.InviteDelete, async invite => {
  if (!invite.guild || !isSource(invite.guild)) return;

  await sendLog('logs', {
    title: '🗑️ INVITE DELETED',
    description: '**تم حذف دعوة**',
    color: COLORS.danger,
    fields: [
      { name: '🔗 Code', value: invite.code }
    ]
  });
});

client.on(Events.GuildEmojiCreate, async emoji => {
  if (!isSource(emoji.guild)) return;
  await sendLog('logs', {
    title: '😀 EMOJI CREATED',
    description: '**تم إضافة Emoji**',
    color: COLORS.success,
    thumbnail: emoji.url,
    fields: [
      { name: '😀 Emoji', value: emoji.toString() },
      { name: '📌 الاسم', value: emoji.name },
      { name: '🆔 ID', value: `\`${emoji.id}\`` }
    ]
  });
});

client.on(Events.GuildEmojiDelete, async emoji => {
  if (!isSource(emoji.guild)) return;
  await sendLog('logs', {
    title: '🗑️ EMOJI DELETED',
    description: '**تم حذف Emoji**',
    color: COLORS.danger,
    fields: [
      { name: '📌 الاسم', value: emoji.name },
      { name: '🆔 ID', value: `\`${emoji.id}\`` }
    ]
  });
});

client.on(Events.GuildStickerCreate, async sticker => {
  if (!isSource(sticker.guild)) return;
  await sendLog('logs', {
    title: '🎟️ STICKER CREATED',
    description: '**تم إضافة Sticker**',
    color: COLORS.success,
    fields: [
      { name: '📌 الاسم', value: sticker.name },
      { name: '🆔 ID', value: `\`${sticker.id}\`` }
    ]
  });
});

client.on(Events.GuildStickerDelete, async sticker => {
  if (!isSource(sticker.guild)) return;
  await sendLog('logs', {
    title: '🗑️ STICKER DELETED',
    description: '**تم حذف Sticker**',
    color: COLORS.danger,
    fields: [
      { name: '📌 الاسم', value: sticker.name },
      { name: '🆔 ID', value: `\`${sticker.id}\`` }
    ]
  });
});

// ============================================
// KICKS + EXTRA AUDIT EVENTS
// ============================================

const auditSeen = new Set();
const channelUpdateAuditCache = new Map();
const messageDeleteAuditCache = new Map();

client.on(Events.GuildAuditLogEntryCreate, async (entry, guild) => {
  if (!isSource(guild)) return;

  const key = `${guild.id}-${entry.id}`;
  if (auditSeen.has(key)) return;
  auditSeen.add(key);
  setTimeout(() => auditSeen.delete(key), 60000);

  if (entry.action === AuditLogEvent.MessageDelete && entry.targetId) {
    messageDeleteAuditCache.set(`${guild.id}:${entry.targetId}`, entry);
    setTimeout(() => {
      const current = messageDeleteAuditCache.get(`${guild.id}:${entry.targetId}`);
      if (current?.id === entry.id) messageDeleteAuditCache.delete(`${guild.id}:${entry.targetId}`);
    }, 60000);
  }

  if (
    [
      AuditLogEvent.ChannelUpdate,
      AuditLogEvent.ChannelOverwriteCreate,
      AuditLogEvent.ChannelOverwriteUpdate,
      AuditLogEvent.ChannelOverwriteDelete
    ].filter(Boolean).includes(entry.action) && entry.targetId
  ) {
    channelUpdateAuditCache.set(`${guild.id}:${entry.targetId}`, entry);
    setTimeout(() => channelUpdateAuditCache.delete(`${guild.id}:${entry.targetId}`), 60000);
  }

  if (entry.action === AuditLogEvent.MemberKick) {
    await sendLog('kicks', {
      title: '👢 MEMBER KICKED',
      description: '**تم طرد عضو من السيرفر**',
      color: COLORS.danger,
      fields: [
        { name: '👤 الشخص الذي تم طرده', value: entry.target ? targetUserInfo(entry.target) : `\`${entry.targetId}\`` },
        { name: '🛡️ تم الطرد بواسطة', value: entry.executor ? targetUserInfo(entry.executor) : (entry.executorId ? `<@${entry.executorId}>` : '⚠️ Discord لم يرسل بيانات منفذ العملية') },
        { name: '📝 سبب الطرد', value: entry.reason || 'لم يتم تقديم سبب' }
      ]
    });
  }
});

// ============================================
// ERROR HANDLING + BOT STATE
// ============================================

client.on('error', async error => {
  console.error('[DISCORD ERROR]', error);
  if (botReady) {
    await sendBotState('⚠️ BOT ERROR', `حدث خطأ في اتصال Discord أو البوت:\n\`${trim(error?.message || error, 800)}\``, COLORS.warning);
  }
});

process.on('SIGINT', () => gracefulExit('SIGINT', 0));
process.on('SIGTERM', () => gracefulExit('SIGTERM', 0));

process.on('warning', async warning => {
  console.warn('[NODE WARNING]', warning?.name || 'Warning', warning?.message || warning);
  if (botReady) {
    await sendBotState(
      '⚠️ NODE WARNING',
      `**تحذير من Node.js**\n\`${trim(warning?.message || warning, 900)}\``,
      COLORS.warning
    );
  }
});

process.on('unhandledRejection', async error => {
  console.error('[UNHANDLED REJECTION]', error);
  if (botReady) {
    await sendBotState('⚠️ UNHANDLED ERROR', `حدث خطأ غير متوقع:\n\`${trim(error?.message || error, 800)}\``, COLORS.warning);
  }
});

process.on('uncaughtException', async error => {
  console.error('[UNCAUGHT EXCEPTION]', error);
  if (botReady) {
    try {
      await sendBotState('💥 BOT CRASHED', `حدث Crash:\n\`${trim(error?.stack || error?.message || error, 900)}\``, COLORS.danger);
    } catch {}
  }
  setTimeout(() => gracefulExit('CRASH', 1), 1200);
});

if (!CONFIG.sourceGuildId || !CONFIG.logGuildId) {
  console.warn('⚠️ SOURCE_GUILD_ID or LOG_GUILD_ID is missing in .env');
}

if (!CONFIG.token) {
  console.error('❌ TOKEN is missing in .env');
  process.exit(1);
}

// BOT START / ONLINE STATE
client.once(Events.ClientReady, async readyClient => {
  botReady = true;
  console.log(`[BOT STATE] Online as ${readyClient.user.tag}`);
  await sendBotState(
    '🟢 BOT ONLINE',
    '**تم تشغيل البوت بنجاح وأصبح Online**',
    COLORS.success,
    [
      { name: '🌐 السيرفرات', value: `\`${readyClient.guilds.cache.size}\`` },
      { name: '📡 الحالة', value: '**Online / Ready**' }
    ]
  );
});

// Discord connection interruption/recovery state.
client.on(Events.ShardDisconnect, async (event, shardId) => {
  if (botReady) {
    await sendBotState(
      '🔴 BOT DISCONNECTED',
      `**تم فصل اتصال البوت مع Discord**\nShard: \`${shardId}\`\nCode: \`${event?.code ?? 'غير متاح'}\``,
      COLORS.danger
    );
  }
});

client.on(Events.ShardResume, async (shardId, replayedEvents) => {
  if (botReady) {
    await sendBotState(
      '🟢 BOT RECONNECTED',
      '**تم استعادة اتصال البوت مع Discord**',
      COLORS.success,
      [
        { name: '🔢 Shard', value: `\`${shardId}\`` },
        { name: '📦 الأحداث المستعادة', value: `\`${replayedEvents ?? 0}\`` }
      ]
    );
  }
});

client.login(CONFIG.token).catch(async error => {
  console.error('[NMR LOGIN ERROR]', error?.stack || error?.message || error);
  await sendBotState(
    '💥 BOT LOGIN FAILED',
    `**فشل تشغيل البوت وتسجيل الدخول إلى Discord**\n\`${trim(error?.message || error, 900)}\``,
    COLORS.danger
  );
  process.exitCode = 1;
});


// ============================================
// DEEP SERVER SETTINGS LOGS
// ============================================
client.on(Events.GuildUpdate, async (oldGuild, newGuild) => {
  if (!isSource(newGuild)) return;

  const changes = [];
  if (oldGuild.name !== newGuild.name) changes.push(`📝 **الاسم:** ${oldGuild.name} ➜ ${newGuild.name}`);
  if (oldGuild.icon !== newGuild.icon) changes.push('🖼️ **تم تغيير صورة السيرفر**');
  if (oldGuild.banner !== newGuild.banner) changes.push('🎨 **تم تغيير Banner السيرفر**');
  if (oldGuild.splash !== newGuild.splash) changes.push('✨ **تم تغيير Splash السيرفر**');
  if (oldGuild.vanityURLCode !== newGuild.vanityURLCode) changes.push(`🔗 **Vanity Link:** ${oldGuild.vanityURLCode || 'لا يوجد'} ➜ ${newGuild.vanityURLCode || 'لا يوجد'}`);
  if (oldGuild.description !== newGuild.description) changes.push('📄 **تم تغيير وصف السيرفر**');
  if (oldGuild.verificationLevel !== newGuild.verificationLevel) changes.push('🛡️ **تم تغيير Verification Level**');
  if (oldGuild.defaultMessageNotifications !== newGuild.defaultMessageNotifications) changes.push('🔔 **تم تغيير Message Notifications**');
  if (oldGuild.explicitContentFilter !== newGuild.explicitContentFilter) changes.push('🔞 **تم تغيير Content Filter**');
  if (oldGuild.afkChannelId !== newGuild.afkChannelId) changes.push('💤 **تم تغيير AFK Channel**');
  if (oldGuild.afkTimeout !== newGuild.afkTimeout) changes.push(`⏱️ **AFK Timeout:** ${oldGuild.afkTimeout} ➜ ${newGuild.afkTimeout}`);
  if (!changes.length) return;

  const audit = await findAudit(newGuild, AuditLogEvent.GuildUpdate, newGuild.id, 30000);
  await sendLog('logs', {
    title: '⚙️ SERVER UPDATED',
    description: '**تم تعديل إعدادات أو بيانات السيرفر**',
    color: COLORS.warning,
    thumbnail: newGuild.iconURL({ size: 512 }) || null,
    image: oldGuild.banner !== newGuild.banner && newGuild.bannerURL ? newGuild.bannerURL({ size: 1024 }) : null,
    fields: [
      { name: '🏠 السيرفر', value: `**${newGuild.name}** • \`${newGuild.id}\`` },
      { name: '📝 التعديلات', value: trim(changes.join('\n'), 1024) },
      { name: '🛡️ تم بواسطة', value: await executorInfo(audit) }
    ]
  });
});
