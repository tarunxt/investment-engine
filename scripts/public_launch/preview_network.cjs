// Preview process only. The real frontend may contact only its two loopback ports.
const net = require('node:net');
const original = net.Socket.prototype.connect;
const allowed = new Set((process.env.STAGE01_ALLOWED_PORTS || '').split(',').map(Number));
net.Socket.prototype.connect = function (...args) {
  let options = args[0];
  if (Array.isArray(options)) options = options[0];
  const port = typeof options === 'object' ? Number(options.port) : Number(options);
  const host = typeof options === 'object' ? (options.host || 'localhost') : (typeof args[1] === 'string' ? args[1] : 'localhost');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) || !allowed.has(port)) {
    throw new Error('Stage01 synthetic preview prohibits external network connections');
  }
  return original.apply(this, args);
};
