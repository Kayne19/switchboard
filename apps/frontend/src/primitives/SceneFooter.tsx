/**
 * The band across a page's foot: a caption on the right, and a label on the
 * left where a page has one. The call page's scenes have none -- the corner
 * there carries the CHANNEL / MODE stack instead (#180, `ChannelStack`) --
 * and the debug page labels both ends.
 */
export function SceneFooter({ left, right }: { left?: string; right: string }) {
  return (
    <div className="scene-footer tech micro" aria-hidden="true">
      {left === undefined ? null : <span>{left}</span>}
      <span>{right}</span>
    </div>
  );
}
