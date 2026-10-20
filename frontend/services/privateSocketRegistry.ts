// Keep synchronous account-boundary cleanup independent of the lazy WS client.
const clients = new Set<{ close(): void }>();
export const registerPrivateSocket = (client: { close(): void }) => clients.add(client);
export const unregisterPrivateSocket = (client: { close(): void }) => clients.delete(client);
export function closePrivateWebSockets() {
  for (const client of [...clients]) client.close();
}
