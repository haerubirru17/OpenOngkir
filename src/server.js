// API OpenOngkir (Node http bawaan, tanpa framework).
//
//   GET /v1/wilayah?parent=          daftar provinsi / kabupaten / kecamatan
//   GET /v1/cost?origin=&destination=&weight_g=&courier=&fresh=1
//   GET /v1/health                   status layanan (tanpa auth, untuk monitoring)
//
// Auth (kecuali /v1/health): header X-API-Key, kunci dari env
// OPENONGKIR_API_KEY. Bila env tidak diset, kunci acak dibuat saat start
// dan dicetak ke stdout. Rate limit: 60 permintaan/menit/IP.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createHarvester, ALL_COURIERS, COURIERS } from './harvester.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RATE_LIMIT_PER_MIN = 60;
const RATE_WINDOW_MS = 60_000;
const MIN_WEIGHT_G = 100;
const MAX_WEIGHT_G = 30_000;

const DISCLAIMER =
  'Estimasi — harga final mengikuti tarif resmi kurir saat paket diserahkan.';

function json(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function parseCouriers(param) {
  if (!param) return [...ALL_COURIERS];
  const list = param.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const unknown = list.filter((c) => !COURIERS[c]);
  if (unknown.length > 0) {
    throw { status: 400, message: `Kurir tidak dikenal: ${unknown.join(', ')}. Pilihan: ${ALL_COURIERS.join(', ')}.` };
  }
  return [...new Set(list)];
}

export function createServer({ db, harvester, apiKey, rateLimitPerMin = RATE_LIMIT_PER_MIN } = {}) {
  const startedAt = Date.now();
  // Rate limit per IP: daftar timestamp permintaan dalam 1 menit terakhir.
  const hits = new Map();

  function checkRateLimit(ip) {
    const now = Date.now();
    const list = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
    if (list.length >= rateLimitPerMin) return false;
    list.push(now);
    hits.set(ip, list);
    // Bersihkan IP lama sesekali agar map tidak membesar.
    if (hits.size > 10_000) {
      for (const [k, v] of hits) {
        if (v.length === 0 || now - v[v.length - 1] >= RATE_WINDOW_MS) hits.delete(k);
      }
    }
    return true;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const ip = req.socket.remoteAddress || 'unknown';
      if (!checkRateLimit(ip)) {
        json(res, 429, { success: false, error: 'Terlalu banyak permintaan. Coba lagi sebentar.' }, { 'Retry-After': '60' });
        return;
      }
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;

      if (req.method !== 'GET') {
        json(res, 405, { success: false, error: 'Hanya metode GET yang didukung.' });
        return;
      }

      // /v1/health sengaja tanpa auth (untuk monitoring / Uptime Kuma).
      if (path !== '/v1/health') {
        if (!apiKey || req.headers['x-api-key'] !== apiKey) {
          json(res, 401, { success: false, error: 'API key tidak valid. Kirim header X-API-Key.' });
          return;
        }
      }

      if (path === '/v1/health') {
        const last = db.lastHarvestAt();
        json(res, 200, {
          success: true,
          status: 'ok',
          version: '0.2.0',
          uptime_s: Math.floor((Date.now() - startedAt) / 1000),
          tariffs: db.countTariffs(),
          courier_places: db.countCourierPlaces(),
          wilayah: db.countWilayah(),
          last_harvest: last ? new Date(last).toISOString() : null,
        });
        return;
      }

      if (path === '/v1/wilayah') {
        const parent = url.searchParams.get('parent') || '';
        if (parent && !db.getWilayah(parent)) {
          json(res, 400, { success: false, error: `Kode wilayah induk ${parent} tidak ditemukan.` });
          return;
        }
        json(res, 200, { success: true, data: db.listWilayah(parent) });
        return;
      }

      if (path === '/v1/cost') {
        const origin = (url.searchParams.get('origin') || '').trim();
        const destination = (url.searchParams.get('destination') || '').trim();
        const weightG = Number(url.searchParams.get('weight_g') || 1000);
        const fresh = url.searchParams.get('fresh') === '1' || url.searchParams.get('fresh') === 'true';

        if (!origin || !destination) {
          json(res, 400, { success: false, error: 'Parameter origin dan destination wajib diisi (kode kecamatan, mis. 36.71.01).' });
          return;
        }
        const originRow = db.getWilayah(origin);
        const destRow = db.getWilayah(destination);
        if (!originRow || originRow.level !== 'kecamatan') {
          json(res, 400, { success: false, error: `Kode asal ${origin} bukan kecamatan yang valid.` });
          return;
        }
        if (!destRow || destRow.level !== 'kecamatan') {
          json(res, 400, { success: false, error: `Kode tujuan ${destination} bukan kecamatan yang valid.` });
          return;
        }
        if (!Number.isFinite(weightG) || weightG < MIN_WEIGHT_G || weightG > MAX_WEIGHT_G) {
          json(res, 400, { success: false, error: `weight_g harus ${MIN_WEIGHT_G}–${MAX_WEIGHT_G} gram.` });
          return;
        }
        let couriers;
        try {
          couriers = parseCouriers(url.searchParams.get('courier') || '');
        } catch (e) {
          json(res, e.status || 400, { success: false, error: e.message });
          return;
        }

        const weightKg = Math.max(1, Math.ceil(weightG / 1000));
        const { options, errors } = await harvester.getCost({
          originCode: origin, destCode: destination, weightKg, couriers, fresh,
        });
        if (options.length === 0) {
          json(res, 502, {
            success: false,
            error: 'Semua kurir gagal dipanen untuk rute ini.',
            errors,
          });
          return;
        }
        json(res, 200, {
          success: true,
          origin: { code: origin, name: originRow.name },
          destination: { code: destination, name: destRow.name },
          weight_g: weightG,
          weight_kg: weightKg,
          estimate: true,
          disclaimer: DISCLAIMER,
          options,
          errors,
        });
        return;
      }

      json(res, 404, { success: false, error: `Rute ${path} tidak ditemukan.` });
    } catch (err) {
      console.error('[server] error:', err);
      if (!res.headersSent) {
        json(res, 500, { success: false, error: 'Kesalahan internal server.' });
      }
    }
  });

  return server;
}

// Dijalankan langsung: node src/server.js
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const dbPath = process.env.OPENONGKIR_DB || join(ROOT, 'data', 'openongkir.db');
  const port = Number(process.env.OPENONGKIR_PORT || 3000);
  let apiKey = process.env.OPENONGKIR_API_KEY || '';
  if (!apiKey) {
    apiKey = randomBytes(32).toString('hex');
    console.log('[openongkir] OPENONGKIR_API_KEY tidak diset — kunci sementara (berlaku sampai restart):');
    console.log(`[openongkir] ${apiKey}`);
  }
  const db = openDb(dbPath);
  const harvester = createHarvester({ db });
  const server = createServer({ db, harvester, apiKey });
  server.listen(port, () => {
    console.log(`[openongkir] jalan di port ${port} — DB: ${dbPath}`);
    console.log(`[openongkir] wilayah: ${db.countWilayah()} baris, tarif: ${db.countTariffs()} baris`);
  });

  // Cron refresh + spot-check di dalam service (default tiap 24 jam).
  const intervalMs = Number(process.env.OPENONGKIR_REFRESH_INTERVAL_MS || 24 * 60 * 60 * 1000);
  let timer = null;
  if (intervalMs > 0) {
    timer = setInterval(async () => {
      try {
        const refreshLimit = Number(process.env.OPENONGKIR_REFRESH_LIMIT || 10);
        const spotCheckLimit = Number(process.env.OPENONGKIR_SPOTCHECK_LIMIT || 5);
        console.log('[openongkir] perawatan harian mulai...');
        const out = await harvester.runDailyMaintenance({ refreshLimit, spotCheckLimit });
        console.log('[openongkir] perawatan harian selesai:', JSON.stringify(out));
      } catch (err) {
        console.error('[openongkir] perawatan harian gagal:', err);
      }
    }, intervalMs);
    timer.unref();
  }

  const shutdown = () => {
    console.log('[openongkir] berhenti...');
    if (timer) clearInterval(timer);
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
