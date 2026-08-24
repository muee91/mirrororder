import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Desktop v2 render failure", error, info);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <main className="fatal-error">
          <p className="eyebrow">Desktop v2</p>
          <h1>界面渲染失败</h1>
          <p>{this.state.error.message}</p>
          <button type="button" onClick={() => window.location.reload()}>
            重新加载
          </button>
        </main>
      );
    }
    return this.props.children;
  }
}
