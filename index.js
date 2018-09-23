'use strict';

const assert = require('assert');
const Emitter = require('events');
const dgram = require('dgram');
const internalIp = require('internal-ip');
const publicIp = require('public-ip');
const stun = require('stun');
const dtls = require('@nodertc/dtls');
const sorted = require('sorted-array-functions');
const unicast = require('unicast');
const pem = require('pem-file');
const fingerprint = require('./lib/fingerprint');
const { createPassword, createUsername } = require('./lib/ice-util');
const sdp = require('./lib/sdp');

const {
  STUN_ATTR_XOR_MAPPED_ADDRESS,
  STUN_ATTR_USERNAME,
  STUN_ATTR_USE_CANDIDATE,
  STUN_ATTR_ICE_CONTROLLING,
  STUN_ATTR_PRIORITY,
  STUN_EVENT_BINDING_REQUEST,
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
 * Create SDP candidate.
 * @param {object} options
 * @param {number} options.foundation
 * @param {number} options.priority
 * @param {number} options.port
 * @param {string} options.ip
 * @param {string} options.transport
 * @param {string} options.type
 * @param {string} options.username
 * @returns {string}
 */
function createCandidate(options = {}) {
  const { foundation, priority, ip, port, transport, type, username } = options;

  return `candidate:${foundation} 1 ${transport} ${priority} ${ip} ${port} typ ${type} generation 0 ufrag ${username}`;
}

/**
 * Ordered collection of WebRTC ICE candidates.
 */
class Candidates {
  /**
   * @constructor
   */
  constructor() {
    this[_candidates] = [];
  }

  /**
   * Add a new candidate.
   * @param {string} address
   * @param {number} port
   * @param {number} priority
   */
  push(address, port, priority) {
    const value = { address, port, priority };
    const filter = (left, right) => (left.priority < right.priority ? 1 : -1);

    sorted.add(this[_candidates], value, filter);
  }

  /**
   * @returns {number}
   */
  get length() {
    return this[_candidates].length;
  }

  /**
   * @returns {string}
   */
  get primaryAddress() {
    if (this[_candidates].length === 0) {
      throw new Error('Empty list of candidates.');
    }

    return this[_candidates][0].address;
  }

  /**
   * @returns {number}
   */
  get primaryPort() {
    if (this[_candidates].length === 0) {
      throw new Error('Empty list of candidates.');
    }

    return this[_candidates][0].port;
  }
}

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
    this.emit('offer', offer);

    this[_offer] = sdp.parse(offer);
    const mid = 'data';
    const { media } = this[_offer];

    if (Array.isArray(media) && media.length > 0) {
      const mediadata = media[0];

      assert(mediadata.protocol === 'DTLS/SCTP', 'Invalid protocol');

      this[_peerIceUsername] = mediadata.iceUfrag;
      this[_peerIcePassword] = mediadata.icePwd;

      this[_peerFingerprint] = mediadata.fingerprint.hash;
      console.log(
        '[nodertc] remote certificate fingerprint (%s) %s',
        mediadata.fingerprint.type,
        mediadata.fingerprint.hash
      );
    } else {
      throw new Error('Invalid SDP');
    }

    await this.listen();

    this[_answer] = sdp.create({
      username: this.username,
      password: this[_icePassword],
      fingerprint: this[_fingerprint],
      mid,
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

    // Start DTLS server when peer ready.
    this.once('candidate', () => this.startDTLS());
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
   * Bind NodeRTC to http transport to exchage SDP.
   * @param {object} router express or any compatible router.
   */
  use(router) {
    router.post('/offer', (req, res) => handleOffer(this, req, res));
    router.post('/candidate', (req, res) => handleCandidate(this, req, res));
    router.get('/candidates/:username', (req, res) =>
      getCandidates(this, req, res)
    );
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

/**
 * Handler for `/offer` url.
 * @param {NodeRTC} nodertc
 * @param {object} req
 * @param {object} res
 */
async function handleOffer(nodertc, req, res) {
  const { type, sdp: offer } = req.body;

  assert.strictEqual(type, 'offer', 'Expected an SDP offer');

  const session = nodertc.createSession();
  const answer = await session.createAnswer(offer);

  res.json({ sdp: answer, type: 'answer' });
}

/**
 * Handler for `POST /candidate` url.
 * @param {NodeRTC} nodertc
 * @param {object} req
 * @param {object} res
 */
function handleCandidate(nodertc, req, res) {
  const { ip, port, username, priority } = req.body;
  console.log('[nodertc] got ice candidate', ip, port, username, priority);

  const session = nodertc[_sessions].find(
    sessionItem => sessionItem[_peerIceUsername] === username
  );

  if (session) {
    console.log('[nodertc] found session for candidate');

    session.appendCandidate(ip, port, priority);
    session.emit('candidate', req.body);
  }

  res.send();
}

/**
 * Handler for `GET /candidates` url.
 * @param {NodeRTC} nodertc
 * @param {object} req
 * @param {object} res
 */
function getCandidates(nodertc, req, res) {
  const { username } = req.params;
  const uname = Buffer.from(username, 'base64').toString('ascii');

  const session = nodertc[_sessions].find(
    sessionItem => sessionItem[_peerIceUsername] === uname
  );

  const internalCandidate = createCandidate({
    foundation: 4235452027,
    component: 1,
    transport: 'udp',
    priority: 2113937151,
    ip: nodertc.internal,
    port: session.port,
    type: 'host',
    username: session.username,
  });

  const externalCandidate = createCandidate({
    foundation: 4235452028,
    component: 1,
    transport: 'udp',
    priority: 1677729535,
    ip: nodertc.external,
    port: session.port,
    type: 'srflx',
    username: session.username,
  });

  console.log(
    '[nodertc] send ice candidate',
    nodertc.internal,
    session.port,
    session.username
  );
  console.log(
    '[nodertc] send ice candidate',
    nodertc.external,
    session.port,
    session.username
  );

  res.json([
    {
      candidate: internalCandidate,
      sdpMLineIndex: 0,
      sdpMid: 'data',
      usernameFragment: session.username,
    },
    {
      candidate: externalCandidate,
      sdpMLineIndex: 0,
      sdpMid: 'data',
      usernameFragment: session.username,
    },
  ]);
}
