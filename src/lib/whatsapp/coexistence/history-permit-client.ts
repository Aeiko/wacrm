import { createConnection } from 'node:net';

/** Consume-only broker. A lost acknowledgement is a denial, never a retry. */
export async function consumeDispatchPermit(
  phone: string,
  request: string
): Promise<boolean> {
  const env = process.env;
  const socketPath = env.WHATSAPP_COEXISTENCE_HISTORY_PERMIT_SOCKET;

  if (
    env.WHATSAPP_COEXISTENCE_ENABLED !== 'true' ||
    env.WHATSAPP_COEXISTENCE_HISTORY_REQUEST_ENABLED !== 'true' ||
    phone !== env.WHATSAPP_COEXISTENCE_RELAY_PHONE_ID ||
    !/^[1-9][0-9]{0,31}$/.test(phone) ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(request) ||
    socketPath !== '/run/wacrm-history-permit/consume.sock'
  )
    return false;

  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let response = '';

    const timer = setTimeout(() => {
      resolve(false);
      socket.destroy();
    }, 1500);

    socket.setEncoding('utf8');
    socket.once('connect', () => socket.end(`${phone} ${request}\n`));
    socket.on('data', (chunk: string) => {
      response += chunk;

      if (response.length > 6) socket.destroy();
    });
    socket.once('error', () => resolve(false));
    socket.once('end', () => resolve(response === 'spent\n'));
    socket.once('close', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}
