import { pathToFileURL } from 'node:url';

export function parseAuditPublicFlag(stdout) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout, 'utf8') > 65536) throw new Error('Invalid public audit build flag');
  const values = new Set();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith('CREDX_PUBLIC_AUDIT_FLAG=')) continue;
    const match = /^CREDX_PUBLIC_AUDIT_FLAG=(true|false)$/.exec(line);
    if (!match) throw new Error('Invalid public audit build flag');
    values.add(match[1]);
  }
  if (values.size !== 1) throw new Error('Invalid public audit build flag');
  return [...values][0];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const chunks = []; let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 65536) throw new Error('Invalid public audit build flag');
      chunks.push(chunk);
    }
    process.stdout.write(parseAuditPublicFlag(Buffer.concat(chunks, bytes).toString('utf8')) + '\n');
  } catch {
    process.stderr.write('Invalid public audit build flag\n');
    process.exitCode = 1;
  }
}
