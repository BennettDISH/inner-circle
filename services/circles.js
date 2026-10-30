import { randomInt } from 'node:crypto';

// circles.name and listings.title are VARCHAR(255). A longer one made Postgres fail the insert
// (a raw error on circles, a 500 on listings), so the routes check first. Postgres counts
// characters, not UTF-16 units, so an emoji counts once; and it cannot store a NUL character.
export const NAME_MAX = 255;

/** Why `value` can't be a name or title, or null. Callers have already dealt with "missing". */
export function nameError(value, label) {
  if (typeof value !== 'string') return `${label} must be text`;
  if ([...value].length > NAME_MAX) return `${label} must be ${NAME_MAX} characters or fewer`;
  if (value.includes('\0')) return `${label} has a character that can't be saved`;
  return null;
}

/** Why `value` can't go in a TEXT column (a description, a message), or null. Missing is fine. */
export function textError(value, label) {
  if (value == null) return null;
  if (typeof value !== 'string') return `${label} must be text`;
  if (value.includes('\0')) return `${label} has a character that can't be saved`;
  return null;
}

// Whether a listing's owner is still a member of its circle (SQL; `l` is the listing). A listing
// shows in its circle only while this holds. It is read from the membership rather than stored,
// so however a membership ends the listing is hidden, and rejoining brings it back as it was.
export const OWNER_IN_CIRCLE = `EXISTS (SELECT 1 FROM circle_members om
                                        WHERE om.circle_id = l.circle_id AND om.central_user_id = l.central_user_id)`;

// Six characters of 0-9 and A-Z, each drawn with crypto.randomInt: the wrong-code limit only
// holds if the next code can't be guessed from the last one.
const CODE_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export function generateJoinCode(pick = randomInt) {
  let code = '';
  for (let i = 0; i < 6; i++) code += CODE_CHARS[pick(CODE_CHARS.length)];
  return code;
}

const JOIN_CODE_KEY = 'circles_join_code_key';

/** Insert a circle on `client` (inside the caller's transaction) with a fresh join code. When
 *  the code is already taken, try one more code; a second clash is an error like any other.
 *  The savepoint keeps the failed insert from aborting the caller's transaction. */
export async function insertCircle(client, { name, description, createdBy }, makeCode = generateJoinCode) {
  for (let attempt = 0; ; attempt++) {
    await client.query('SAVEPOINT join_code');
    try {
      const { rows } = await client.query(
        `INSERT INTO circles (name, description, join_code, created_by)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [name, description, makeCode(), createdBy]
      );
      await client.query('RELEASE SAVEPOINT join_code');
      return rows[0];
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT join_code');
      if (attempt === 0 && err.code === '23505' && err.constraint === JOIN_CODE_KEY) continue;
      throw err;
    }
  }
}
