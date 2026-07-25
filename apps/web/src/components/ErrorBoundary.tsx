import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Optional label to identify which surface failed. */
  surface?: string;
}
interface State {
  error: Error | null;
}

/** Catches render errors in a subtree so one broken panel/dialog can't blank the app. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[hypergate] ${this.props.surface ?? 'UI'} crashed`, error, info);
  }

  reset = (): void => this.setState({ error: null });

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="panel error-boundary" role="alert">
          <div className="empty">
            <div className="cat">💥</div>
            <b>Something went wrong{this.props.surface ? ` in ${this.props.surface}` : ''}.</b>
            <div className="small" style={{ marginTop: 4 }}>{this.state.error.message}</div>
            <div style={{ marginTop: 14 }}>
              <button className="btn btn-primary" onClick={this.reset}>Try again</button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
