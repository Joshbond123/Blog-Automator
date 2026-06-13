import React, { useMemo } from "react";
import {
  AbsoluteFill,
  Audio,
  Img,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
  CalculateMetadataFunction,
} from "remotion";

export type Word = { word: string; start: number; end: number };
export type Scene = { src: string };

export type ViralProps = {
  audioSrc: string;
  musicSrc: string;
  hasMusic: boolean;
  scenes: Scene[];
  words: Word[];
  durationInSeconds: number;
  cta: string;
  hookText: string;
};

export const defaultProps: ViralProps = {
  audioSrc: "render-assets/voiceover.mp3",
  musicSrc: "render-assets/music.mp3",
  hasMusic: false,
  scenes: [],
  words: [],
  durationInSeconds: 60,
  cta: "LIKE, SHARE & FOLLOW — CHECK LINK IN COMMENTS",
  hookText: "",
};

export const calcMetadata: CalculateMetadataFunction<ViralProps> = ({ props }) => {
  const fps = 30;
  const dur = Math.max(5, Math.ceil((props.durationInSeconds || 60) * fps));
  return { durationInFrames: dur, fps };
};

const SceneClip: React.FC<{ src: string; index: number; durationInFrames: number }> = ({
  src,
  index,
  durationInFrames,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Ken-Burns zoom: alternate zoom-in / zoom-out per scene
  const zoomIn = index % 2 === 0;
  const startScale = zoomIn ? 1.0 : 1.18;
  const endScale = zoomIn ? 1.18 : 1.0;
  const scale = interpolate(frame, [0, durationInFrames], [startScale, endScale], {
    extrapolateRight: "clamp",
  });

  // Subtle pan
  const panX = interpolate(frame, [0, durationInFrames], [0, zoomIn ? -20 : 20], {
    extrapolateRight: "clamp",
  });

  // Crossfade: 6-frame fade in/out at boundaries
  const fadeFrames = 6;
  const opacity = interpolate(
    frame,
    [0, fadeFrames, durationInFrames - fadeFrames, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Brief "hook" punch on the very first scene to grab attention in <2s
  const hookPunch =
    index === 0
      ? spring({ frame, fps, config: { damping: 12, mass: 0.5, stiffness: 180 } })
      : 1;
  const punchScale = index === 0 ? 0.96 + 0.04 * hookPunch : 1;

  return (
    <AbsoluteFill style={{ backgroundColor: "#000", overflow: "hidden", opacity }}>
      <Img
        src={staticFile(src)}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: `translateX(${panX}px) scale(${scale * punchScale})`,
          transformOrigin: "center center",
        }}
      />
      {/* subtle vignette to make subtitles pop */}
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(0,0,0,0) 50%, rgba(0,0,0,0.45) 100%)",
          pointerEvents: "none",
        }}
      />
    </AbsoluteFill>
  );
};

type Phrase = { text: string; start: number; end: number };

// Viral TikTok / Reels style: 1 short word per beat, or 2 if the words are
// very short (≤4 chars each) and combined length stays tiny. Each chunk
// hard-syncs to the voiceover word timestamps so subtitles never lag, never
// stack, and never appear in big broken blocks.
function groupWordsIntoPhrases(words: Word[]): Phrase[] {
  const phrases: Phrase[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];
    const cleanA = (w.word || "").trim();
    const cleanB = (next?.word || "").trim();
    // Pair very short consecutive words (e.g. "in the", "to be") so a single
    // 2-letter word doesn't flash for 200ms.
    if (
      next &&
      cleanA.length <= 4 &&
      cleanB.length <= 4 &&
      cleanA.length + cleanB.length <= 7
    ) {
      phrases.push({
        text: `${cleanA} ${cleanB}`,
        start: w.start,
        end: next.end,
      });
      i += 1;
    } else {
      phrases.push({ text: cleanA, start: w.start, end: w.end });
    }
  }
  return phrases;
}

const Subtitles: React.FC<{ words: Word[] }> = ({ words }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  const phrases = useMemo(() => groupWordsIntoPhrases(words), [words]);

  // Find the active phrase (binary-friendly linear scan; phrases are small).
  let active: Phrase | null = null;
  for (const p of phrases) {
    if (t >= p.start && t <= p.end + 0.05) {
      active = p;
      break;
    }
  }
  if (!active) return null;

  const local = t - active.start;
  // Pop-in animation
  const pop = spring({
    frame: Math.round(local * fps),
    fps,
    config: { damping: 10, mass: 0.4, stiffness: 220 },
  });
  const scale = 0.85 + 0.15 * pop;
  const opacity = interpolate(local, [0, 0.08], [0, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        padding: "0 60px",
      }}
    >
      <div
        style={{
          fontFamily:
            'Inter, "Arial Black", "Helvetica Neue", Arial, sans-serif',
          fontWeight: 900,
          fontSize: 110,
          color: "#FFFFFF",
          textAlign: "center",
          textTransform: "uppercase",
          letterSpacing: 2,
          lineHeight: 1.04,
          WebkitTextStroke: "10px #000000",
          paintOrder: "stroke fill",
          textShadow: "0 8px 24px rgba(0,0,0,0.75)",
          transform: `scale(${scale})`,
          opacity,
          maxWidth: 960,
          wordBreak: "break-word",
        }}
      >
        {active.text.toUpperCase()}
      </div>
    </AbsoluteFill>
  );
};

const HookOverlay: React.FC<{ text: string }> = ({ text }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  if (!text || t > 2.0) return null;

  const opacity = interpolate(t, [0, 0.15, 1.7, 2.0], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const pop = spring({ frame, fps, config: { damping: 8, mass: 0.4, stiffness: 200 } });
  const scale = 0.8 + 0.2 * pop;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-start",
        alignItems: "center",
        paddingTop: 200,
      }}
    >
      <div
        style={{
          fontFamily: 'Inter, "Arial Black", sans-serif',
          fontWeight: 900,
          fontSize: 96,
          color: "#FFE600",
          textAlign: "center",
          textTransform: "uppercase",
          letterSpacing: 1.5,
          lineHeight: 1.05,
          WebkitTextStroke: "8px #000000",
          paintOrder: "stroke fill",
          textShadow: "0 6px 20px rgba(0,0,0,0.8)",
          transform: `scale(${scale})`,
          opacity,
          maxWidth: 960,
        }}
      >
        {text.toUpperCase()}
      </div>
    </AbsoluteFill>
  );
};

const CTAOverlay: React.FC<{ text: string }> = ({ text }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const ctaDurationFrames = Math.round(fps * 4); // last 4 seconds
  const startFrame = Math.max(0, durationInFrames - ctaDurationFrames);
  if (frame < startFrame) return null;

  const local = frame - startFrame;
  const opacity = interpolate(
    local,
    [0, 8, ctaDurationFrames - 10, ctaDurationFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const pop = spring({
    frame: local,
    fps,
    config: { damping: 12, mass: 0.5, stiffness: 180 },
  });
  const scale = 0.9 + 0.1 * pop;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-end",
        alignItems: "center",
        paddingBottom: 240,
      }}
    >
      <div
        style={{
          fontFamily: 'Inter, "Arial Black", sans-serif',
          fontWeight: 900,
          fontSize: 76,
          color: "#FFFFFF",
          textAlign: "center",
          textTransform: "uppercase",
          letterSpacing: 2,
          lineHeight: 1.1,
          WebkitTextStroke: "6px #000000",
          paintOrder: "stroke fill",
          background:
            "linear-gradient(135deg, rgba(255,30,90,0.92), rgba(255,140,0,0.92))",
          padding: "28px 56px",
          borderRadius: 28,
          boxShadow: "0 16px 60px rgba(0,0,0,0.55)",
          transform: `scale(${scale})`,
          opacity,
          maxWidth: 980,
        }}
      >
        {text.toUpperCase()}
      </div>
    </AbsoluteFill>
  );
};

export const ViralVideo: React.FC<ViralProps> = ({
  audioSrc,
  musicSrc,
  hasMusic,
  scenes,
  words,
  cta,
  hookText,
}) => {
  const { durationInFrames } = useVideoConfig();
  const sceneCount = Math.max(1, scenes.length);
  const sceneFrames = Math.ceil(durationInFrames / sceneCount);

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {scenes.map((s, i) => (
        <Sequence
          key={i}
          from={i * sceneFrames}
          durationInFrames={Math.min(sceneFrames + 8, durationInFrames - i * sceneFrames)}
        >
          <SceneClip src={s.src} index={i} durationInFrames={sceneFrames + 8} />
        </Sequence>
      ))}

      <HookOverlay text={hookText} />
      <Subtitles words={words} />
      {/* No visual CTA overlay — the call-to-action is delivered as the spoken
          last sentence of the voiceover (like / share / follow / link in comments). */}

      <Audio src={staticFile(audioSrc)} />
      {hasMusic ? <Audio src={staticFile(musicSrc)} volume={0.06} /> : null}
    </AbsoluteFill>
  );
};
