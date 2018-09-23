'use strict';

const { createHash } = require('crypto');

module.exports = fingerprint;

const upper = s => s.toUpperCase();
const colon = s => s.match(/(.{2})/g).join(':');

/**
 * Create fingerprint of certificate.
 * @param {Buffer} file
 * @param {string} hashname
 * @returns {string}
 */
function fingerprint(file, hashname) {
  const hash = createHash(hashname)
    .update(file)
    .digest('hex');

  return colon(upper(hash));
}
