import http from 'node:http';
import { WebSocketServer } from 'ws';

export class DisplayFixtureServer {
  constructor(options = {}) {
    this.generation = options.initialGeneration ?? 1;
    this.replayActions = options.replayActions ?? [];
    this.reports = [];
    this.retiredReports = [];
    this.acksSent = 0;
    // Every text frame the browser sent, in order; binary frames appear as
    // { binary: <byteLength> }.
    this.frames = [];
    this.clients = new Set();
    this.httpServer = null;
    this.wss = null;
    this.port = 0;
  }

  async start() {
    return new Promise((resolve) => {
      this.httpServer = http.createServer((req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        if (req.method === 'POST' && url.pathname === '/display') {
          let body = '';
          req.on('data', chunk => body += chunk);
          req.on('end', () => {
            const data = JSON.parse(body);
            this.broadcast({ type: 'display', action: data.action });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          });
          return;
        }

        if (req.method === 'POST' && url.pathname === '/view') {
          let body = '';
          req.on('data', chunk => body += chunk);
          req.on('end', () => {
            const data = JSON.parse(body);
            this.broadcast({ type: 'view', target: data.view });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          });
          return;
        }

        if (req.method === 'GET' && url.pathname === '/screen-state') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            lastReport: this.reports[this.reports.length - 1] ?? null,
            reports: this.reports,
            retiredReports: this.retiredReports,
            acksSent: this.acksSent,
          }));
          return;
        }

        res.writeHead(404);
        res.end();
      });

      this.wss = new WebSocketServer({ server: this.httpServer, path: '/ws' });

      this.wss.on('connection', (ws) => {
        this.clients.add(ws);

        ws.on('message', (data, isBinary) => {
          if (isBinary) {
            this.frames.push({ binary: data.length });
            return;
          }
          try {
            const msg = JSON.parse(data.toString());
            this.frames.push(msg);
            if (msg.type === 'hello') {
              ws.send(JSON.stringify({
                type: 'hello_ack',
                version: 1,
                stt_streaming: true,
                mse_mp3: false,
              }));
              ws.send(JSON.stringify({
                type: 'epoch',
                generation: this.generation,
              }));
              ws.send(JSON.stringify({
                type: 'status',
                route: 'operator',
                routes: [{ value: 'operator', label: 'Operator' }],
                model: 'gpt-5',
                models: [{ value: 'gpt-5', label: 'gpt-5' }],
                thinking: 'high',
                thinking_levels: [{ value: 'high', label: 'High' }],
              }));

              // Send replay display actions
              for (const action of this.replayActions) {
                ws.send(JSON.stringify({
                  type: 'display',
                  action,
                }));
              }
            } else if (msg.type === 'ping') {
              ws.send(JSON.stringify({ type: 'pong', nonce: msg.nonce, time: msg.time }));
            } else if (msg.type === 'clip') {
              ws.send(JSON.stringify({ type: 'accepted', id: msg.id, streaming: false }));
            } else if (msg.type === 'typed_turn') {
              // As route_final_transcript in apps/backend/src/api.rs: a typed
              // turn under the current epoch is taken and echoed back as the
              // caller's transcript line with the same id; a stale one is not.
              if (msg.generation === this.generation) {
                ws.send(JSON.stringify({ type: 'transcript', id: msg.id, text: msg.text }));
              }
            } else if (msg.type === 'screen_state') {
              if (msg.generation === this.generation) {
                this.reports.push(msg);
                this.acksSent++;
                ws.send(JSON.stringify({ type: 'screen_state_ack' }));
              } else {
                // Ignore / reject retired report generations
                this.retiredReports.push(msg);
              }
            }
          } catch (e) {
            // Ignore malformed messages
          }
        });

        ws.on('close', () => {
          this.clients.delete(ws);
        });
      });

      this.httpServer.listen(0, '127.0.0.1', () => {
        this.port = this.httpServer.address().port;
        resolve({
          port: this.port,
          wsUrl: `ws://127.0.0.1:${this.port}/ws`,
          httpUrl: `http://127.0.0.1:${this.port}`,
        });
      });
    });
  }

  broadcast(message) {
    const payload = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === 1) { // OPEN
        client.send(payload);
      }
    }
  }

  setGeneration(gen) {
    this.generation = gen;
    this.broadcast({ type: 'epoch', generation: gen });
  }

  async stop() {
    return new Promise((resolve) => {
      for (const client of this.clients) {
        try { client.close(); } catch {}
      }
      this.clients.clear();
      if (this.wss) {
        this.wss.close(() => {
          if (this.httpServer) {
            this.httpServer.close(() => resolve());
          } else {
            resolve();
          }
        });
      } else if (this.httpServer) {
        this.httpServer.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}
