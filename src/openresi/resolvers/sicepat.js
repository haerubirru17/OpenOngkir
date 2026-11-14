import { BaseCourierResolver } from './base.js';
import { parseLocationQuery } from '../utils/locationParser.js';

/**
 * SiCepat Ekspres Tracking & Shipping Cost Resolver
 * Direct integration with https://www.sicepat.com and https://api.sicepatconsumer.com
 */
export class SiCepatResolver extends BaseCourierResolver {
  constructor() {
    super('SiCepat Ekspres', 'sicepat');
    this.originApiUrl =
      'https://api.sicepatconsumer.com/v1/contentsvc/public/delivery-fee/origin';
    this.destinationApiUrl =
      'https://api.sicepatconsumer.com/v1/contentsvc/public/delivery-fee/destination';
    this.fareApiUrl =
      'https://api.sicepatconsumer.com/v1/contentsvc/public/delivery-fee/fare-non-international';
    this.validateAwbUrl =
      'https://api.sicepatconsumer.com/v2/contentsvc/public/validate-awb-id';
    this.checkAwbUrl =
      'https://api.sicepatconsumer.com/v2/contentsvc/public/check-awb';

    this.defaultUserAgent =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

    // Google reCAPTCHA v3 parameters for SiCepat
    this.recaptchaSiteKey = '6LfG3VIqAAAAAOZ_w59NNZIrgEu8pHKSEBZGqxTN';
    this.recaptchaCo = Buffer.from('https://www.sicepat.com:443')
      .toString('base64')
      .replace(/=/g, '.');
  }

  /**
   * Dynamically fetch invisible reCAPTCHA v3 token directly from Google
   * @private
   * @param {string} [action='checkAwb']
   * @returns {Promise<string>}
   */
  async _getRecaptchaToken(action = 'checkAwb') {
    try {
      // 1. Get recaptcha client version from api.js
      const apiRes = await fetch(
        `https://www.google.com/recaptcha/api.js?render=${this.recaptchaSiteKey}`,
        {
          headers: { 'User-Agent': this.defaultUserAgent },
        }
      );
      const apiText = await apiRes.text();
      const vMatch = apiText.match(/releases\/([^\/]+)\/recaptcha/);
      const version = vMatch ? vMatch[1] : '';

      // 2. Fetch anchor page to obtain session token
      const anchorUrl = `https://www.google.com/recaptcha/api2/anchor?ar=1&k=${this.recaptchaSiteKey}&co=${this.recaptchaCo}&hl=en&v=${version}&size=invisible&cb=12345`;
      const anchorRes = await fetch(anchorUrl, {
        headers: {
          'User-Agent': this.defaultUserAgent,
          'Referer': 'https://www.sicepat.com/',
        },
      });
      const anchorHtml = await anchorRes.text();
      const tokenMatch = anchorHtml.match(/id="recaptcha-token"\s+value="([^"]+)"/);
      const anchorToken = tokenMatch ? tokenMatch[1] : null;

      if (!anchorToken) {
        return 'fallback-token';
      }

      // 3. Request final single-use response token from reload endpoint
      const reloadUrl = `https://www.google.com/recaptcha/api2/reload?k=${this.recaptchaSiteKey}`;
      const reloadRes = await fetch(reloadUrl, {
        method: 'POST',
        headers: {
          'User-Agent': this.defaultUserAgent,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': anchorUrl,
        },
        body: `v=${version}&reason=q&c=${encodeURIComponent(
          anchorToken
        )}&k=${this.recaptchaSiteKey}&co=${this.recaptchaCo}&hl=en&size=invisible&sa=${action}`,
      });

      const reloadText = await reloadRes.text();
      const finalTokenMatch = reloadText.match(/"rresp","([^"]+)"/);
      return finalTokenMatch ? finalTokenMatch[1] : 'fallback-token';
    } catch (_) {
      return 'fallback-token';
    }
  }

  /**
   * Search origin locations for SiCepat
   * @param {string} query - Keyword e.g. "Jakarta"
   * @returns {Promise<Array<{ code: string, label: string }>>}
   */
  async searchOrigins(query) {
    const q = (query || '').trim();
    if (q.length < 2) return [];

    const url = `${this.originApiUrl}?keyword=${encodeURIComponent(q)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': this.defaultUserAgent,
        'Accept': 'application/json, text/plain, */*',
        'Origin': 'https://www.sicepat.com',
        'Referer': 'https://www.sicepat.com/',
      },
    });

    if (!res.ok) {
      // HTTP error (mis. 429/500) adalah kegagalan transien — lempar agar
      // pemanggil me-retry, jangan kembalikan [] yang disalahartikan
      // sebagai "lokasi tidak ditemukan" (permanen).
      throw new Error(`Gagal mencari lokasi asal SiCepat (HTTP ${res.status}).`);
    }
    const json = await res.json().catch(() => ({}));
    const results = json?.data?.sicepat?.results || [];

    // Prioritize exact or word boundary matches
    const qLower = q.toLowerCase();
    const sorted = [...results].sort((a, b) => {
      const aName = (a.origin_name || '').toLowerCase();
      const bName = (b.origin_name || '').toLowerCase();
      if (aName === qLower) return -1;
      if (bName === qLower) return 1;
      if (aName.startsWith(qLower) && !bName.startsWith(qLower)) return -1;
      if (!aName.startsWith(qLower) && bName.startsWith(qLower)) return 1;
      return 0;
    });

    return sorted.map((item) => ({
      code: item.origin_code || '',
      label: item.origin_name || '',
    }));
  }

  /**
   * Search destination locations for SiCepat
   * @param {string} query - Keyword e.g. "Surabaya" or "Medan"
   * @returns {Promise<Array<{ code: string, label: string, city: string, district: string, province: string }>>}
   */
  async searchDestinations(query) {
    const q = (query || '').trim();
    if (q.length < 2) return [];

    const url = `${this.destinationApiUrl}?keyword=${encodeURIComponent(q)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': this.defaultUserAgent,
        'Accept': 'application/json, text/plain, */*',
        'Origin': 'https://www.sicepat.com',
        'Referer': 'https://www.sicepat.com/',
      },
    });

    if (!res.ok) {
      // HTTP error (mis. 429/500) adalah kegagalan transien — lempar agar
      // pemanggil me-retry, jangan kembalikan [] yang disalahartikan
      // sebagai "lokasi tidak ditemukan" (permanen).
      throw new Error(`Gagal mencari lokasi tujuan SiCepat (HTTP ${res.status}).`);
    }
    const json = await res.json().catch(() => ({}));
    const results = json?.data?.sicepat?.results || [];

    // Sort to prioritize word-boundary matches (e.g. prevent "Sumedang" from outranking "Medan")
    const wordRegex = new RegExp(`\\b${q}\\b`, 'i');
    const sorted = [...results].sort((a, b) => {
      const aMatch = wordRegex.test(a.city) || wordRegex.test(a.subdistrict);
      const bMatch = wordRegex.test(b.city) || wordRegex.test(b.subdistrict);
      if (aMatch && !bMatch) return -1;
      if (!aMatch && bMatch) return 1;
      return 0;
    });

    return sorted.map((item) => ({
      code: item.destination_code || '',
      label: `${item.subdistrict}, ${item.city}, ${item.province}`,
      district: item.subdistrict || '',
      city: item.city || '',
      province: item.province || '',
    }));
  }

  /**
   * Calculate shipping fee (Cek Ongkir) for SiCepat Ekspres
   * @param {object} params
   * @param {string} params.origin - Origin city/code (e.g. "Jakarta" or "CGK")
   * @param {string} params.destination - Destination city/subdistrict/code (e.g. "Surabaya" or "SUB10024")
   * @param {number|string} [params.weight=1] - Weight in kg (defaults to 1)
   * @returns {Promise<object>} Standardized rates result
   */
  async calculateCost(params = {}) {
    const rawOrigin = (params.origin || '').trim();
    const rawDest = (params.destination || '').trim();
    const weight = Math.max(0.1, parseFloat(params.weight || 1));

    if (!rawOrigin || !rawDest) {
      return {
        success: false,
        courier: this.name,
        error: 'Kota/wilayah asal (origin) dan tujuan (destination) wajib diisi.',
      };
    }

    let originCode = rawOrigin;
    let originLabel = rawOrigin;

    // 1. Resolve Origin if plain text
    const isOriginCode = /^[A-Z]{3}$/.test(rawOrigin.toUpperCase());
    if (isOriginCode) {
      originCode = rawOrigin.toUpperCase();
    } else {
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
          error: `Kota asal "${rawOrigin}" tidak ditemukan di database SiCepat. Coba ketik nama kota utama (contoh: Jakarta, Bandung, Surabaya).`,
        };
      }
      origins = parsedOrigin.rankMatches(origins, { getLabel: (o) => o.label });
      originCode = origins[0].code;
      originLabel = origins[0].label;
    }

    // 2. Resolve Destination if plain text
    let destCode = rawDest;
    let destLabel = rawDest;

    const isDestCode = /^[A-Z]{3}[0-9]{5}$/i.test(rawDest);
    if (isDestCode) {
      destCode = rawDest.toUpperCase();
    } else {
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
          error: `Wilayah tujuan "${rawDest}" tidak ditemukan di database SiCepat. Coba ketik nama kecamatan atau kota.`,
        };
      }
      dests = parsedDest.rankMatches(dests, {
        getLabel: (d) => d.label,
        getCity: (d) => d.city,
        getDistrict: (d) => d.district,
      });
      destCode = dests[0].code;
      destLabel = dests[0].label;
    }

    // 3. Query Fare API
    const res = await fetch(this.fareApiUrl, {
      method: 'POST',
      headers: {
        'User-Agent': this.defaultUserAgent,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'Origin': 'https://www.sicepat.com',
        'Referer': 'https://www.sicepat.com/',
        'x-recaptcha': 'bypass-token',
      },
      body: JSON.stringify({
        origin: originCode,
        destination: destCode,
        weight: String(weight),
      }),
    });

    if (!res.ok) {
      return {
        success: false,
        courier: this.name,
        error: `Gagal menghitung ongkos kirim SiCepat (HTTP ${res.status}).`,
      };
    }

    const json = await res.json().catch(() => ({}));
    const rawServices = json?.data?.sicepat?.results || [];

    if (rawServices.length === 0) {
      return {
        success: false,
        courier: this.name,
        error: `Tidak ada layanan SiCepat yang tersedia untuk rute ${originCode} ke ${destCode}.`,
      };
    }

    const currencyFmt = new Intl.NumberFormat('id-ID', {
      style: 'currency',
      currency: 'IDR',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });

    const services = rawServices.map((item) => {
      const code = (item.service || '').toUpperCase();
      const fee = parseFloat(item.tariff || item.total_price || 0);

      return {
        service: code,
        type: code,
        name: `SiCepat ${code} (${item.description || 'Layanan Pengiriman'})`,
        cost: fee,
        formattedCost: currencyFmt.format(fee),
        etd: item.etd || '-',
        description: item.description || '',
        isCod: !!item.isCod,
      };
    });

    return {
      success: true,
      courier: this.name,
      origin: {
        code: originCode,
        label: originLabel,
      },
      destination: {
        code: destCode,
        label: destLabel,
      },
      weight: `${weight} kg`,
      services: services,
    };
  }

  /**
   * Track waybill on SiCepat Ekspres
   * @param {string} waybillNumber - Nomor resi SiCepat (e.g. 001234567890)
   * @param {object} [options]
   * @param {string} [options.phone] - 5 digit terakhir nomor HP penerima
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

    const phone = (options.phone || options.last5Phone || '').toString().trim();

    // 1. Validate if AWB requires phone number verification
    const token1 = await this._getRecaptchaToken('checkAwb');
    const vRes = await fetch(this.validateAwbUrl, {
      method: 'POST',
      headers: {
        'User-Agent': this.defaultUserAgent,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'Origin': 'https://www.sicepat.com',
        'Referer': 'https://www.sicepat.com/',
        'x-recaptcha': token1,
      },
      body: JSON.stringify({ awb_number: resi }),
    });

    const vJson = await vRes.json().catch(() => ({}));
    const isAwbId = vJson?.data?.is_awb_id;

    if (isAwbId && !phone) {
      return {
        success: false,
        courier: this.name,
        waybillNumber: resi,
        verified: false,
        status: 'AWAITING_PHONE_VERIFICATION',
        requiresPhoneVerification: true,
        message:
          'Sesuai kebijakan privasi SiCepat Ekspres, masukkan 5 digit terakhir nomor HP penerima (gunakan opsi --phone <5_digit> atau query ?phone=XXXXX).',
      };
    }

    // 2. Fetch tracking details with fresh single-use token
    const token2 = await this._getRecaptchaToken('checkAwb');
    const cRes = await fetch(this.checkAwbUrl, {
      method: 'POST',
      headers: {
        'User-Agent': this.defaultUserAgent,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'Origin': 'https://www.sicepat.com',
        'Referer': 'https://www.sicepat.com/',
        'x-recaptcha': token2,
      },
      body: JSON.stringify({
        awb_id: phone || '',
        awb_number: resi,
      }),
    });

    const cJson = await cRes.json().catch(() => ({}));
    const statusCode = cJson?.data?.sicepat?.status?.code;
    const resultData = cJson?.data?.sicepat?.result;

    if (
      statusCode === 404 ||
      !resultData ||
      Object.keys(resultData).length === 0
    ) {
      return {
        success: false,
        courier: this.name,
        waybillNumber: resi,
        status: 'NOT_FOUND',
        message: `Nomor resi "${resi}" tidak ditemukan di sistem SiCepat Ekspres. Pastikan nomor resi sudah benar.`,
      };
    }

    // 3. Parse and Standardize Checkpoints
    const rawHistory = Array.isArray(resultData.track_history)
      ? resultData.track_history
      : [];

    const history = rawHistory.map((item) => {
      const parts = (item.date_time || '').split(' ');
      const date = parts[0] || '';
      const time = parts[1] || '';

      return {
        dateTime: item.date_time || '',
        date: date,
        time: time,
        location: item.city || '',
        status: item.receiver_name ? `Diterima oleh ${item.receiver_name}` : item.city || '',
        description: item.city || item.receiver_name || 'Status diperbarui',
        actor: item.receiver_name || '',
      };
    });

    // Determine Status
    let standardizedStatus = 'ON_PROCESS';
    const lastStatus = (resultData.last_status?.status || '').toUpperCase();
    const podReceiver = resultData.POD_receiver || '';

    if (podReceiver || lastStatus.includes('DELIVERED') || lastStatus.includes('TERKIRIM') || lastStatus.includes('DITERIMA')) {
      standardizedStatus = 'DELIVERED';
    } else if (lastStatus.includes('ANTAR') || lastStatus.includes('DELIVERY') || lastStatus.includes('SIGESIT')) {
      standardizedStatus = 'ON_DELIVERY';
    } else if (lastStatus.includes('RETUR') || lastStatus.includes('RETURN')) {
      standardizedStatus = 'RETURN_TO_SENDER';
    }

    return {
      success: true,
      courier: this.name,
      waybillNumber: resi,
      verified: true,
      status: standardizedStatus,
      summary: {
        waybill: resi,
        service: resultData.service || 'SiCepat Ekspres',
        status: resultData.last_status?.status || standardizedStatus,
        date: resultData.send_date || '',
        sender: resultData.sender || '',
        senderAddress: resultData.sender_address || '',
        recipient: resultData.receiver_name || '',
        recipientAddress: resultData.receiver_address || '',
        podReceiver: podReceiver || '',
        podDate: resultData.POD_receiver_time || '',
      },
      history: history,
    };
  }
}

export const sicepatResolver = new SiCepatResolver();
