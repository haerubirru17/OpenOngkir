// API OpenOngkir (Node http bawaan, tanpa framework).
//
//   GET /v1/wilayah?parent=          daftar provinsi / kabupaten / kecamatan
//   GET /v1/cost?origin=&destination=&weight_g=&courier=&fresh=1
//   GET /v1/track?courier=&awb=&phone=&fresh=1
//   GET /v1/health                   status layanan (tanpa auth, untuk monitoring)
//   GET /test                        konsol tes di browser (tanpa auth, halaman statis)
//   POST /v1/api-keys                buat API key baru (tanpa auth, maks 3/IP/24 jam)
//
// Auth (kecuali /v1/health, /test, POST /v1/api-keys): header X-API-Key.
// Kunci yang diterima: master key env OPENONGKIR_API_KEY, atau key yang
// dibuat lewat POST /v1/api-keys (disimpan sebagai hash SHA-256).
// Bila env tidak diset, kunci acak dibuat saat start dan dicetak ke stdout.
// Rate limit: 60 permintaan/menit/IP.
import http from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createHarvester, ALL_COURIERS, COURIERS } from './harvester.js';
import { createTracker } from './tracker.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Versi dari package.json (satu sumber — jangan hardcode di sini).
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
// Halaman konsol tes (satu file statis, dibaca sekali saat start).
const TEST_PAGE = readFileSync(join(ROOT, 'public', 'test.html'));
const RATE_LIMIT_PER_MIN = 60;
const RATE_WINDOW_MS = 60_000;
const MIN_WEIGHT_G = 100;
const MAX_WEIGHT_G = 30_000;
// Pembuatan API key publik (POST /v1/api-keys): anti borong key.
const API_KEY_CREATE_MAX_PER_DAY = 3;
const API_KEY_CREATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_JSON_BODY_BYTES = 10_000;

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

/** SHA-256 hex dari sebuah API key (yang disimpan di DB hanya hash-nya). */
function hashApiKey(key) {
  return createHash('sha256').update(key).digest('hex');
}

/** Perbandingan string timing-safe (panjang beda = langsung tidak sama). */
function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// Peer loopback = koneksi dari cloudflared lokal (produksi diakses lewat
// Cloudflare Tunnel yang meneruskan ke localhost).
const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * IP klien asli. Bila peer adalah loopback (cloudflared lokal), semua
 * permintaan publik tiba dengan remoteAddress yang sama, jadi IP asli
 * diambil dari header CF-Connecting-IP, atau entri pertama
 * X-Forwarded-For bila tidak ada. Header hanya dipercaya dari peer
 * loopback — peer luar selalu dinilai dari remoteAddress (anti spoofing).
 */
export function getClientIp(req) {
  const peer = req.socket.remoteAddress || 'unknown';
  if (!LOOPBACK_PEERS.has(peer)) return peer;
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') {
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }
  return peer;
}

/** Baca body JSON (kosong = {}). Throw {status, message} bila tidak valid. */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BODY_BYTES) throw { status: 413, message: 'Body terlalu besar.' };
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw { status: 400, message: 'Body harus JSON yang valid.' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw { status: 400, message: 'Body harus objek JSON.' };
  }
  return parsed;
}

export function createServer({ db, harvester, tracker, apiKey, rateLimitPerMin = RATE_LIMIT_PER_MIN } = {}) {
  const startedAt = Date.now();
  const track = tracker || createTracker({ db });
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

  // Key valid bila: master key env, ATAU hash-nya ada di api_keys dan
  // belum dicabut. Perbandingan master key timing-safe.
  function isValidApiKey(presented) {
    if (!presented || typeof presented !== 'string') return false;
    if (apiKey && safeEqual(presented, apiKey)) return true;
    const row = db.getApiKey(hashApiKey(presented));
    return Boolean(row && !row.revoked);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const ip = getClientIp(req);
      if (!checkRateLimit(ip)) {
        json(res, 429, { success: false, error: 'Terlalu banyak permintaan. Coba lagi sebentar.' }, { 'Retry-After': '60' });
        return;
      }
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;

      // Satu-satunya POST yang didukung: membuat API key baru.
      const isCreateKey = req.method === 'POST' && path === '/v1/api-keys';
      if (req.method !== 'GET' && !isCreateKey) {
        json(res, 405, { success: false, error: 'Metode tidak didukung untuk rute ini.' });
        return;
      }

      // /v1/health sengaja tanpa auth (untuk monitoring / Uptime Kuma);
      // /test juga tanpa auth (halaman statis — API key dimasukkan di halaman);
      // POST /v1/api-keys tanpa auth (pembuatan key publik, dibatasi per IP).
      if (path !== '/v1/health' && path !== '/test' && !isCreateKey) {
        if (!isValidApiKey(req.headers['x-api-key'])) {
          json(res, 401, { success: false, error: 'API key tidak valid. Kirim header X-API-Key.' });
          return;
        }
      }

      if (isCreateKey) {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (e) {
          json(res, e.status || 400, { success: false, error: e.message || 'Body tidak valid.' });
          return;
        }
        let label = body.label ?? null;
        if (label !== null && typeof label !== 'string') {
          json(res, 400, { success: false, error: 'Label harus berupa teks.' });
          return;
        }
        label = label ? label.trim().slice(0, 100) || null : null;
        const since = Date.now() - API_KEY_CREATE_WINDOW_MS;
        if (db.countApiKeysByIp(ip, since) >= API_KEY_CREATE_MAX_PER_DAY) {
          json(res, 429, {
            success: false,
            error: 'Batas pembuatan API key tercapai: maksimal 3 kunci baru per 24 jam dari IP ini. Coba lagi besok.',
          });
          return;
        }
        const key = randomBytes(32).toString('hex');
        const createdAt = Date.now();
        db.saveApiKey(hashApiKey(key), label, ip, createdAt);
        json(res, 201, {
          success: true,
          api_key: key,
          label,
          created_at: new Date(createdAt).toISOString(),
          note: 'Simpan kunci ini — hanya ditampilkan sekali.',
        });
        return;
      }

      if (path === '/test') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': TEST_PAGE.length,
        });
        res.end(TEST_PAGE);
        return;
      }

      if (path === '/v1/health') {
        const last = db.lastHarvestAt();
        const stats = db.getQuoteStats();
        const totalQuotes = stats.from_db + stats.live;
        json(res, 200, {
          success: true,
          status: 'ok',
          version: VERSION,
          uptime_s: Math.floor((Date.now() - startedAt) / 1000),
          tariffs: db.countTariffs(),
          courier_places: db.countCourierPlaces(),
          track_cached: db.countTrackCache(),
          wilayah: db.countWilayah(),
          last_update: last ? new Date(last).toISOString() : null,
          quotes_from_db: stats.from_db,
          quotes_live: stats.live,
          // % quote dari DB (1 desimal); null bila belum ada quote sama sekali.
          quotes_db_pct: totalQuotes > 0
            ? Math.round((stats.from_db / totalQuotes) * 1000) / 10
            : null,
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
            error: 'Tarif tidak dapat diambil dari kurir untuk rute ini.',
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

      if (path === '/v1/track') {
        const courier = (url.searchParams.get('courier') || '').trim();
        const awb = (url.searchParams.get('awb') || '').trim();
        const phone = url.searchParams.get('phone') || '';
        const fresh = url.searchParams.get('fresh') === '1' || url.searchParams.get('fresh') === 'true';

        const result = await track.track({ courier, awb, phone, fresh });
        switch (result.kind) {
          case 'found':
            json(res, 200, { success: true, ...result.data });
            return;
          case 'not_found':
            json(res, 404, {
              success: false, error: result.message, courier, awb, status: 'NOT_FOUND',
            });
            return;
          case 'needs_phone':
            json(res, 400, {
              success: false, error: result.message, courier, awb,
              requiresPhoneVerification: true, digits: result.digits,
            });
            return;
          case 'wrong_phone':
            json(res, 400, {
              success: false, error: result.message, courier, awb, status: 'WRONG_PHONE_DIGITS',
            });
            return;
          case 'verification_failed':
            // JNE tidak membedakan digit salah vs resi tidak ada — 404
            // dengan status yang menjelaskan dua kemungkinan itu.
            json(res, 404, {
              success: false, error: result.message, courier, awb, status: 'VERIFICATION_FAILED',
            });
            return;
          case 'invalid':
            json(res, 400, { success: false, error: result.message });
            return;
          default: // 'error' — gangguan kurir, bukan vonis resi palsu.
            json(res, 502, {
              success: false,
              error: `Gagal melacak resi di ${COURIERS[courier.toLowerCase()] || courier}: ${result.message}`,
              courier, awb,
            });
            return;
        }
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
  const tracker = createTracker({ db });
  const server = createServer({ db, harvester, tracker, apiKey });
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
