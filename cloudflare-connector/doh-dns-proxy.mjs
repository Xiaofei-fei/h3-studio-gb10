import dgram from 'node:dgram';
import net from 'node:net';
import tls from 'node:tls';

const listenAddress = process.env.DNS_LISTEN_ADDRESS ?? '127.0.0.1';
const listenPort = Number(process.env.DNS_LISTEN_PORT ?? '53');
const proxy = new URL(process.env.DNS_PROXY_URL ?? 'http://127.0.0.1:7890');
const doh = new URL(process.env.DOH_URL ?? 'https://cloudflare-dns.com/dns-query');
const requestTimeoutMs = Number(process.env.DNS_REQUEST_TIMEOUT_MS ?? '12000');

function waitFor(socket, event) {
  return new Promise((resolve, reject) => {
    const done = () => {
      socket.off('error', fail);
      resolve();
    };
    const fail = (error) => {
      socket.off(event, done);
      reject(error);
    };
    socket.once(event, done);
    socket.once('error', fail);
  });
}

function readHeaders(socket) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timeout = setTimeout(() => fail(new Error('proxy CONNECT timed out')), requestTimeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('data', receive);
      socket.off('error', fail);
    };
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const receive = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const boundary = buffer.indexOf('\r\n\r\n');
      if (boundary < 0) {
        if (buffer.length > 32 * 1024) fail(new Error('proxy CONNECT headers are too large'));
        return;
      }
      cleanup();
      resolve({ headers: buffer.subarray(0, boundary).toString('latin1'), rest: buffer.subarray(boundary + 4) });
    };
    socket.on('data', receive);
    socket.once('error', fail);
  });
}

async function proxyTunnel() {
  const socket = net.connect(Number(proxy.port || 80), proxy.hostname);
  socket.on('error', () => {});
  socket.setNoDelay(true);
  socket.setTimeout(requestTimeoutMs, () => socket.destroy(new Error('proxy connection timed out')));
  await waitFor(socket, 'connect');
  const target = `${doh.hostname}:${Number(doh.port || 443)}`;
  socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Connection: keep-alive\r\n\r\n`);
  const { headers, rest } = await readHeaders(socket);
  if (!/^HTTP\/1\.[01] 200\b/m.test(headers)) {
    socket.destroy();
    throw new Error(`proxy CONNECT failed: ${headers.split('\r\n', 1)[0]}`);
  }
  if (rest.length) socket.unshift(rest);
  const secureSocket = tls.connect({ socket, servername: doh.hostname, ALPNProtocols: ['http/1.1'] });
  secureSocket.on('error', () => {});
  secureSocket.setTimeout(requestTimeoutMs, () => secureSocket.destroy(new Error('DoH TLS connection timed out')));
  await waitFor(secureSocket, 'secureConnect');
  secureSocket.setTimeout(0);
  return secureSocket;
}

function decodeChunked(body) {
  const chunks = [];
  let offset = 0;
  while (offset < body.length) {
    const lineEnd = body.indexOf('\r\n', offset);
    if (lineEnd < 0) throw new Error('invalid chunked DoH response');
    const size = Number.parseInt(body.subarray(offset, lineEnd).toString('ascii').split(';', 1)[0], 16);
    if (!Number.isFinite(size)) throw new Error('invalid chunk size from DoH server');
    offset = lineEnd + 2;
    if (size === 0) break;
    if (offset + size > body.length) throw new Error('truncated chunked DoH response');
    chunks.push(body.subarray(offset, offset + size));
    offset += size + 2;
  }
  return Buffer.concat(chunks);
}

async function resolve(query) {
  const socket = await proxyTunnel();
  const path = `${doh.pathname}${doh.search}`;
  const headers = [
    `POST ${path} HTTP/1.1`,
    `Host: ${doh.host}`,
    'Accept: application/dns-message',
    'Content-Type: application/dns-message',
    `Content-Length: ${query.length}`,
    'Connection: close',
    '',
    '',
  ].join('\r\n');
  const response = await new Promise((resolveResponse, reject) => {
    const chunks = [];
    const timeout = setTimeout(() => socket.destroy(new Error('DoH response timed out')), requestTimeoutMs);
    const finish = (fn) => (value) => {
      clearTimeout(timeout);
      fn(value);
    };
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.once('end', finish(() => resolveResponse(Buffer.concat(chunks))));
    socket.once('error', finish(reject));
    socket.write(Buffer.concat([Buffer.from(headers, 'ascii'), query]));
  });
  const boundary = response.indexOf('\r\n\r\n');
  if (boundary < 0) throw new Error('invalid DoH response');
  const responseHeaders = response.subarray(0, boundary).toString('latin1');
  if (!/^HTTP\/1\.[01] 200\b/m.test(responseHeaders)) {
    throw new Error(`DoH request failed: ${responseHeaders.split('\r\n', 1)[0]}`);
  }
  const body = response.subarray(boundary + 4);
  const answer = /transfer-encoding:\s*chunked/i.test(responseHeaders) ? decodeChunked(body) : body;
  if (answer.length < 12) throw new Error('DoH returned an invalid DNS payload');
  return answer;
}

const udp = dgram.createSocket('udp4');
udp.on('message', async (query, remote) => {
  try {
    udp.send(await resolve(query), remote.port, remote.address);
  } catch (error) {
    console.error(`udp DNS request failed: ${error.message}`);
  }
});
udp.on('error', (error) => console.error(`udp listener failed: ${error.message}`));
udp.bind(listenPort, listenAddress);

const tcp = net.createServer((socket) => {
  let pending = Buffer.alloc(0);
  let queue = Promise.resolve();
  socket.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 2) {
      const length = pending.readUInt16BE(0);
      if (pending.length < length + 2) return;
      const query = pending.subarray(2, length + 2);
      pending = pending.subarray(length + 2);
      queue = queue.then(async () => {
        const answer = await resolve(query);
        const frame = Buffer.alloc(answer.length + 2);
        frame.writeUInt16BE(answer.length, 0);
        answer.copy(frame, 2);
        socket.write(frame);
      }).catch((error) => console.error(`tcp DNS request failed: ${error.message}`));
    }
  });
});
tcp.on('error', (error) => console.error(`tcp listener failed: ${error.message}`));
tcp.listen(listenPort, listenAddress, () => {
  console.log(`DoH DNS proxy listening on ${listenAddress}:${listenPort}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    udp.close();
    tcp.close(() => process.exit(0));
  });
}
