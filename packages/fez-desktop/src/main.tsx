import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

/**
 * The last line of defense: any render throw above this used to unmount
 * everything — a white window with the reason visible only in a devtools
 * console no end user has open. Extension surfaces carry their own
 * boundaries; this one exists for our own bugs.
 */
class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error?: Error }
> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="boot error">
          <div>
            <p>fez hit a rendering bug: {this.state.error.message}</p>
            <button className="agent-action" onClick={() => this.setState({ error: undefined })}>
              try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>,
);
