import React from "react";
import { Composition } from "remotion";
import { ViralVideo, calcMetadata, defaultProps } from "./ViralVideo";

const FPS = 30;
const WIDTH = 1080;
const HEIGHT = 1920;

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="ViralVideo"
        component={ViralVideo}
        width={WIDTH}
        height={HEIGHT}
        fps={FPS}
        durationInFrames={1800}
        defaultProps={defaultProps}
        calculateMetadata={calcMetadata}
      />
    </>
  );
};
