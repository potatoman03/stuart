import { describe, expect, it } from "vitest";
import { computeMainWindowSize } from "../../apps/desktop/src/window-sizing";

describe("computeMainWindowSize", () => {
  it("keeps the desktop window resizable on a typical laptop display", () => {
    expect(computeMainWindowSize({ width: 1440, height: 900 })).toEqual({
      width: 1180,
      height: 792,
      minWidth: 720,
      minHeight: 560,
    });
  });

  it("caps the initial size on very large displays", () => {
    expect(computeMainWindowSize({ width: 2560, height: 1600 })).toEqual({
      width: 1400,
      height: 960,
      minWidth: 720,
      minHeight: 560,
    });
  });

  it("never drops below the smaller desktop minimum size", () => {
    expect(computeMainWindowSize({ width: 640, height: 480 })).toEqual({
      width: 720,
      height: 560,
      minWidth: 720,
      minHeight: 560,
    });
  });
});
