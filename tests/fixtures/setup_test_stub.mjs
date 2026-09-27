export class BorderedLoader {
  controller = new AbortController();
  get signal() { return this.controller.signal; }
  onAbort;
  dispose() {}
}
