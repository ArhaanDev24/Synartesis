import { useEffect, useRef, type ReactNode } from "react";

/** Dialogs return you to the control that opened them, even after Escape. */
export function FocusPanel({ children, className, id, label, at, onClose, returnTo }: {
  children: ReactNode;
  className: string;
  id: string;
  label: string;
  at?: string;
  onClose: () => void;
  returnTo?: HTMLElement | null;
}): React.JSX.Element {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const trigger = returnTo ?? document.activeElement;
    const element = panel.current;
    if (element === null) return;
    const controls = (): HTMLElement[] => [...element.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]',
    )].filter((control) => control.getClientRects().length > 0);
    (controls()[0] ?? element).focus();
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); close.current();
      } else if (event.key === "Tab") {
        const items = controls();
        const first = items[0] ?? element;
        const last = items[items.length - 1] ?? element;
        if (!element.contains(document.activeElement) || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
          event.preventDefault(); (event.shiftKey ? last : first).focus();
        }
      }
    };
    document.addEventListener("keydown", keydown, true);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);
  useEffect(() => {
    // Step two of undo is a new decision, so focus returns to its safe exit.
    panel.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
  }, [label]);
  return <div ref={panel} className={className} id={id} data-at={at} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>{children}</div>;
}
