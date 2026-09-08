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
  if (!user) return 'غير معروف';
  return `${user.tag || user.username}\n<@${user.id}> • \`${user.id}\``;
}

function memberInfo(member) {
  if (!member) return 'غير معروف';
  return `${member.user.tag}\n<@${member.id}> • \`${member.id}\``;
}

// اسم الرول كنص عادي فقط - بدون @Role mention
function roleInfo(role, fallbackId) {
  if (!role) return `Unknown Role\n\`${fallbackId || 'Unknown'}\``;
  return `**${role.name}**\n\`${role.id}\``;
}

function targetUserInfo(memberOrUser) {
  const user = memberOrUser?.user || memberOrUser;
  if (!user) return 'غير معروف';
  return `<@${user.id}>\n\`${user.id}\``;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getChannel(type) {
  const id = CONFIG.channels[type];
  if (!id) return null;

  const guild = client.guilds.cache.get(CONFIG.logGuildId);
  if (!guild) return null;

  const channel = guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null);
  return channel?.isTextBased() ? channel : null;
}

async function sendLog(type, options = {}) {
  const channel = await getChannel(type);

  if (!channel) {
    console.log(`[NMR LOGS] Missing ${type.toUpperCase()} channel ID in .env`);
    return;
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

  if (options.author) {
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

  try {
    await channel.send({ embeds: [embed] });
  } catch (error) {
    console.error('[NMR LOGS SEND ERROR]', error.message);
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
    console.error('[BOT STATE]', error.message);
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
// Also verify the channel whenever Discord provides it.
async function findMessageDeleteAudit(guild, authorId, channelId) {
  for (let attempt = 0; attempt < 7; attempt++) {
    if (attempt) await wait(500);
    try {
      const logs = await guild.fetchAuditLogs({
        type: AuditLogEvent.MessageDelete,
        limit: 50
      });

      const candidates = [...logs.entries.values()].filter(e => {
        if (Date.now() - e.createdTimestamp > 30000) return false;
        if (authorId && e.targetId !== authorId) return false;
        return true;
      });

      const exact = candidates.find(e => {
        const extra = e.extra || {};
        const auditChannel = extra.channelId || extra.channel_id || extra.channel?.id;
        return !channelId || !auditChannel || auditChannel === channelId;
      });

      if (exact) return exact;
    } catch {}
  }
  return null;
}

function saveMessage(message) {
  messageCache.set(message.id, {
    id: message.id,
    content: message.content || '',
    authorId: message.author?.id,
    authorTag: message.author?.tag,
    avatar: message.author?.displayAvatarURL?.(),
    channelId: message.channel?.id,
    channelName: message.channel?.name,
    attachments: [...message.attachments.values()].map(a => ({
      name: a.name,
      url: a.url,
      contentType: a.contentType
    })),
    embeds: message.embeds.map(e => ({
      title: e.title,
      description: e.description,
      url: e.url
    })),
    createdTimestamp: message.createdTimestamp
  });

  setTimeout(() => messageCache.delete(message.id), 24 * 60 * 60 * 1000);
}

// ============================================
// READY + INVITE CACHE
// ============================================

client.once(Events.ClientReady, async () => {
  console.log(`====================================`);
  console.log(` NMR LOGS V3 ULTIMATE ONLINE`);
  console.log(` Logged in as: ${client.user.tag}`);
  console.log(`====================================`);

  const source = client.guilds.cache.get(CONFIG.sourceGuildId);
  if (source) {
    const invites = await source.invites.fetch().catch(() => null);
    if (invites) inviteCache.set(source.id, new Map(invites.map(i => [i.code, i.uses])));
  }

  botReady = true;
  await sendBotState(
    '🟢 BOT STARTED',
    '**بوت NMR LOGS اشتغل بنجاح وهو الآن يراقب السيرفر**',
    COLORS.success,
    [
      { name: '🏠 السيرفر الأساسي', value: CONFIG.sourceGuildId ? `\`${CONFIG.sourceGuildId}\`` : 'غير معروف' },
      { name: '📊 حالة النظام', value: 'ONLINE ✅' }
    ]
  );
});

// Bot state listeners
client.on(Events.ShardDisconnect, async (event, shardId) => {
  if (botReady) {
    await sendBotState(
      '🔴 BOT DISCONNECTED',
      '**اتصال البوت بـ Discord انقطع**',
      COLORS.danger,
      [{ name: '📡 Shard', value: `${shardId}` }]
    );
  }
});

client.on(Events.ShardReconnecting, async shardId => {
  if (botReady) {
    await sendBotState(
      '🟡 BOT RECONNECTING',
      '**البوت يحاول إعادة الاتصال بـ Discord**',
      COLORS.warning,
      [{ name: '📡 Shard', value: `${shardId}` }]
    );
  }
});

client.on(Events.ShardResume, async (replayed, shardId) => {
  if (botReady) {
    await sendBotState(
      '🟢 BOT RECONNECTED',
      '**تمت إعادة اتصال البوت بنجاح**',
      COLORS.success,
      [{ name: '📡 Shard', value: `${shardId}` }]
    );
  }
});

// ============================================
// MEMBER LOGS
// ============================================

client.on(Events.GuildMemberAdd, async member => {
  if (!isSource(member.guild)) return;

  let inviteText = 'غير معروف';
  const oldInvites = inviteCache.get(member.guild.id);
  const newInvites = await member.guild.invites.fetch().catch(() => null);

  if (newInvites && oldInvites) {
    const used = newInvites.find(i => (oldInvites.get(i.code) || 0) < i.uses);
    if (used) {
      inviteText = `discord.gg/${used.code}\nبواسطة: ${used.inviter ? userInfo(used.inviter) : 'غير معروف'}`;
    }
  }

  if (newInvites) inviteCache.set(member.guild.id, new Map(newInvites.map(i => [i.code, i.uses])));

  await sendLog('logs', {
    title: '📥 MEMBER JOINED',
    description: '**عضو جديد دخل السيرفر**',
    color: COLORS.success,
    thumbnail: member.user.displayAvatarURL(),
    fields: [
      { name: '👤 العضو', value: memberInfo(member) },
      { name: '🎂 تاريخ إنشاء الحساب', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:F>` },
      { name: '🔗 طريقة الدخول', value: inviteText },
      { name: '👥 عدد الأعضاء', value: `${member.guild.memberCount}`, inline: true }
    ]
  });
});

client.on(Events.GuildMemberRemove, async member => {
  if (!isSource(member.guild)) return;

  const kick = await findAudit(member.guild, AuditLogEvent.MemberKick, member.id);

  if (kick) return;

  await sendLog('logs', {
    title: '📤 MEMBER LEFT',
    description: '**عضو خرج من السيرفر**',
    color: COLORS.warning,
    thumbnail: member.user.displayAvatarURL(),
    fields: [
      { name: '👤 العضو', value: memberInfo(member) },
      { name: '👥 عدد الأعضاء', value: `${member.guild.memberCount}`, inline: true }
    ]
  });
});

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  if (!isSource(newMember.guild)) return;

  // Nickname
  if (oldMember.nickname !== newMember.nickname) {
    const audit = await findAudit(newMember.guild, AuditLogEvent.MemberUpdate, newMember.id);

    await sendLog('logs', {
      title: '✏️ NICKNAME CHANGED',
      description: '**تم تغيير اسم عضو**',
      color: COLORS.info,
      thumbnail: newMember.user.displayAvatarURL(),
      fields: [
        { name: '👤 الشخص الذي تم تغيير اسمه', value: targetUserInfo(newMember) },
        { name: '⬅️ الاسم القديم', value: oldMember.nickname || oldMember.user.username },
        { name: '➡️ الاسم الجديد', value: newMember.nickname || newMember.user.username },
        { name: '🛡️ تم التغيير بواسطة', value: audit?.executor ? targetUserInfo(audit.executor) : 'غير معروف' }
      ]
    });
  }

  // Roles Added / Removed
  const oldRoles = new Set(oldMember.roles.cache.keys());
  const newRoles = new Set(newMember.roles.cache.keys());

  const added = [...newRoles].filter(id => !oldRoles.has(id) && id !== newMember.guild.id);
  const removed = [...oldRoles].filter(id => !newRoles.has(id) && id !== newMember.guild.id);

  const audit = (added.length || removed.length)
    ? await findAudit(newMember.guild, AuditLogEvent.MemberRoleUpdate, newMember.id, 20000)
    : null;

  // كل الرولات المضافة في Embed واحد
  if (added.length) {
    const rolesText = added.map((roleId, i) => {
      const role = newMember.guild.roles.cache.get(roleId);
      return `**${i + 1}.** ${roleInfo(role, roleId)}`;
    }).join('\n\n');

    await sendLog('roles', {
      title: '➕ ROLES ADDED',
      description: `**تم إعطاء ${added.length} رتبة للعضو**`,
      color: COLORS.success,
      thumbnail: newMember.user.displayAvatarURL(),
      fields: [
        { name: '👤 الشخص الذي تم إعطاؤه الرولات', value: targetUserInfo(newMember) },
        { name: '🎖️ الرولات التي تمت إضافتها', value: rolesText },
        { name: '🛡️ تم الإعطاء بواسطة', value: audit?.executor ? userInfo(audit.executor) : 'غير معروف' },
        { name: '📝 السبب', value: audit?.reason || 'لم يتم تقديم سبب' },
        { name: '🕒 وقت الإعطاء', value: `<t:${Math.floor(Date.now() / 1000)}:F>` }
      ]
    });
  }

  // كل الرولات المحذوفة في Embed واحد
  if (removed.length) {
    const rolesText = removed.map((roleId, i) => {
      const role = oldMember.roles.cache.get(roleId) || newMember.guild.roles.cache.get(roleId);
      return `**${i + 1}.** ${roleInfo(role, roleId)}`;
    }).join('\n\n');

    await sendLog('roles', {
      title: '➖ ROLES REMOVED',
      description: `**تم سحب ${removed.length} رتبة من العضو**`,
      color: COLORS.danger,
      thumbnail: newMember.user.displayAvatarURL(),
      fields: [
        { name: '👤 الشخص الذي تم إزالة الرولات منه', value: targetUserInfo(newMember) },
        { name: '🎖️ الرولات التي تمت إزالتها', value: rolesText },
        { name: '🛡️ تمت الإزالة بواسطة', value: audit?.executor ? userInfo(audit.executor) : 'غير معروف' },
        { name: '📝 السبب', value: audit?.reason || 'لم يتم تقديم سبب' },
        { name: '🕒 وقت الإزالة', value: `<t:${Math.floor(Date.now() / 1000)}:F>` }
      ]
    });
  }
});

// ============================================
// MESSAGE LOGS - CACHE EVERYTHING
// ============================================

client.on(Events.MessageCreate, message => {
  if (!message.guild || !isSource(message.guild)) return;
  if (message.author.bot && !CONFIG.logBotMessages) return;
  saveMessage(message);
});

client.on(Events.MessageDelete, async message => {
  if (!message.guild || !isSource(message.guild)) return;

  const saved = messageCache.get(message.id);

  if (message.partial) {
    await message.fetch().catch(() => null);
  }

  const authorId = message.author?.id || saved?.authorId;
  const audit = await findMessageDeleteAudit(message.guild, authorId, message.channelId || saved?.channelId);

  // MessageDelete does not include the message body when the message is partial.
  // The local messageCache is therefore the only reliable source after deletion.
  const content = message.content || saved?.content || 'تعذر استرجاع محتوى الرسالة (لم يكن محفوظًا قبل الحذف)';
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
        value: message.author ? userInfo(message.author) : `${saved?.authorTag || 'غير معروف'}\n\`${saved?.authorId || 'غير معروف'}\``
      },
      {
        name: '📍 الروم',
        value: message.channel ? `<#${message.channel.id}> • \`${message.channel.id}\`` : `#${saved?.channelName || 'غير معروف'}`
      },
      { name: '💬 الرسالة المحذوفة', value: code(content) },
      {
        name: '🛡️ تم الحذف بواسطة',
        // Discord does not create a MessageDelete audit entry when a user deletes
        // their own message. In that case, fall back to the message author.
        value: audit?.executor
          ? userInfo(audit.executor)
          : (authorId ? `<@${authorId}>\n\`${authorId}\`` : 'غير معروف')
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

  messageCache.delete(message.id);
});

client.on(Events.MessageDeleteBulk, async messages => {
  const first = messages.first();
  if (!first?.guild || !isSource(first.guild)) return;

  const list = messages.map(msg => {
    const saved = messageCache.get(msg.id);
    return `• **${msg.author?.tag || saved?.authorTag || 'Unknown'}**: ${trim(msg.content || saved?.content || 'بدون نص', 180)}`;
  }).join('\n');

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
      { name: '👤 العضو', value: newMessage.author ? userInfo(newMessage.author) : 'غير معروف' },
      { name: '📍 الروم', value: `<#${newMessage.channel.id}> • \`${newMessage.channel.id}\`` },
      { name: '⬅️ الرسالة القديمة', value: code(oldContent || 'بدون نص') },
      { name: '➡️ الرسالة الجديدة', value: code(newContent || 'بدون نص') },
      { name: '🔗 رابط الرسالة', value: newMessage.url || 'غير متاح' }
    ]
  });

  saveMessage(newMessage);
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
        { name: '📍 الروم', value: `${newState.channel || oldState.channel || 'غير معروف'}` },
        { name: '📊 الحالة', value: newState[key] ? 'تم التفعيل 🔴' : 'تم الإلغاء 🟢' },
        { name: '🛡️ تم بواسطة', value: audit?.executor ? userInfo(audit.executor) : 'غير معروف' }
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
        { name: '📍 الروم', value: `${newState.channel || oldState.channel || 'غير معروف'}` },
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
      { name: '🛡️ بواسطة', value: audit?.executor ? userInfo(audit.executor) : 'غير معروف' },
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
      { name: '🛡️ بواسطة', value: audit?.executor ? userInfo(audit.executor) : 'غير معروف' }
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
      { name: '🛡️ بواسطة', value: audit?.executor ? userInfo(audit.executor) : 'غير معروف' }
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
      { name: '🛡️ بواسطة', value: audit?.executor ? userInfo(audit.executor) : 'غير معروف' }
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
      { name: '🛡️ بواسطة', value: audit?.executor ? `<@${audit.executor.id}>` : 'غير معروف' }
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
// ROLE LOGS - DEEP
// ============================================

client.on(Events.GuildRoleCreate, async role => {
  if (!isSource(role.guild)) return;
  const audit = await findAudit(role.guild, AuditLogEvent.RoleCreate, role.id);

  await sendLog('roles', {
    title: '➕ ROLE CREATED',
    description: '**تم إنشاء رتبة جديدة**',
    color: COLORS.success,
    fields: [
      { name: '🎭 الاسم', value: role.name },
      { name: '🆔 ID', value: `\`${role.id}\`` },
      { name: '🎨 اللون', value: role.hexColor },
      { name: '🛡️ بواسطة', value: audit?.executor ? userInfo(audit.executor) : 'غير معروف' }
    ]
  });
});

client.on(Events.GuildRoleDelete, async role => {
  if (!isSource(role.guild)) return;
  const audit = await findAudit(role.guild, AuditLogEvent.RoleDelete, role.id);

  await sendLog('roles', {
    title: '🗑️ ROLE DELETED',
    description: '**تم حذف رتبة**',
    color: COLORS.danger,
    fields: [
      { name: '🎭 الاسم', value: role.name },
      { name: '🆔 ID', value: `\`${role.id}\`` },
      { name: '🛡️ بواسطة', value: audit?.executor ? userInfo(audit.executor) : 'غير معروف' }
    ]
  });
});

client.on(Events.GuildRoleUpdate, async (oldRole, newRole) => {
  if (!isSource(newRole.guild)) return;

  const changes = [];
  if (oldRole.name !== newRole.name) changes.push(`**Name:** ${oldRole.name} ➜ ${newRole.name}`);
  if (oldRole.hexColor !== newRole.hexColor) changes.push(`**Color:** ${oldRole.hexColor} ➜ ${newRole.hexColor}`);
  if (oldRole.hoist !== newRole.hoist) changes.push(`**Hoist:** ${oldRole.hoist} ➜ ${newRole.hoist}`);
  if (oldRole.mentionable !== newRole.mentionable) changes.push(`**Mentionable:** ${oldRole.mentionable} ➜ ${newRole.mentionable}`);
  const permissionDiff = diffPermissions(oldRole.permissions, newRole.permissions);
  if (permissionDiff.added.length || permissionDiff.removed.length) changes.push('**Permissions:** تم تعديل الصلاحيات');

  if (!changes.length) return;

  const audit = await findAudit(newRole.guild, AuditLogEvent.RoleUpdate, newRole.id);

  await sendLog('roles', {
    title: '✏️ ROLE UPDATED',
    description: '**تم تعديل رتبة**',
    color: COLORS.role,
    fields: [
      { name: '🎭 الرتبة', value: roleInfo(newRole) },
      { name: '📝 التغييرات', value: changes.join('\n') },
      ...(permissionDiff.added.length ? [{
        name: `➕ صلاحيات تمت إضافتها (${permissionDiff.added.length})`,
        value: trim(permissionText(permissionDiff.added), 1024)
      }] : []),
      ...(permissionDiff.removed.length ? [{
        name: `➖ صلاحيات تمت إزالتها (${permissionDiff.removed.length})`,
        value: trim(permissionText(permissionDiff.removed), 1024)
      }] : []),
      { name: '🛡️ بواسطة', value: audit?.executor ? userInfo(audit.executor) : 'غير معروف' }
    ]
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
      { name: '👤 بواسطة', value: invite.inviter ? userInfo(invite.inviter) : 'غير معروف' },
      { name: '📍 الروم', value: invite.channel ? `${invite.channel}` : 'غير معروف' },
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

client.on(Events.GuildAuditLogEntryCreate, async (entry, guild) => {
  if (!isSource(guild)) return;

  const key = `${guild.id}-${entry.id}`;
  if (auditSeen.has(key)) return;
  auditSeen.add(key);
  setTimeout(() => auditSeen.delete(key), 60000);

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
        { name: '🛡️ تم الطرد بواسطة', value: entry.executor ? targetUserInfo(entry.executor) : 'غير معروف' },
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
  setTimeout(() => gracefulExit('CRASH', 1), 800);
});

if (!CONFIG.sourceGuildId || !CONFIG.logGuildId) {
  console.warn('⚠️ SOURCE_GUILD_ID or LOG_GUILD_ID is missing in .env');
}

if (!CONFIG.token) {
  console.error('❌ TOKEN is missing in .env');
  process.exit(1);
}

client.login(CONFIG.token);


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
      { name: '🛡️ تم بواسطة', value: audit?.executor ? userInfo(audit.executor) : 'غير معروف' }
    ]
  });
});
