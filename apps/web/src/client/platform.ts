export type DesktopCodexLoginState = {
  status: "idle" | "launching" | "waiting" | "completed" | "error";
  message: string;
  recentLines: string[];
  verificationUri?: string;
  userCode?: string;
  updatedAt: string;
};

export type StuartDesktopBridge = {
  isDesktop: true;
  isPackaged: boolean;
  platform: string;
  appVersion: string;
  apiOrigin: string;
  /** Synchronous main-process origin (required for correct API URL in packaged Electron). */
  getApiOriginSync?: () => string;
  pickFolder: () => Promise<string | null>;
  openExternal: (url: string) => Promise<boolean>;
  startCodexLogin: () => Promise<boolean>;
  getCodexLoginState: () => Promise<DesktopCodexLoginState>;
  restartServer: () => Promise<boolean>;
  showInFolder: (filePath: string) => Promise<boolean>;
  encryptToken: (plaintext: string) => Promise<{ encrypted: string | null; fallback: string | null }>;
  decryptToken: (encryptedBase64: string) => Promise<string>;
};

declare global {
  interface Window {
    stuartDesktop?: StuartDesktopBridge;
  }
}

export function getDesktopBridge(): StuartDesktopBridge | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  return window.stuartDesktop;
}

export function isDesktopApp(): boolean {
  return Boolean(getDesktopBridge()?.isDesktop);
}

export function getApiOrigin(): string {
  if (typeof window === "undefined") {
    return "";
  }

  const bridge = getDesktopBridge();
  if (bridge?.getApiOriginSync) {
    try {
      const fromMain = bridge.getApiOriginSync();
      if (typeof fromMain === "string" && /^https?:\/\//i.test(fromMain.trim())) {
        return fromMain.replace(/\/$/, "");
      }
    } catch {
      // fall through
    }
  }

  const fromLocation =
    window.location.protocol === "http:" || window.location.protocol === "https:"
      ? window.location.origin.replace(/\/$/, "")
      : "";

  /*
   * Desktop dev loads the UI from Vite (STUART_UI_PORT, e.g. 5173) while the harness runs on
   * STUART_API_ORIGIN (e.g. 8787). window.location.origin would send /api through Vite's proxy;
   * that often works in a normal browser but is flaky in Electron (citations, search, SSE).
   * Call the harness directly; the server enables CORS for local dev.
   *
   * Packaged desktop serves UI + API from one origin — ports match, so we still use fromLocation.
   */
  if (bridge?.isDesktop && !bridge.isPackaged && bridge.apiOrigin) {
    const api = bridge.apiOrigin.replace(/\/$/, "");
    try {
      if (fromLocation) {
        const uiUrl = new URL(fromLocation);
        const apiUrl = new URL(api);
        if (uiUrl.port !== apiUrl.port || uiUrl.hostname !== apiUrl.hostname) {
          return api;
        }
      }
    } catch {
      // fall through to fromLocation / bridge
    }
  }

  if (fromLocation) {
    return fromLocation;
  }

  if (bridge?.apiOrigin) {
    return bridge.apiOrigin.replace(/\/$/, "");
  }

  if (window.location.protocol === "file:") {
    return "http://127.0.0.1:8787";
  }

  return "";
}

export function apiUrl(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const base = getApiOrigin();
  return base ? `${base}${normalized}` : normalized;
}

export function openExternalUrl(url: string): Promise<boolean> {
  const bridge = getDesktopBridge();
  if (bridge) {
    return bridge.openExternal(url);
  }

  window.open(url, "_blank", "noopener,noreferrer");
  return Promise.resolve(true);
}
