import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function escapeXml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function main() {
  const sourceImageUrl = process.env.SOURCE_IMAGE_URL;
  const titleText = String(process.env.TITLE_TEXT || '').toUpperCase();
  const catboxHash = process.env.CATBOX_HASH;

  if (!sourceImageUrl || !titleText || !catboxHash) {
    throw new Error('Missing SOURCE_IMAGE_URL, TITLE_TEXT, or CATBOX_HASH');
  }

  const sourcePath = 'source.png';
  const overlaySvgPath = 'overlay.svg';
  const outputPath = 'final-overlay.png';

  await execFileAsync('curl', ['-fsSL', sourceImageUrl, '-o', sourcePath], { maxBuffer: 20 * 1024 * 1024 });

  const overlaySvg = `
<svg width="1600" height="900" viewBox="0 0 1600 900" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="rgba(0,0,0,0.15)"/>
      <stop offset="100%" stop-color="rgba(0,0,0,0.75)"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="1600" height="900" fill="url(#g)"/>
  <foreignObject x="80" y="560" width="1440" height="280">
    <div xmlns="http://www.w3.org/1999/xhtml" style="font-family:Arial, Helvetica, sans-serif; color:#ffffff; font-weight:900; font-size:66px; line-height:1.08; letter-spacing:1px; text-transform:uppercase; text-align:center; text-shadow:0 4px 14px rgba(0,0,0,0.95);">${escapeXml(titleText)}</div>
  </foreignObject>
</svg>`.trim();

  await fs.writeFile(overlaySvgPath, overlaySvg, 'utf8');

  await execFileAsync('convert', [sourcePath, '-resize', '1600x900^', '-gravity', 'center', '-extent', '1600x900', overlaySvgPath, '-composite', outputPath], { maxBuffer: 20 * 1024 * 1024 });

  const { stdout } = await execFileAsync('curl', [
    '-sS',
    '-F', 'reqtype=fileupload',
    '-F', `userhash=${catboxHash}`,
    '-F', `fileToUpload=@${outputPath}`,
    'https://catbox.moe/user/api.php'
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
