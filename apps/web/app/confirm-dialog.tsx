"use client";

/* Dialog backdrop is presentational; the dialog has a keyboard-accessible cancel button. */
/* eslint-disable jsx-a11y/no-static-element-interactions */

import { useCallback, useState } from "react";

type ConfirmOptions = { title?: string; message: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean };
type ConfirmState = ConfirmOptions & { resolve: (value: boolean) => void };

/**
 * Drop-in replacement for window.confirm(message) that renders Planbraid's own dialog
 * instead of the browser's native popup. Usage: const { confirm, confirmDialog } =
 * useConfirm(); ... if (!(await confirm("Disconnect X?"))) return; ... return
 * <>{confirmDialog}{...rest of the component}</> - one hook covers every confirmation a
 * component needs, each awaited call replacing the state its own promise until answered.
 */
export function useConfirm() {
  const [state, setState] = useState<ConfirmState | null>(null);

  const confirm = useCallback((options: ConfirmOptions | string) => {
    const normalized = typeof options === "string" ? { message: options } : options;
    return new Promise<boolean>((resolve) => setState({ ...normalized, resolve }));
  }, []);

  const respond = useCallback((value: boolean) => {
    setState((current) => { current?.resolve(value); return null; });
  }, []);

  const confirmDialog = state ? <ConfirmDialog {...state} onCancel={() => respond(false)} onConfirm={() => respond(true)} /> : null;
  return { confirm, confirmDialog };
}

function ConfirmDialog({ title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", danger, onConfirm, onCancel }: ConfirmOptions & { onConfirm: () => void; onCancel: () => void }) {
  return <div className="dialog-backdrop confirm-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-label={title ?? "Confirm"}>
      {title && <h3>{title}</h3>}
      <p>{message}</p>
      <div className="confirm-actions">
        <button onClick={onCancel}>{cancelLabel}</button>
        <button className={danger ? "confirm-primary danger" : "confirm-primary"} onClick={onConfirm} autoFocus>{confirmLabel}</button>
      </div>
    </section>
  </div>;
}
