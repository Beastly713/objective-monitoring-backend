import { WebSocketServer } from 'ws';

const PORT = 8080;
const PATH = '/objective';

const wss = new WebSocketServer({
  port: PORT,
  host: '0.0.0.0',
  perMessageDeflate: false,
});

let totalPackets = 0;
let invalidPackets = 0;
let totalSequenceGaps = 0;

let windowPackets = 0;
let windowBytes = 0;

let lastPacket = null;

const lastSeqBySession = new Map();

function validatePacket(p) {
  if (!p || p.schema !== 1) return false;
  if (typeof p.session_id !== 'string') return false;
  if (!Number.isInteger(p.seq)) return false;

  if (!Array.isArray(p.n) || p.n.length !== 5) return false;

  if (!Array.isArray(p.ecg)) return false;
  if (!Array.isArray(p.ppg)) return false;
  if (!Array.isArray(p.gsr)) return false;
  if (!Array.isArray(p.imu)) return false;
  if (!Array.isArray(p.temp)) return false;

  if (
    p.n[0] !== p.ecg.length ||
    p.n[1] !== p.ppg.length ||
    p.n[2] !== p.gsr.length ||
    p.n[3] !== p.imu.length ||
    p.n[4] !== p.temp.length
  ) {
    return false;
  }

  if (
    typeof p.created_us !== 'number' ||
    typeof p.t0_us !== 'number' ||
    typeof p.t1_us !== 'number'
  ) {
    return false;
  }

  if (!(p.t0_us <= p.t1_us && p.t1_us <= p.created_us)) {
    return false;
  }

  if ((p.t1_us - p.t0_us) > 150000) {
    return false;
  }

  return true;
}

wss.on('connection', (ws, req) => {
  const remote = req.socket.remoteAddress;

  console.log(`CONNECTED ${remote} path=${req.url}`);

  if (req.url !== PATH) {
    ws.close(1008, 'wrong path');
    return;
  }

  ws.on('error', (err) => {
    console.error('WS ERROR:', err.message);
  });

  ws.on('close', (code, reason) => {
    console.log(
      `DISCONNECTED ${remote} code=${code} reason=${reason.toString()}`
    );
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      invalidPackets++;
      console.error('Unexpected binary WebSocket frame');
      return;
    }

    const text = data.toString();
    const bytes = Buffer.byteLength(text);

    let packet;

    try {
      packet = JSON.parse(text);
    } catch {
      invalidPackets++;
      console.error('Invalid JSON packet');
      return;
    }

    if (!validatePacket(packet)) {
      invalidPackets++;
      console.error(`Invalid packet seq=${packet?.seq ?? '?'}`);
      return;
    }

    const session = packet.session_id;
    const seq = packet.seq >>> 0;

    const previous = lastSeqBySession.get(session);

    if (previous !== undefined) {
      const expected = (previous + 1) >>> 0;

      if (seq !== expected) {
        if (seq > expected) {
          const gap = seq - expected;

          totalSequenceGaps += gap;

          console.error(
            `SEQUENCE GAP session=${session} expected=${expected} got=${seq} gap=${gap}`
          );
        } else {
          console.error(
            `NON-FORWARD SEQUENCE session=${session} expected=${expected} got=${seq}`
          );
        }
      }
    }

    lastSeqBySession.set(session, seq);

    totalPackets++;
    windowPackets++;
    windowBytes += bytes;

    lastPacket = packet;

    // ACK only after the packet has been parsed and validated.
    if (ws.readyState === 1) {
      ws.send(`ACK:${seq}`);
    }
  });
});

setInterval(() => {
  const clients = wss.clients.size;

  if (!lastPacket) {
    console.log(
      `RX 0/s | CLIENTS:${clients} | waiting on ws://0.0.0.0:${PORT}${PATH}`
    );
    return;
  }

  const span = lastPacket.t1_us - lastPacket.t0_us;

  console.log(
    `RX ${windowPackets}/s | ` +
    `TOTAL:${totalPackets} | ` +
    `BYTES:${windowBytes}/s | ` +
    `CLIENTS:${clients} | ` +
    `LAST_SEQ:${lastPacket.seq} | ` +
    `N:${JSON.stringify(lastPacket.n)} | ` +
    `SPAN:${span}us | ` +
    `GAPS:${totalSequenceGaps} | ` +
    `INVALID:${invalidPackets}`
  );

  windowPackets = 0;
  windowBytes = 0;
}, 1000);

console.log(
  `WebSocket receiver V2 listening on ws://0.0.0.0:${PORT}${PATH}`
);
