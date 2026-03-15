import fs from 'node:fs/promises';
import { statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function validateImageFile(path, label) {
  const size = statSync(path).size;
  if (size < 15 * 1024) {
    throw new Error(`${label} image too small (${size} bytes)`);
  }

  const python = `
from PIL import Image, ImageStat
img = Image.open('${path}').convert('RGB')
width, height = img.size
if width < 400 or height < 300:
    raise SystemExit('INVALID_DIMENSIONS')
stat = ImageStat.Stat(img)
mean = sum(stat.mean) / 3
std = sum(stat.stddev) / 3
if mean < 8:
    raise SystemExit('TOO_DARK')
if std < 6:
    raise SystemExit('TOO_FLAT')
print(f"{width}x{height} mean={mean:.2f} std={std:.2f}")
`.trim();

  const { stdout, stderr } = await execFileAsync('python3', ['-c', python]);
  const out = String(stdout || '').trim();
  const err = String(stderr || '').trim();
  if (err.includes('INVALID_DIMENSIONS') || err.includes('TOO_DARK') || err.includes('TOO_FLAT')) {
    throw new Error(`${label} validation failed: ${err}`);
  }
  if (out) console.log(`${label} validation: ${out}`);
}

async function main() {
  const sourceImageUrl = process.env.SOURCE_IMAGE_URL;
  const titleText = String(process.env.TITLE_TEXT || '').toUpperCase().trim();
  const catboxHash = process.env.CATBOX_HASH;

  if (!sourceImageUrl || !titleText || !catboxHash) {
    throw new Error('Missing SOURCE_IMAGE_URL, TITLE_TEXT, or CATBOX_HASH');
  }

  const sourcePath = 'source-image';
  const gradientPath = 'gradient-overlay.png';
  const titleCardPath = 'title-card.png';
  const outputPath = 'final-overlay.png';

  await execFileAsync('curl', ['-fsSL', sourceImageUrl, '-o', sourcePath], { maxBuffer: 20 * 1024 * 1024 });
  await validateImageFile(sourcePath, 'source');

  await execFileAsync('convert', [
    '-size', '1600x900',
    'gradient:rgba(0,0,0,0.05)-rgba(0,0,0,0.75)',
    gradientPath,
  ], { maxBuffer: 20 * 1024 * 1024 });

  await execFileAsync('convert', [
    '-background', 'none',
    '-fill', 'white',
    '-font', 'DejaVu-Sans-Bold',
    '-pointsize', '74',
    '-size', '1440x260',
    'caption:' + titleText,
    '-gravity', 'center',
    '-stroke', 'black',
    '-strokewidth', '3',
    titleCardPath,
  ], { maxBuffer: 20 * 1024 * 1024 });

  await execFileAsync('convert', [
    sourcePath,
    '-resize', '1600x900^',
    '-gravity', 'center',
    '-extent', '1600x900',
    gradientPath,
    '-compose', 'over',
    '-composite',
    titleCardPath,
    '-gravity', 'south',
    '-geometry', '+0+36',
    '-compose', 'over',
    '-composite',
    '-colorspace', 'sRGB',
    '-alpha', 'remove',
    '-alpha', 'off',
    outputPath,
  ], { maxBuffer: 20 * 1024 * 1024 });

  await validateImageFile(outputPath, 'final');

  const { stdout } = await execFileAsync('curl', [
    '-sS',
    '-F', 'reqtype=fileupload',
    '-F', `userhash=${catboxHash}`,
    '-F', `fileToUpload=@${outputPath}`,
    'https://catbox.moe/user/api.php',
  ], { maxBuffer: 20 * 1024 * 1024 });

  const finalImageUrl = String(stdout || '').trim();
  if (!/^https?:\/\//.test(finalImageUrl)) {
    throw new Error(`Catbox upload failed: ${finalImageUrl || 'empty response'}`);
  }

  await fs.writeFile('result.json', JSON.stringify({ finalImageUrl }, null, 2), 'utf8');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
