declare module "node-windows" {
  export class Service {
    constructor(options: { name: string; description: string; script: string });
    install(): void;
    start(): void;
    on(event: "install" | "start" | "error", handler: () => void): void;
  }
}
