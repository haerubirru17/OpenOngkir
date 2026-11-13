// Tes generate API key publik: POST /v1/api-keys + auth multi-key.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openDb } from '../src/db.js';
import { createHarvester } from '../src/harvester.js';
import { createServer } from '../src/server.js';

const MASTER_KEY = 'tes-kunci-master-123';

async function startServer() {
  const db = openDb(':memory:');
  const harvester = createHarvester({
    db, resolvers: {}, sleepFn: () => Promise.resolve(), politeDelayMs: 0, timeoutMs: 5000,
  });
  const server = createServer({ db, harvester, apiKey: MASTER_KEY });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, server, base };
}

async function stop(ctx) {
  await new Promise((r) => ctx.server.close(r));
  ctx.db.close();
}

function createKey(base, label, extraHeaders = {}) {
  return fetch(`${base}/v1/api-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: label === undefined ? undefined : JSON.stringify({ label }),
  });
}

describe('POST /v1/api-keys', () => {
  it('tanpa auth = 201, key tampil sekali (64 hex), hanya hash tersimpan', async () => {
    const ctx = await startServer();
    try {
      const res = await createKey(ctx.base, 'kunci tes');
      assert.equal(res.status, 201);
      const b = await res.json();
      assert.equal(b.success, true);
      assert.match(b.api_key, /^[0-9a-f]{64}$/);
      assert.equal(b.label, 'kunci tes');
      assert.match(b.created_at, /^\d{4}-\d{2}-\d{2}T/);
      assert.match(b.note, /hanya ditampilkan sekali/);
      // Key asli tidak tersimpan — hanya hash SHA-256-nya.
      const hash = createHash('sha256').update(b.api_key).digest('hex');
      const row = ctx.db.getApiKey(hash);
      assert.ok(row);
      assert.equal(row.label, 'kunci tes');
      assert.equal(row.revoked, 0);
    } finally {
      await stop(ctx);
    }
  });

  it('key baru bisa dipakai auth; key salah tetap 401; master key tetap berlaku', async () => {
    const ctx = await startServer();
    try {
      const b = await (await createKey(ctx.base)).json();
      const ok = await fetch(`${ctx.base}/v1/wilayah`, { headers: { 'X-API-Key': b.api_key } });
      assert.equal(ok.status, 200);
      const wrong = await fetch(`${ctx.base}/v1/wilayah`, { headers: { 'X-API-Key': 'bukan-kunci' } });
      assert.equal(wrong.status, 401);
      const master = await fetch(`${ctx.base}/v1/wilayah`, { headers: { 'X-API-Key': MASTER_KEY } });
      assert.equal(master.status, 200);
    } finally {
      await stop(ctx);
    }
  });

  it('batas 3 key per IP per 24 jam, ke-4 = 429', async () => {
    const ctx = await startServer();
    try {
      const keys = new Set();
      for (let i = 0; i < 3; i++) {
        const res = await createKey(ctx.base);
        assert.equal(res.status, 201);
        keys.add((await res.json()).api_key);
      }
      assert.equal(keys.size, 3); // tiap key unik
      const res = await createKey(ctx.base);
      assert.equal(res.status, 429);
      const b = await res.json();
      assert.match(b.error, /maksimal 3 kunci baru per 24 jam/);
    } finally {
      await stop(ctx);
    }
  });

  it('CF-Connecting-IP berbeda = kuota pembuatan terpisah (peer loopback)', async () => {
    const ctx = await startServer();
    try {
      // IP-A menghabiskan jatahnya: 3×201 lalu 429.
      for (let i = 0; i < 3; i++) {
        const res = await createKey(ctx.base, undefined, { 'CF-Connecting-IP': '203.0.113.1' });
        assert.equal(res.status, 201);
      }
      const fourth = await createKey(ctx.base, undefined, { 'CF-Connecting-IP': '203.0.113.1' });
      assert.equal(fourth.status, 429);
      // IP-B tidak terpengaruh jatah IP-A.
      const other = await createKey(ctx.base, undefined, { 'CF-Connecting-IP': '203.0.113.2' });
      assert.equal(other.status, 201);
    } finally {
      await stop(ctx);
    }
  });

  it('key yang dicabut = 401', async () => {
    const ctx = await startServer();
    try {
      const b = await (await createKey(ctx.base)).json();
      const hash = createHash('sha256').update(b.api_key).digest('hex');
      ctx.db.revokeApiKey(hash);
      const res = await fetch(`${ctx.base}/v1/wilayah`, { headers: { 'X-API-Key': b.api_key } });
      assert.equal(res.status, 401);
    } finally {
      await stop(ctx);
    }
  });

  it('body bukan JSON = 400; label bukan teks = 400', async () => {
    const ctx = await startServer();
    try {
      const bad = await fetch(`${ctx.base}/v1/api-keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{bukan json',
      });
      assert.equal(bad.status, 400);
      const badLabel = await fetch(`${ctx.base}/v1/api-keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 123 }),
      });
      assert.equal(badLabel.status, 400);
    } finally {
      await stop(ctx);
    }
  });
});
