# NMR LOGS

## 1) Install
```bash
npm install
```

## 2) Configure
Rename `.env.example` to `.env` and put:
- Bot Token
- Main server ID in SOURCE_GUILD_ID
- Logs server ID in LOG_GUILD_ID

You can either:
- put exact channel IDs in `.env`, OR
- keep them empty and name the channels exactly:
  - 〘 Logs 〙
  - 〘 Roles 〙
  - 〘 Voice・State 〙
  - 〘 Bans 〙
  - 〘 Kicks 〙

## 3) Discord Developer Portal
Enable these Privileged Gateway Intents:
- SERVER MEMBERS INTENT
- MESSAGE CONTENT INTENT
- PRESENCE INTENT (optional)

## 4) Bot permissions
On the main server:
- View Audit Log
- View Channels
- Read Message History

On logs server:
- View Channels
- Send Messages
- Embed Links
- Attach Files

## 5) Start
```bash
npm start
```

Important:
Discord does not expose every internal action as a separate event. This bot captures the broad Discord events and Audit Log actions available to bots. Deleted/edited message content is best captured while the bot is online and has Message Content Intent.
