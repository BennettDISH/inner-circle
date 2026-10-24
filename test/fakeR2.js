// Preloaded into the app under test (node --import ./test/fakeR2.js server.js): a fake S3
// client stands in for R2, so the real upload routes, commands and headers run without a
// bucket. Each object is a JSON file under FAKE_R2_DIR, which the test process reads back.
// Touch FAIL_PUT, FAIL_GET or FAIL_DELETE in that directory to make the matching call fail.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { useClientForTests } from '../config/r2.js';
import { photoBudgetForTests } from '../services/photos.js';

const dir = process.env.FAKE_R2_DIR;
const file = (key) => path.join(dir, `obj-${encodeURIComponent(key)}.json`);
const failing = (what) => fs.existsSync(path.join(dir, `FAIL_${what}`));
const flagged = (name) => fs.existsSync(path.join(dir, name));
const down = () => Object.assign(new Error('fake R2 is down'), { name: 'ServiceUnavailable', $metadata: { httpStatusCode: 503 } });

useClientForTests({
  async send(command, options) {
    const { Bucket, Key, Body, ContentType, CacheControl } = command.input;
    // Every call has a time limit: the app passes an abort signal (calls.jsonl keeps the record)
    const timeLimited = options?.abortSignal instanceof AbortSignal;
    fs.appendFileSync(path.join(dir, 'calls.jsonl'), `${JSON.stringify({ command: command.constructor.name, key: Key, timeLimited })}\n`);
    switch (command.constructor.name) {
      case 'PutObjectCommand':
        if (failing('PUT')) throw down();
        fs.writeFileSync(file(Key), JSON.stringify({
          bucket: Bucket, key: Key, contentType: ContentType, cacheControl: CacheControl,
          body: Buffer.from(Body).toString('base64'),
        }));
        return {};
      case 'GetObjectCommand': {
        if (failing('GET')) throw down();
        if (!fs.existsSync(file(Key))) throw Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
        const o = JSON.parse(fs.readFileSync(file(Key), 'utf8'));
        const bytes = Buffer.from(o.body, 'base64');
        if (flagged('SLOW_GET')) {
          // A bucket that sends the first bytes and then goes quiet. When the app lets go of the
          // stream, it is destroyed, and the marker file says so.
          const stream = new Readable({ read() {} });
          stream.push(bytes);
          stream.on('close', () => fs.writeFileSync(path.join(dir, 'STREAM_CLOSED'), ''));
          return { Body: stream, ContentType: o.contentType, ContentLength: bytes.length + 1_000_000 };
        }
        return { Body: Readable.from([bytes]), ContentType: o.contentType, ContentLength: bytes.length };
      }
      case 'DeleteObjectCommand':
        if (failing('DELETE')) throw down();
        fs.rmSync(file(Key), { force: true });
        return {};
      default:
        throw new Error(`fake R2 does not know ${command.constructor.name}`);
    }
  },
});

if (process.env.FAKE_R2_BUDGET) photoBudgetForTests(Number(process.env.FAKE_R2_BUDGET));
