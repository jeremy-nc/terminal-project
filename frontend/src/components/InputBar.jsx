import React, { useRef } from "react";
import { sendStdin } from "../terminalController.js";

export default function InputBar() {
  const inputRef = useRef(null);

  function submit() {
    const val = inputRef.current?.value ?? "";
    sendStdin(val + "\n");
    if (inputRef.current) inputRef.current.value = "";
  }

  function onKeyDown(e) {
    if (e.key === "Enter") { e.preventDefault(); submit(); }
  }

  return (
    <div className="inputbar">
      <input
        ref={inputRef}
        type="text"
        placeholder="Type a command and press Enter…"
        autoComplete="off"
        onKeyDown={onKeyDown}
      />
      <button onClick={submit}>Send</button>
    </div>
  );
}
