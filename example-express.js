'use strict';

const assert = require('assert');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const morgan = require('morgan');
const nodertc = require('.');

const rtc = nodertc({
  certificate: fs.readFileSync(path.resolve('fixtures/certificate.pem')),
  certificatePrivateKey: fs.readFileSync(path.resolve('fixtures/private.pem')),
});
const app = express();

app.use(bodyParser.json());
app.use(express.static('fixtures'));
app.use(morgan('dev'));

app.post('/offer', async (req, res) => {
  const { type, sdp: offer } = req.body;

  assert.strictEqual(type, 'offer', 'Expected an SDP offer');

  const session = rtc.createSession();
  const answer = await session.createAnswer(offer);

  res.json({ sdp: answer, type: 'answer' });
});

rtc.on('session', session => {
  console.log('[nodertc] got new session');

  session.on('offer', () => {
    console.log('[nodertc] got offer');
  });

  session.once('channel', channel => {
    console.log('[nodertc] got channel %s', channel.label);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.on('line', line => {
      channel.write(line);
    });

    channel.on('data', data => {
      console.log(`${data.toString()}`);

      rl.prompt();
    });
  });
});

app.get('/', (req, res) => {
  res.sendFile('fixtures/index.html', { root: __dirname });
});

app.listen(7007, async () => {
  console.log('[http] server started at localhost:7007');

  await rtc.start();
  console.log('[nodertc] started');
});
