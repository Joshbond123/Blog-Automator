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

async function renderOverlayWithPython(sourcePath, outputPath) {
  const python = `
import os
from PIL import Image, ImageDraw, ImageFont

source_path = os.environ['SOURCE_PATH']
output_path = os.environ['OUTPUT_PATH']
title = (os.environ.get('TITLE_TEXT', '') or '').strip().upper()
if not title:
    raise SystemExit('MISSING_TITLE')

img = Image.open(source_path).convert('RGB')
w, h = img.size
base = img.convert('RGBA')
layer = Image.new('RGBA', (w, h), (0, 0, 0, 0))
draw = ImageDraw.Draw(layer)

# Bottom gradient for readability (keeps original dimensions)
grad_h = max(int(h * 0.46), 220)
grad_top = h - grad_h
for y in range(grad_top, h):
    t = (y - grad_top) / max(1, grad_h - 1)
    alpha = int(8 + (190 - 8) * t)
    draw.line([(0, y), (w, y)], fill=(0, 0, 0, alpha))

margin_x = max(int(w * 0.06), 38)
max_text_w = w - margin_x * 2
max_text_h = max(int(h * 0.33), 180)
start_y = h - max_text_h - max(int(h * 0.06), 34)

font_path = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
if not os.path.exists(font_path):
    font_path = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'

measure = ImageDraw.Draw(Image.new('RGB', (10, 10)))

def wrap_text(text, font, width):
    words = text.split()
    lines = []
    cur = ''
    for w_ in words:
        cand = (cur + ' ' + w_).strip()
        box = measure.textbbox((0, 0), cand, font=font, stroke_width=2)
        if box[2] - box[0] <= width or not cur:
            cur = cand
        else:
            lines.append(cur)
            cur = w_
    if cur:
        lines.append(cur)
    return lines

best = None
for size in range(max(int(w * 0.07), 42), 27, -2):
    font = ImageFont.truetype(font_path, size=size)
    lines = wrap_text(title, font, max_text_w)
    if len(lines) > 6:
        continue
    heights = []
    widths = []
    for line in lines:
        box = measure.textbbox((0, 0), line, font=font, stroke_width=2)
        widths.append(box[2] - box[0])
        heights.append(box[3] - box[1])
    line_gap = max(int(size * 0.24), 10)
    total_h = sum(heights) + line_gap * (len(lines) - 1)
    if total_h <= max_text_h:
        best = (font, lines, heights, widths, line_gap, total_h)
        break

if best is None:
    font = ImageFont.truetype(font_path, size=28)
    lines = wrap_text(title, font, max_text_w)
    lines = lines[:6]
    heights = []
    widths = []
    for line in lines:
        box = measure.textbbox((0, 0), line, font=font, stroke_width=2)
        widths.append(box[2] - box[0])
        heights.append(box[3] - box[1])
    line_gap = 9
    total_h = sum(heights) + line_gap * (len(lines) - 1)
else:
    font, lines, heights, widths, line_gap, total_h = best

text_pad_x = max(int(w * 0.02), 16)
text_pad_y = max(int(h * 0.012), 10)
box_w = min(max(widths) + text_pad_x * 2, int(w * 0.92))
box_h = total_h + text_pad_y * 2
box_x = (w - box_w) // 2
box_y = max(start_y, h - box_h - max(int(h * 0.05), 24))
box_r = max(int(min(box_w, box_h) * 0.08), 12)

# Title card backdrop
draw.rounded_rectangle(
    [box_x, box_y, box_x + box_w, box_y + box_h],
    radius=box_r,
    fill=(0, 0, 0, 138),
    outline=(255, 255, 255, 70),
    width=2,
)

y = box_y + text_pad_y
for idx, line in enumerate(lines):
    tw = widths[idx]
    th = heights[idx]
    x = (w - tw) // 2
    draw.text(
        (x, y),
        line,
        font=font,
        fill=(255, 255, 255, 245),
        stroke_width=2,
        stroke_fill=(0, 0, 0, 215),
    )
    y += th + line_gap

final = Image.alpha_composite(base, layer).convert('RGB')
if final.size != (w, h):
    raise SystemExit('DIMENSION_MISMATCH')
final.save(output_path, format='PNG', optimize=True)
print(f'overlay_rendered {w}x{h}')
`;

  await execFileAsync('python3', ['-c', python], {
    env: {
      ...process.env,
      SOURCE_PATH: sourcePath,
      OUTPUT_PATH: outputPath,
    },
    maxBuffer: 20 * 1024 * 1024,
  });
}

async function main() {
  const sourceImageUrl = process.env.SOURCE_IMAGE_URL;
  const titleText = String(process.env.TITLE_TEXT || '').toUpperCase().trim();
  const catboxHash = process.env.CATBOX_HASH;

  if (!sourceImageUrl || !titleText || !catboxHash) {
    throw new Error('Missing SOURCE_IMAGE_URL, TITLE_TEXT, or CATBOX_HASH');
  }

  const sourcePath = 'source-image';
  const outputPath = 'final-overlay.png';

  await execFileAsync('curl', ['-fsSL', sourceImageUrl, '-o', sourcePath], { maxBuffer: 20 * 1024 * 1024 });
  await validateImageFile(sourcePath, 'source');

  await renderOverlayWithPython(sourcePath, outputPath);

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
