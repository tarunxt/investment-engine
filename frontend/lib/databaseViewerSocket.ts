import { request as httpRequest } from 'node:http';
import { lstat } from 'node:fs/promises';
import path from 'node:path';

const MAX_RESPONSE_BYTES = 1_048_576;

export function verifySocketMetadata(socket: { isSocket(): boolean; uid: number; mode: number }, directory: { isDirectory(): boolean; uid: number; mode: number }, uid: number) {
  if (!socket.isSocket() || socket.uid !== uid || (socket.mode & 0o777) !== 0o600 ||
      !directory.isDirectory() || ![0, uid].includes(directory.uid) || (directory.mode & 0o022) !== 0) {
    throw new Error('Private viewer socket unavailable');
  }
}

type Metadata = { uid: number; mode: number; isSocket(): boolean; isDirectory(): boolean };
type MetadataReader = (name: string) => Promise<Metadata>;

/** Metadata injection is only for namespace-mapped synthetic fixtures. */
export function createDatabaseViewerSocketFetcher(readMetadata: MetadataReader = name => lstat(name)): typeof fetch {
return async (input, init) => {
  const socketPath = process.env.DATABASE_VIEWER_SOCKET_PATH || '/run/investor-database-viewer.sock';
  if (!path.isAbsolute(socketPath) || socketPath.includes('\0') || socketPath.split('/').some(part => part === '..') || !process.getuid) throw new Error('Private viewer socket unavailable');
  const signal = AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(8_000)]);
  signal.throwIfAborted();
  const [socket, directory] = await Promise.all([readMetadata(socketPath), readMetadata(path.dirname(socketPath))]);
  verifySocketMetadata(socket, directory, process.getuid());
  // Protect the pathname from swaps through writable or symlinked ancestors.
  for (let ancestor = path.dirname(path.dirname(socketPath)); ; ancestor = path.dirname(ancestor)) {
    const entry = await readMetadata(ancestor);
    const trustedStickyRoot = entry.uid === 0 && (entry.mode & 0o1000) !== 0;
    if (!entry.isDirectory() || ![0, process.getuid()].includes(entry.uid) || ((entry.mode & 0o022) !== 0 && !trustedStickyRoot)) throw new Error('Private viewer socket ancestor unavailable');
    if (ancestor === path.dirname(ancestor)) break;
  }
  signal.throwIfAborted();
  const method = init?.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD') throw new Error('Viewer method unavailable');
  const url = new URL(input instanceof Request ? input.url : input.toString());
  const incoming = new Headers(init?.headers);
  const headers: Record<string, string> = { host: 'viewer.invalid', 'accept-encoding': 'identity' };
  for (const name of ['accept', 'accept-language']) {
    const value = incoming.get(name);
    if (value) headers[name] = value;
  }
  return await new Promise<Response>((resolve, reject) => {
    const request = httpRequest({ socketPath, path: url.pathname + url.search, method, headers, signal }, response => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) { response.destroy(new Error('Viewer response limit exceeded')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        const status = response.statusCode || 502;
        const safe = new Headers();
        for (const name of ['content-type', 'content-security-policy', 'x-content-type-options', 'referrer-policy', 'location']) {
          const value = response.headers[name];
          if (typeof value === 'string') safe.set(name, value);
        }
        if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') { reject(new Error('Unexpected viewer encoding')); return; }
        resolve(new Response(method === 'HEAD' || status === 204 || status === 304 ? null : Uint8Array.from(Buffer.concat(chunks)), { status, headers: safe }));
      });
    });
    request.on('error', reject);
    request.end();
  });
};
}

/** Production always uses real filesystem metadata; no HTTP/TCP fallback. */
export const fetchDatabaseViewerSocket = createDatabaseViewerSocketFetcher();
