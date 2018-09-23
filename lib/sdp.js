'use strict';

const sdp = require('sdp-transform');

module.exports = {
  create,
  parse,
};

/**
 * Creates SDP from provided params.
 * @param {object} options
 * @param {string} options.username
 * @param {string} options.password
 * @param {string} options.fingerprint
 * @param {string} options.mid
 * @returns {string}
 */
function create(options = {}) {
  const { username, password, fingerprint, mid } = options;

  return sdp.write({
    version: 0,
    origin: {
      username: '-',
      sessionId: '3497579305088229251',
      sessionVersion: 2,
      netType: 'IN',
      ipVer: 4,
      address: '127.0.0.1',
    },
    name: '-',
    timing: { start: 0, stop: 0 },
    groups: [{ type: 'BUNDLE', mids: mid }],
    msidSemantic: {
      semantic: '',
      token: 'WMS',
    },
    media: [
      {
        type: 'application',
        port: 9,
        protocol: 'DTLS/SCTP',
        payloads: 5000,
        setup: 'active',
        iceUfrag: username,
        icePwd: password,
        mid,
        fingerprint: {
          type: 'sha-256',
          hash: fingerprint,
        },
        connection: {
          version: 4,
          ip: '0.0.0.0',
        },
        sctpmap: {
          sctpmapNumber: 5000,
          app: 'webrtc-datachannel',
          maxMessageSize: 1024,
        },
      },
    ],
  });
}

/**
 * Parse SDP to json.
 * @param {string} session
 * @returns {object}
 */
function parse(session) {
  return sdp.parse(session);
}
