import { Component, type ErrorInfo, type ReactNode } from 'react';

interface SurfaceBoundaryProps {
  /** Names the surface in the log: an object id, or the part of the stage. */
  surfaceId: string;
  /**
   * The value the content renders from, usually its scene object. The
   * surface stays degraded while this is unchanged and tries again when it
   * changes, so replacing a broken object with valid data brings it back.
   */
  resetKey: unknown;
  /** What stands in for the content after it throws; by default a label. */
  fallback?: ReactNode;
  children: ReactNode;
}

interface SurfaceBoundaryState {
  failed: boolean;
  resetKey: unknown;
}

// A render error unmounts everything up to the nearest boundary, and with
// none that is the whole page, the call runtime included. This keeps a
// throw to the surface that raised it: the frame and everything around it
// stay, and the surface reads as unavailable rather than blank.
export class SurfaceBoundary extends Component<SurfaceBoundaryProps, SurfaceBoundaryState> {
  state: SurfaceBoundaryState = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromProps(props: SurfaceBoundaryProps, state: SurfaceBoundaryState): Partial<SurfaceBoundaryState> | null {
    return Object.is(props.resetKey, state.resetKey) ? null : { failed: false, resetKey: props.resetKey };
  }

  static getDerivedStateFromError(): Partial<SurfaceBoundaryState> {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`Switchboard: ${this.props.surfaceId} failed to render; showing it as unavailable.`, error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return this.props.fallback ?? <div className="surface-unavailable tech micro">OBJECT / UNAVAILABLE</div>;
  }
}
