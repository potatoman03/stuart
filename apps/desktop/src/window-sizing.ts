export type WindowSize = {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
};

export function computeMainWindowSize(workArea: { width: number; height: number }): WindowSize {
  const minWidth = 720;
  const minHeight = 560;
  const width = Math.max(minWidth, Math.min(1400, Math.floor(workArea.width * 0.82)));
  const height = Math.max(minHeight, Math.min(960, Math.floor(workArea.height * 0.88)));

  return {
    width,
    height,
    minWidth,
    minHeight,
  };
}
