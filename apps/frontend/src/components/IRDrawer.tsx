import { useController } from '../controller/context';
// Closed, or behind the focus layer (a modal), the drawer is inert: out of the tab order.
export function IRDrawer({ open, onClose, behindFocus = false }: { open: boolean; onClose: () => void; behindFocus?: boolean }) {
  const { state } = useController();
  return <aside className={`ir-drawer${open?' ir-drawer--open':''}`} aria-hidden={!open} inert={!open || behindFocus}><div className="ir-drawer__head tech micro"><span>SCENE IR / LIVE</span><button type="button" onClick={onClose}>CLOSE</button></div><pre>{JSON.stringify(state,null,2)}</pre></aside>;
}
