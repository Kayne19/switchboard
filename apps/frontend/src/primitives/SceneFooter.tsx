export function SceneFooter({ left, right }: { left: string; right: string }) {
  return <div className="scene-footer tech micro" aria-hidden="true"><span>{left}</span><span>{right}</span></div>;
}
