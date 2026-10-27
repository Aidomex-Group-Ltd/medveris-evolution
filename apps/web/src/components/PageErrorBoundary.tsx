import { Component, type ErrorInfo, type ReactNode } from "react";
import { ErrorState } from "@medveris/ui";

interface Props {
  children: ReactNode;
}

interface State {
  failed: boolean;
}

/** Keeps the application shell usable when a single workspace fails to render. */
export class PageErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("workspace render failed", error.message, info.componentStack?.split("\n")[1]?.trim());
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return <ErrorState message="This workspace could not be displayed. Reload the page or choose another workspace." onRetry={() => this.setState({ failed: false })} />;
    }
    return this.props.children;
  }
}
