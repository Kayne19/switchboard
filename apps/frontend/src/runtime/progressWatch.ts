// The silence watch: is a clip that is meant to be sounding sounding?

/**
 * Watches the element's `currentTime` while a clip is meant to be sounding:
 * every `ms` it has to have moved. One that has not is stalled, whether
 * before its first sound (WebKit leaving a MediaSource it cannot play
 * pending, #203) or partway (#213), and `onStall` is told which.
 * `stillArriving` lets a stream hold the watch while its bytes are still
 * landing. `ms` 0 turns the watch off.
 */
export class ProgressWatch {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    position: () => number,
    ms: number,
    onStall: (heard: boolean) => void,
    stillArriving?: () => boolean,
  ) {
    if (ms <= 0) return;
    let heard = false;
    let last = position();
    const check = () => {
      this.timer = null;
      const now = position();
      const arriving = stillArriving?.() ?? false;
      if (now > last) {
        heard = true;
        last = now;
      } else if (!arriving) {
        onStall(heard);
        return;
      }
      this.timer = setTimeout(check, ms);
    };
    this.timer = setTimeout(check, ms);
  }

  cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
