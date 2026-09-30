export type SearchResult = {
  name: string;
  path: string;
  kind: "file" | "folder";
};

export type DragPayload = {
  paths?: string[];
};

export type GrokBallEngine = {
  setEmotion: (id: string, options?: { auto?: boolean }) => boolean;
  setGaze: (x: number, y: number) => GrokBallEngine;
  clearGaze: () => GrokBallEngine;
  bounce: () => GrokBallEngine;
  burst: (count?: number) => GrokBallEngine;
  spin: (turns?: number, direction?: -1 | 1) => GrokBallEngine;
};

export type RemoteEntry = {
  name: string;
  path: string;
  kind: "file" | "folder";
  size: number;
  modified?: number;
};

export type SshPrepare = {
  attemptId: string;
  host: string;
  port: number;
  username: string;
  fingerprint: string;
  authMethods: string[];
  trusted: boolean;
};

export type SftpTransferEvent = {
  kind?: "upload" | "download";
  status?: string;
  path?: string;
  paths?: string[];
  transferredBytes?: number;
  totalBytes?: number;
  error?: string;
  failures?: string[];
};

declare global {
  interface Window {
    GrokBall?: {
      create: (
        target: Element,
        options?: {
          emotion?: string;
          color?: string;
          eyeColor?: string;
          shape?: "blob" | "wedge" | "gem";
          label?: string;
          idle?: boolean;
        },
      ) => GrokBallEngine;
    };
  }
}
