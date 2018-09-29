'use strict';

const sorted = require('sorted-array-functions');

const _candidates = Symbol('candidates');

/**
 * Ordered collection of WebRTC ICE candidates.
 */
module.exports = class Candidates {
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
};
