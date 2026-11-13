// Tes deteksi IP klien: header forward hanya dipercaya dari peer loopback
// (cloudflared lokal) — peer luar selalu dinilai dari remoteAddress.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getClientIp } from '../src/server.js';

function fakeReq(peer, headers = {}) {
  return { socket: { remoteAddress: peer }, headers };
}

describe('getClientIp', () => {
  it('peer loopback + CF-Connecting-IP = IP dari header', () => {
    assert.equal(
      getClientIp(fakeReq('127.0.0.1', { 'cf-connecting-ip': '203.0.113.7' })),
      '203.0.113.7'
    );
  });

  it('peer loopback IPv6 (::1, ::ffff:127.0.0.1) juga dipercaya headernya', () => {
    assert.equal(
      getClientIp(fakeReq('::1', { 'cf-connecting-ip': '203.0.113.8' })),
      '203.0.113.8'
    );
    assert.equal(
      getClientIp(fakeReq('::ffff:127.0.0.1', { 'cf-connecting-ip': '203.0.113.9' })),
      '203.0.113.9'
    );
  });

  it('CF-Connecting-IP didahulukan atas X-Forwarded-For', () => {
    assert.equal(
      getClientIp(fakeReq('127.0.0.1', {
        'cf-connecting-ip': '203.0.113.7',
        'x-forwarded-for': '198.51.100.1, 203.0.113.7',
      })),
      '203.0.113.7'
    );
  });

  it('tanpa CF-Connecting-IP, pakai entri pertama X-Forwarded-For (di-trim)', () => {
    assert.equal(
      getClientIp(fakeReq('127.0.0.1', { 'x-forwarded-for': ' 198.51.100.1 , 203.0.113.7' })),
      '198.51.100.1'
    );
  });

  it('peer loopback tanpa header = remoteAddress', () => {
    assert.equal(getClientIp(fakeReq('127.0.0.1')), '127.0.0.1');
  });

  it('peer non-loopback mengabaikan header CF-Connecting-IP/X-Forwarded-For palsu', () => {
    assert.equal(
      getClientIp(fakeReq('203.0.113.50', {
        'cf-connecting-ip': '1.2.3.4',
        'x-forwarded-for': '5.6.7.8',
      })),
      '203.0.113.50'
    );
  });
});
