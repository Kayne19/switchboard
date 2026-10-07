import { AnimatePresence, motion } from 'motion/react';
import { useLayoutEffect, useRef, type MouseEvent } from 'react';
import type { ControllerState, NoteData, SceneObject } from '../controller/types';
import { noteTarget } from '../app/noteItems';
import { anchoredNote, objectsOfType } from '../app/sceneModel';
import { AnnotationCard } from '../primitives/AnnotationCard';
import { useLayoutMotion } from '../hooks/useLayoutMotion';
import { ObjectView } from './renderObject';
import { SurfaceBoundary } from './SurfaceBoundary';

/**
 * The notes focus keeps beside an object: the ones the scene draws about
 * it, so a note never goes when its object takes the stage. On a chart,
 * every note that names it (the scene lays each one over it); on any other
 * object, the first note that names it (`anchoredNote`, the one the rail
 * shows when the object is the primary). Focus gives the
 * object the stage and the rail goes, so the notes come with it, in a panel
 * of their own beside or under it, and what they name stays marked in it:
 * a chart's bar its outline and printed value, a point its ring, a diagram's node
 * or actor, a list's item, its NOTE marker, the view opening on it. A
 * focused note has none: it is the note.
 */
export function focusNotes(state: ControllerState, object: SceneObject | null): Array<SceneObject<NoteData>> {
  if (!object || object.type === 'note') return [];
  const notes = objectsOfType<NoteData>(state, 'note');
  if (object.type === 'chart') return notes.filter((note) => note.data.anchor?.target === object.id);
  const note = anchoredNote(notes, object.id);
  return note ? [note] : [];
}

// Where the notes stand is the focus box's geometry, in the stylesheet
// (`.focus-layer__content--noted`): beside a wide object, as the rail is,
// and under a tall one. Each card names what its note is about in the
// object's words, as the rail card does (`noteTarget`).
export function FocusLayer({
  object,
  objects,
  notes = [],
  onClose,
}: {
  object: SceneObject | null;
  /** Every object on stage, by id: a card names the one its note is about (`noteTarget`). */
  objects: Readonly<Record<string, SceneObject>>;
  notes?: Array<SceneObject<NoteData>>;
  onClose: () => void;
}) {
  const noted = notes.length > 0;
  // The focused object shares its identity with the object in its slot.
  const shared = useLayoutMotion({ layoutId: object ? `switchboard-object-${object.id}` : undefined });
  const returnButton = useModalFocus(object !== null);
  return (
    <AnimatePresence>
      {object ? (
        <motion.div
          className="focus-layer"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.22 }}
          role="dialog"
          aria-modal="true"
          aria-label={`Focused ${object.type}`}
          onMouseDown={(event: MouseEvent<HTMLDivElement>) => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          <motion.div
            className={`focus-layer__content focus-layer__content--${object.type}${noted ? ' focus-layer__content--noted' : ''}`}
            {...shared}
            transition={{ layout: { duration: 0.46, ease: [0.22, 0.61, 0.36, 1] } }}
          >
            <div className="focus-layer__header tech micro">
              <span>FOCUS / {object.type.toUpperCase()}</span>
              <button ref={returnButton} className="focus-layer__return" type="button" onClick={onClose}>RETURN / ESC</button>
            </div>
            <SurfaceBoundary surfaceId={object.id} resetKey={object}>
              <ObjectView object={object} slot="focus" onStage={objects} notes={notes.map((note) => note.data)} />
            </SurfaceBoundary>
            {noted ? (
              <aside className="focus-layer__note" data-notes={notes.length}>
                {notes.map((note) => (
                  <SurfaceBoundary key={note.id} surfaceId={note.id} resetKey={note}>
                    <AnnotationCard data={note.data} named={noteTarget(objects, note.data)} />
                  </SurfaceBoundary>
                ))}
              </aside>
            ) : null}
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

/**
 * The focus layer is a modal dialog, and focus acts as one: it moves to
 * RETURN as the layer opens, stays in the layer (everything behind it is
 * `inert` while it is open: the scene, SceneShell `behindFocus`; the
 * history, TranscriptDrawer; on the demo page the CTRL button, both panels
 * and the scene keys, App), and goes back to what held it before when the
 * layer closes: the surface that was activated, or the field the caller was
 * typing in when the agent opened it. Focus opened with nothing held gives
 * focus back to nothing. Before, the layer only said it was modal: Tab
 * walked on into the stage behind the backdrop.
 *
 * The holder is read in a layout effect, in the commit that opens the
 * layer: that commit makes it inert (or hides it), and the browser then
 * moves focus to the body before a passive effect would run for an
 * update the agent sent.
 */
function useModalFocus(open: boolean) {
  const returnButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const held = document.activeElement;
    const opener = held instanceof HTMLElement && held !== document.body ? held : null;
    // RETURN draws the page's ring only when the keyboard opened the layer:
    // focus the agent opened, or a tap, leaves the ring off until a key. A
    // text field always matches :focus-visible, so it says nothing of a key.
    const keyed = Boolean(opener?.matches(':focus-visible') && !opener.matches('input, textarea'));
    returnButton.current?.focus({ preventScroll: true, focusVisible: keyed } as FocusOptions);
    return () => {
      if (!opener) return;
      // Where motion's shared identity hides the slot copy, it shows again
      // when the layout animation lets it go, a frame or the rest of the
      // animation later: try each frame until it takes focus, while focus
      // has gone nowhere else, for at most a second.
      let frames = 0;
      const giveBack = () => {
        if (!opener.isConnected || leaving(opener)) return;
        const active = document.activeElement;
        if (active && active !== document.body && !active.closest('.focus-layer')) return;
        opener.focus({ preventScroll: true });
        if (document.activeElement !== opener && (frames += 1) < 60) requestAnimationFrame(giveBack);
      };
      // After the commit: React puts back the focus it saw before a commit's
      // DOM changes once they are made, and a layout effect's cleanup runs
      // among them, so a focus given here would be undone.
      queueMicrotask(giveBack);
    };
  }, [open]);
  return returnButton;
}

/** Whether `element` is in a scene that is leaving: the stage draws the scene it goes to after it. */
function leaving(element: Element): boolean {
  const scene = element.closest('.stage > [data-scene]');
  return scene !== null && scene !== [...document.querySelectorAll('.stage > [data-scene]')].at(-1);
}
