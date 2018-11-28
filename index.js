'use strict';

const assert = require('assert');
const Emitter = require('events');
const dgram = require('dgram');
const { isIPv4 } = require('net');
const internalIp = require('internal-ip');
const publicIp = require('public-ip');
const stun = require('stun');
const dtls = require('@nodertc/dtls');
const sctp = require('@nodertc/sctp');
const { createChannel } = require('@nodertc/datachannel');
const unicast = require('unicast');
const pem = require('pem-file');
const fingerprint = require('./lib/fingerprint');
const { createPassword, createUsername } = require('./lib/ice-util');
const sdp = require('./lib/sdp');
const Candidates = require('./lib/candidates');

const {
  STUN_ATTR_XOR_MAPPED_ADDRESS,
  STUN_ATTR_USERNAME,
  STUN_ATTR_USE_CANDIDATE,
  STUN_ATTR_ICE_CONTROLLING,
  STUN_ATTR_PRIORITY,
  STUN_EVENT_BINDING_REQUEST,
  STUN_EVENT_BINDING_RESPONSE,
  STUN_EVENT_BINDING_ERROR_RESPONSE,
  STUN_BINDING_RESPONSE,
  STUN_BINDING_REQUEST,
} = stun.constants;

module.exports = create;

const _sessions = Symbol('sessions');
const _socket = Symbol('socket');
const _usocket = Symbol('unicast-socket');
const _offer = Symbol('offer');
const _answer = Symbol('answer');
const _certificate = Symbol('certificate');
const _privateKey = Symbol('private-key');
const _publicIp = Symbol('public-ip');
const _internalIp = Symbol('internal-ip');
const _fingerprint = Symbol('fingerprint');
const _peerFingerprint = Symbol('peer-fingerprint');
const _iceUsername = Symbol('ice-username');
const _icePassword = Symbol('ice-password');
const _peerIceUsername = Symbol('peer-ice-username');
const _peerIcePassword = Symbol('peer-ice-password');
const _stun = Symbol('stun');
const _dtls = Symbol('dtls');
const _candidates = Symbol('candidates');

const tieBreaker = Buffer.from('ffaecc81e3dae860', 'hex');

/**
 * WebRTC session.
 */
class Session extends Emitter {
  /**
   * @constructor
   * @param {object} options
   * @param {string} options.external
   * @param {string} options.internal
   * @param {Buffer} options.certificate
   * @param {Buffer} options.privateKey
   * @param {string} options.fingerprint
   */
  constructor(options = {}) {
    super();

    this[_socket] = dgram.createSocket('udp4');
    this[_usocket] = null;
    this[_stun] = null;
    this[_dtls] = null;

    this[_publicIp] = options.external;
    this[_internalIp] = options.internal;
    this[_fingerprint] = options.fingerprint;
    this[_certificate] = options.certificate;
    this[_privateKey] = options.privateKey;

    this[_offer] = null;
    this[_answer] = null;

    this[_iceUsername] = createUsername();
    this[_icePassword] = createPassword();

    this[_peerIceUsername] = null;
    this[_peerIcePassword] = null;

    this[_peerFingerprint] = null;

    this[_candidates] = new Candidates();
  }

  /**
   * @returns {sdp.SDPInfo}
   */
  get offer() {
    return this[_offer];
  }

  /**
   * Get STUN server instance.
   * @returns {stun.StunServer}
   */
  get stun() {
    return this[_stun];
  }

  /**
   * Get DTLS socket instance.
   * @returns {dtls.Socket}
   */
  get dtls() {
    return this[_dtls];
  }

  /**
   * Get ICE username.
   * @returns {string}
   */
  get username() {
    return this[_iceUsername];
  }

  /**
   * Get socket port.
   * @returns {number}
   */
  get port() {
    return this[_socket].address().port;
  }

  /**
   * @returns {string}
   */
  get fingerprint() {
    return this[_fingerprint];
  }

  /**
   * Creates an SDP answer based on offer.
   * @param {string} offer peer's SDP offer
   * @returns {string}
   */
  async createAnswer(offer) {
    this[_offer] = sdp.parse(offer);
    this.emit('offer', this[_offer]);

    const { media, fingerprint: fgprint, groups } = this[_offer];
    const haveMediaData = Array.isArray(media) && media.length > 0;

    if (!haveMediaData) {
      throw new Error('Invalid SDP offer');
    }

    const mediadata = media.find(item => item.protocol.includes('DTLS/SCTP'));

    if (!mediadata) {
      throw new Error('Datachannel not found');
    }

    const mid =
      Array.isArray(groups) && groups.length > 0 ? groups[0].mids : 'data';

    const { candidates } = mediadata;

    this[_peerIceUsername] = mediadata.iceUfrag;
    this[_peerIcePassword] = mediadata.icePwd;

    this[_peerFingerprint] =
      (fgprint && fgprint.hash) || mediadata.fingerprint.hash;

    if (!Array.isArray(candidates)) {
      throw new TypeError('Session should have at least one candidate');
    }

    candidates
      .filter(candidate => isIPv4(candidate.ip))
      .forEach(({ ip, port, priority }) => {
        this.appendCandidate(ip, port, priority);
        this.emit('candidate');
      });

    await this.listen();

    this[_answer] = sdp.create({
      username: this.username,
      password: this[_icePassword],
      fingerprint: this[_fingerprint],
      mid,
      candidates: [
        {
          ip: this[_internalIp],
          port: this.port,
          type: 'host',
        },
        {
          ip: this[_publicIp],
          port: this.port,
          type: 'srflx',
        },
      ],
    });

    this.emit('answer', this[_answer]);
    return this[_answer];
  }

  /**
   * Start internal ICE server.
   * @param {number} port
   */
  async listen(port = 0) {
    const listenUDP = new Promise(resolve => {
      this[_socket].bind(port, '0.0.0.0', resolve);
    });

    await listenUDP;

    this.startSTUN();

    // Start DTLS server after first STUN answer.
    this.stun.once(STUN_EVENT_BINDING_RESPONSE, () => this.startDTLS());
  }

  /**
   * Starts STUN server.
   */
  startSTUN() {
    console.log('[nodertc][stun] start');

    this[_stun] = stun.createServer(this[_socket]);

    setInterval(() => {
      if (this[_candidates].length === 0) {
        return;
      }

      const { primaryAddress, primaryPort } = this[_candidates];
      const request = stun.createMessage(STUN_BINDING_REQUEST);

      const outuser = `${this[_peerIceUsername]}:${this[_iceUsername]}`;
      request.addAttribute(STUN_ATTR_USERNAME, outuser);
      request.addAttribute(STUN_ATTR_USE_CANDIDATE);
      request.addAttribute(STUN_ATTR_ICE_CONTROLLING, tieBreaker);
      request.addAttribute(STUN_ATTR_PRIORITY, 2113937151);
      request.addMessageIntegrity(this[_peerIcePassword]);
      request.addFingerprint();

      this.stun.send(request, primaryPort, primaryAddress);
    }, 1e3).unref();

    this.stun.on(STUN_EVENT_BINDING_REQUEST, (req, rinfo) => {
      assert(stun.validateFingerprint(req));
      assert(stun.validateMessageIntegrity(req, this[_icePassword]));

      const userattr = req.getAttribute(STUN_ATTR_USERNAME);
      const sender = userattr.value.toString('ascii');
      const expectedSender = `${this[_iceUsername]}:${this[_peerIceUsername]}`;
      assert(sender === expectedSender);

      const response = stun.createMessage(
        STUN_BINDING_RESPONSE,
        req.transactionId
      );

      response.addAttribute(
        STUN_ATTR_XOR_MAPPED_ADDRESS,
        rinfo.address,
        rinfo.port
      );

      response.addMessageIntegrity(this[_icePassword]);
      response.addFingerprint();

      this.stun.send(response, rinfo.port, rinfo.address);
    });

    this.stun.on(STUN_EVENT_BINDING_ERROR_RESPONSE, req => {
      console.error('[nodertc][stun] got error', req);
    });
  }

  /**
   * Starts DTLS client.
   */
  startDTLS() {
    console.log('[nodertc][dtls] start');

    const options = {
      socket: this[_usocket],
      certificate: this[_certificate],
      certificatePrivateKey: this[_privateKey],
      checkServerIdentity: certificate =>
        fingerprint(certificate.raw, 'sha256') === this[_peerFingerprint],
    };

    this[_dtls] = dtls.connect(options);

    this.dtls.once('connect', () => {
      console.log('[nodertc][dtls] successful connected!');
    });

    this.dtls.on('error', err => {
      console.error('[nodertc][dtls]', err);
    });

    this.startSCTP();
  }

  /**
   * Starts SCTP server.
   */
  startSCTP() {
    console.log('[nodertc][sctp] start');

    this.sctp = sctp.createServer({
      transport: this.dtls,
    });

    this.sctp.once('listening', () => {
      console.log('[nodertc][sctp] server started');
    });

    this.sctp.on('connection', socket => {
      console.log('[nodertc][sctp] got a new connection!');

      socket.on('stream', sctpStreamIn => {
        console.log('[nodertc][sctp] got stream %s', sctpStreamIn.stream_id);

        const sctpStreamOut = socket.createStream(sctpStreamIn.stream_id);

        const channel = createChannel({
          input: sctpStreamIn,
          output: sctpStreamOut,
          negotiated: true,
        });

        channel.once('open', () => {
          this.emit('channel', channel);
        });
      });

      socket.on('error', err => {
        console.error('[nodertc][sctp]', err);
      });
    });

    this.sctp.on('error', err => {
      console.error('[nodertc][sctp]', err);
    });

    this.sctp.listen(5000); // Port defined in SDP
  }

  /**
   * Add a new candidate.
   * @param {string} address
   * @param {number} port
   * @param {number} priority
   */
  appendCandidate(address, port, priority) {
    this[_candidates].push(address, port, priority);

    const { primaryAddress, primaryPort } = this[_candidates];

    console.log('[nodertc] primary address', primaryAddress);
    console.log('[nodertc] primary port', primaryPort);

    if (this[_usocket] === null) {
      this[_usocket] = unicast.createSocket({
        socket: this[_socket],
        remoteAddress: primaryAddress,
        remotePort: primaryPort,
        messagesFilter: () => true,
      });
    } else {
      this[_usocket].remoteAddress = primaryAddress;
      this[_usocket].remotePort = primaryPort;
    }
  }
}

/**
 * Base class for WebRTC.
 */
class NodeRTC extends Emitter {
  /**
   * @constructor
   * @param {object} options
   * @param {Buffer} options.certificate
   * @param {Buffer} options.certificatePrivateKey
   */
  constructor(options = {}) {
    super();

    this[_sessions] = [];
    this[_certificate] = options.certificate;
    this[_privateKey] = options.certificatePrivateKey;

    this[_publicIp] = null;
    this[_internalIp] = null;

    assert(Buffer.isBuffer(this[_certificate]), 'Invalid certificate');

    const isValidPrivateKey = Buffer.isBuffer(this[_privateKey]);
    assert(isValidPrivateKey, 'Invalid certificate private key');

    // Client certificate fingerprint.
    this[_fingerprint] = fingerprint(pem.decode(this[_certificate]), 'sha256');
  }

  /**
   * @returns {number} the number of an active sessions
   */
  get size() {
    return this[_sessions].length;
  }

  /**
   * Public address.
   * @returns {string}
   */
  get external() {
    return this[_publicIp];
  }

  /**
   * Internal address.
   * @returns {string}
   */
  get internal() {
    return this[_internalIp];
  }

  /**
   * Creates new webrtc session.
   * @returns {Session}
   */
  createSession() {
    const session = new Session({
      external: this[_publicIp],
      internal: this[_internalIp],
      certificate: this[_certificate],
      privateKey: this[_privateKey],
      fingerprint: this[_fingerprint],
    });

    this[_sessions].push(session);

    session.once('close', () => {
      const i = this[_sessions].indexOf(session);

      if (i > -1) {
        this[_sessions].splice(i, 1);
      }
    });

    this.emit('session', session);

    return session;
  }

  /**
   * Prepares WebRTC server to work.
   */
  async start() {
    const [external, internal] = await Promise.all([
      publicIp.v4(),
      internalIp.v4(),
    ]);

    this[_publicIp] = external;
    this[_internalIp] = internal;

    console.log('[nodertc] external ip', external);
    console.log('[nodertc] internal ip', internal);
    this.emit('ready');
  }
}

/**
 * Creates an instance of NodeRTC.
 * @param {object} options
 * @param {Buffer} options.certificate
 * @param {Buffer} options.certificatePrivateKey
 * @returns {NodeRTC}
 */
function create(options = {}) {
  return new NodeRTC(options);
}
