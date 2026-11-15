"use client";

import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { python } from "@codemirror/lang-python";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";

export function PythonCodeEditor({ value, onChange, readOnly = false }: {
  value: string;
  onChange(value: string): void;
  readOnly?: boolean;
}) {
  const t = useTranslations("Assets");
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const editable = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        python(),
        editable.current.of(EditorView.editable.of(!readOnly)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        }),
      ],
    });
    const next = new EditorView({ state, parent: host.current });
    view.current = next;
    return () => { next.destroy(); view.current = null; };
    // A CodeMirror instance is deliberately stable while the user types.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const current = view.current;
    if (!current || current.state.doc.toString() === value) return;
    current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: editable.current.reconfigure(EditorView.editable.of(!readOnly)) });
  }, [readOnly]);

  return <div className="python-editor" ref={host} aria-label={t("pythonEditor")} />;
}
