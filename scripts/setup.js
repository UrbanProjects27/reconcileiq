const { createInterface } = require('node:readline/promises');
const { Writable } = require('node:stream');
const { openDatabase } = require('../lib/database');
const { createUser } = require('../lib/auth');

async function main() {
  const db = await openDatabase();
  try {
    const [row] = await db.query('SELECT COUNT(*) AS count FROM app_users');
    if (Number(row.count)) { console.log('An account already exists. Sign in and manage team access under Settings.'); return; }
    let email = process.env.ADMIN_EMAIL;
    let password = process.env.ADMIN_PASSWORD;
    let name = process.env.ADMIN_NAME || 'Workspace Admin';
    if (!email || !password) {
      if (!process.stdin.isTTY) throw new Error('Interactive setup requires a terminal. Alternatively provide ADMIN_EMAIL and ADMIN_PASSWORD through your environment.');
      let muted = false;
      const output = new Writable({write(chunk, encoding, callback) { if (!muted) process.stdout.write(chunk); callback(); }});
      const prompt = createInterface({input:process.stdin,output,terminal:true});
      try {
        email = await prompt.question('Administrator email: ');
        name = await prompt.question('Administrator name: ') || name;
        const pending = prompt.question('Password (12–128 characters, hidden): ');
        muted = true; password = await pending; muted = false; process.stdout.write('\n');
      } finally { muted = false; prompt.close(); }
    }
    await createUser(db,{email,name,password,role:'admin',mustChange:false});
    console.log('Administrator created. Run npm start and sign in at http://127.0.0.1:4173.');
  } finally { await db.close(); }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
