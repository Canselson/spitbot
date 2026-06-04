const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatTime(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDayHeader(date) {
  return `${DAY_NAMES[date.getDay()]} ${date.getDate()} ${MONTH_NAMES[date.getMonth()]}`;
}

function formatEvent(event) {
  if (event.allDay) {
    const counter = event.totalDays ? ` (day ${event.dayOf} of ${event.totalDays})` : '';
    return `• All day – ${event.summary}${counter}`;
  }
  return `• ${formatTime(event.start)} – ${event.summary}`;
}

function formatWeeklyMessage(events) {
  if (events.length === 0) {
    return '📅 *This Week\'s Events*\n\n_No events scheduled this week._';
  }

  // Group events by calendar date (ignoring time)
  const byDay = new Map();
  for (const event of events) {
    const key = event.start.toDateString();
    if (!byDay.has(key)) {
      byDay.set(key, { date: event.start, events: [] });
    }
    byDay.get(key).events.push(event);
  }

  const lines = ['📅 *This Week\'s Events*'];

  for (const { date, events: dayEvents } of byDay.values()) {
    lines.push('');
    lines.push(`*${formatDayHeader(date)}*`);
    for (const event of dayEvents) {
      lines.push(formatEvent(event));
    }
  }

  return lines.join('\n');
}

module.exports = { formatWeeklyMessage };
