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
    engagementText: string;
  };

  export const defaultProps: ViralProps = {
    audioSrc: "render-assets/voiceover.mp3",
    musicSrc: "render-assets/music.mp3",
    hasMusic: false,
    scenes: [],
    words: [],
    durationInSeconds: 60,
    cta: "LIKE & FOLLOW — FULL STORY IN COMMENTS",
    hookText: "",
    engagementText: "",
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

  function groupWordsIntoPhrases(words: Word[]): Phrase[] {
    const phrases: Phrase[] = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const next = words[i + 1];
      const cleanA = (w.word || "").trim();
      const cleanB = (next?.word || "").trim();
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

  // Hide subtitles once the engagement overlay takes over
  const Subtitles: React.FC<{ words: Word[]; hideAfterSeconds?: number }> = ({ words, hideAfterSeconds }) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const t = frame / fps;

    if (hideAfterSeconds !== undefined && t >= hideAfterSeconds) return null;

    const phrases = useMemo(() => groupWordsIntoPhrases(words), [words]);

    let active: Phrase | null = null;
    for (const p of phrases) {
      if (t >= p.start && t <= p.end + 0.05) {
        active = p;
        break;
      }
    }
    if (!active) return null;

    const local = t - active.start;
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

  // Opening hook — yellow headline, fades out after 2.5s
  const HookOverlay: React.FC<{ text: string }> = ({ text }) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const t = frame / fps;
    if (!text || t > 2.5) return null;

    const opacity = interpolate(t, [0, 0.1, 2.0, 2.5], [0, 1, 1, 0], {
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
          paddingTop: 180,
        }}
      >
        {/* dark gradient bar behind hook text */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 360,
            background: "linear-gradient(180deg, rgba(0,0,0,0.72) 0%, rgba(0,0,0,0) 100%)",
            opacity,
          }}
        />
        <div
          style={{
            fontFamily: 'Inter, "Arial Black", sans-serif',
            fontWeight: 900,
            fontSize: 88,
            color: "#FFE600",
            textAlign: "center",
            textTransform: "uppercase",
            letterSpacing: 1.5,
            lineHeight: 1.05,
            WebkitTextStroke: "8px #000000",
            paintOrder: "stroke fill",
            textShadow: "0 6px 20px rgba(0,0,0,0.9)",
            transform: `scale(${scale})`,
            opacity,
            maxWidth: 960,
            zIndex: 2,
            position: "relative",
          }}
        >
          {text.toUpperCase()}
        </div>
      </AbsoluteFill>
    );
  };

  // Engagement question — slides up 8s before end, disappears when CTA starts
  const EngagementQuestion: React.FC<{
    text: string;
    showAtSeconds: number;
    hideAtSeconds: number;
  }> = ({ text, showAtSeconds, hideAtSeconds }) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const t = frame / fps;

    if (!text || t < showAtSeconds || t >= hideAtSeconds) return null;

    const local = t - showAtSeconds;
    const duration = hideAtSeconds - showAtSeconds;

    const slideUp = spring({
      frame: Math.round(local * fps),
      fps,
      config: { damping: 14, mass: 0.6, stiffness: 150 },
    });
    const translateY = 90 - 90 * slideUp;

    const opacity = interpolate(
      local,
      [0, 0.2, duration - 0.3, duration],
      [0, 1, 1, 0],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
    );

    return (
      <AbsoluteFill
        style={{
          justifyContent: "flex-end",
          alignItems: "center",
          paddingBottom: 300,
        }}
      >
        {/* dark bottom gradient for legibility */}
        <div
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            height: 400,
            background: "linear-gradient(0deg, rgba(0,0,0,0.78) 0%, rgba(0,0,0,0) 100%)",
            opacity: Math.min(1, opacity * 1.4),
          }}
        />
        <div
          style={{
            fontFamily: 'Inter, "Arial Black", sans-serif',
            fontWeight: 900,
            fontSize: 66,
            color: "#FFE600",
            textAlign: "center",
            textTransform: "uppercase",
            letterSpacing: 1,
            lineHeight: 1.12,
            WebkitTextStroke: "6px #000000",
            paintOrder: "stroke fill",
            textShadow: "0 4px 16px rgba(0,0,0,0.9)",
            transform: `translateY(${translateY}px)`,
            opacity,
            maxWidth: 900,
            padding: "0 60px",
            position: "relative",
            zIndex: 2,
          }}
        >
          {text.toUpperCase()}
        </div>
      </AbsoluteFill>
    );
  };

  // CTA Overlay — last 5 seconds, animated pill with dark gradient bar behind it
  const CTAOverlay: React.FC<{ text: string }> = ({ text }) => {
    const frame = useCurrentFrame();
    const { fps, durationInFrames } = useVideoConfig();
    const ctaDurationFrames = Math.round(fps * 5);
    const startFrame = Math.max(0, durationInFrames - ctaDurationFrames);
    if (frame < startFrame) return null;

    const local = frame - startFrame;

    // Background bar slides up from below
    const barSlide = spring({
      frame: local,
      fps,
      config: { damping: 18, mass: 0.7, stiffness: 200 },
    });
    const barTranslate = 140 - 140 * barSlide;

    // CTA text pops in ~5 frames after bar starts
    const textDelay = Math.max(0, local - 5);
    const pop = spring({
      frame: textDelay,
      fps,
      config: { damping: 12, mass: 0.5, stiffness: 180 },
    });
    const scale = 0.88 + 0.12 * pop;

    // Fade out gracefully in last 8 frames
    const opacity = interpolate(
      local,
      [0, 6, ctaDurationFrames - 8, ctaDurationFrames],
      [0, 1, 1, 0],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
    );

    return (
      <AbsoluteFill
        style={{
          justifyContent: "flex-end",
          alignItems: "center",
          paddingBottom: 130,
        }}
      >
        {/* Gradient backing so text pops over any background image */}
        <div
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            height: 460,
            background:
              "linear-gradient(0deg, rgba(0,0,0,0.88) 0%, rgba(0,0,0,0.55) 55%, rgba(0,0,0,0) 100%)",
            transform: `translateY(${barTranslate}px)`,
            opacity: Math.min(1, opacity * 1.5),
          }}
        />
        {/* CTA pill */}
        <div
          style={{
            fontFamily: 'Inter, "Arial Black", sans-serif',
            fontWeight: 900,
            fontSize: 70,
            color: "#FFFFFF",
            textAlign: "center",
            textTransform: "uppercase",
            letterSpacing: 2,
            lineHeight: 1.1,
            WebkitTextStroke: "5px #000000",
            paintOrder: "stroke fill",
            background:
              "linear-gradient(135deg, rgba(230,20,80,0.96), rgba(255,130,0,0.96))",
            padding: "26px 52px",
            borderRadius: 28,
            boxShadow:
              "0 14px 52px rgba(0,0,0,0.65), 0 0 0 3px rgba(255,255,255,0.18)",
            transform: `scale(${scale}) translateY(${barTranslate * 0.5}px)`,
            opacity,
            maxWidth: 960,
            position: "relative",
            zIndex: 10,
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
    engagementText,
    durationInSeconds,
  }) => {
    const { durationInFrames } = useVideoConfig();
    const sceneCount = Math.max(1, scenes.length);
    const sceneFrames = Math.ceil(durationInFrames / sceneCount);

    // Engagement question shows 8s before end; CTA takes over last 5s
    const dur = durationInSeconds || 60;
    const ctaStartSec = Math.max(dur - 5, 0);
    const qShowAtSec = Math.max(dur - 8, 0);
    const qHideAtSec = ctaStartSec;

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

        {/* Opening hook: bright yellow headline for first 2.5s */}
        <HookOverlay text={hookText} />

        {/* Word-by-word subtitles — hidden once engagement question appears */}
        <Subtitles words={words} hideAfterSeconds={qShowAtSec} />

        {/* Engagement question: slides up 8s before end, clears before CTA */}
        {engagementText ? (
          <EngagementQuestion
            text={engagementText}
            showAtSeconds={qShowAtSec}
            hideAtSeconds={qHideAtSec}
          />
        ) : null}

        {/* CTA overlay: branded pill + dark gradient, last 5 seconds */}
        <CTAOverlay text={cta} />

        <Audio src={staticFile(audioSrc)} />
        {hasMusic ? <Audio src={staticFile(musicSrc)} volume={0.06} /> : null}
      </AbsoluteFill>
    );
  };
  