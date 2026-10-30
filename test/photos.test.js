// Listing photos on R2: off until every R2 variable is set, then upload (up to four a listing),
// members-only reads, removal and clean-up, against a fake S3 client (test/fakeR2.js) in place
// of the bucket.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startApp, FAKE_BUCKET } from './helpers.js';

const CACHE = 'private, max-age=31536000, immutable';

/** Not decodable pictures, just the bytes the server looks at: the format's magic number, then filler. */
const webp = (size = 64) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), crypto.randomBytes(size)]);
const jpeg = (size = 64) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(size)]);
const png = (size = 64) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(size)]);

/** A circle with an owner and a member, and a listing of the owner's. */
async function setup(app) {
  const owner = await app.user();
  const { circle } = (await owner.as('POST', '/api/circles', { name: 'Family' })).body;
  const member = await app.user();
  assert.equal((await member.as('POST', '/api/circles/join', { join_code: circle.join_code })).status, 200);
  const { listing } = (await owner.as('POST', '/api/listings', { circle_id: circle.id, kind: 'have', title: 'Cordless drill' })).body;
  return { owner, member, circle, listing };
}

describe('photos are off until every R2 variable is set', () => {
  let app;
  before(async () => { app = await startApp(); });
  after(async () => { await app?.stop(); });

  it('says so in the config; the routes answer 503; listings carry an empty photo list', async () => {
    assert.equal((await app.request('GET', '/api/auth/config')).body.photos, false);
    const { owner, listing, circle } = await setup(app);
    assert.equal((await owner.photo(listing.id, webp())).status, 503);
    assert.equal((await owner.getPhoto(listing.id, 1)).status, 503);
    const list = await owner.as('GET', `/api/listings?circle_id=${circle.id}`);
    assert.deepEqual(list.body.listings[0].photos, []);
  });
});

describe('photos stay off with only some of the R2 variables', () => {
  let app;
  before(async () => {
    app = await startApp({ env: { R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'b', R2_SECRET_ACCESS_KEY: 'c' } }); // no R2_BUCKET
  });
  after(async () => { await app?.stop(); });

  it('reports photos off and refuses an upload', async () => {
    assert.equal((await app.request('GET', '/api/auth/config')).body.photos, false);
    const { owner, listing } = await setup(app);
    assert.equal((await owner.photo(listing.id, webp())).status, 503);
  });
});

describe('listing photos', () => {
  let app;
  // 300 kB an account a day: room for a few small photos, and a budget a test can use up
  before(async () => { app = await startApp({ fakeR2: true, photoBudget: 300 * 1000 }); });
  after(async () => { await app?.stop(); });

  it('says photos are on in the config', async () => {
    assert.deepEqual((await app.request('GET', '/api/auth/config')).body, { ssoEnabled: true, photos: true });
  });

  it('stores an upload privately with an immutable cache header, and a member reads it back', async () => {
    const { owner, member, circle, listing } = await setup(app);
    const bytes = webp();
    const up = await owner.photo(listing.id, bytes);
    assert.equal(up.status, 201);
    const photoId = up.body.photo.id;

    const stored = app.r2.objects().find((o) => o.key.startsWith(`circles/${circle.id}/`));
    assert.ok(stored, 'the object is in the bucket, under its circle');
    assert.match(stored.key, /^circles\/\d+\/[0-9a-f]{24}\.webp$/);
    assert.equal(stored.bucket, FAKE_BUCKET);
    assert.equal(stored.contentType, 'image/webp');
    assert.equal(stored.cacheControl, CACHE);
    assert.deepEqual(stored.body, bytes);

    for (const who of [owner, member]) {
      const got = await who.getPhoto(listing.id, photoId);
      assert.equal(got.status, 200);
      assert.deepEqual(got.body, bytes);
      assert.equal(got.headers.get('content-type'), 'image/webp');
      assert.equal(got.headers.get('cache-control'), CACHE);
      assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
    }
    // the listing lists its photos, in the circle view and in mine
    const list = await member.as('GET', `/api/listings?circle_id=${circle.id}`);
    assert.deepEqual(list.body.listings[0].photos, [{ id: photoId }]);
    const mine = await owner.as('GET', '/api/listings/mine');
    assert.deepEqual(mine.body.listings[0].photos, [{ id: photoId }]);
  });

  it('shows a photo to members of the circle only, and needs a sign-in', async () => {
    const { owner, listing } = await setup(app);
    const photoId = (await owner.photo(listing.id, webp())).body.photo.id;
    const outsider = await app.user();
    assert.equal((await outsider.getPhoto(listing.id, photoId)).status, 403);
    assert.equal((await app.request('GET', `/api/listings/${listing.id}/photos/${photoId}`)).status, 401);
    // a member who left the circle can no longer read it, but the owner still can
    const { owner: o2, member, circle, listing: l2 } = await setup(app);
    const id2 = (await o2.photo(l2.id, webp())).body.photo.id;
    assert.equal((await member.getPhoto(l2.id, id2)).status, 200);
    await member.as('DELETE', `/api/circles/${circle.id}/leave`);
    assert.equal((await member.getPhoto(l2.id, id2)).status, 403);
    assert.equal((await o2.getPhoto(l2.id, id2)).status, 200);
  });

  it('lets only the listing owner add or remove photos', async () => {
    const { owner, member, listing } = await setup(app);
    const before = app.r2.keys();
    assert.equal((await member.photo(listing.id, webp())).status, 403);
    assert.deepEqual(app.r2.keys(), before);
    const photoId = (await owner.photo(listing.id, webp())).body.photo.id;
    assert.equal((await member.as('DELETE', `/api/listings/${listing.id}/photos/${photoId}`)).status, 403);
    assert.equal((await owner.photo(999999, webp())).status, 404);
    assert.equal((await owner.photo('abc', webp())).status, 400);
    assert.equal((await owner.as('DELETE', `/api/listings/${listing.id}/photos/999999`)).status, 404);
  });

  it('takes a jpeg or a png as well, by what the bytes are and not by what the client says', async () => {
    const { owner, listing } = await setup(app);
    assert.equal((await owner.photo(listing.id, jpeg(), 'image/png')).status, 201);
    assert.equal((await owner.photo(listing.id, png(), 'image/jpeg')).status, 201);
    const types = app.r2.objects().filter((o) => /\.(jpg|png)$/.test(o.key)).map((o) => [o.key.split('.').pop(), o.contentType]);
    assert.ok(types.some(([e, t]) => e === 'jpg' && t === 'image/jpeg'));
    assert.ok(types.some(([e, t]) => e === 'png' && t === 'image/png'));
  });

  it('refuses what is not a jpeg, png or webp, and an empty body', async () => {
    const { owner, listing } = await setup(app);
    const before = app.r2.keys();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const gif = Buffer.concat([Buffer.from('GIF89a'), crypto.randomBytes(40)]);
    for (const [bytes, type] of [[svg, 'image/svg+xml'], [gif, 'image/gif'], [Buffer.from('hello'), 'image/webp'], [Buffer.alloc(0), 'image/webp']]) {
      assert.equal((await owner.photo(listing.id, bytes, type)).status, 400, type);
    }
    // not an image content type at all
    assert.equal((await owner.as('POST', `/api/listings/${listing.id}/photos`, { title: 'x' })).status, 400);
    assert.deepEqual(app.r2.keys(), before);
  });

  it('caps one upload at 2 MB', async () => {
    const { owner, listing } = await setup(app);
    const res = await owner.photo(listing.id, webp(2 * 1024 * 1024 + 10));
    assert.equal(res.status, 413);
    assert.match(res.body.error, /2 MB/);
    assert.equal(app.r2.objects().filter((o) => o.body.length > 2 * 1024 * 1024).length, 0);
  });

  it('allows four photos a listing; the fifth is refused and stores nothing', async () => {
    const { owner, listing, circle } = await setup(app);
    for (let i = 0; i < 4; i++) assert.equal((await owner.photo(listing.id, webp())).status, 201);
    const before = app.r2.keys();
    const fifth = await owner.photo(listing.id, webp());
    assert.equal(fifth.status, 409);
    assert.match(fifth.body.error, /4 photos/);
    assert.deepEqual(app.r2.keys(), before);
    const list = await owner.as('GET', `/api/listings?circle_id=${circle.id}`);
    assert.equal(list.body.listings[0].photos.length, 4);
    // room again once one is removed
    const first = list.body.listings[0].photos[0].id;
    assert.equal((await owner.as('DELETE', `/api/listings/${listing.id}/photos/${first}`)).status, 200);
    assert.equal((await owner.photo(listing.id, webp())).status, 201);
  });

  it('keeps four even when uploads race for the last place', async () => {
    const { owner, listing } = await setup(app);
    for (let i = 0; i < 3; i++) assert.equal((await owner.photo(listing.id, webp())).status, 201);
    const results = await Promise.all(Array.from({ length: 3 }, () => owner.photo(listing.id, webp())));
    assert.ok(results.every((r) => r.status === 201 || r.status === 409), results.map((r) => `${r.status} ${JSON.stringify(r.body)}`).join('\n'));
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    const rows = (await app.db.query('SELECT object_key FROM listing_photos WHERE listing_id = $1', [listing.id])).rows;
    assert.equal(rows.length, 4);
    // the three that lost left nothing behind in the bucket
    const circleKeys = app.r2.keys().filter((k) => k.startsWith(`circles/${listing.circle_id}/`));
    assert.deepEqual(circleKeys, rows.map((r) => r.object_key).sort());
  });

  it('removes the object when a photo is removed', async () => {
    const { owner, listing } = await setup(app);
    const photoId = (await owner.photo(listing.id, webp())).body.photo.id;
    const key = (await app.db.query('SELECT object_key FROM listing_photos WHERE id = $1', [photoId])).rows[0].object_key;
    assert.ok(app.r2.keys().includes(key));
    assert.equal((await owner.as('DELETE', `/api/listings/${listing.id}/photos/${photoId}`)).status, 200);
    assert.ok(!app.r2.keys().includes(key));
    assert.equal((await owner.getPhoto(listing.id, photoId)).status, 404);
  });

  it('removes every photo\'s object when the listing is deleted', async () => {
    const { owner, listing } = await setup(app);
    for (let i = 0; i < 3; i++) await owner.photo(listing.id, webp());
    const keys = (await app.db.query('SELECT object_key FROM listing_photos WHERE listing_id = $1', [listing.id])).rows.map((r) => r.object_key);
    assert.equal(keys.length, 3);
    assert.ok(keys.every((k) => app.r2.keys().includes(k)));
    assert.equal((await owner.as('DELETE', `/api/listings/${listing.id}`)).status, 200);
    assert.ok(keys.every((k) => !app.r2.keys().includes(k)));
    assert.equal((await app.db.query('SELECT 1 FROM listing_photos WHERE listing_id = $1', [listing.id])).rows.length, 0);
  });

  it('limits an account to its daily budget, and gives back what was not stored', async () => {
    const { owner, listing } = await setup(app);
    assert.equal((await owner.photo(listing.id, webp(140 * 1000))).status, 201);
    assert.equal((await owner.photo(listing.id, webp(140 * 1000))).status, 201);
    const over = await owner.photo(listing.id, webp(40 * 1000));
    assert.equal(over.status, 429);
    assert.ok(Number(over.headers.get('retry-after')) > 0);
    assert.match(over.body.error, /a day/);

    // a storage failure stores nothing and costs the day nothing
    const { owner: v, listing: vl } = await setup(app);
    app.r2.fail('put');
    const before = app.r2.keys();
    for (let i = 0; i < 5; i++) assert.equal((await v.photo(vl.id, webp(140 * 1000))).status, 500);
    app.r2.fail('put', false);
    assert.deepEqual(app.r2.keys(), before);
    assert.equal((await v.photo(vl.id, webp(140 * 1000))).status, 201);
  });

  it('answers 502 when the bucket cannot be read, and 404 when the object is gone', async () => {
    const { owner, listing } = await setup(app);
    const photoId = (await owner.photo(listing.id, webp())).body.photo.id;
    app.r2.fail('get');
    assert.equal((await owner.getPhoto(listing.id, photoId)).status, 502);
    app.r2.fail('get', false);
    const key = (await app.db.query('SELECT object_key FROM listing_photos WHERE id = $1', [photoId])).rows[0].object_key;
    app.r2.remove(key);
    assert.equal((await owner.getPhoto(listing.id, photoId)).status, 404);
  });

  it('still deletes a listing when its photos cannot be deleted from the bucket', async () => {
    const { owner, listing } = await setup(app);
    await owner.photo(listing.id, webp());
    app.r2.fail('delete');
    const res = await owner.as('DELETE', `/api/listings/${listing.id}`);
    app.r2.fail('delete', false);
    assert.equal(res.status, 200);
    assert.equal((await owner.as('GET', '/api/listings/mine')).body.listings.some((l) => l.id === listing.id), false);
  });

  it('keeps a listing\'s photos when it is deactivated', async () => {
    const { owner, listing } = await setup(app);
    const photoId = (await owner.photo(listing.id, webp())).body.photo.id;
    await owner.as('PUT', `/api/listings/${listing.id}`, { active: false });
    const mine = await owner.as('GET', '/api/listings/mine');
    assert.deepEqual(mine.body.listings.find((l) => l.id === listing.id).photos, [{ id: photoId }]);
  });

  it('shows a hidden listing\'s photos to its owner only, and to members again once it is back', async () => {
    const { owner, member, listing } = await setup(app);
    const photoId = (await owner.photo(listing.id, webp())).body.photo.id;
    assert.equal((await owner.as('PUT', `/api/listings/${listing.id}`, { active: false })).status, 200);
    assert.equal((await member.getPhoto(listing.id, photoId)).status, 404);
    assert.equal((await owner.getPhoto(listing.id, photoId)).status, 200);
    assert.equal((await owner.as('PUT', `/api/listings/${listing.id}`, { active: true })).status, 200);
    assert.equal((await member.getPhoto(listing.id, photoId)).status, 200);
  });

  it('shows a listing\'s photos only to its owner once the owner left the circle, and to members again on rejoining', async () => {
    const { owner, member, circle, listing } = await setup(app);
    const photoId = (await owner.photo(listing.id, webp())).body.photo.id;
    assert.equal((await owner.as('DELETE', `/api/circles/${circle.id}/leave`)).status, 200);
    assert.equal((await member.getPhoto(listing.id, photoId)).status, 404);
    assert.equal((await owner.getPhoto(listing.id, photoId)).status, 200);
    assert.equal((await owner.as('POST', '/api/circles/join', { join_code: circle.join_code })).status, 200);
    assert.equal((await member.getPhoto(listing.id, photoId)).status, 200);
  });
});
