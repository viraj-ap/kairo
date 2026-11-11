declare module 'node-turn' {
  export default class Turn {
    constructor(opts: Record<string, unknown>);
    start(): void;
    stop(): void;
  }
}
