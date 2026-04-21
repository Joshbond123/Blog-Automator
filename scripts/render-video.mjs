// scripts/render-video.mjs
// Orchestrator for the Remotion-based viral video renderer.
//
// Runs inside the GitHub Actions "Video Renderer" workflow:
//   1. Download voiceover + scene images from the GitHub repo (Contents API).
//   2. Probe voiceover duration with ffprobe.
//   3. Pick a random viral background music track, download & loop/trim it.
//   4. Stage all assets into remotion/public/render-assets/.
//   5. Invoke `remotion render` to produce output.mp4 (1080x1920, h264).
//   6. Write result.json (consumed by the orchestration server).

import fs from "node:fs/promises";
import { statSync, mkdirSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, join, basename } from "node:path";

const execFileAsync = promisify(execFile);

// ── Royalty-free viral music pool (SoundHelix — no attribution required) ─────
const VIRAL_MUSIC_URLS = [
  "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3",
  "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3",
  "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3",
  "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3",
  "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3",
  "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-6.mp3",
  "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-7.mp3",
  "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-8.mp3",
  "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-9.mp3",
  "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-10.mp3",
  "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-11.mp3",
  "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-12.mp3",
];

function shuffledMusicUrls() {
  return [...VIRAL_MUSIC_URLS].sort(() => Math.random() - 0.5);
}

// ── GitHub Contents API download ─────────────────────────────────────────────
async function downloadFromGitHub(repo, token, filePath, outputPath) {
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${encodedPath}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch "${filePath}" from GitHub (${res.status}): ${await res.text()}`);
  }
  const payload = await res.json();
  const b64 = String(payload?.content || "").replace(/\n/g, "");
  if (b64) {
    await fs.writeFile(outputPath, Buffer.from(b64, "base64"));
  } else if (payload?.download_url) {
    const dl = await fetch(payload.download_url);
    if (!dl.ok) throw new Error(`download_url fetch failed (${dl.status})`);
    await fs.writeFile(outputPath, Buffer.from(await dl.arrayBuffer()));
  } else {
    throw new Error(`GitHub returned empty content and no download_url for "${filePath}"`);
  }
  const size = statSync(outputPath).size;
  if (size < 1000) throw new Error(`Downloaded "${outputPath}" is suspiciously small (${size}B)`);
  console.log(`[download] ${filePath} → ${outputPath} (${(size / 1024).toFixed(1)} KB)`);
}

// ── Background-music download with retry, then ffmpeg synthesis fallback ─────
async function downloadMusicTrack(outputPath) {
  for (const url of shuffledMusicUrls()) {
    console.log(`[music] Trying ${url}`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 50 * 1024) throw new Error(`track too small (${buf.length}B)`);
      await fs.writeFile(outputPath, buf);
      console.log(`[music] ✓ Downloaded ${(buf.length / 1024).toFixed(0)}KB`);
      return true;
    } catch (err) {
      console.warn(`[music] failed (${err?.message}); trying next…`);
    }
  }

  console.log("[music] All URLs failed — synthesizing ambient track via ffmpeg");
  try {
    await synthesizeBackgroundMusic(outputPath, 120);
    return true;
  } catch (err) {
    console.warn(`[music] synthesis failed (${err?.message}); video will be voice-only`);
    return false;
  }
}

async function synthesizeBackgroundMusic(outputPath, durationSeconds) {
  const dur = Math.ceil(durationSeconds) + 2;
  const expr = [
    `0.35*sin(2*PI*55*t)*exp(-mod(t,0.5)*9)`,
    `0.20*sin(2*PI*110*t)*exp(-mod(t,0.5)*9)`,
    `0.08*sin(2*PI*330*t)*exp(-mod(t,1.0)*5)`,
    `0.06*sin(2*PI*415*t)*exp(-mod(t,1.0)*5)`,
    `0.04*sin(2*PI*495*t)*exp(-mod(t,2.0)*4)`,
    `0.05*sin(2*PI*880*t)*exp(-mod(t,0.25)*30)`,
  ].join("+");
  await execFileAsync(
    "ffmpeg",
    [
      "-y", "-f", "lavfi",
      "-i", `aevalsrc=${expr}:s=44100:d=${dur}`,
      "-c:a", "libmp3lame", "-q:a", "4",
      outputPath,
    ],
    { maxBuffer: 50 * 1024 * 1024 }
  );
  console.log("[music] ✓ Synthesized fallback track");
}

// ── ffprobe duration ─────────────────────────────────────────────────────────
async function getAudioDuration(audioPath) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    audioPath,
  ]);
  const d = parseFloat(stdout.trim());
  if (!d || d < 1) throw new Error(`Invalid audio duration: ${d}`);
  return d;
}

// ── Loop+trim music to exactly the right length, balanced volume ─────────────
async function prepareMusic(rawMusic, outFile, durationSeconds) {
  const target = durationSeconds + 1.0;
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-stream_loop", "-1",
      "-i", rawMusic,
      "-t", String(target),
      "-af", "afade=t=in:st=0:d=0.6,afade=t=out:st=" + (target - 0.8).toFixed(2) + ":d=0.8",
      "-c:a", "libmp3lame", "-q:a", "4",
      outFile,
    ],
    { maxBuffer: 80 * 1024 * 1024 }
  );
  console.log(`[music] Trimmed/looped to ${target.toFixed(1)}s → ${outFile}`);
}

// ── Stage assets into remotion/public/render-assets/ ─────────────────────────
async function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const voiceoverPath = process.env.VOICEOVER_GITHUB_PATH;
  const scenePaths = JSON.parse(process.env.SCENE_GITHUB_PATHS || "[]");
  const wordTimestamps = JSON.parse(process.env.WORD_TIMESTAMPS_JSON || "[]");
  const correlationId = String(process.env.CORRELATION_ID || `video-${Date.now()}`).trim();
  const title = String(process.env.TITLE_TEXT || "").trim();
  const ctaText =
    String(process.env.CTA_TEXT || "").trim() ||
    "LIKE, SHARE & FOLLOW — CHECK LINK IN BIO";
  const hookText = String(process.env.HOOK_TEXT || title || "").trim().slice(0, 60);

  console.log(`[render-video] correlationId=${correlationId}`);
  console.log(`[render-video] scenes=${scenePaths.length} words=${wordTimestamps.length}`);

  if (!repo || !token) throw new Error("Missing GITHUB_REPOSITORY or GITHUB_TOKEN");
  if (!voiceoverPath) throw new Error("Missing VOICEOVER_GITHUB_PATH");
  if (!scenePaths.length) throw new Error("SCENE_GITHUB_PATHS is empty");

  const REMOTION_DIR = resolve("remotion");
  const PUBLIC_DIR = join(REMOTION_DIR, "public");
  const ASSETS_DIR = join(PUBLIC_DIR, "render-assets");
  await ensureDir(ASSETS_DIR);

  // 1. Download voiceover into the Remotion public dir
  const voiceFile = join(ASSETS_DIR, "voiceover.mp3");
  await downloadFromGitHub(repo, token, voiceoverPath, voiceFile);

  // 2. Download scene images
  const sceneRelPaths = [];
  for (let i = 0; i < scenePaths.length; i++) {
    const localName = `scene_${i}.jpg`;
    await downloadFromGitHub(repo, token, scenePaths[i], join(ASSETS_DIR, localName));
    sceneRelPaths.push(`render-assets/${localName}`);
  }

  // 3. Voice duration
  const voiceDuration = await getAudioDuration(voiceFile);
  console.log(`[render-video] Voiceover duration: ${voiceDuration.toFixed(2)}s`);

  // 4. Music: download → loop/trim to voice duration
  const rawMusic = join(ASSETS_DIR, "music_raw.mp3");
  const musicFile = join(ASSETS_DIR, "music.mp3");
  let hasMusic = await downloadMusicTrack(rawMusic);
  if (hasMusic) {
    try {
      await prepareMusic(rawMusic, musicFile, voiceDuration);
    } catch (err) {
      console.warn(`[music] prepare failed (${err?.message}); video will be voice-only`);
      hasMusic = false;
    }
  }

  // 5. Build inputProps for Remotion
  const inputProps = {
    audioSrc: "render-assets/voiceover.mp3",
    musicSrc: "render-assets/music.mp3",
    hasMusic,
    scenes: sceneRelPaths.map((src) => ({ src })),
    words: wordTimestamps,
    durationInSeconds: voiceDuration,
    cta: ctaText,
    hookText,
  };
  const propsFile = join(REMOTION_DIR, "input-props.json");
  await fs.writeFile(propsFile, JSON.stringify(inputProps, null, 2), "utf8");
  console.log(`[render-video] inputProps written → ${propsFile}`);

  // 6. Invoke Remotion render
  const outputFile = resolve("output.mp4");
  console.log("[remotion] Starting render…");
  await execFileAsync(
    "npx",
    [
      "--no-install",
      "remotion",
      "render",
      "src/index.ts",
      "ViralVideo",
      outputFile,
      `--props=${propsFile}`,
      "--concurrency=1",
      "--log=info",
    ],
    {
      cwd: REMOTION_DIR,
      maxBuffer: 1024 * 1024 * 1024,
      env: {
        ...process.env,
        // headless Chromium friendliness inside CI
        REMOTION_CHROME_MODE: "headless-shell",
      },
    }
  );

  const outputSize = statSync(outputFile).size;
  if (outputSize < 100 * 1024) throw new Error(`Output video too small: ${outputSize} bytes`);

  const result = {
    correlationId,
    title,
    cta: ctaText,
    hookText,
    videoDuration: voiceDuration,
    videoSizeMB: parseFloat((outputSize / 1024 / 1024).toFixed(2)),
    wordCount: wordTimestamps.length,
    sceneCount: sceneRelPaths.length,
    hasBackgroundMusic: hasMusic,
    resolution: "1080x1920",
    fps: 30,
    engine: "remotion",
    outputFile: basename(outputFile),
    timestamp: new Date().toISOString(),
  };
  await fs.writeFile("result.json", JSON.stringify(result, null, 2), "utf8");
  console.log(
    `[render-video] ✓ ${result.outputFile} — ${result.videoSizeMB}MB, ${voiceDuration.toFixed(1)}s, ${hasMusic ? "with music" : "voice-only"} (engine=remotion)`
  );
}

main().catch((err) => {
  console.error("[render-video] FATAL:", err?.stack || err?.message || err);
  process.exit(1);
});
