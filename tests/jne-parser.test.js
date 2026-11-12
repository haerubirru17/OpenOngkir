// Tes regresi parser tracking JNE (src/openresi/resolvers/jne.js).
//
// Bug (validasi resi asli 12 Nov 2026): halaman detail JNE saat ini adalah
// cangkang JS TANPA tabel — semua rincian + riwayat ada sebagai JSON di
// `window.allTrackingData` dalam <script> inline. Parser lama hanya membaca
// tabel, sehingga service/pengirim/penerima/asal/tujuan kosong dan history [].
// Semua data di sini PALSU (resi/nama/kota contoh), strukturnya mereplikasi
// halaman asli.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { jneResolver } from '../src/openresi/resolvers/jne.js';

const AWB = 'KAJ0310999888777';

// Satu entri allTrackingData ala halaman asli (terbaru dulu di history).
function trackingEntry(overrides = {}) {
  return {
    resiNumber: AWB,
    currentStatus: 'DELIVERED',
    service: 'YES',
    from: 'JAKARTA',
    to: 'SURABAYA',
    estimateDelivery: '2',
    podDate: '12-11-2026 14:30:00',
    receiverName: 'SITI',
    receiverRelationship: 'KELUARGA/SAUDARA',
    shipmentDate: '10-11-2026 09:15:00',
    koli: 1,
    weight: '1 Kg',
    goodDescription: 'DOKUMEN',
    shipperName: 'BUDI CONTOH',
    shipperCity: 'JAKARTA',
    receiverNameDetail: 'SITI CONTOH',
    receiverCityDetail: 'SURABAYA',
    history: [
      { title: 'DELIVERED TO [SITI | 12-11-2026 14:30 | SURABAYA ]', date: '12-11-2026 14:30:00', active: true },
      { title: 'WITH DELIVERY COURIER [SURABAYA] [SBY, KUPANG]', date: '12-11-2026 08:00:00', active: false },
      { title: 'SHIPMENT RECEIVED AT [JAKARTA] [JKT, AGEN CONTOH]', date: '10-11-2026 09:15:00', active: false },
    ],
    ...overrides,
  };
}

// Halaman detail ala asli: label kosong (diisi JS), tanpa <table>,
// data di window.allTrackingData.
function detailPageHtml(entry) {
  return `<!DOCTYPE html><html><head><title>JNE</title></head><body>
  <div>Pelacakan Pengiriman</div>
  <div>No Resi : -</div>
  <div>Status Pengiriman : -</div>
  <div>Layanan Pengiriman:</div>
  <div>Dari:</div><div>Ke:</div>
  <div>Estimasi Pengiriman:</div><div>Tanggal POD: .........</div>
  <div class="timeline"></div>
  <div>Riwayat Status</div>
  <div>Detail Pengiriman</div>
  <div>Info Pengirim</div><div>Info Penerima</div>
  <script>
    window.allTrackingData = ${JSON.stringify({ [AWB]: entry })};
  </script>
</body></html>`;
}

describe('jne _parseDetailHtml: JSON allTrackingData', () => {
  it('mengisi service/pengirim/penerima/asal/tujuan + riwayat dari JSON', () => {
    const { summary, history } = jneResolver._parseDetailHtml(detailPageHtml(trackingEntry()), AWB);
    assert.equal(summary.service, 'YES');
    assert.equal(summary.shipper, 'BUDI CONTOH');
    assert.equal(summary.receiver, 'SITI CONTOH');
    assert.equal(summary.origin, 'JAKARTA');
    assert.equal(summary.destination, 'SURABAYA');
    assert.equal(summary.status, 'DELIVERED');
    assert.equal(summary.dateOfShipment, '10-11-2026 09:15:00');
    assert.equal(summary.podDate, '12-11-2026 14:30:00');

    assert.equal(history.length, 3);
    // Tanggal JNE (DD-MM-YYYY) dikonversi agar bisa diurutkan tracker.
    assert.equal(history[0].date, '2026-11-12 14:30:00');
    assert.equal(history[0].description, 'DELIVERED TO [SITI | 12-11-2026 14:30 | SURABAYA ]');
    assert.equal(history[0].location, 'SURABAYA'); // segmen terakhir setelah '|'
    assert.equal(history[1].location, 'SURABAYA');
    assert.equal(history[2].date, '2026-11-10 09:15:00');
    assert.equal(history[2].location, 'JAKARTA');
  });

  it('status mengikuti currentStatus — bukan DELIVERED bila masih jalan', () => {
    const entry = trackingEntry({
      currentStatus: 'ON PROCESS',
      podDate: '',
      history: [
        { title: 'RECEIVED AT [SURABAYA] [SBY, KUPANG]', date: '12-11-2026 08:00:00', active: true },
        { title: 'SHIPMENT RECEIVED AT [JAKARTA] [JKT, AGEN CONTOH]', date: '10-11-2026 09:15:00', active: false },
      ],
    });
    const { summary, history } = jneResolver._parseDetailHtml(detailPageHtml(entry), AWB);
    assert.equal(summary.status, 'ON PROCESS');
    assert.notEqual(summary.status, 'DELIVERED');
    assert.equal(history.length, 2);
  });

  it('tanpa JSON dan tanpa tabel: status jujur ON_PROCESS, field kosong', () => {
    const shell = `<!DOCTYPE html><html><body><div>Pelacakan Pengiriman</div>
      <div>No Resi : -</div><div>Status Pengiriman : -</div></body></html>`;
    const { summary, history } = jneResolver._parseDetailHtml(shell, AWB);
    assert.equal(summary.status, 'ON_PROCESS');
    assert.equal(summary.service, '');
    assert.equal(summary.shipper, '');
    assert.equal(history.length, 0);
  });

  it('fallback tabel lama tetap jalan bila JNE mengembalikan tabel', () => {
    const tablePage = `<!DOCTYPE html><html><body><table>
      <tr><th>Layanan</th><td>REG</td></tr>
      <tr><th>Asal</th><td>JAKARTA</td></tr>
      <tr><th>Tujuan</th><td>SURABAYA</td></tr>
      <tr><th>Pengirim</th><td>BUDI CONTOH</td></tr>
      <tr><th>Penerima</th><td>SITI CONTOH</td></tr>
      <tr><th>Status</th><td>DELIVERED</td></tr>
    </table>
    <table class="history"><tbody>
      <tr><td>2026-11-12 14:30:00</td><td>DELIVERED TO SITI</td><td>SURABAYA</td></tr>
    </tbody></table></body></html>`;
    const { summary, history } = jneResolver._parseDetailHtml(tablePage, AWB);
    assert.equal(summary.service, 'REG');
    assert.equal(summary.origin, 'JAKARTA');
    assert.equal(summary.destination, 'SURABAYA');
    assert.equal(summary.shipper, 'BUDI CONTOH');
    assert.equal(summary.receiver, 'SITI CONTOH');
    assert.equal(summary.status, 'DELIVERED');
    assert.equal(history.length, 1);
    assert.equal(history[0].location, 'SURABAYA');
  });
});

describe('jne track() end-to-end (fetch di-stub)', () => {
  function stubRes({ text = '', json = null, status = 200 } = {}) {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { getSetCookie: () => [] },
      text: async () => text,
      json: async () => json,
    };
  }

  // Alur track(): GET tracking (CSRF) -> POST inquiry (tabel resi)
  // -> POST load-verify (URL detail) -> GET halaman detail.
  async function trackWithDetail(detailHtml) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const method = (init.method || 'GET').toUpperCase();
      const u = String(url);
      if (u === 'https://jne.co.id/tracking-package' && method === 'GET') {
        return stubRes({ text: '<html><body><input name="_token" value="tok123"></body></html>' });
      }
      if (u === 'https://jne.co.id/tracking-package' && method === 'POST') {
        return stubRes({
          text: `<table><tbody><tr><td data-label="No. AWB">${AWB}</td></tr></tbody></table>`,
        });
      }
      if (u === 'https://jne.co.id/load-verify') {
        return stubRes({ json: { status: true, url: 'https://jne.co.id/detail-fake' } });
      }
      if (u === 'https://jne.co.id/detail-fake') {
        return stubRes({ text: detailHtml });
      }
      throw new Error(`URL tak terduga di stub: ${method} ${u}`);
    };
    try {
      return await jneResolver.track(AWB, { phone: '12345' });
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  it('resi terverifikasi: detail terisi + history dari JSON', async () => {
    const r = await trackWithDetail(detailPageHtml(trackingEntry()));
    assert.equal(r.status, 'DELIVERED');
    assert.equal(r.verified, true);
    assert.equal(r.detail.service, 'YES');
    assert.equal(r.detail.shipper, 'BUDI CONTOH');
    assert.equal(r.detail.receiver, 'SITI CONTOH');
    assert.equal(r.detail.origin, 'JAKARTA');
    assert.equal(r.detail.destination, 'SURABAYA');
    assert.equal(r.history.length, 3);
    assert.equal(r.history[0].location, 'SURABAYA');
  });

  it('halaman detail tanpa bukti status: ON_PROCESS, BUKAN DELIVERED', async () => {
    // Baris status tabel KOSONG — jalur yang dulu memicu default 'DELIVERED'.
    const emptyStatusPage = `<!DOCTYPE html><html><body><table>
      <tr><th>Status</th><td></td></tr>
    </table></body></html>`;
    const r = await trackWithDetail(emptyStatusPage);
    assert.equal(r.status, 'ON_PROCESS');
    assert.notEqual(r.status, 'DELIVERED');
  });
});
