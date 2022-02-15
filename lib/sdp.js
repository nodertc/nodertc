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
 * @param {object[]} options.candidates
 * @returns {string}
 */
function create(options = {}) {
  const { username, password, fingerprint, mid, candidates } = options;

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
        // Doc about SDP candidates
        // https://developer.mozilla.org/en-US/docs/Web/API/RTCIceCandidate/candidate
        // https://webrtcforthecurious.com/docs/02-signaling/#sdp-values-used-by-webrtc
        // https://datatracker.ietf.org/doc/html/draft-ietf-mmusic-ice-sip-sdp-39#page-18
        // https://datatracker.ietf.org/doc/html/draft-ietf-rtcweb-sdp-14
        // Future: Add mDNS candidate where the IP address is obscured.
        candidates: candidates.map(({ ip, port, type }, i) => {
          // TODO: Review candidates if server have more than a local ip and a public ip
          const componentId = 1;
          // Priority formula
          // https://datatracker.ietf.org/doc/html/rfc8445#section-5.1.2
          // The type preference MUST be an integer from 0 (lowest preference) to
          // 126 (highest preference) inclusive
          let typePreference = 0;
          switch (type) {
            case 'host':
              typePreference = 126;
              break;
            case 'srflx':
              typePreference = 64;
              break;
            case 'prflx':
              typePreference = 16;
              break;
            case 'relay':
              typePreference = 8;
              break;
          }
          // The local preference MUST be an integer from 0 (lowest preference) to
          //  65535 (highest preference) inclusive
          const localPreference = type == 'host' ? 65535 : 0;
          
          const priority = 0x1000000 * typePreference + 
            256 * localPreference +
            256 - componentId;

          if (i == 0) {
            return {
              ip,
              port,
              type,
              priority,
              transport: 'udp',
              component: componentId,
              foundation: i,
            }
          }
          return {
            ip,
            port,
            type,
            priority,
            transport: 'udp',
            component: componentId,
            foundation: i,
            raddr: candidates[0].ip,
            rport: candidates[0].port,
          }
        }),
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
