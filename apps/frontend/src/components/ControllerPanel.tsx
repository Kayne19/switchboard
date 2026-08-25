import { useRef, useState, type ChangeEvent } from 'react';
import { useController } from '../controller/context';
import { assertControllerAction } from '../controller/validation';
import { previousRunAction } from '../fixtures/scenes';

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function ControllerPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, dispatch, loadFixture } = useController();
  const [input, setInput] = useState('{"op":"show","id":"gpu","type":"metric","data":{"label":"GPU","value":"94%"}}');
  const [error, setError] = useState<string | null>(null);
  const demoToken = useRef(0);

  const send = () => {
    try {
      const action = assertControllerAction(JSON.parse(input));
      dispatch(action);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Invalid action');
    }
  };

  const runDemo = async () => {
    const token = ++demoToken.current;
    loadFixture('training');
    await delay(700);
    if (token !== demoToken.current) return;
    dispatch({ op: 'show', id: 'gpu', type: 'metric', data: { label: 'GPU', value: '94%' } });
    await delay(700);
    if (token !== demoToken.current) return;
    dispatch({ op: 'say', target: 'loss', at: { x: 32, series: 'VAL LOSS' }, text: 'Validation begins diverging here. The training curve is still descending normally.' });
    await delay(800);
    if (token !== demoToken.current) return;
    dispatch(previousRunAction);
    await delay(900);
    if (token !== demoToken.current) return;
    dispatch({ op: 'hide', id: 'gpu' });
  };

  return (
    <aside className={`controller-panel${open ? ' controller-panel--open' : ''}`} aria-hidden={!open}>
      <div className="controller-panel__head tech micro">
        <span>V17.2 / CONTROLLER</span>
        <button type="button" onClick={onClose}>CLOSE</button>
      </div>
      <div className="controller-panel__grid">
        <button type="button" onClick={() => loadFixture('training')}>LOAD TRAINING</button>
        <button type="button" onClick={() => dispatch({ op: 'show', id: 'gpu', type: 'metric', data: { label: 'GPU', value: '94%' } })}>+ GPU</button>
        <button type="button" onClick={() => dispatch({ op: 'focus', id: 'loss' })}>FOCUS LOSS</button>
        <button type="button" onClick={() => dispatch({ op: 'say', target: 'loss', at: { x: 32, series: 'VAL LOSS' }, text: 'Validation begins diverging here. The training curve is still descending normally.' })}>ANNOTATE</button>
        <button type="button" onClick={() => dispatch(previousRunAction)}>+ PREVIOUS RUN</button>
        <button type="button" onClick={() => dispatch({ op: 'hide', id: 'gpu' })}>- GPU</button>
        <button type="button" onClick={() => dispatch({ op: 'listen', on: !state.listening })}>LISTEN</button>
        <button type="button" onClick={() => dispatch({ op: 'clear' })}>CLEAR</button>
      </div>
      <button className="controller-panel__demo" type="button" onClick={runDemo}>RUN MOTION DEMO</button>
      <label className="controller-panel__label tech micro" htmlFor="raw-action">RAW ACTION / JSON</label>
      <textarea id="raw-action" value={input} onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setInput(event.target.value)} />
      <button className="controller-panel__send" type="button" onClick={send}>DISPATCH</button>
      {error ? <div className="controller-panel__error tech micro">ERROR / {error}</div> : null}
      <pre className="controller-panel__state">{JSON.stringify(state, null, 2)}</pre>
    </aside>
  );
}
