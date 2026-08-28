declare module "@novnc/novnc" {
  export default class RFB {
    constructor(target: HTMLElement, url: string, options?: { viewOnly?: boolean; credentials?: unknown });
    disconnect(): void;
    addEventListener(event: string, handler: (e: any) => void): void;
    removeEventListener(event: string, handler: (e: any) => void): void;
  }
}
