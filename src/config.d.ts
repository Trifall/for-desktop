declare type DesktopConfig = {
  firstLaunch: boolean;
  customFrame: boolean;
  minimiseToTray: boolean;
  spellchecker: boolean;
  hardwareAcceleration: boolean;
  discordRpc: boolean;
  pushToTalk: boolean;
  pushToTalkKeybind: string;
  pushToTalkMode: "hold" | "toggle";
  windowState: {
    x: number;
    y: number;
    width: number;
    height: number;
    isMaximised: boolean;
  };
};

declare interface Window {
  desktopConfig: {
    get: () => DesktopConfig;
    set: (config: DesktopConfig) => void;
    getAutostart: () => Promise<boolean>;
    setAutostart: (value: boolean) => Promise<boolean>;
  };
  native: {
    versions: {
      node: () => string;
      chrome: () => string;
      electron: () => string;
      desktop: () => string;
    };
    minimise: () => void;
    maximise: () => void;
    close: () => void;
    setBadgeCount: (count: number) => void;
  };
  pushToTalk: {
    onStateChange: (callback: (state: { active: boolean }) => void) => void;
    offStateChange: (callback: (state: { active: boolean }) => void) => void;
    setManualState: (active: boolean) => void;
    getCurrentState: () => { active: boolean };
    isAvailable: () => boolean;
  };
}
