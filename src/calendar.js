require('dotenv').config();
const ical = require('node-ical');

function getWeekBounds() {
  const now = new Date();
  const day = now.getDay(); // 0 = Sunday, 1 = Monday …
  const diffToMonday = day === 0 ? -6 : 1 - day;

  const monday = new Date(now);
  monday.setDate(now.getDate() + diffToMonday);
  monday.setHours(0, 0, 0, 0);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);

  return { monday, sunday };
}

// Returns the week the bot will cover on its next Monday send.
// If today is Monday, that's this week; otherwise it's next Monday's week.
function getNextWeekBounds() {
  const now = new Date();
  const day = now.getDay();
  const diffToNextMonday = day === 1 ? 0 : (8 - day) % 7;

  const monday = new Date(now);
  monday.setDate(now.getDate() + diffToNextMonday);
  monday.setHours(0, 0, 0, 0);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);

  return { monday, sunday };
}

function isAllDay(event) {
  return !!(event.start && event.start.dateOnly);
}

// ICS DTEND for all-day events is the day AFTER the last day (exclusive).
// This expands one event into one entry per day it covers within the week,
// including events that started before Monday or end after Sunday.
function expandAllDayEvent(event, monday, sunday) {
  const eventStart = event.start;
  const totalDays = Math.round((event.end - eventStart) / 86400000);
  // Subtract 1 ms so the last day is inclusive for comparisons
  const eventLastDay = new Date(event.end - 1);

  const rangeStart = eventStart < monday ? monday : eventStart;
  const rangeEnd = eventLastDay > sunday ? sunday : eventLastDay;

  if (rangeStart > rangeEnd) return [];

  const results = [];
  const cursor = new Date(rangeStart);
  cursor.setHours(0, 0, 0, 0);

  while (cursor <= rangeEnd) {
    const dayOf = Math.round((cursor - eventStart) / 86400000) + 1;
    results.push({
      summary: event.summary || '(No title)',
      start: new Date(cursor),
      allDay: true,
      dayOf: totalDays > 1 ? dayOf : null,
      totalDays: totalDays > 1 ? totalDays : null,
    });
    cursor.setDate(cursor.getDate() + 1);
  }

  return results;
}

async function getWeekEvents(bounds) {
  const url = process.env.ICS_URL;
  if (!url) throw new Error('ICS_URL is not set in .env');

  const { monday, sunday } = bounds || getWeekBounds();

  let rawEvents;
  try {
    rawEvents = await ical.async.fromURL(url);
  } catch (err) {
    throw new Error(`Failed to fetch calendar from ICS_URL: ${err.message}`);
  }

  const weekEvents = [];

  for (const key of Object.keys(rawEvents)) {
    const event = rawEvents[key];
    if (event.type !== 'VEVENT') continue;

    const allDay = isAllDay(event);

    if (event.rrule) {
      const exdates = event.exdate ? Object.values(event.exdate) : [];
      const exdateSet = new Set(exdates.map((d) => d.toDateString()));

      const occurrences = event.rrule.between(monday, sunday, true);
      for (const date of occurrences) {
        if (exdateSet.has(date.toDateString())) continue;
        const duration = event.end && event.start ? event.end - event.start : 0;
        const occEnd = new Date(date.getTime() + duration);

        if (allDay) {
          weekEvents.push(...expandAllDayEvent({ ...event, start: date, end: occEnd }, monday, sunday));
        } else {
          weekEvents.push({
            summary: event.summary || '(No title)',
            start: date,
            end: occEnd,
            allDay: false,
            dayOf: null,
            totalDays: null,
          });
        }
      }
    } else {
      if (!event.start) continue;

      if (allDay) {
        weekEvents.push(...expandAllDayEvent(event, monday, sunday));
      } else {
        // Timed events: include only if they start within the week
        if (event.start >= monday && event.start <= sunday) {
          weekEvents.push({
            summary: event.summary || '(No title)',
            start: event.start,
            end: event.end || event.start,
            allDay: false,
            dayOf: null,
            totalDays: null,
          });
        }
      }
    }
  }

  return weekEvents.sort((a, b) => a.start - b.start);
}

module.exports = { getWeekEvents, getWeekBounds, getNextWeekBounds };
