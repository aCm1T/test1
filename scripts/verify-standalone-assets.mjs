import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const required = [
  'public/assets/frontline-menu-bg.png',
  'public/assets/dev-wet-asphalt-v1.png',
  'public/assets/development/nightglass-dusk-skyline-v1.png',
  'public/assets/development/original-materials/nightglass-charcoal-ripstop-v1.png',
  'public/assets/development/original-materials/nightglass-urban-ripstop-v2.png',
  'public/assets/development/polyhaven/sunset_jhbcentral_2k.hdr',
  'public/assets/development/polyhaven/asphalt_01_diff_1k.jpg',
  'public/assets/development/polyhaven/asphalt_01_nor_gl_1k.jpg',
  'public/assets/development/polyhaven/asphalt_01_arm_1k.jpg',
  'public/assets/development/polyhaven/concrete_floor_diff_1k.jpg',
  'public/assets/development/polyhaven/concrete_floor_nor_gl_1k.jpg',
  'public/assets/development/polyhaven/concrete_floor_arm_1k.jpg',
  'public/assets/development/polyhaven/yellow_plaster_diff_1k.jpg',
  'public/assets/development/polyhaven/yellow_plaster_nor_gl_1k.jpg',
  'public/assets/development/polyhaven/yellow_plaster_arm_1k.jpg',
  'public/assets/development/cc0-props/Barrel_01_1k.gltf',
  'public/assets/development/cc0-props/Barrel_01.bin',
  'public/assets/ASSET-LICENSES.md',
  'public/assets/manifest.json',
];

const failures = [];
for (const relative of required) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute) || fs.statSync(absolute).size === 0) failures.push(`missing or empty: ${relative}`);
}

const manifestPath = path.join(root, 'public/assets/manifest.json');
if (fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const asset of manifest.assets ?? []) {
    const relative = `public/assets/${String(asset.url).replace(/^\/+/, '')}`;
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) failures.push(`manifest target missing: ${relative}`);
    else if (Number(asset.bytes) !== fs.statSync(absolute).size) failures.push(`manifest byte count is stale: ${relative}`);
    if (!asset.license?.name || !asset.license?.url) failures.push(`manifest license missing: ${asset.id ?? asset.url}`);
  }
}

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
if (/https?:\/\//i.test(html)) failures.push('index.html contains an external runtime URL');

const sourceFiles = walk(path.join(root, 'src')).filter((file) => /\.(ts|css)$/.test(file));
for (const file of sourceFiles) {
  const contents = fs.readFileSync(file, 'utf8');
  if (/(['"`])\/assets\//.test(contents)) {
    failures.push(`deployment-base-unsafe /assets URL: ${path.relative(root, file)}`);
  }
}

if (failures.length) {
  console.error('Standalone asset profile FAILED');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log(`Standalone asset profile passed (${required.length} required files, no external runtime URLs).`);

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
