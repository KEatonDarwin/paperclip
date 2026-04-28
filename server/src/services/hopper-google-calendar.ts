interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

export interface CalendarEvent {
  id: string;
  summary: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  htmlLink: string;
}

interface EventListResponse {
  items?: CalendarEvent[];
}

interface FreeBusyResponse {
  calendars: {
    primary?: { busy: Array<{ start: string; end: string }> };
  };
}

interface GoogleCalendarService {
  findFreeSlot(preferredStart: Date, durationMinutes: number): Promise<Date>;
  createEvent(
    title: string,
    description: string | null,
    start: Date,
    durationMinutes: number,
  ): Promise<{ eventId: string; htmlLink: string }>;
  listEvents(timeMin: Date, timeMax: Date): Promise<CalendarEvent[]>;
}

export function googleCalendarService(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): GoogleCalendarService {
  let cachedToken: string | null = null;
  let tokenExpiresAt = 0;

  async function getAccessToken(): Promise<string> {
    if (cachedToken && Date.now() < tokenExpiresAt - 60_000) {
      return cachedToken;
    }
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    if (!res.ok) {
      throw new Error(`Google token refresh failed: ${res.status}`);
    }
    const data = (await res.json()) as TokenResponse;
    cachedToken = data.access_token;
    tokenExpiresAt = Date.now() + data.expires_in * 1000;
    return cachedToken;
  }

  async function authHeaders(): Promise<Record<string, string>> {
    const token = await getAccessToken();
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
  }

  /**
   * Find the first free slot at or after preferredStart for durationMinutes.
   * Searches in 30-minute increments within a 7-day window.
   */
  async function findFreeSlot(preferredStart: Date, durationMinutes: number): Promise<Date> {
    const windowEnd = new Date(preferredStart.getTime() + 7 * 24 * 60 * 60 * 1000);
    const headers = await authHeaders();

    const res = await fetch("https://www.googleapis.com/calendar/v3/freebusy", {
      method: "POST",
      headers,
      body: JSON.stringify({
        timeMin: preferredStart.toISOString(),
        timeMax: windowEnd.toISOString(),
        items: [{ id: "primary" }],
      }),
    });

    if (!res.ok) {
      // If freebusy fails, fall back to the preferred start time
      return preferredStart;
    }

    const data = (await res.json()) as FreeBusyResponse;
    const busySlots = data.calendars?.primary?.busy ?? [];

    // Walk through time in 30-min increments until we find a free slot
    const slotMs = durationMinutes * 60 * 1000;
    let candidate = new Date(preferredStart);

    for (let i = 0; i < 336; i++) { // max 7 days × 48 slots
      const candidateEnd = new Date(candidate.getTime() + slotMs);
      const conflicting = busySlots.some((busy) => {
        const busyStart = new Date(busy.start).getTime();
        const busyEnd = new Date(busy.end).getTime();
        return candidate.getTime() < busyEnd && candidateEnd.getTime() > busyStart;
      });

      if (!conflicting) {
        return candidate;
      }

      // Advance by 30 minutes
      candidate = new Date(candidate.getTime() + 30 * 60 * 1000);
    }

    // If no slot found, return preferred start as fallback
    return preferredStart;
  }

  async function createEvent(
    title: string,
    description: string | null,
    start: Date,
    durationMinutes: number,
  ): Promise<{ eventId: string; htmlLink: string }> {
    const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
    const headers = await authHeaders();

    const body: Record<string, unknown> = {
      summary: title,
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
    };
    if (description) {
      body.description = description;
    }

    const res = await fetch(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      },
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => res.status.toString());
      throw new Error(`Google Calendar createEvent failed: ${errText}`);
    }

    const event = (await res.json()) as CalendarEvent;
    return { eventId: event.id, htmlLink: event.htmlLink };
  }

  async function listEvents(timeMin: Date, timeMax: Date): Promise<CalendarEvent[]> {
    const headers = await authHeaders();
    const params = new URLSearchParams({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
    });
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
      { headers },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as EventListResponse;
    return data.items ?? [];
  }

  return { findFreeSlot, createEvent, listEvents };
}
