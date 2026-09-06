/**
 * Times as the person reading them experiences them.
 *
 * The journal stores UTC, which is right: a run may be undone on another
 * machine in another country, and an ordering that depends on where you are
 * standing is not an ordering. But every view printed that UTC string
 * unchanged, so somebody in Kolkata watching an agent work saw 10:05 while
 * their clock said 15:35, and could not tell whether what they were looking at
 * had just happened or happened this morning.
 *
 * Stored in UTC, shown in local time. Nothing here changes what is recorded.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (value: number): string => String(value).padStart(2, "0");

/** Same calendar day, locally. */
function isToday(when: Date, now: Date): boolean {
  return (
    when.getFullYear() === now.getFullYear() &&
    when.getMonth() === now.getMonth() &&
    when.getDate() === now.getDate()
  );
}

/**
 * A column in a list: the time alone for today, the date too for anything
 * else. A bare time reads as ordering, and these lists are not ordered by
 * clock -- a fortnight-old 13:09 above this morning's 09:00 made the oldest
 * row look like the newest.
 */
export function shortTime(iso: string, now: Date = new Date()): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) {
    return iso.slice(11, 19).padEnd(12);
  }
  const time = `${pad(when.getHours())}:${pad(when.getMinutes())}`;
  if (isToday(when, now)) {
    return `${time}:${pad(when.getSeconds())}`.padEnd(12);
  }
  return `${pad(when.getDate())} ${MONTHS[when.getMonth()] ?? ""} ${time}`.padEnd(12);
}

/** The whole moment, for a header where there is room to say it in full. */
export function fullTime(iso: string, now: Date = new Date()): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) {
    return iso;
  }
  const clock = `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`;
  if (isToday(when, now)) {
    return `today at ${clock}`;
  }
  return `${pad(when.getDate())} ${MONTHS[when.getMonth()] ?? ""} ${String(when.getFullYear())}, ${clock}`;
}

/** "4 minutes ago". What you actually want to know while something is running. */
export function ago(iso: string, now: Date = new Date()): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) {
    return "";
  }
  const seconds = Math.max(0, Math.round((now.getTime() - when.getTime()) / 1000));
  if (seconds < 10) {
    return "just now";
  }
  if (seconds < 60) {
    return `${String(seconds)}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${String(minutes)}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${String(hours)}h ago`;
  }
  return `${String(Math.round(hours / 24))}d ago`;
}
