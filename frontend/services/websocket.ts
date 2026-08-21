type MessageHandler = (data: Record<string, unknown>) => void;
type StatusHandler = (connected: boolean) => void;

export interface WSClientOptions {
  url: string;
  onMessage: MessageHandler;
  onStatusChange?: StatusHandler;
  maxReconnectDelay?: number;
}

const MAX_RECONNECT_DELAY_MS = 30_000;
const devAuthDisabled =
  process.env.NEXT_PUBLIC_DISABLE_AUTH === 'true' ||
  process.env.NODE_ENV === 'development';

async function getWebSocketTicket(): Promise<string | null> {
  const response = await fetch('/backend-api/auth/websocket-ticket', {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!response.ok) return devAuthDisabled ? 'dev' : null;
  const payload = await response.json() as { ticket?: string };
  return payload.ticket?.trim() || null;
}

/**
 * Lightweight WebSocket client with:
 * - One-time, short-lived server-issued ticket before each connect attempt
 * - Exponential backoff reconnect (stops on clean close or auth failure)
 * - Automatic ping-frame filtering
 */
export class WSClient {
  private ws: WebSocket | null = null;
  private reconnectDelay = 1_000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  private readonly url: string;
  private readonly onMessage: MessageHandler;
  private readonly onStatusChange: StatusHandler;
  private readonly maxReconnectDelay: number;

  constructor(opts: WSClientOptions) {
    this.url = opts.url;
    this.onMessage = opts.onMessage;
    this.onStatusChange = opts.onStatusChange ?? (() => {});
    this.maxReconnectDelay = opts.maxReconnectDelay ?? MAX_RECONNECT_DELAY_MS;
  }

  /** Open the connection (or schedule the first attempt). */
  connect(): void {
    void this._doConnect();
  }

  /** Permanently close — no further reconnects. */
  close(code = 1000): void {
    this.destroyed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close(code);
    this.ws = null;
  }

  private async _doConnect(): Promise<void> {
    if (this.destroyed) return;

    const ticket = await getWebSocketTicket();
    if (!ticket || this.destroyed) return;

    const ws = new WebSocket(`${this.url}?token=${encodeURIComponent(ticket)}`);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectDelay = 1_000;
      this.onStatusChange(true);
    };

    ws.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string) as Record<string, unknown>;
        if (data.type === 'ping') return; // server keepalive — ignore
        this.onMessage(data);
      } catch {
        // ignore malformed frames
      }
    };

    ws.onclose = (event: CloseEvent) => {
      this.ws = null;
      this.onStatusChange(false);
      // 1000 = clean close by us; 4001 = server rejected auth — don't reconnect
      if (this.destroyed || event.code === 1000 || event.code === 4001) return;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
        void this._doConnect();
      }, this.reconnectDelay);
    };

    ws.onerror = () => ws.close();
  }
}
