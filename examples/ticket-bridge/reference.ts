import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { canonical } from '@agent18/provider-contracts';
import { verifySyncSignature } from '../../packages/application/src/ticket-sync.js';
import { z } from 'zod';
/** Durable idempotency reference receiver for an external ticket system. */
export function referenceTicketBridge(
  secret: string,
  project: { organizationId: string; projectId: string },
  file = ':memory:',
) {
  const db = new DatabaseSync(file);
  db.exec(
    'CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,hash TEXT,external_id TEXT);CREATE TABLE IF NOT EXISTS tickets(id TEXT PRIMARY KEY,version INTEGER,status TEXT,priority TEXT,deleted INTEGER)',
  );
  let fail = false;
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || req.url !== '/events') {
        res.writeHead(404).end();
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8192) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const input = z
        .object({
          eventId: z.string().uuid(),
          organizationId: z.literal(project.organizationId),
          projectId: z.literal(project.projectId),
          tenantId: z.string().min(1).max(128),
          ticketId: z.string().uuid(),
          origin: z.literal('agent18'),
          version: z.number().int().positive(),
          status: z.enum([
            'new',
            'open',
            'investigating',
            'waiting_customer',
            'waiting_internal',
            'resolved',
            'closed',
          ]),
          priority: z.enum(['low', 'normal', 'high', 'urgent']),
          deleted: z.boolean(),
        })
        .strict()
        .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      verifySyncSignature(
        secret,
        String(req.headers['x-agent18-timestamp'] ?? ''),
        input.eventId,
        input,
        String(req.headers['x-agent18-signature'] ?? ''),
      );
      if (req.headers['x-agent18-event'] !== input.eventId) {
        res.writeHead(401).end();
        return;
      }
      const hash = createHash('sha256').update(canonical(input)).digest('hex'),
        previous = db.prepare('SELECT * FROM receipts WHERE id=?').get(input.eventId),
        externalId = 'EXT-' + input.ticketId;
      if (previous && previous.hash !== hash) {
        res.writeHead(409).end();
        return;
      }
      db.exec('BEGIN');
      try {
        if (!previous) {
          db.prepare('INSERT INTO receipts VALUES(?,?,?)').run(input.eventId, hash, externalId);
          db.prepare(
            'INSERT INTO tickets VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,status=excluded.status,priority=excluded.priority,deleted=excluded.deleted WHERE tickets.version<excluded.version',
          ).run(input.ticketId, input.version, input.status, input.priority, +input.deleted);
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      // Test hook models a lost response after a successful upstream commit.
      if (fail) {
        res.writeHead(503).end();
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ eventId: input.eventId, externalId }));
    } catch {
      res.writeHead(400).end();
    }
  });
  return {
    server,
    db,
    setFailAfterCommit(value: boolean) {
      fail = value;
    },
  };
}
