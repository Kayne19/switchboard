import { useController } from '../controller/context';
export function IRDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state } = useController();
  return <aside className={`ir-drawer${open?' ir-drawer--open':''}`} aria-hidden={!open}><div className="ir-drawer__head tech micro"><span>SCENE IR / LIVE</span><button type="button" onClick={onClose}>CLOSE</button></div><pre>{JSON.stringify(state,null,2)}</pre></aside>;
}
