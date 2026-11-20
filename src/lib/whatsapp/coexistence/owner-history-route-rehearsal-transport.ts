import { connect } from 'node:net';
import { z } from 'zod';
import { createHistoryRequestTransport } from './history-request-transport';

// Only the disposable runner resolves the mounted route's transport import here.
const origin = z
  .string()
  .regex(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/)
  .parse(process.env.NEXT_PUBLIC_SUPABASE_URL);

const port = Number(new URL(origin).port);

export const historyRequestTransport = createHistoryRequestTransport(
  (_options, done) => {
    const onError = (error: Error) => done(error, null);

    const socket = connect(port, '127.0.0.1', () => {
      socket.off('error', onError);
      done(null, socket);
    });

    socket.once('error', onError);
  }
);
