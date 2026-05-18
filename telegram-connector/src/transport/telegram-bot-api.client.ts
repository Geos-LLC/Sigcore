import axios, { AxiosInstance } from 'axios';

export interface TelegramSendResponse {
  ok: boolean;
  result?: { message_id: number; chat?: { id: number }; date: number };
  description?: string;
  error_code?: number;
}

export interface TelegramGetMeResponse {
  ok: boolean;
  result?: { id: number; is_bot: boolean; username?: string; first_name?: string };
  description?: string;
}

/** Thin Telegram Bot API client.  Stateless; one instance per request is fine. */
export class TelegramBotApiClient {
  private readonly http: AxiosInstance;

  constructor(private readonly botToken: string, baseUrl = 'https://api.telegram.org') {
    if (!botToken) throw new Error('bot_token_required');
    this.http = axios.create({
      baseURL: `${baseUrl}/bot${botToken}`,
      timeout: 15000,
    });
  }

  async sendMessage(chatId: string | number, text: string): Promise<TelegramSendResponse> {
    const res = await this.http.post<TelegramSendResponse>('/sendMessage', {
      chat_id: chatId,
      text,
    });
    return res.data;
  }

  async getMe(): Promise<TelegramGetMeResponse> {
    const res = await this.http.get<TelegramGetMeResponse>('/getMe');
    return res.data;
  }
}

export type TelegramBotApiClientFactory = (token: string) => TelegramBotApiClient;
export const defaultBotApiClientFactory: TelegramBotApiClientFactory = (token) =>
  new TelegramBotApiClient(token);
