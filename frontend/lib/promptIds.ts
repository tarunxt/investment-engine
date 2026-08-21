export function getPromptLogicalId(name: string, id?: number | string | null) {
  const source = `${name || 'prompt'}:${id ?? ''}`.toUpperCase();
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let value = hash >>> 0;
  let output = '';
  for (let index = 0; index < 4; index += 1) {
    output = alphabet[value % alphabet.length] + output;
    value = Math.floor(value / alphabet.length);
  }
  return output.padStart(4, '0').slice(-4);
}
