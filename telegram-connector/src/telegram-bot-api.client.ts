import axios from 'axios';

export interface BotSendResult {
  ok: boolean;
  externalMessageId?: string;
  error?: string;
}

/**
 * Thin Telegram Bot API client. Only the calls the connector needs. We don't
 * pull in node-telegram-bot-api or grammY because Sigcore drives polling/
 * webhook lifecycle elsewhere and we want the dependency surface minimal.
 */
export class TelegramBotApi {
  private readonly base: string;

  constructor(private readonly token: string, baseUrl = 'https://api.telegram.org') {
    this.base = `${baseUrl}/bot${token}`;
  }

  async getMe(): Promise<{ id: number; username?: string; first_name?: string } | null> {
    try {
      const res = await axios.get(`${this.base}/getMe`, { timeout: 10000 });
      if (!res.data?.ok) return null;
      return res.data.result;
    } catch {
      return null;
    }
  }

  async setWebhook(url: string, secretToken?: string): Promise<boolean> {
    try {
      const res = await axios.post(
        `${this.base}/setWebhook`,
        { url, secret_token: secretToken },
        { timeout: 10000 },
      );
      return Boolean(res.data?.ok);
    } catch {
      return false;
    }
  }

  async deleteWebhook(): Promise<boolean> {
    try {
      const res = await axios.post(`${this.base}/deleteWebhook`, {}, { timeout: 10000 });
      return Boolean(res.data?.ok);
    } catch {
      return false;
    }
  }

  async sendMessage(chatId: string, text: string): Promise<BotSendResult> {
    try {
      const res = await axios.post(
        `${this.base}/sendMessage`,
        { chat_id: chatId, text },
        { timeout: 15000 },
      );
      if (res.data?.ok && res.data?.result?.message_id) {
        return {
          ok: true,
          externalMessageId: `${chatId}:${res.data.result.message_id}`,
        };
      }
      return { ok: false, error: res.data?.description || 'unknown_error' };
    } catch (err) {
      // Surface Telegram's structured error if present, but never the URL
      // (which contains the bot token).
      const message =
        (axios.isAxiosError(err) && err.response?.data?.description) ||
        (err instanceof Error ? err.message : 'send_failed');
      return { ok: false, error: scrubMessage(message) };
    }
  }
}

function scrubMessage(msg: string): string {
  // Defense in depth — strip anything that looks like a bot token if it leaks
  // into an axios error string.
  return msg.replace(/\d{6,12}:[A-Za-z0-9_-]{30,}/g, '[REDACTED]');
}