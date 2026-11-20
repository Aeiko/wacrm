"""Single consume request on a systemd-accepted Unix socket. No issue or reset API."""
import re
import socket
import sqlite3
import sys
from contextlib import closing
from pathlib import Path

DB = Path('/var/lib/wacrm-history-permit/permits.sqlite')
REQUEST = re.compile(rb'([1-9][0-9]{0,31}) ([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\n')


def spend(path, frame):
    match = REQUEST.fullmatch(frame)
    if not match:
        return False
    with closing(sqlite3.connect(path.as_uri() + '?mode=rw', uri=True, timeout=0.25)) as db:
        db.execute('PRAGMA synchronous=FULL')
        with db:
            spent = db.execute("""UPDATE history_permits SET state='spent'
                WHERE phone_id=? AND request_id=? AND state='ready' AND expires_at>unixepoch()""",
                tuple(part.decode('ascii') for part in match.groups())).rowcount == 1
        return spent


def serve(conn, path):
    conn.settimeout(1)
    with conn.makefile('rb') as incoming:
        frame = incoming.read(71)
    # Do not acknowledge until the transaction has durably committed.
    conn.sendall(b'spent\n' if spend(path, frame) else b'denied\n')


if __name__ == '__main__':
    try:
        with socket.socket(fileno=0) as conn:
            serve(conn, DB)
    except (OSError, sqlite3.Error):
        sys.exit(1)
