/**
 * Where an object is drawn (`renderObject` in components/renderObject.tsx):
 * - `primary`: the scene's main slot, under the scene frame, which already
 *   names the object, so its own meta line leaves the title out (MetaTitle);
 * - `aux`: a cell in the aux row beside the primary, where a list is
 *   compact;
 * - `focus`: the focus layer, the object given the stage.
 */
export type Slot = 'primary' | 'aux' | 'focus';
