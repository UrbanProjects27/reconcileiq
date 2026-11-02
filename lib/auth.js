const { randomBytes, scrypt, timingSafeEqual, createHash, randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const derive = promisify(scrypt);
const digest = value => createHash('sha256').update(value).digest('hex');
const publicUser = row => ({ id: row.id, email: row.email, name: row.name, role: row.role, active: !!row.active, mustChange: !!row.must_change });
function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    const error = new Error('Use a password of 12 to 128 characters.'); error.status = 400; throw error;
  }
}
async function hashPassword(password) {
  validatePassword(password);
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${(await derive(password, salt, 64)).toString('hex')}`;
}
async function verifyPassword(password, encoded) {
  const [, salt, expected] = encoded.split(':');
  if (typeof password !== 'string' || password.length > 128) return false;
  const actual = await derive(password, salt, 64);
  const buffer = Buffer.from(expected, 'hex');
  return buffer.length === actual.length && timingSafeEqual(buffer, actual);
}
async function createUser(db, { email, name, password, role = 'viewer', mustChange = true }) {
  email = String(email || '').trim().toLowerCase(); name = String(name || '').trim();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) || email.length > 254 || !name || name.length > 100 || /[<>\x00-\x1f]/.test(name) || !['admin','editor','viewer'].includes(role)) {
    const error = new Error('Provide a valid name, email and role.'); error.status = 400; throw error;
  }
  const user = { id: randomUUID(), email, name, role };
  const passwordHash = await hashPassword(password);
  try {
    await db.query('INSERT INTO app_users(id,email,name,role,password_hash,active,must_change,created_at) VALUES($1,$2,$3,$4,$5,1,$6,$7)', [user.id,email,name,role,passwordHash,mustChange ? 1 : 0,new Date().toISOString()]);
  } catch (error) {
    if (/unique|duplicate/i.test(error.message)) { error.status = 409; error.message = 'An account with that email already exists.'; }
    throw error;
  }
  return { ...user, active: true, mustChange };
}
module.exports = { digest, publicUser, hashPassword, verifyPassword, validatePassword, createUser };
