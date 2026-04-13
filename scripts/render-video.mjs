import fs from 'node:fs/promises';
import { statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const execFileAsync = promisify(execFile);

// ── Royalty-free music pool (SoundHelix — no attribution required) ────────────
// SoundHelix.com provides algorithmically-composed instrumental tracks, freely usable.
const VIRAL_MUSIC_URLS = [
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3',
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3',
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3',
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3',
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-6.mp3',
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-7.mp3',
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-8.mp3',
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-9.mp3',
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-10.mp3',
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-11.mp3',
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-12.mp3',
];

function pickRandomMusicUrls() {
  // Return a shuffled copy so we can try in random order
  const shuffled = [...VIRAL_MUSIC_URLS].sort(() => Math.random() - 0.5);
  return shuffled;
}

// ── GitHub asset download ─────────────────────────────────────────────────────
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
  if (b64) {
    await fs.writeFile(outputPath, Buffer.from(b64, 'base64'));
  } else if (payload?.download_url) {
    const dlRes = await fetch(payload.download_url);
    if (!dlRes.ok) throw new Error(`Failed to download "${filePath}" via download_url (${dlRes.status})`);
    const buf = Buffer.from(await dlRes.arrayBuffer());
    await fs.writeFile(outputPath, buf);
  } else {
    throw new Error(`GitHub returned empty content and no download_url for "${filePath}"`);
  }
  const size = statSync(outputPath).size;
  if (size < 1000) throw new Error(`Downloaded file "${outputPath}" is suspiciously small (${size} bytes)`);
  console.log(`[download] ${filePath} → ${outputPath} (${(size / 1024).toFixed(1)} KB)`);
}

// ── Background music: download with retry, then synthesize as final fallback ──
async function downloadMusicTrack(outputPath) {
  const urls = pickRandomMusicUrls();

  for (const musicUrl of urls) {
    console.log(`[music] Trying: ${musicUrl}`);
    try {
      const res = await fetch(musicUrl, { signal: AbortSignal.timeout(25000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 50 * 1024) throw new Error(`Track too small (${buf.length} bytes)`);
      await fs.writeFile(outputPath, buf);
      console.log(`[music] ✓ Downloaded ${(buf.length / 1024).toFixed(0)}KB from ${musicUrl}`);
      return true;
    } catch (err) {
      console.warn(`[music] Failed (${err?.message}), trying next...`);
    }
  }

  // All URLs failed — synthesize an ambient lo-fi beat with ffmpeg
  console.log('[music] All URLs failed. Synthesizing background music with ffmpeg...');
  try {
    await synthesizeBackgroundMusic(outputPath, 120);
    return true;
  } catch (synthErr) {
    console.warn(`[music] Synthesis also failed (${synthErr?.message}). Video will be voice-only.`);
    return false;
  }
}

// Generate a synthesized lo-fi ambient background track (no downloads needed)
async function synthesizeBackgroundMusic(outputPath, durationSeconds) {
  const dur = Math.ceil(durationSeconds) + 2;
  // Bass kick at ~2 beats/sec + warm chord pad + subtle hi-hat rhythm
  const expr = [
    `0.35*sin(2*PI*55*t)*exp(-mod(t,0.5)*9)`,      // punchy bass kick every 0.5s
    `0.20*sin(2*PI*110*t)*exp(-mod(t,0.5)*9)`,      // bass harmonic
    `0.08*sin(2*PI*330*t)*exp(-mod(t,1.0)*5)`,      // mid chord tone every 1s
    `0.06*sin(2*PI*415*t)*exp(-mod(t,1.0)*5)`,      // chord second note
    `0.04*sin(2*PI*495*t)*exp(-mod(t,2.0)*4)`,      // chord third note every 2s
    `0.05*sin(2*PI*880*t)*exp(-mod(t,0.25)*30)`,    // hi-hat clicks every 0.25s
  ].join('+');
  await execFileAsync('ffmpeg', [
    '-y',
    '-f', 'lavfi',
    '-i', `aevalsrc=${expr}:s=44100:d=${dur}`,
    '-c:a', 'aac', '-b:a', '96k',
    outputPath,
  ], { maxBuffer: 50 * 1024 * 1024 });
  console.log('[music] ✓ Synthesized background track');
}

// ── Mix voiceover + background music ─────────────────────────────────────────
async function mixAudioWithMusic(voiceFile, musicFile, outputFile) {
  // amix with stream_loop -1 in filter_complex causes "Invalid argument" on
  // some ffmpeg builds regardless of duration option. Safe pattern:
  //   Step 1 — trim/loop music to voiceover_duration+2s (plain I/O, no filter)
  //   Step 2 — amix two finite streams (no stream_loop involved)

  const voiceDuration = await getAudioDuration(voiceFile);
  const trimDuration  = voiceDuration + 2;

  const trimmedMusicFile = outputFile.replace('final_audio', 'music_trimmed');

  // Step 1: produce a finite music clip (loop until trimDuration, then stop)
  // Output is .mp3 so use libmp3lame — writing AAC to an .mp3 container is invalid.
  await execFileAsync('ffmpeg', [
    '-y',
    '-stream_loop', '-1', '-i', musicFile,
    '-t', String(trimDuration),
    '-c:a', 'libmp3lame', '-q:a', '4',
    trimmedMusicFile,
  ], { maxBuffer: 50 * 1024 * 1024 });
  console.log(`[music] Trimmed music to ${trimDuration.toFixed(1)}s`);

  // Step 2: mix voiceover (100%) + finite music (15%); duration=first trims to voice length
  await execFileAsync('ffmpeg', [
    '-y',
    '-i', voiceFile,
    '-i', trimmedMusicFile,
    '-filter_complex', '[1:a]volume=0.15[bg];[0:a][bg]amix=inputs=2:duration=first[out]',
    '-map', '[out]',
    '-c:a', 'aac', '-b:a', '192k',
    outputFile,
  ], { maxBuffer: 100 * 1024 * 1024 });
  console.log(`[music] Mixed audio (${voiceDuration.toFixed(1)}s) → ${outputFile}`);
}

// ── Audio duration probe ──────────────────────────────────────────────────────
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

// ── ASS subtitle time format ──────────────────────────────────────────────────
function toAssTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.round((seconds - Math.floor(seconds)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

// ── Viral-style ASS subtitles (9:16 vertical, centered, bold, word-by-word) ──
function buildAssSubtitles(wordTimestamps) {
  // Bold white text, black outline, centered middle of screen — TikTok style.
  // PlayRes matches 1080×1920 (9:16). Alignment=5 → middle-center.
  const styleFields = [
    'Style: viral',
    'Arial',
    '88',          // Fontsize — large & readable on mobile
    '&H00FFFFFF',  // PrimaryColour: white
    '&H00FFFFFF',  // SecondaryColour
    '&H00000000',  // OutlineColour: black
    '&H96000000',  // BackColour: 60% transparent black shadow
    '-1',          // Bold: yes
    '0',           // Italic: no
    '0',           // Underline: no
    '0',           // StrikeOut: no
    '100',         // ScaleX
    '100',         // ScaleY
    '0',           // Spacing
    '0',           // Angle
    '1',           // BorderStyle: outline + drop shadow
    '5',           // Outline width
    '2',           // Shadow depth
    '5',           // Alignment: 5 = middle-center (TikTok position)
    '60',          // MarginL
    '60',          // MarginR
    '0',           // MarginV
    '1',           // Encoding
  ].join(',');

  const header = `[Script Info]
ScriptType: v4.00+
WrapStyle: 0
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styleFields}

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

// ── Scene video (vertical 1080×1920, Ken Burns zoom) ─────────────────────────
async function buildSceneVideo(imagePath, outputPath, duration, sceneIndex) {
  const frames = Math.max(24, Math.ceil(duration * 24));
  const zoomDir = sceneIndex % 2 === 0 ? 'in' : 'out';
  const zoomExpr = zoomDir === 'in'
    ? `min(zoom+0.0003,1.3)`
    : `if(eq(on\\,1)\\,1.3\\,max(zoom-0.0003\\,1.0))`;

  await execFileAsync('ffmpeg', [
    '-y',
    '-loop', '1',
    '-t', String(duration + 0.5),
    '-i', imagePath,
    '-vf', [
      'scale=1080:1920:force_original_aspect_ratio=increase',
      'crop=1080:1920',
      `zoompan=z='${zoomExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1080x1920:fps=24`,
      'format=yuv420p',
    ].join(','),
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '22',
    '-r', '24',
    '-pix_fmt', 'yuv420p',
    '-t', String(duration),
    outputPath,
  ], { maxBuffer: 150 * 1024 * 1024 });

  console.log(`[scene] ${outputPath} rendered (${duration.toFixed(2)}s, zoom-${zoomDir})`);
}

// ── Main render pipeline ──────────────────────────────────────────────────────
async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const voiceoverPath = process.env.VOICEOVER_GITHUB_PATH;
  const scenePaths = JSON.parse(process.env.SCENE_GITHUB_PATHS || '[]');
  const wordTimestamps = JSON.parse(process.env.WORD_TIMESTAMPS_JSON || '[]');
  const correlationId = String(process.env.CORRELATION_ID || `video-${Date.now()}`).trim();
  const title = String(process.env.TITLE_TEXT || '').trim();

  console.log(`[render-video] correlationId=${correlationId}`);
  console.log(`[render-video] Scenes: ${scenePaths.length}, Words: ${wordTimestamps.length}`);

  if (!repo || !token) throw new Error('Missing GITHUB_REPOSITORY or GITHUB_TOKEN');
  if (!voiceoverPath) throw new Error('Missing VOICEOVER_GITHUB_PATH');
  if (!scenePaths.length) throw new Error('SCENE_GITHUB_PATHS is empty');

  await fs.mkdir('render_workspace', { recursive: true });

  // ── 1. Download voiceover ──────────────────────────────────────────────────
  const voiceFile = 'render_workspace/voiceover.mp3';
  await downloadFromGitHub(repo, token, voiceoverPath, voiceFile);

  // ── 2. Download scene images ───────────────────────────────────────────────
  const sceneFiles = [];
  for (let i = 0; i < scenePaths.length; i++) {
    const sceneFile = `render_workspace/scene_${i}.jpg`;
    await downloadFromGitHub(repo, token, scenePaths[i], sceneFile);
    sceneFiles.push(sceneFile);
  }

  const totalDuration = await getAudioDuration(voiceFile);
  console.log(`[render-video] Voiceover duration: ${totalDuration.toFixed(2)}s`);

  // ── 3. Download background music (non-fatal) ───────────────────────────────
  const musicFile = 'render_workspace/music.mp3';
  const hasMusicTrack = await downloadMusicTrack(musicFile);

  // ── 4. Build word-by-word ASS subtitles ───────────────────────────────────
  const assContent = buildAssSubtitles(wordTimestamps);
  await fs.writeFile('render_workspace/subtitles.ass', assContent, 'utf8');
  console.log(`[render-video] ASS subtitles built: ${wordTimestamps.length} words`);

  // ── 5. Render individual scene videos (1080×1920 vertical) ────────────────
  const sceneDuration = totalDuration / sceneFiles.length;
  const sceneVideos = [];
  for (let i = 0; i < sceneFiles.length; i++) {
    const videoFile = `render_workspace/scene_${i}_video.mp4`;
    await buildSceneVideo(sceneFiles[i], videoFile, sceneDuration, i);
    sceneVideos.push(videoFile);
  }

  // ── 6. Concatenate scene videos ────────────────────────────────────────────
  const concatList = sceneVideos.map((f) => `file '${resolve(f).replace(/'/g, "'\\''")}'`).join('\n');
  await fs.writeFile('render_workspace/concat_list.txt', concatList, 'utf8');

  console.log('[render-video] Concatenating scene videos...');
  await execFileAsync('ffmpeg', [
    '-y', '-f', 'concat', '-safe', '0',
    '-i', 'render_workspace/concat_list.txt',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
    '-pix_fmt', 'yuv420p', '-r', '24',
    'render_workspace/video_scenes.mp4',
  ], { maxBuffer: 300 * 1024 * 1024 });

  // ── 7. Mix audio: voiceover + background music ────────────────────────────
  const finalAudioFile = 'render_workspace/final_audio.mp3';
  if (hasMusicTrack) {
    await mixAudioWithMusic(voiceFile, musicFile, finalAudioFile);
  } else {
    // No music — just use raw voiceover
    await fs.copyFile(voiceFile, finalAudioFile);
    console.log('[render-video] Using voiceover-only audio (no background music).');
  }

  // ── 8. Combine video + final audio ────────────────────────────────────────
  console.log('[render-video] Combining video + audio...');
  await execFileAsync('ffmpeg', [
    '-y',
    '-i', 'render_workspace/video_scenes.mp4',
    '-i', finalAudioFile,
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '192k',
    '-map', '0:v:0', '-map', '1:a:0',
    '-shortest',
    'render_workspace/video_audio.mp4',
  ], { maxBuffer: 300 * 1024 * 1024 });

  // ── 9. Burn subtitles into video ───────────────────────────────────────────
  console.log('[render-video] Burning subtitles...');
  await execFileAsync('ffmpeg', [
    '-y',
    '-i', 'render_workspace/video_audio.mp4',
    '-vf', `ass=render_workspace/subtitles.ass`,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '21',
    '-c:a', 'copy',
    'output.mp4',
  ], { maxBuffer: 400 * 1024 * 1024 });

  const outputSize = statSync('output.mp4').size;
  if (outputSize < 100 * 1024) throw new Error(`Output video too small: ${outputSize} bytes`);
  console.log(`[render-video] ✓ output.mp4 — ${(outputSize / 1024 / 1024).toFixed(2)} MB, ${totalDuration.toFixed(1)}s, ${hasMusicTrack ? 'with music' : 'voice only'}`);

  const result = {
    correlationId,
    title,
    videoDuration: totalDuration,
    videoSizeMB: parseFloat((outputSize / 1024 / 1024).toFixed(2)),
    wordCount: wordTimestamps.length,
    sceneCount: sceneFiles.length,
    hasBackgroundMusic: hasMusicTrack,
    resolution: '1080x1920',
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
