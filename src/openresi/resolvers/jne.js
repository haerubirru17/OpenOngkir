import * as cheerio from 'cheerio';
import { BaseCourierResolver } from './base.js';
import { parseLocationQuery } from '../utils/locationParser.js';

/**
 * JNE Express Tracking & Shipping Cost Resolver
 * Direct integration with https://jne.co.id (tracking-package, api-origin, api-destination, shipping-fee)
 */
export class JNEResolver extends BaseCourierResolver {
  constructor() {
    super('JNE Express', 'jne');
    this.baseUrl = 'https://jne.co.id';
    this.trackingUrl = 'https://jne.co.id/tracking-package';
    this.verifyUrl = 'https://jne.co.id/load-verify';
    this.originApiUrl = 'https://jne.co.id/api-origin';
    this.destinationApiUrl = 'https://jne.co.id/api-destination';
    this.shippingFeeUrl = 'https://jne.co.id/shipping-fee';
    this.defaultUserAgent =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  }

  /**
   * Fetch initial tracking session, cookies, and CSRF token
   * @private
   */
  async _getSession() {
    const res = await fetch(this.trackingUrl, {
      method: 'GET',
      headers: {
        'User-Agent': this.defaultUserAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'id,en-US;q=0.9,en;q=0.8',
      },
    });

    if (!res.ok) {
      throw new Error(`Failed to load JNE tracking page (HTTP ${res.status})`);
    }

    const html = await res.text();
    const tokenMatch = html.match(/name="_token"\s+value="([^"]+)"/i);
    const token = tokenMatch ? tokenMatch[1] : null;

    if (!token) {
      throw new Error('Failed to extract CSRF token from JNE tracking page');
    }

    // Extract cookies
    const cookieHeaders = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    const cookieStr = cookieHeaders.map((c) => c.split(';')[0]).join('; ');

    return { token, cookieStr };
  }

  /**
   * Track waybill on JNE
   * @param {string} waybillNumber - Nomor resi JNE
   * @param {object} [options]
   * @param {string} [options.phone] - 5 digit terakhir atau nomor HP lengkap penerima
   * @param {string} [options.last5Phone] - Alias for phone
   * @returns {Promise<object>} Standardized tracking object
   */
  async track(waybillNumber, options = {}) {
    const resi = this.sanitizeWaybill(waybillNumber);
    if (!resi) {
      return {
        success: false,
        courier: this.name,
        waybillNumber: '',
        status: 'INVALID_INPUT',
        message: 'Nomor resi tidak boleh kosong.',
      };
    }

    // 1. Get Session Token & Cookies
    const { token, cookieStr } = await this._getSession();

    // 2. Submit Resi Inquiry (JNE expects JSON format serialized by Tagify)
    const tagifyPayload = JSON.stringify([{ value: resi }]);
    const formBody = new URLSearchParams({
      _token: token,
      'cek-resi': tagifyPayload,
    });

    const postRes = await fetch(this.trackingUrl, {
      method: 'POST',
      headers: {
        'User-Agent': this.defaultUserAgent,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookieStr,
        'Origin': this.baseUrl,
        'Referer': this.trackingUrl,
      },
      body: formBody.toString(),
    });

    if (!postRes.ok) {
      throw new Error(`JNE server error during initial inquiry (HTTP ${postRes.status})`);
    }

    const postHtml = await postRes.text();
    const $ = cheerio.load(postHtml);

    // 3. Inspect table
    const tableRows = $('table tbody tr');
    let foundAwb = null;

    tableRows.each((_, el) => {
      const awbCell = $(el).find('td[data-label="No. AWB"]').text().trim();
      if (awbCell && (awbCell.toUpperCase() === resi.toUpperCase() || awbCell.includes(resi))) {
        foundAwb = awbCell;
      }
    });

    if (!foundAwb) {
      const errorMsg = $('.errorMsg').text().trim() || 'Nomor resi tidak ditemukan di sistem JNE.';
      return {
        success: false,
        courier: this.name,
        waybillNumber: resi,
        status: 'NOT_FOUND',
        message: errorMsg,
      };
    }

    // 4. Handle Phone Verification if requested
    const rawPhone = options.phone || options.last5Phone;
    if (rawPhone) {
      const cleanDigits = String(rawPhone).replace(/\D/g, '').slice(-5);
      if (cleanDigits.length !== 5) {
        return {
          success: true,
          courier: this.name,
          waybillNumber: resi,
          verified: false,
          status: 'INVALID_PHONE_DIGITS',
          message: 'Verifikasi membutuhkan 5 digit nomor telepon penerima (contoh: 12345).',
        };
      }

      // Submit verification POST
      const verifyRes = await fetch(this.verifyUrl, {
        method: 'POST',
        headers: {
          'User-Agent': this.defaultUserAgent,
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest',
          'Cookie': cookieStr,
          'Referer': this.trackingUrl,
        },
        body: new URLSearchParams({
          _token: token,
          resi_: resi,
          num_all: cleanDigits,
        }).toString(),
      });

      const verifyData = await verifyRes.json().catch(() => null);

      if (verifyData && verifyData.status && verifyData.url) {
        // Fetch verified detailed tracking page
        const detailRes = await fetch(verifyData.url, {
          method: 'GET',
          headers: {
            'User-Agent': this.defaultUserAgent,
            'Cookie': cookieStr,
            'Referer': this.trackingUrl,
          },
        });

        const detailHtml = await detailRes.text();
        const parsedDetail = this._parseDetailHtml(detailHtml, resi);

        return {
          success: true,
          courier: this.name,
          waybillNumber: resi,
          verified: true,
          status: parsedDetail.summary.status || 'DELIVERED',
          detail: parsedDetail.summary,
          history: parsedDetail.history,
          sourceUrl: verifyData.url,
        };
      } else {
        return {
          success: true,
          courier: this.name,
          waybillNumber: resi,
          verified: false,
          status: 'VERIFICATION_FAILED',
          message:
            verifyData?.error ||
            'Verifikasi gagal: 5 digit nomor telepon penerima tidak cocok dengan data paket JNE.',
        };
      }
    }

    // 5. AWB is registered but requires 5-digit recipient phone number
    return {
      success: true,
      courier: this.name,
      waybillNumber: resi,
      verified: false,
      status: 'AWAITING_PHONE_VERIFICATION',
      requiresPhoneVerification: true,
      message:
        'Resi terdaftar di sistem JNE. Sesuai kebijakan privasi JNE, masukkan 5 digit terakhir nomor HP penerima (phone: "12345") untuk melihat rincian pelacakan dan status POD lengkap.',
    };
  }

  /**
   * Search origin locations for JNE
   * @param {string} query - Keyword e.g. "Jakarta"
   * @returns {Promise<Array<{ code: string, label: string }>>}
   */
  async searchOrigins(query) {
    const q = (query || '').trim();
    if (q.length < 3) return [];

    const url = `${this.originApiUrl}?search=${encodeURIComponent(q)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': this.defaultUserAgent,
        'X-Requested-With': 'XMLHttpRequest',
      },
    });

    if (!res.ok) return [];
    const json = await res.json().catch(() => ({}));
    const data = Array.isArray(json.data) ? json.data : [];
    return data.map((item) => ({
      code: item.code || '',
      label: item.label || '',
    }));
  }

  /**
   * Search destination locations for JNE
   * @param {string} query - Keyword e.g. "Bandung"
   * @returns {Promise<Array<{ code: string, label: string }>>}
   */
  async searchDestinations(query) {
    const q = (query || '').trim();
    if (q.length < 3) return [];

    const url = `${this.destinationApiUrl}?search=${encodeURIComponent(q)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': this.defaultUserAgent,
        'X-Requested-With': 'XMLHttpRequest',
      },
    });

    if (!res.ok) return [];
    const json = await res.json().catch(() => ({}));
    const data = Array.isArray(json.data) ? json.data : [];
    return data.map((item) => ({
      code: item.code || '',
      label: item.label || '',
    }));
  }

  /**
   * Calculate shipping fee (Cek Ongkir) for JNE
   * @param {object} params
   * @param {string} params.origin - Origin city name (e.g. "Jakarta") or JNE code (e.g. "CGK10000")
   * @param {string} params.destination - Destination city name (e.g. "Bandung") or JNE code (e.g. "BDO10000")
   * @param {number|string} [params.weight=1] - Weight in kg (defaults to 1)
   * @returns {Promise<object>} Standardized rates result
   */
  async calculateCost(params = {}) {
    const rawOrigin = (params.origin || '').trim();
    const rawDest = (params.destination || '').trim();
    const weight = Math.max(1, Math.round(parseFloat(params.weight || 1)));

    if (!rawOrigin || !rawDest) {
      return {
        success: false,
        courier: this.name,
        error: 'Kota/wilayah asal (origin) dan tujuan (destination) wajib diisi.',
      };
    }

    let originItem = { code: rawOrigin, label: rawOrigin };
    let destItem = { code: rawDest, label: rawDest };

    // 1. Resolve Origin Code if user passed plain text
    const isOriginCode = /^[A-Z]{3}[0-9]{5}$/i.test(rawOrigin);
    if (!isOriginCode) {
      const parsedOrigin = parseLocationQuery(rawOrigin);
      let origins = [];
      for (const q of parsedOrigin.originQueries) {
        origins = await this.searchOrigins(q);
        if (origins.length > 0) break;
      }
      if (origins.length === 0) {
        return {
          success: false,
          courier: this.name,
          error: `Kota/wilayah asal "${rawOrigin}" tidak ditemukan di sistem JNE. Coba ketik nama kota utama.`,
        };
      }
      origins = parsedOrigin.rankMatches(origins, { getLabel: (o) => o.label });
      originItem = origins[0];
    }

    // 2. Resolve Destination Code if user passed plain text
    const isDestCode = /^[A-Z]{3}[0-9]{5}$/i.test(rawDest);
    if (!isDestCode) {
      const parsedDest = parseLocationQuery(rawDest);
      let dests = [];
      for (const q of parsedDest.destinationQueries) {
        dests = await this.searchDestinations(q);
        if (dests.length > 0) break;
      }
      if (dests.length === 0) {
        return {
          success: false,
          courier: this.name,
          error: `Kota/wilayah tujuan "${rawDest}" tidak ditemukan di sistem JNE. Coba ketik nama kota/kecamatan.`,
        };
      }
      dests = parsedDest.rankMatches(dests, { getLabel: (d) => d.label });
      destItem = dests[0];
    }

    // 3. Query JNE shipping fee calculation endpoint
    const query = new URLSearchParams({
      origin: originItem.code,
      destination: destItem.code,
      weight: String(weight),
    });

    const feeUrl = `${this.shippingFeeUrl}?${query.toString()}`;
    const res = await fetch(feeUrl, {
      method: 'GET',
      headers: {
        'User-Agent': this.defaultUserAgent,
        'Referer': this.baseUrl,
      },
    });

    if (!res.ok) {
      throw new Error(`JNE server error calculating shipping rates (HTTP ${res.status})`);
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    const services = [];
    $('table tbody tr').each((_, tr) => {
      const tds = $(tr).find('td');
      if (tds.length >= 4) {
        const serviceName = $(tds[0]).text().trim();
        const packageType = $(tds[1]).text().trim();
        const rawTariff = $(tds[2]).text().trim();
        const etd = $(tds[3]).text().trim();

        // Extract numeric cost (e.g. "IDR 12.000" -> 12000)
        const numCost = parseInt(rawTariff.replace(/[^0-9]/g, ''), 10) || 0;
        const formattedCost = numCost > 0 ? `Rp ${numCost.toLocaleString('id-ID')}` : rawTariff;

        // Friendly ETD description (e.g. "1-2 D" -> "1-2 Hari")
        let friendlyEtd = etd;
        if (/([0-9\-]+)\s*d/i.test(etd)) {
          friendlyEtd = etd.replace(/d/i, 'Hari').trim();
        } else if (/([0-9\-]+)\s*h/i.test(etd)) {
          friendlyEtd = etd.replace(/h/i, 'Jam').trim();
        }

        services.push({
          service: serviceName,
          type: packageType,
          name: `JNE ${serviceName}`,
          cost: numCost,
          formattedCost,
          etd: friendlyEtd,
          description: packageType ? `Layanan JNE ${serviceName} (${packageType})` : `Layanan JNE ${serviceName}`,
          rawTariff,
        });
      }
    });

    return {
      success: true,
      courier: this.name,
      origin: originItem,
      destination: destItem,
      weight: `${weight} kg`,
      servicesCount: services.length,
      services,
      sourceUrl: feeUrl,
    };
  }

  /**
   * Parse detailed HTML tracking page
   * @private
   */
  _parseDetailHtml(html, resi) {
    const $ = cheerio.load(html);
    const summary = {
      waybillNumber: resi,
      courier: this.name,
      service: '',
      dateOfShipment: '',
      origin: '',
      destination: '',
      shipper: '',
      receiver: '',
      status: 'ON_PROCESS',
      podDate: '',
      deliveredTo: '',
    };
    const history = [];

    // 1. Generic Table Key-Value Extractor
    $('table tr').each((_, tr) => {
      const th = $(tr).find('th, td:first-child').text().trim().toLowerCase();
      const td = $(tr).find('td:last-child').text().trim();

      if (th.includes('layanan') || th.includes('service')) summary.service = td;
      if (th.includes('tanggal') || th.includes('date')) summary.dateOfShipment = td;
      if (th.includes('asal') || th.includes('origin')) summary.origin = td;
      if (th.includes('tujuan') || th.includes('destination')) summary.destination = td;
      if (th.includes('pengirim') || th.includes('shipper')) summary.shipper = td;
      if (th.includes('penerima') || th.includes('consignee') || th.includes('receiver')) summary.receiver = td;
      if (th.includes('status')) summary.status = td;
      if (th.includes('pod') || th.includes('diterima oleh') || th.includes('received by')) summary.deliveredTo = td;
    });

    // 2. Timeline / Tracking History parser
    const historyRows = $('table.history tr, .timeline-item, .tracking-history tr, tbody tr');
    historyRows.each((_, el) => {
      const text = $(el).text().trim();
      const tds = $(el).find('td');

      if (tds.length >= 2) {
        const date = $(tds[0]).text().trim();
        const desc = $(tds[1]).text().trim();
        const city = tds.length >= 3 ? $(tds[2]).text().trim() : '';

        if (date && desc && !date.toLowerCase().includes('tanggal') && !date.toLowerCase().includes('no')) {
          history.push({
            date,
            location: city || undefined,
            description: desc,
          });
        }
      } else if (text && text.length > 10) {
        const timeEl = $(el).find('.time, .date, time').text().trim();
        const descEl = $(el).find('.desc, .text, p').text().trim();
        if (timeEl || descEl) {
          history.push({
            date: timeEl || '',
            description: descEl || text,
          });
        }
      }
    });

    const lowerStatus = (summary.status || '').toLowerCase();
    const fullText = $('body').text().toLowerCase();
    if (lowerStatus.includes('delivered') || lowerStatus.includes('diterima') || fullText.includes('delivered')) {
      summary.status = 'DELIVERED';
    }

    return { summary, history };
  }
}

export const jneResolver = new JNEResolver();
