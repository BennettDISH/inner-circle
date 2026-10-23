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
const down = () => Object.assign(new Error('fake R2 is down'), { name: 'ServiceUnavailable', $metadata: { httpStatusCode: 503 } });

useClientForTests({
  async send(command) {
    const { Bucket, Key, Body, ContentType, CacheControl } = command.input;
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
