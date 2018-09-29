'use strict';

/* eslint-env browser */

const pcconfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  iceCandidatePoolSize: 0xff,
};

const pc = new RTCPeerConnection(pcconfig);

pc.addEventListener('icecandidate', async ({ candidate }) => {
  if (candidate) {
    return;
  }

  const offer = pc.localDescription;
  console.log('[pc] send offer\n', offer.sdp);
  const answer = await sendOffer(offer);
  console.log('[pc] got answer\n', answer.sdp);
  await pc.setRemoteDescription(answer);
});

pc.addEventListener('negotiationneeded', async () => {
  const offer = await pc.createOffer({
    iceRestart: true,
  });
  await pc.setLocalDescription(offer);
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
