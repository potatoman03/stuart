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
  pickFolder: () => Promise<string | null>;
  openExternal: (url: string) => Promise<boolean>;
  startCodexLogin: () => Promise<boolean>;
  getCodexLoginState: () => Promise<DesktopCodexLoginState>;
  restartServer: () => Promise<boolean>;
  showInFolder: (filePath: string) => Promise<boolean>;
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
