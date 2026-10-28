import { AnimatePresence, motion, type HTMLMotionProps } from 'motion/react';
import { useRef, type MouseEvent, type RefObject } from 'react';
import type { ControllerState, NoteData, SceneObject } from '../controller/types';
import { noteTarget } from '../app/noteItems';
import { anchoredNote, objectsOfType } from '../app/sceneModel';
import { AnnotationCard } from '../primitives/AnnotationCard';
import { ReturnControl } from '../primitives/ReturnControl';
import { useLayoutMotion } from '../hooks/useLayoutMotion';
import { useModalFocus } from '../hooks/useModalFocus';
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
/**
 * An object at the size focus gives it, with the notes about it and a
 * header line: what it is, and the one way out. Focus draws it over the
 * scene; the theater view draws it as the scene (`TheaterScene` in
 * Scenes.tsx), so the two cannot drift on how a staged object reads. The
 * theater's box carries its own class names beside focus's, for its
 * placement in the scene.
 */
export function StagedObject({
  object,
  objects,
  notes,
  label,
  action,
  onAction,
  actionRef,
  variant,
  motionProps,
}: {
  object: SceneObject;
  objects: Readonly<Record<string, SceneObject>>;
  notes: Array<SceneObject<NoteData>>;
  /** The header's left words. */
  label: string;
  /** The words of the way out, on the header's right. */
  action: string;
  onAction: () => void;
  actionRef?: RefObject<HTMLButtonElement | null>;
  variant: 'focus' | 'theater';
  motionProps?: HTMLMotionProps<'div'>;
}) {
  const noted = notes.length > 0;
  const theater = variant === 'theater';
  return (
    <motion.div
      className={`focus-layer__content focus-layer__content--${object.type}${noted ? ' focus-layer__content--noted' : ''}${theater ? ' theater__box' : ''}`}
      {...motionProps}
    >
      <div className={`focus-layer__header tech micro${theater ? ' theater__header' : ''}`}>
        <span>{label}</span>
        <ReturnControl label={action} onClose={onAction} buttonRef={actionRef} />
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
  );
}

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
  // The focused object shares its identity with the object in its slot.
  const shared = useLayoutMotion({ layoutId: object ? `switchboard-object-${object.id}` : undefined });
  const returnButton = useRef<HTMLButtonElement>(null);
  useModalFocus(object !== null, '.focus-layer', returnButton);
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
          <StagedObject
            object={object}
            objects={objects}
            notes={notes}
            label={`FOCUS / ${object.type.toUpperCase()}`}
            action="RETURN / ESC"
            onAction={onClose}
            actionRef={returnButton}
            variant="focus"
            motionProps={{ ...shared, transition: { layout: { duration: 0.46, ease: [0.22, 0.61, 0.36, 1] } } }}
          />
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
