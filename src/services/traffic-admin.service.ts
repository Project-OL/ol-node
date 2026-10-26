import { prismaRead } from '../config/database'
import { redisClient, RedisKeys } from '../config/redis'
import {
  ALL_SECTIONS,
  istDayDate,
  istDayKey,
  istHourKey,
  ONLINE_WINDOW_MS,
} from './traffic.service'

/**
 * TRF-05: read side of the admin Traffic page. All days are IST calendar days. Postgres holds the
 * history (rolled up every 10 min); "now" reads Redis directly.
 */
const DAY_MS = 86_400_000

export type MinutePoint = {
  t: string
  online: number
  hosts: number | null
  viewers: number | null
  calls: number | null
}

export type DaySummary = {
  coverageMinutes: number
  peak: { online: number; at: string } | null
  low: { online: number; at: string } | null
  median: number | null
  quietWindow: { from: string; to: string; minutes: number; threshold: number } | null
}

/** `YYYY-MM-DD` (IST) -> [start, end) instants. */
export function istDayRange(date: string): { from: Date; to: Date } {
  const from = new Date(`${date}T00:00:00+05:30`)
  return { from, to: new Date(from.getTime() + DAY_MS) }
}

/** Today's IST date as `YYYY-MM-DD`. */
export function istToday(now = Date.now()): string {
  const k = istDayKey(now)
  return `${k.slice(0, 4)}-${k.slice(4, 6)}-${k.slice(6, 8)}`
}

/**
 * Peak, low, median and the longest quiet stretch of a day's online-user minutes. Quiet = online
 * users at or under 20% of the day's peak (at least 1), over consecutive recorded minutes.
 */
export function summarizeDay(points: { t: string; online: number }[]): DaySummary {
  if (points.length === 0)
    return { coverageMinutes: 0, peak: null, low: null, median: null, quietWindow: null }
  let peak = points[0]!
  let low = points[0]!
  for (const p of points) {
    if (p.online > peak.online) peak = p
    if (p.online < low.online) low = p
  }
  const sorted = points.map((p) => p.online).sort((a, b) => a - b)
  const median = sorted[Math.floor((sorted.length - 1) / 2)]!

  let quietWindow: DaySummary['quietWindow'] = null
  if (peak.online > 0) {
    const threshold = Math.max(1, Math.floor(peak.online * 0.2))
    let start = -1
    let best: [number, number] | null = null
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!
      if (p.online > threshold) {
        start = -1
        continue
      }
      // A missing minute (no sample) breaks the run: a gap is not proof of quiet.
      const joins = i > 0 && Date.parse(p.t) - Date.parse(points[i - 1]!.t) === 60_000
      if (start < 0 || !joins) start = i
      if (!best || i - start > best[1] - best[0]) best = [start, i]
    }
    if (best) {
      quietWindow = {
        from: points[best[0]]!.t,
        to: points[best[1]]!.t,
        minutes: best[1] - best[0] + 1,
        threshold,
      }
    }
  }
  return {
    coverageMinutes: points.length,
    peak: { online: peak.online, at: peak.t },
    low: { online: low.online, at: low.t },
    median,
    quietWindow,
  }
}

function dayKeyOf(date: string): string {
  return date.replaceAll('-', '')
}

export const trafficAdminService = {
  /** Online now, live and calls now, and this hour's sections (straight from Redis). */
  async now(now = Date.now()) {
    const hour = istHourKey(now)
    const [online, live, req, latest] = await Promise.all([
      redisClient.zcount(RedisKeys.presenceLastPing(), now - ONLINE_WINDOW_MS, '+inf'),
      redisClient.hgetall(RedisKeys.trafficLiveNow()),
      redisClient.hgetall(RedisKeys.trafficHourRequests(hour)),
      prismaRead.trafficMinute.findFirst({ orderBy: { minute: 'desc' }, select: { minute: true } }),
    ])
    const sections = Object.keys(req ?? {})
    const users = await Promise.all(
      sections.map((s) => redisClient.pfcount(RedisKeys.trafficHourSectionUsers(hour, s))),
    )
    const liveAt = Number(live?.at ?? 0)
    const n = (v?: string) => (v == null || v === '' ? null : Number(v))
    return {
      at: new Date(now).toISOString(),
      onlineUsers: online,
      live: liveAt
        ? {
            at: new Date(liveAt).toISOString(),
            hostsLive: n(live.hostsLive),
            viewers: n(live.viewers),
            callsActive: n(live.callsActive),
            usersInCalls: n(live.usersInCalls),
          }
        : null,
      thisHour: {
        hour: `${hour.slice(8, 10)}:00`,
        users: await redisClient.pfcount(RedisKeys.trafficHourUsers(hour)),
        sections: sections
          .map((section, i) => ({ section, requests: Number(req[section]), users: users[i] ?? 0 }))
          .sort((a, b) => b.users - a.users || b.requests - a.requests),
      },
      lastSampleAt: latest?.minute.toISOString() ?? null,
    }
  },

  /** One IST day: minute series (+ previous day's for comparison), summary, hours, sections. */
  async day(date: string) {
    const { from, to } = istDayRange(date)
    const prevFrom = new Date(from.getTime() - DAY_MS)
    const dayDate = istDayDate(dayKeyOf(date))
    const [minutes, prevMinutes, hourly, daily] = await Promise.all([
      prismaRead.trafficMinute.findMany({
        where: { minute: { gte: from, lt: to } },
        orderBy: { minute: 'asc' },
      }),
      prismaRead.trafficMinute.findMany({
        where: { minute: { gte: prevFrom, lt: from } },
        orderBy: { minute: 'asc' },
        select: { minute: true, onlineUsers: true },
      }),
      prismaRead.trafficHourly.findMany({
        where: { hour: { gte: from, lt: to }, section: ALL_SECTIONS },
        orderBy: { hour: 'asc' },
      }),
      prismaRead.trafficDaily.findMany({ where: { day: dayDate } }),
    ])
    const points: MinutePoint[] = minutes.map((m) => ({
      t: m.minute.toISOString(),
      online: m.onlineUsers,
      hosts: m.hostsLive,
      viewers: m.liveViewers,
      calls: m.callsActive,
    }))
    const all = daily.find((d) => d.section === ALL_SECTIONS)
    return {
      date,
      timezone: 'Asia/Kolkata',
      summary: {
        ...summarizeDay(points),
        activeUsers: all?.users ?? null,
        requests: all?.requests ?? null,
        errors5xx: all?.errors5xx ?? null,
        peakHostsLive: points.reduce<number | null>(
          (a, p) => (p.hosts == null ? a : Math.max(a ?? 0, p.hosts)),
          null,
        ),
      },
      minutes: points,
      previousDay: prevMinutes.map((m) => ({ t: m.minute.toISOString(), online: m.onlineUsers })),
      hours: hourly.map((h) => ({
        hour: istHourKey(h.hour).slice(8, 10),
        users: h.users,
        requests: h.requests,
        errors5xx: h.errors5xx,
      })),
      sections: daily
        .filter((d) => d.section !== ALL_SECTIONS)
        .map((d) => ({
          section: d.section,
          users: d.users,
          requests: d.requests,
          errors5xx: d.errors5xx,
        }))
        .sort((a, b) => b.users - a.users || b.requests - a.requests),
    }
  },

  /** The last `days` IST days ending today: per-day totals, hour-of-day heatmap, uniques, sections. */
  async range(days: 7 | 30, now = Date.now()) {
    const today = istToday(now)
    const { to } = istDayRange(today)
    const from = new Date(to.getTime() - days * DAY_MS)
    const dates = Array.from({ length: days }, (_, i) =>
      istToday(from.getTime() + i * DAY_MS + 3_600_000),
    )
    const dayKeys = dates.map(dayKeyOf)

    const [daily, hourly, peaks] = await Promise.all([
      prismaRead.trafficDaily.findMany({
        where: { day: { gte: istDayDate(dayKeys[0]!), lte: istDayDate(dayKeys.at(-1)!) } },
      }),
      prismaRead.trafficHourly.findMany({
        where: { hour: { gte: from, lt: to }, section: ALL_SECTIONS },
        select: { hour: true, users: true },
      }),
      prismaRead.$queryRawUnsafe<{ d: string; peak: number }[]>(
        `select to_char((minute at time zone 'Asia/Kolkata')::date, 'YYYY-MM-DD') d, max(online_users)::int peak
           from traffic_minute where minute >= $1 and minute < $2 group by 1`,
        from,
        to,
      ),
    ])
    const sectionNames = [...new Set(daily.map((d) => d.section).filter((s) => s !== ALL_SECTIONS))]
    const [uniqueUsers, ...sectionUsers] = await Promise.all([
      redisClient.pfcount(...dayKeys.map((k) => RedisKeys.trafficDayUsers(k))),
      ...sectionNames.map((s) =>
        redisClient.pfcount(...dayKeys.map((k) => RedisKeys.trafficDaySectionUsers(k, s))),
      ),
    ])
    const peakByDate = new Map(peaks.map((p) => [p.d, p.peak]))
    const allByDate = new Map(
      daily
        .filter((d) => d.section === ALL_SECTIONS)
        .map((d) => [d.day.toISOString().slice(0, 10), d]),
    )
    return {
      days,
      from: dates[0],
      to: today,
      uniqueUsers,
      perDay: dates.map((date) => ({
        date,
        activeUsers: allByDate.get(date)?.users ?? null,
        requests: allByDate.get(date)?.requests ?? null,
        peakOnline: peakByDate.get(date) ?? null,
      })),
      heatmap: hourly.map((h) => {
        const k = istHourKey(h.hour)
        return {
          date: `${k.slice(0, 4)}-${k.slice(4, 6)}-${k.slice(6, 8)}`,
          hour: Number(k.slice(8, 10)),
          users: h.users,
        }
      }),
      sections: sectionNames
        .map((section, i) => ({
          section,
          users: sectionUsers[i] ?? 0,
          requests: daily.filter((d) => d.section === section).reduce((a, d) => a + d.requests, 0),
        }))
        .sort((a, b) => b.users - a.users || b.requests - a.requests),
    }
  },
}
