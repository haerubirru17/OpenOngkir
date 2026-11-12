// Tracker: cek resi live dari endpoint resmi kurir via OpenResi
// (vendored di src/openresi/), dengan cache singkat 30 menit.
//
// Prinsip tri-state (PLAN.md): found / not_found / error — gangguan kurir
// tidak boleh divonis sebagai "resi palsu". Resi yang tidak ditemukan dan
// error TIDAK di-cache, agar percobaan berikutnya selalu cek live lagi.
//
// Digit HP: JNE butuh 5 digit terakhir HP penerima, J&T 4 digit terakhir
// HP pengirim/penerima (temuan Fase 0). Digit ini WAJIB diisi sebelum
// memanggil kurir — tanpa itu JNE/J&T tidak menampilkan rincian.
// Kurir lain: phone diteruskan bila diisi (SiCepat membutuhkannya untuk
// sebagian resi), diabaikan bila tidak.
//
// Catatan perilaku kurir (probe live 12 Nov 2026, resi dummy 1234567890):
// - JNE tidak membedakan "resi tidak ada" dari "digit HP salah": keduanya
//   kembali sebagai VERIFICATION_FAILED ("Verifikasi gagal atau data tidak
//   ditemukan"). Dipetakan ke 404 dengan pesan yang menjelaskan dua
//   kemungkinan itu.
// - SiCepat bisa menggantung > 60 dtk (aliran reCAPTCHA) — timeout keras
//   20 dtk wajib, agar satu kurir tidak menggantung API.
// - AnterAja tracking TIDAK terblokir 403 (berbeda dengan API ongkirnya).
import { getResolver } from './openresi/index.js';
import { COURIERS, ALL_COURIERS } from './harvester.js';
import { TRACK_CACHE_TTL_MS } from './db.js';

export { TRACK_CACHE_TTL_MS };

// Jumlah digit HP yang wajib diisi, per kurir.
export const PHONE_DIGITS = { jne: 5, jnt: 4 };
// Siapa pemilik nomor HP-nya (untuk pesan error yang jelas).
const PHONE_OWNER = { jne: 'penerima', jnt: 'pengirim atau penerima' };

const TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout ${label} (${ms / 1000} dtk)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Error permanen (tidak usah di-retry): resi tidak ada, blokir akses, input salah.
function isPermanentError(err) {
  return /tidak ditemukan|not found|http status 40[13]|invalid/i.test(
    String(err?.message || err || '')
  );
}

/**
 * Normalisasi status mentah kurir ke satu dari 5 status standar.
 * Idempotent untuk status yang sudah standar.
 */
export function normalizeStatus(raw) {
  const s = String(raw || '').toUpperCase().trim();
  if (['DELIVERED', 'ON_DELIVERY', 'ON_PROCESS', 'IN_TRANSIT', 'RETURN_TO_SENDER'].includes(s)) {
    return s;
  }
  if (s.includes('DELIVER') || s.includes('TERKIRIM') || s.includes('DITERIMA') || s.includes('SELESAI')) {
    return 'DELIVERED';
  }
  if (s.includes('ANTAR') || s.includes('DELIVERY') || s.includes('DIANTAR') || s.includes('OUT FOR')) {
    return 'ON_DELIVERY';
  }
  if (s.includes('RETUR') || s.includes('RETURN') || s.includes('KEMBALI')) {
    return 'RETURN_TO_SENDER';
  }
  if (s.includes('TRANSIT') || s.includes('PERJALANAN') || s.includes('MANIFEST')) {
    return 'IN_TRANSIT';
  }
  return 'ON_PROCESS';
}

/**
 * Normalisasi riwayat kurir ke events { time, status, location, description },
 * urut kronologis (terlama dulu). Resolver mengembalikan urutan yang
 * berbeda-beda (J&T: terbaru dulu; JNE/POS: tergantung halaman kurir),
 * jadi diurutkan berdasarkan waktu yang bisa diparse; yang tidak bisa
 * diparse diletakkan di akhir dengan urutan asli dipertahankan.
 */
export function normalizeEvents(history) {
  const events = (history || []).map((item, i) => {
    const time = String(
      item.dateTime || [item.date, item.time].filter(Boolean).join(' ') || ''
    ).trim();
    const ts = time ? Date.parse(time) : NaN;
    return {
      time,
      status: String(item.status || '').trim(),
      location: String(item.location || '').trim(),
      description: String(item.description || item.status || 'Status diperbarui').trim(),
      _ts: Number.isFinite(ts) ? ts : null,
      _i: i,
    };
  });
  events.sort((a, b) => {
    if (a._ts !== null && b._ts !== null) return a._ts - b._ts || a._i - b._i;
    if (a._ts !== null) return -1;
    if (b._ts !== null) return 1;
    return a._i - b._i;
  });
  return events.map(({ time, status, location, description }) => ({
    time, status, location, description,
  }));
}

/** Normalisasi hasil resolver ke bentuk standar API (tanpa fetched_at/cached). */
export function normalizeResult(courier, res) {
  const summary = res.summary || res.detail || {};
  return {
    courier,
    courierName: COURIERS[courier] || res.courier || courier,
    awb: res.waybillNumber || res.waybill || '',
    status: normalizeStatus(res.status),
    service: String(summary.service || ''),
    sender: String(summary.sender || summary.shipper || ''),
    recipient: String(summary.recipient || summary.receiver || ''),
    origin: String(summary.origin || ''),
    destination: String(summary.destination || ''),
    events: normalizeEvents(res.history),
  };
}

export function createTracker({
  db,
  resolvers = null,
  now = Date.now,
  sleepFn = sleep,
  timeoutMs = TIMEOUT_MS,
  maxAttempts = MAX_ATTEMPTS,
} = {}) {
  const getRes = (code) =>
    resolvers ? resolvers[code] || null : getResolver(code);
  // Lacak yang sedang berjalan, per kunci kurir+resi+phone (dedupe request
  // bersamaan). Phone masuk kunci agar hasil resi yang sudah terverifikasi
  // tidak terbagi ke request dengan digit yang salah.
  const inFlight = new Map();

  /**
   * Lacak satu resi.
   * @returns { kind: 'found'|'not_found'|'needs_phone'|'wrong_phone'|
   *   'verification_failed'|'invalid'|'error', data?, message?, digits? }
   * - found: data = hasil normalisasi + fetched_at + cached.
   * - not_found: resi tidak ada di sistem kurir.
   * - needs_phone: resi butuh digit HP (SiCepat, bila phone tidak diisi).
   * - wrong_phone: digit HP diisi tapi ditolak kurir (J&T).
   * - verification_failed: JNE — digit salah ATAU resi tidak ada (kurir
   *   tidak membedakan keduanya).
   * - invalid: input dari pemanggil tidak valid.
   * - error: kurir gagal/timeout (gangguan, bukan vonis resi palsu).
   */
  async function track({ courier, awb, phone = '', fresh = false }) {
    const code = String(courier || '').trim().toLowerCase();
    const resi = String(awb || '').trim().replace(/\s+/g, '');
    if (!code || !COURIERS[code]) {
      return {
        kind: 'invalid',
        message: `Kurir tidak dikenal: ${courier || '(kosong)'}. Pilihan: ${ALL_COURIERS.join(', ')}.`,
      };
    }
    if (!resi) {
      return { kind: 'invalid', message: 'Nomor resi (awb) wajib diisi.' };
    }

    // Validasi + normalisasi digit HP. Bila pemanggil mengirim lebih dari
    // yang dibutuhkan (mis. nomor lengkap), ambil N digit terakhir saja.
    const digits = PHONE_DIGITS[code] || 0;
    let cleanPhone = String(phone || '').replace(/\D/g, '');
    if (digits > 0) {
      if (cleanPhone.length < digits) {
        return {
          kind: 'invalid',
          message:
            `Untuk ${COURIERS[code]}, isi ${digits} digit terakhir nomor HP ${PHONE_OWNER[code]} ` +
            `(param phone, mis. phone=${'1'.repeat(digits)}). Hanya digit terakhir, bukan nomor lengkap.`,
        };
      }
      cleanPhone = cleanPhone.slice(-digits);
    }

    if (!fresh) {
      const cached = db.getTrackCache(code, resi);
      if (cached && cached.fetched_at >= now() - TRACK_CACHE_TTL_MS) {
        return {
          kind: 'found',
          data: {
            ...JSON.parse(cached.payload),
            fetched_at: new Date(cached.fetched_at).toISOString(),
            cached: true,
          },
        };
      }
    }

    const key = `${code}|${resi}|${cleanPhone}`;
    const existing = inFlight.get(key);
    if (existing) return existing;
    const p = trackLive(code, resi, cleanPhone).finally(() => inFlight.delete(key));
    inFlight.set(key, p);
    return p;
  }

  /** Panggil kurir live (retry untuk kegagalan transien saja). */
  async function trackLive(code, resi, cleanPhone) {
    const resolver = getRes(code);
    if (!resolver) {
      return { kind: 'error', message: `Kurir ${code} tidak didukung.` };
    }
    let lastErr = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const res = await withTimeout(
          resolver.track(resi, { phone: cleanPhone }),
          timeoutMs,
          `lacak ${code}`
        );
        if (!res) throw new Error(`Tidak ada respons dari ${COURIERS[code]}.`);
        switch (res.status) {
          case 'NOT_FOUND':
            return {
              kind: 'not_found',
              message: res.message || `Nomor resi "${resi}" tidak ditemukan di sistem ${COURIERS[code]}.`,
            };
          case 'AWAITING_PHONE_VERIFICATION':
            // Digit sudah diisi tapi kurir tetap meminta verifikasi =
            // digitnya salah (J&T). Tanpa digit = memang butuh digit (SiCepat).
            if (cleanPhone) {
              return {
                kind: 'wrong_phone',
                message:
                  `Digit HP tidak cocok dengan data paket ${COURIERS[code]}. ` +
                  `Periksa kembali ${PHONE_DIGITS[code] || 5} digit terakhir nomor HP dan coba lagi.`,
              };
            }
            return {
              kind: 'needs_phone',
              digits: PHONE_DIGITS[code] || 5,
              message:
                res.message ||
                `Resi ini membutuhkan verifikasi ${PHONE_DIGITS[code] || 5} digit terakhir nomor HP (param phone).`,
            };
          case 'VERIFICATION_FAILED':
            // JNE: tidak membedakan digit salah vs resi tidak ada.
            return {
              kind: 'verification_failed',
              message:
                `${res.message || 'Verifikasi gagal.'} ` +
                `Periksa kembali nomor resi dan ${PHONE_DIGITS[code] || 5} digit terakhir ` +
                `nomor HP ${PHONE_OWNER[code] || 'penerima'} — salah satu dari keduanya tidak cocok.`,
            };
          case 'INVALID_PHONE_DIGITS':
          case 'INVALID_INPUT':
          case 'INVALID_WAYBILL':
            return { kind: 'invalid', message: res.message || 'Input tidak valid.' };
          case 'RESOLVER_ERROR':
          case 'UNSUPPORTED_COURIER':
            throw new Error(res.message || `Gagal melacak di ${COURIERS[code]}.`);
          default:
            if (res.success) {
              const data = normalizeResult(code, res);
              db.saveTrackCache(code, resi, JSON.stringify(data), now());
              return {
                kind: 'found',
                data: { ...data, fetched_at: new Date(now()).toISOString(), cached: false },
              };
            }
            throw new Error(res.message || res.error || `Gagal melacak di ${COURIERS[code]}.`);
        }
      } catch (err) {
        lastErr = err;
        if (isPermanentError(err)) break;
        if (attempt < maxAttempts - 1) await sleepFn(1000 * 2 ** attempt);
      }
    }
    return { kind: 'error', message: String(lastErr?.message || lastErr) };
  }

  return { track, _normalizeStatus: normalizeStatus, _normalizeEvents: normalizeEvents };
}
