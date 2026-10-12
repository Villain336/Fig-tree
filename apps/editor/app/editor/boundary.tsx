"use client";

import { Component, type ReactNode } from "react";

/** Keeps a failing panel from taking the whole editor down; shows the error in its place. */
export class PanelBoundary extends Component<{ name: string; children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error): void {
    console.error(`${this.props.name} failed`, error);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="p-3 text-[11px] text-red-700" role="alert" data-testid="panel-error">
          {this.props.name} failed: {this.state.error.message}
          <button type="button" className="ml-2 underline" data-anchor-exempt="" onClick={() => this.setState({ error: null })}>
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
