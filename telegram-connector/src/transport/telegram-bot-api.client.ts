import axios from 'axios';

const BASE = 'https://api.telegram.org';

export async function sendBotMessage(
  botToken: string,
  chatId: string,
  text: string,
): Promise<{ ok: boolean; messageId?: string; description?: string }> {
  try {
    const res = await axios.post(
      `${BASE}/bot${botToken}/sendMessage`,
      { chat_id: chatId, text },
      { timeout: 20000 },
    );
    const data = res.data || {};
    if (data.ok) {
      return { ok: true, messageId: String(data.result?.message_id) };
    }
    return { ok: false, description: data.description };
  } catch (e: any) {
    return { ok: false, description: e?.response?.data?.description || e?.message || 'unknown' };
  }
}

export async function getBotInfo(botToken: string): Promise<{ ok: boolean; username?: string }> {
  try {
    const res = await axios.get(`${BASE}/bot${botToken}/getMe`, { timeout: 10000 });
    if (res.data?.ok) return { ok: true, username: res.data.result?.username };
    return { ok: false };
  } catch {
    return { ok: false };
  }
}
