/**
 * JSX namespace bridge. @types/react v19 keeps its JSX types under
 * `React.JSX` — the GLOBAL `JSX` namespace was removed — and classic
 * jsx-factory mode (`--jsx-factory=h`, the shape that shares the host's
 * one React) gives the compiler nowhere else to look: it checks the
 * factory's own namespace, then global JSX, and finds neither. This
 * re-exports React's JSX types as the global the compiler expects.
 * Types only — nothing exists at runtime.
 */
import type { JSX as ReactJSX } from "react";

declare global {
  namespace JSX {
    type Element = ReactJSX.Element;
    interface ElementClass extends ReactJSX.ElementClass {}
    interface ElementAttributesProperty extends ReactJSX.ElementAttributesProperty {}
    interface ElementChildrenAttribute extends ReactJSX.ElementChildrenAttribute {}
    interface IntrinsicAttributes extends ReactJSX.IntrinsicAttributes {}
    interface IntrinsicClassAttributes<T> extends ReactJSX.IntrinsicClassAttributes<T> {}
    interface IntrinsicElements extends ReactJSX.IntrinsicElements {}
  }
}

export {};
