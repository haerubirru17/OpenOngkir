/**
 * Base Courier Resolver Class
 */
export class BaseCourierResolver {
  /**
   * @param {string} name - Courier display name (e.g. 'JNE Express')
   * @param {string} code - Courier code identifier (e.g. 'jne')
   */
  constructor(name, code) {
    this.name = name;
    this.code = code.toLowerCase();
  }

  /**
   * Track a waybill / airwaybill (resi)
   * @param {string} waybillNumber - Nomor resi
   * @param {object} [options] - Additional options (e.g. phone number digits)
   * @returns {Promise<object>} Standardized tracking result
   */
  async track(waybillNumber, options = {}) {
    throw new Error(`track() method is not implemented for ${this.name}`);
  }

  /**
   * Calculate shipping cost (cek ongkir)
   * @param {object} params
   * @param {string} params.origin - Origin city/code
   * @param {string} params.destination - Destination city/code
   * @param {number|string} [params.weight=1] - Weight in kg
   * @returns {Promise<object>} Standardized rates result
   */
  async calculateCost(params = {}) {
    throw new Error(`calculateCost() method is not implemented for ${this.name}`);
  }

  /**
   * Search origin locations
   * @param {string} query
   * @returns {Promise<Array<{ code: string, label: string }>>}
   */
  async searchOrigins(query) {
    throw new Error(`searchOrigins() method is not implemented for ${this.name}`);
  }

  /**
   * Search destination locations
   * @param {string} query
   * @returns {Promise<Array<{ code: string, label: string }>>}
   */
  async searchDestinations(query) {
    throw new Error(`searchDestinations() method is not implemented for ${this.name}`);
  }

  /**
   * Sanitize waybill input
   * @param {string} input 
   * @returns {string}
   */
  sanitizeWaybill(input) {
    if (!input || typeof input !== 'string') return '';
    return input.trim().replace(/\s+/g, '');
  }
}
