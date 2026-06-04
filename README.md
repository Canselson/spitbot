# spitbot

Sends a formatted weekly calendar digest to a WhatsApp group every Monday at 08:00.

## How it works

1. Every Monday at 08:00 (configurable), it fetches a public `.ics` calendar URL.
2. It parses all events for the current Monday–Sunday week.
3. It formats them into a readable WhatsApp message and sends it to the configured group.

## Prerequisites

- Node.js 18+
- A WhatsApp account you can link (the bot runs as a linked device)
- A publicly accessible `.ics` calendar URL

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create your `.env` file

```bash
cp .env.example .env
```

Edit `.env` and fill in your values:

| Variable               | Description                                                                 |
|------------------------|-----------------------------------------------------------------------------|
| `ICS_URL`              | Public `.ics` URL (see below for how to get one from Google Calendar)       |
| `WHATSAPP_GROUP_NAME`  | The **exact** name of the WhatsApp group to send the message to             |
| `CRON_SCHEDULE`        | Cron expression — default `0 8 * * 1` (Monday 08:00). See crontab.guru     |

#### Getting a Google Calendar `.ics` URL

1. Open Google Calendar → Settings (gear icon) → click your calendar name under "My calendars".
2. Scroll to **"Integrate calendar"** → copy **"Secret address in iCal format"**.
3. Paste it as `ICS_URL` in `.env`.

### 3. Link your WhatsApp account

Run the bot once — it will display a QR code in the terminal:

```bash
npm start
```

Open WhatsApp on your phone → **Settings → Linked Devices → Link a Device** → scan the QR code.

The session is saved to `.wwebjs_auth/` so you won't need to scan again on subsequent runs.

## Usage

### Start the bot (runs continuously, triggers on schedule)

```bash
npm start
```

### Send a message immediately (for testing)

```bash
npm run test-send
```

This fetches this week's events right now and sends the message — no waiting for Monday.

## Message format

```
📅 *This Week's Events*

*Monday 9 June*
• 10:00 – Team standup
• 14:00 – Client call

*Wednesday 11 June*
• All day – Company away day
```

Days with no events are omitted entirely. If the whole week is empty, a "No events" message is sent instead.

## File structure

```
spitbot/
├── src/
│   ├── index.js       — entry point; starts cron + WhatsApp client
│   ├── calendar.js    — fetches and parses the .ics feed
│   ├── formatter.js   — builds the WhatsApp message string
│   ├── whatsapp.js    — WhatsApp client setup and send helper
│   └── test-send.js   — sends immediately without waiting for cron
├── .env               — your config (never commit this)
├── .env.example       — template
└── .gitignore
```

## Notes

- **Session persistence**: WhatsApp session files are stored in `.wwebjs_auth/`. Back this up if you want to avoid re-scanning after a reinstall.
- **Recurring events**: Recurring events (RRULE) and their exceptions (EXDATE) are handled automatically.
- **Timezones**: Events are displayed in the local system timezone. Make sure the machine running the bot is set to the correct timezone.
- **Keep the bot running**: Use a process manager like [PM2](https://pm2.keymetrics.io/) or a system service to keep it alive:
  ```bash
  npm install -g pm2
  pm2 start npm --name spitbot -- start
  pm2 save
  ```
