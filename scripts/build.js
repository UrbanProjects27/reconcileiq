const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const destination = path.join(root, 'dist');
fs.mkdirSync(destination, {recursive:true});
const files = ['index.html','app.js','auth.js','finance.js','styles.css','overrides.css'];
// Publish only the frontend allowlist. Never publish the repository root.
for (const entry of fs.readdirSync(destination, {withFileTypes:true})) {
  if (entry.isFile() && !files.includes(entry.name)) fs.unlinkSync(path.join(destination,entry.name));
  if (entry.isDirectory()) throw new Error('Unexpected directory in dist; inspect it before publishing.');
}
for (const file of files) fs.copyFileSync(path.join(root,file),path.join(destination,file));
console.log(`Prepared ${files.length} public assets. Backend code and secrets are excluded.`);
