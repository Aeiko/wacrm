import type { CoexistenceFetch } from '../coexistence-meta';

// Live exchange is a separate release decision. No runtime flag installs a transport.
export function discoveryHostTransport(): CoexistenceFetch | null {
  return null;
}
