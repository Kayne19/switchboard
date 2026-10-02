import { clockTime, formatMs } from '../explain';
import type { DebugState } from '../reducer';
import type { PaneSelect } from '../AgentPane';

export function FloorPanel({ state, select }: { state: DebugState; select: PaneSelect }) {
  const floors = state.floorOrder
    .map((id) => state.floors[id])
    .filter(Boolean)
    .reverse();
  return (
    <div className="panel">
      <div className="panel-bar">
        <h2>Floor gate</h2>
        <span className="muted">
          {floors.filter((floor) => !floor.released).length} waiting · {floors.length} total
        </span>
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th>time</th>
            <th>agent</th>
            <th>message</th>
            <th>gate answers</th>
            <th>rewrite</th>
            <th>released</th>
            <th>spoken</th>
            <th>waited</th>
          </tr>
        </thead>
        <tbody>
          {floors.map((floor) => (
            <tr key={floor.id} onClick={() => select.floor(floor.id)} className={floor.released ? '' : 'open'}>
              <td className="mono">{clockTime(floor.firstTs)}</td>
              <td>{floor.agent}</td>
              <td>{floor.message}</td>
              <td className="mono">
                {floor.gates.length === 0
                  ? '—'
                  : floor.gates.map((gate) => (
                      <span key={gate.seq} className={`gate-${gate.answer}`}>
                        {gate.answer} {formatMs(gate.latency_ms)}{' '}
                      </span>
                    ))}
              </td>
              <td>{floor.rewrite ? `“${floor.rewrite.rewritten}” (${formatMs(floor.rewrite.latency_ms)})` : '—'}</td>
              <td>{floor.released?.how ?? <span className="blink">waiting</span>}</td>
              <td>{floor.speech ? (floor.speech.delivered ? 'yes' : `no${floor.speech.reason ? `: ${floor.speech.reason}` : ''}`) : '—'}</td>
              <td className="mono">{formatMs((floor.released?.timestamp_ms ?? floor.lastTs) - floor.firstTs)}</td>
            </tr>
          ))}
          {floors.length === 0 && (
            <tr>
              <td colSpan={8} className="muted">
                No agent has asked for the floor yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
