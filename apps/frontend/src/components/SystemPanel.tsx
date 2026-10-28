import type { ChangeEvent } from 'react';
import type { LineControls } from '../controller/context';
import type { SelectOption } from '../runtime/lineStatus';
import { ReturnControl } from '../primitives/ReturnControl';

/**
 * The system view's panel (#277): the line the caller is on and the
 * controls the call runtime holds for it -- the route (a project, or the
 * operator), the model and thinking level of the leg, and the hangup that
 * asks nobody (README.md, "Getting unstuck"). It draws what the runtime
 * reports and acts only through it: the runtime locks a picker while a
 * request runs and posts each one with the epoch the page holds, so a
 * picker here cannot act on a leg the caller never saw (#263). A pick is
 * not shown as made until the line's next `status` says it was. On the
 * demo page there is no call, and the panel says so.
 */
export function SystemPanel({ line, onExit }: { line: LineControls | undefined; onExit: () => void }) {
  return (
    <section className="system" aria-label="Line controls">
      <div className="system__header tech micro">
        <span>SYSTEM / LINE</span>
        <ReturnControl label="EXIT / ESC" onClose={onExit} />
      </div>
      {line ? <LineBody line={line} /> : <div className="system__none tech micro">NO CALL / NOTHING TO SWITCH</div>}
    </section>
  );
}

function LineBody({ line }: { line: LineControls }) {
  // With the socket down no control can reach the service.
  const down = !line.connected;
  return (
    <>
      <div className="system__line">
        <span className="system__label tech micro">ON THE LINE</span>
        <span className="system__who">{line.routeLabel}</span>
      </div>
      <Picker name="route" label="ROUTE" value={line.route} options={line.routes} disabled={down || line.routeDisabled} onPick={line.selectRoute} />
      <Picker name="model" label="MODEL" value={line.model} options={line.models} disabled={down || line.modelDisabled} title={line.modelTitle} onPick={line.selectModel} />
      <Picker name="thinking" label="THINKING" value={line.thinking} options={line.thinkingLevels} disabled={down || line.thinkingDisabled} onPick={line.selectThinking} />
      <div className="system__row">
        <span className="system__label tech micro">HANG UP</span>
        <div className="system__hangup-cell">
          <button className="system__hangup tech micro" type="button" disabled={down} onClick={line.hangup}>HANG UP</button>
          <span className="system__note">
            {line.onProject
              ? `Drops ${line.routeLabel} and puts you back with the operator.`
              : 'Cuts the operator off. It starts fresh when you speak again.'}
          </span>
        </div>
      </div>
      <div className={`system__status tech micro${line.statusError ? ' system__status--error' : ''}`} role="status">
        STATUS / {line.status}
      </div>
    </>
  );
}

function Picker({
  name,
  label,
  value,
  options,
  disabled,
  title,
  onPick,
}: {
  name: string;
  label: string;
  value: string;
  options: SelectOption[];
  disabled: boolean;
  title?: string;
  onPick: (value: string) => void;
}) {
  return (
    <label className="system__row">
      <span className="system__label tech micro">{label}</span>
      <span className="system__picker">
        <select
          className="system__select"
          name={name}
          value={value}
          disabled={disabled || options.length === 0}
          title={title || undefined}
          onChange={(event: ChangeEvent<HTMLSelectElement>) => onPick(event.target.value)}
        >
          {options.length === 0 ? <option value="">NONE</option> : null}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </span>
    </label>
  );
}
