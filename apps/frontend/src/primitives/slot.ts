/**
 * Where an object is drawn: the one prop by which a primitive draws for its
 * place (`renderObject`, components/renderObject.tsx, gives every object
 * its own). A primitive given none is the primary.
 * - `primary`: the scene's main slot, under the scene frame, which already
 *   names the object, so its own meta line leaves the title out (MetaTitle);
 * - `aux`: a cell in the aux row beside the primary, where a list is
 *   compact;
 * - `focus`: the focus layer, the object given the stage.
 * Metrics and progress also stand in the rail beside the main column
 * (`'rail'`), read there as one stack of instruments.
 */
export type Slot = 'primary' | 'aux' | 'focus';
