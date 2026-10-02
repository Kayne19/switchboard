import { clockTime } from '../explain';
import type { DebugState } from '../reducer';

export function AgentsPanel({ state }: { state: DebugState }) {
  const agentStates = new Map(state.agents.map((agent) => [agent.project, agent]));
  const hosts = Object.values(state.hosts).sort((a, b) => a.host.localeCompare(b.host));
  const call = state.calls[state.calls.length - 1];
  return (
    <div className="panel">
      <div className="panel-bar">
        <h2 className="tech">Agents & hosts</h2>
        {call && (
          <span className="tech micro muted">
            call {call.callId} / {call.endTs ? `ended ${clockTime(call.endTs)}${call.reason ? ` (${call.reason})` : ''}` : 'live'}
          </span>
        )}
      </div>
      <div className="cards">
        {state.paneOrder.map((agent) => {
          const pane = state.panes[agent];
          const info = agentStates.get(agent);
          const turns = state.turns.filter((turn) => turn.agent === agent);
          return (
            <div key={agent} className="card agent-card">
              <div className="card-head">
                <span className="card-title tech">{agent}</span>
                {info && <span className={`pane-state tech micro state-${info.state}`}>{info.state}</span>}
              </div>
              <div className="kv">
                {turns.length} turns / {pane?.tools ?? 0} tools / {pane?.items.length ?? 0} items
              </div>
              <div className="kv muted">{pane?.openTurn ? `in turn ${pane.openTurn}` : 'no open turn'}</div>
              {pane && pane.lastTs > 0 && <div className="kv muted">last activity {clockTime(pane.lastTs)}</div>}
              {info?.pending_request && <div className="kv semantic-orange">pending: “{info.pending_request.message}”</div>}
            </div>
          );
        })}
      </div>
      <h3 className="sub-h tech micro">Host links</h3>
      <table className="grid">
        <thead>
          <tr>
            <th>host</th>
            <th>link</th>
            <th>since</th>
            <th>recent changes</th>
          </tr>
        </thead>
        <tbody>
          {hosts.map((host) => (
            <tr key={host.host}>
              <td>{host.host}</td>
              <td className={host.connected ? 'semantic-green' : 'semantic-red'}>{host.connected ? 'connected' : 'down'}</td>
              <td className="mono">{clockTime(host.sinceTs)}</td>
              <td className="mono">
                {host.flips.slice(-6).map((flip) => (
                  <span key={flip.ts} className={flip.connected ? 'semantic-green' : 'semantic-red'}>
                    {flip.connected ? '▲' : '▼'}
                    {clockTime(flip.ts).slice(0, 8)}{' '}
                  </span>
                ))}
              </td>
            </tr>
          ))}
          {hosts.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                No host link events yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
