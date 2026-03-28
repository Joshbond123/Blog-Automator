import fs from 'node:fs/promises';
import { statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function downloadFromGitHub(repo, token, filePath, outputPath) {
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${encodedPath}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (!res.ok) throw new Error(`Failed to fetch "${filePath}" from GitHub (${res.status}): ${await res.text()}`);
  const payload = await res.json();
  const b64 = String(payload?.content || '').replace(/\n/g, '');
  if (!b64) throw new Error(`GitHub returned empty content for "${filePath}"`);
  await fs.writeFile(outputPath, Buffer.from(b64, 'base64'));
  const size = statSync(outputPath).size;
  if (size < 1000) throw new Error(`Downloaded file "${outputPath}" is suspiciously small (${size} bytes)`);
  console.log(`[download] ${filePath} → ${outputPath} (${(size / 1024).toFixed(1)} KB)`);
}

async function getAudioDuration(audioPath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    audioPath,
  ]);
  const d = parseFloat(stdout.trim());
  if (!d || d < 1) throw new Error(`Invalid audio duration: ${d}`);
  return d;
}

function toAssTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.round(((seconds - Math.floor(seconds)) * 100));
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function buildAssSubtitles(wordTimestamps) {
  const style = [
    'Style: viral',
    'Arial',
    '72',
    '&H00FFFFFF',
    '&H00FFFFFF',
    '&H00000000',
    '&H80000000',
    '-1',
    '0',
    '0',
    '0',
    '100',
    '100',
    '0',
    '0',
    '1',
    '4',
    '2',
    '5',
    '30',
    '30',
    '80',
    '1',
  ].join(',');

  const header = `[Script Info]
ScriptType: v4.00+
WrapStyle: 0
PlayResX: 1280
PlayResY: 720
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${style}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  const events = wordTimestamps
    .filter((w) => w && w.word && typeof w.start === 'number' && typeof w.end === 'number')
    .map(({ word, start, end }) => {
      const startTime = toAssTime(Math.max(0, start));
      const endTime = toAssTime(Math.max(start + 0.05, end));
      const clean = String(word)
        .toUpperCase()
        .replace(/[{}\\]/g, '')
        .replace(/[,.:!?;]+$/, '');
      return `Dialogue: 0,${startTime},${endTime},viral,,0,0,0,,${clean}`;
    })
    .join('\n');

  return `${header}\n${events}\n`;
}

async function buildSceneVideo(imagePath, outputPath, duration, sceneIndex) {
  const frames = Math.max(24, Math.ceil(duration * 24));
  const zoomDir = sceneIndex % 2 === 0 ? 'in' : 'out';
  const zoomExpr = zoomDir === 'in'
    ? `min(zoom+0.0004,1.25)`
    : `if(eq(on\\,1)\\,1.25\\,max(zoom-0.0004\\,1.0))`;

  await execFileAsync('ffmpeg', [
    '-y',
    '-loop', '1',
    '-t', String(duration + 0.5),
    '-i', imagePath,
    '-vf', [
      'scale=1280:720:force_original_aspect_ratio=increase',
      'crop=1280:720',
      `zoompan=z='${zoomExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1280x720:fps=24`,
      'format=yuv420p',
    ].join(','),
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-r', '24',
    '-pix_fmt', 'yuv420p',
    '-t', String(duration),
    outputPath,
  ], { maxBuffer: 100 * 1024 * 1024 });

  console.log(`[scene] ${outputPath} rendered (${duration.toFixed(2)}s, ${zoomDir} zoom)`);
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const voiceoverPath = process.env.VOICEOVER_GITHUB_PATH;
  const scenePaths = JSON.parse(process.env.SCENE_GITHUB_PATHS || '[]');
  const wordTimestamps = JSON.parse(process.env.WORD_TIMESTAMPS_JSON || '[]');
  const correlationId = String(process.env.CORRELATION_ID || `video-${Date.now()}`).trim();
  const title = String(process.env.TITLE_TEXT || '').trim();

  console.log(`[render-video] Starting render for correlationId=${correlationId}`);
  console.log(`[render-video] Scenes: ${scenePaths.length}, Words: ${wordTimestamps.length}`);

  if (!repo || !token) throw new Error('Missing GITHUB_REPOSITORY or GITHUB_TOKEN');
  if (!voiceoverPath) throw new Error('Missing VOICEOVER_GITHUB_PATH');
  if (!scenePaths.length) throw new Error('SCENE_GITHUB_PATHS is empty');

  await fs.mkdir('render_workspace', { recursive: true });

  const voiceFile = 'render_workspace/voiceover.mp3';
  await downloadFromGitHub(repo, token, voiceoverPath, voiceFile);

  const sceneFiles = [];
  for (let i = 0; i < scenePaths.length; i++) {
    const sceneFile = `render_workspace/scene_${i}.jpg`;
    await downloadFromGitHub(repo, token, scenePaths[i], sceneFile);
    sceneFiles.push(sceneFile);
  }

  const totalDuration = await getAudioDuration(voiceFile);
  console.log(`[render-video] Audio duration: ${totalDuration.toFixed(2)}s`);

  const assContent = buildAssSubtitles(wordTimestamps);
  await fs.writeFile('render_workspace/subtitles.ass', assContent, 'utf8');
  console.log(`[render-video] ASS subtitles: ${wordTimestamps.length} words`);

  const sceneDuration = totalDuration / sceneFiles.length;
  const sceneVideos = [];
  for (let i = 0; i < sceneFiles.length; i++) {
    const videoFile = `render_workspace/scene_${i}_video.mp4`;
    await buildSceneVideo(sceneFiles[i], videoFile, sceneDuration, i);
    sceneVideos.push(videoFile);
  }

  const concatList = sceneVideos.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n');
  await fs.writeFile('render_workspace/concat_list.txt', concatList, 'utf8');

  console.log('[render-video] Concatenating scene videos...');
  await execFileAsync('ffmpeg', [
    '-y', '-f', 'concat', '-safe', '0',
    '-i', 'render_workspace/concat_list.txt',
    '-c', 'copy',
    'render_workspace/video_scenes.mp4',
  ], { maxBuffer: 200 * 1024 * 1024 });

  console.log('[render-video] Adding voiceover audio...');
  await execFileAsync('ffmpeg', [
    '-y',
    '-i', 'render_workspace/video_scenes.mp4',
    '-i', voiceFile,
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '128k',
    '-map', '0:v:0', '-map', '1:a:0',
    '-shortest',
    'render_workspace/video_audio.mp4',
  ], { maxBuffer: 200 * 1024 * 1024 });

  console.log('[render-video] Burning subtitles...');
  await execFileAsync('ffmpeg', [
    '-y',
    '-i', 'render_workspace/video_audio.mp4',
    '-vf', `ass=render_workspace/subtitles.ass`,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
    '-c:a', 'copy',
    'output.mp4',
  ], { maxBuffer: 300 * 1024 * 1024 });

  const outputSize = statSync('output.mp4').size;
  if (outputSize < 100 * 1024) throw new Error(`Output video too small: ${outputSize} bytes`);
  console.log(`[render-video] Final video: output.mp4 (${(outputSize / 1024 / 1024).toFixed(2)} MB, ${totalDuration.toFixed(1)}s)`);

  const result = {
    correlationId,
    title,
    videoDuration: totalDuration,
    videoSizeMB: parseFloat((outputSize / 1024 / 1024).toFixed(2)),
    wordCount: wordTimestamps.length,
    sceneCount: sceneFiles.length,
    outputFile: 'output.mp4',
    timestamp: new Date().toISOString(),
  };

  await fs.writeFile('result.json', JSON.stringify(result, null, 2), 'utf8');
  console.log('[render-video] Done.', JSON.stringify(result));
}

main().catch((err) => {
  console.error('[render-video] FATAL ERROR:', err?.message || err);
  process.exit(1);
});
