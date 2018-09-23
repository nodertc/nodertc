'use strict';

/* eslint-env browser */

const pcconfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  iceCandidatePoolSize: 0xff,
};

const ICECANDIDATE_REGEXP = /^candidate:(?<foundation>[\w\d]+) (?<component>[\w\d]+) (?<protocol>\w+) (?<priority>\d+) (?<ip>[\d.:]+) (?<port>\d+) typ (?<type>\w+)/;

const ICEUFRAG_REGEXP = /ufrag (?<username>[\w+\/]+)/i;

const pc = new RTCPeerConnection(pcconfig);

pc.addEventListener('icecandidate', async ({ candidate }) => {
  if (!candidate) {
    return;
  }

  const parsed = candidate.candidate.match(ICECANDIDATE_REGEXP);
  const unameParsed = candidate.candidate.match(ICEUFRAG_REGEXP);

  console.group('candidate');
  console.log(candidate.candidate);
  console.groupEnd('candidate');

  const { ip, port, protocol, type, priority } = parsed.groups;

  if (protocol.toLowerCase() !== 'udp') {
    return;
  }

  await fetch('/candidate', {
    method: 'post',
    body: JSON.stringify({
      ip,
      port: Number(port),
      protocol,
      type,
      username: unameParsed && unameParsed.groups.username,
      priority: Number(priority),
    }),
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
    },
  });
});

pc.addEventListener('negotiationneeded', async () => {
  const offer = await pc.createOffer({
    iceRestart: true,
  });
  await pc.setLocalDescription(offer);
  console.log('[pc] send offer\n', offer.sdp);

  const answer = await sendOffer(offer);
  console.log('[pc] got answer\n', answer.sdp);

  await pc.setRemoteDescription(answer);

  const { username } = offer.sdp.match(/a=ice-ufrag:(?<username>[^\s]+)/).groups;
  const candidates = await getCandidates(username);

  await Promise.all(candidates.map(candidate => pc.addIceCandidate(candidate)));
  console.log('[pc] got ICE candidates\n', ...candidates);
});

pc.addEventListener('datachannel', ({ channel }) => {
  console.log('got channel', channel);

  channel.addEventListener('open', () => {
    console.log('[dc] channel is ready', channel);

    channel.send(`Hello, world!`);
  });

  channel.addEventListener('close', () => {
    console.log('[dc] channel is closed');
  });

  channel.addEventListener('message', ({ data }) => {
    console.log('got message: %s', data.toString());
  });
});

const channel = pc.createDataChannel('console');

channel.addEventListener('open', () => {
  console.log('[dc] channel is ready', channel);

  channel.send(`Hello, world!`);
});

channel.addEventListener('close', () => {
  console.log('[dc] channel is closed');
});

channel.addEventListener('message', ({ data }) => {
  console.log('[dc] got message: %s', data.toString());
});

/**
 * Send offer.
 * @param {{ sdp: string, type: string }} offer
 * @returns {{ sdp: string, type: string }}
 */
async function sendOffer(offer) {
  const res = await fetch('/offer', {
    method: 'post',
    body: JSON.stringify(offer),
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
    },
  });

  return res.json();
}

/**
 * Get candidates to connect.
 * @returns {object[]}
 */
async function getCandidates(username) {
  const res2 = await fetch(`/candidates/${btoa(username)}`, {
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
    },
  });

  return res2.json();
}
