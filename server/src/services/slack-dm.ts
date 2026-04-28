interface SlackMessage {
  type: string;
  ts: string;
  text: string;
  bot_id?: string;
  user?: string;
}

interface SlackDmService {
  openChannel(): Promise<string>;
  postMessage(channelId: string, text: string): Promise<string>;
  fetchReplies(channelId: string, threadTs: string, afterTs: string): Promise<SlackMessage[]>;
}

export function slackDm(botToken: string, targetUserId: string): SlackDmService {
  const baseHeaders = {
    "Content-Type": "application/json; charset=utf-8",
    Authorization: `Bearer ${botToken}`,
  };

  async function callApi(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`https://slack.com/api/${path}`, {
      method: "POST",
      headers: baseHeaders,
      body: JSON.stringify(body),
    });
    return res.json();
  }

  async function openChannel(): Promise<string> {
    const data = await callApi("conversations.open", { users: targetUserId }) as {
      ok: boolean;
      error?: string;
      channel?: { id: string };
    };
    if (!data.ok) throw new Error(data.error ?? "conversations.open failed");
    return data.channel!.id;
  }

  async function postMessage(channelId: string, text: string): Promise<string> {
    const data = await callApi("chat.postMessage", { channel: channelId, text }) as {
      ok: boolean;
      error?: string;
      ts?: string;
    };
    if (!data.ok) throw new Error(data.error ?? "chat.postMessage failed");
    return data.ts!;
  }

  async function fetchReplies(channelId: string, threadTs: string, afterTs: string): Promise<SlackMessage[]> {
    let data: { ok: boolean; messages?: SlackMessage[] };
    try {
      data = await callApi("conversations.replies", {
        channel: channelId,
        ts: threadTs,
        oldest: afterTs,
        inclusive: false,
        limit: 50,
      }) as typeof data;
    } catch {
      return [];
    }
    if (!data.ok) return [];
    const messages = data.messages ?? [];
    // Exclude bot messages and the thread parent (ts === threadTs)
    return messages.filter(
      (m) => m.ts !== threadTs && !m.bot_id && m.type === "message",
    );
  }

  return { openChannel, postMessage, fetchReplies };
}
