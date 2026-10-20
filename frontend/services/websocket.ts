type MessageHandler = (data: Record<string, unknown>) => void;
type StatusHandler = (connected: boolean) => void;
export interface WSClientOptions {
  url: string;
  onMessage: MessageHandler;
  onStatusChange?: StatusHandler;
  maxReconnectDelay?: number;
}
const MAX_RECONNECT_DELAY_MS = 30_000;
const clients = new Set<WSClient>();
export function closePrivateWebSockets() {
  for (const client of [...clients]) client.close();
}
async function getWebSocketTicket(signal: AbortSignal): Promise<string | null> {
  const response = await fetch('/backend-api/auth/websocket-ticket', {
    method: 'POST', cache: 'no-store', signal,
    headers: { 'Content-Type': 'application/json' },
  });
  if (!response.ok) return null;
  const payload = await response.json() as { ticket?: string };
  return payload.ticket?.trim() || null;
}
export class WSClient {
  private ws: WebSocket | null = null;
  private reconnectDelay = 1_000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private ticketRequest: AbortController | null = null;
  private connecting = false;
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
    clients.add(this);
  }
  connect(): void { void this._doConnect(); }
  close(code = 1000): void {
    if (this.destroyed) return;
    this.destroyed = true;
    clients.delete(this);
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ticketRequest?.abort();
    this.ticketRequest = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close(code);
    this.onStatusChange(false);
  }
  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      void this._doConnect();
    }, this.reconnectDelay);
  }
  private async _doConnect(): Promise<void> {
    if (this.destroyed || this.connecting || this.ws) return;
    this.connecting = true;
    const request = new AbortController();
    this.ticketRequest = request;
    let ticket: string | null;
    try {
      ticket = await getWebSocketTicket(request.signal);
    } catch {
      if (!this.destroyed) this.scheduleReconnect();
      return;
    } finally {
      this.connecting = false;
      if (this.ticketRequest === request) this.ticketRequest = null;
    }
    if (!ticket || this.destroyed) return;
    const ws = new WebSocket(`${this.url}?token=${encodeURIComponent(ticket)}`);
    this.ws = ws;
    ws.onopen = () => {
      if (this.destroyed || this.ws !== ws) return;
      this.reconnectDelay = 1_000;
      this.onStatusChange(true);
    };
    ws.onmessage = (event: MessageEvent) => {
      if (this.destroyed || this.ws !== ws) return;
      try {
        const data = JSON.parse(event.data as string) as Record<string, unknown>;
        if (data.type !== 'ping') this.onMessage(data);
      } catch { /* Ignore malformed frames without logging ticket URLs. */ }
    };
    ws.onclose = (event: CloseEvent) => {
      if (this.destroyed || this.ws !== ws) return;
      this.ws = null;
      this.onStatusChange(false);
      if (event.code === 4001) {
        closePrivateWebSockets();
        if (typeof window !== 'undefined') window.dispatchEvent(new Event('private-session-revoked'));
        return;
      }
      if ([1000, 1008, 4003, 4004].includes(event.code)) { this.close(); return; }
      // Expired access4002 and transport loss fetch a fresh one-use ticket.
      this.scheduleReconnect();
    };
    ws.onerror = () => { if (!this.destroyed && this.ws === ws) ws.close(); };
  }
}
