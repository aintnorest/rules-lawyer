"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import type { QueryResult } from "../src/types";

type Role = "user" | "assistant";

type Message = {
  id: string;
  /** Stable thread root id (root user message id). All replies in the thread share this. */
  threadId: string;
  role: Role;
  content: string;
  /** Truthy while streaming or on error; result-bearing assistants have status === undefined. */
  status?: string;
  result?: QueryResult;
};

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Short, low-volume sine blip used when a result lands while the tab is hidden. Self-closes its AudioContext. */
function playPing(): void {
  try {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    const t0 = ctx.currentTime;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(0.06, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.2);
    osc.onended = () => {
      ctx.close().catch(() => {});
    };
  } catch {
    // ignore: ping is best-effort
  }
}

export default function Home() {
  const [libraries, setLibraries] = useState<{ id: string; label: string }[]>(
    [],
  );
  const [selectedLibrary, setSelectedLibrary] = useState<string>("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [followUpThreadId, setFollowUpThreadId] = useState<string | null>(null);
  const [followUpInput, setFollowUpInput] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);

  const [speechSupported, setSpeechSupported] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  // biome-ignore lint/suspicious/noExplicitAny: Web Speech API has no built-in TS types in lib.dom yet.
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    fetch("/api/libraries")
      .then((res) => res.json())
      .then((data) => {
        setLibraries(data);
        if (data.length > 0) setSelectedLibrary(data[0].id);
      });

    if (
      typeof window !== "undefined" &&
      ("SpeechRecognition" in window || "webkitSpeechRecognition" in window)
    ) {
      setSpeechSupported(true);
      const SpeechRecognition =
        // biome-ignore lint/suspicious/noExplicitAny: see recognitionRef note
        (window as any).SpeechRecognition ||
        // biome-ignore lint/suspicious/noExplicitAny: see recognitionRef note
        (window as any).webkitSpeechRecognition;
      recognitionRef.current = new SpeechRecognition();
      recognitionRef.current.continuous = false;
      recognitionRef.current.interimResults = false;

      // biome-ignore lint/suspicious/noExplicitAny: see recognitionRef note
      recognitionRef.current.onresult = (event: any) => {
        const text = event.results[0][0].transcript;
        setInput(text);
      };
      recognitionRef.current.onend = () => {
        setIsRecording(false);
      };
    }
  }, []);

  const startVoice = () => {
    if (!recognitionRef.current) return;
    if (isRecording) {
      recognitionRef.current.stop();
      setIsRecording(false);
    } else {
      recognitionRef.current.start();
      setIsRecording(true);
    }
  };

  /**
   * Send a question. When `threadId` is provided, this is a follow-up: the chat history sent to
   * the model is built **only from that thread's prior completed messages**. Otherwise, history
   * is empty so the main footer always asks a fresh question.
   */
  const ask = async (
    question: string,
    opts: { threadId?: string },
  ): Promise<void> => {
    if (!question || isProcessing || !selectedLibrary) return;

    const isFollowUp = Boolean(opts.threadId);
    const rootThreadId = opts.threadId ?? newId();
    const userId = isFollowUp ? newId() : rootThreadId;
    const assistantId = newId();

    const history = isFollowUp
      ? messages
          .filter(
            (m) =>
              m.threadId === rootThreadId &&
              m.status === undefined &&
              (m.role === "user" || m.role === "assistant"),
          )
          .map((m) => ({
            role: m.role,
            content:
              m.role === "assistant" && m.result?.answer
                ? m.result.answer
                : m.content,
          }))
      : [];

    setIsProcessing(true);
    setMessages((prev) => [
      ...prev,
      {
        id: userId,
        threadId: rootThreadId,
        role: "user",
        content: question,
      },
      {
        id: assistantId,
        threadId: rootThreadId,
        role: "assistant",
        content: "",
        status: "connecting...",
      },
    ]);

    console.log("[UI] ask", {
      libraryId: selectedLibrary,
      isFollowUp,
      threadId: rootThreadId,
      historyLen: history.length,
      questionPreview: question.slice(0, 80),
    });

    const updateAssistant = (mut: (m: Message) => Message) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? mut(m) : m)),
      );
    };

    try {
      const response = await fetch("/api/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          libraryId: selectedLibrary,
          question,
          history,
        }),
      });
      if (!response.body) throw new Error("No readable stream");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let done = false;
      let finalResult: QueryResult | null = null;

      let buffer = "";
      let currentEvent = "";

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        if (!value) continue;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7);
          } else if (line.startsWith("data: ")) {
            const dataStr = line.slice(6);
            if (!dataStr) continue;
            try {
              const data = JSON.parse(dataStr);
              if (currentEvent === "status") {
                updateAssistant((m) => ({ ...m, status: String(data) }));
              } else if (currentEvent === "result") {
                finalResult = data as QueryResult;
                updateAssistant((m) => ({
                  ...m,
                  status: undefined,
                  content: finalResult?.answer ?? "",
                  result: finalResult ?? undefined,
                }));
              } else if (currentEvent === "error") {
                const message =
                  typeof data?.message === "string" ? data.message : "Error";
                console.error("[UI][SSE error]", message);
                updateAssistant((m) => ({
                  ...m,
                  status: "error",
                  content: message,
                }));
              }
            } catch (_err) {
              console.error("[SSE] Failed to parse SSE data chunk:", dataStr);
            }
          }
        }
      }

      if (
        finalResult &&
        typeof document !== "undefined" &&
        document.visibilityState !== "visible"
      ) {
        playPing();
      }
    } catch (err) {
      console.error("[UI] Fetch/Stream Error:", err);
      updateAssistant((m) => ({ ...m, status: "error" }));
    } finally {
      setIsProcessing(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const q = input.trim();
    if (!q || isProcessing) return;
    setInput("");
    await ask(q, {});
  };

  const handleFollowUpSubmit = async (e: FormEvent, threadId: string) => {
    e.preventDefault();
    const q = followUpInput.trim();
    if (!q || isProcessing) return;
    setFollowUpInput("");
    setFollowUpThreadId(null);
    await ask(q, { threadId });
  };

  /** Per-thread pair index → small left indent for follow-up messages. */
  const threadCounts = new Map<string, number>();
  const decorated = messages.map((m) => {
    if (m.role === "user") {
      const cur = threadCounts.get(m.threadId) ?? 0;
      threadCounts.set(m.threadId, cur + 1);
      return { ...m, depth: cur };
    }
    const after = threadCounts.get(m.threadId) ?? 1;
    return { ...m, depth: Math.max(0, after - 1) };
  });

  return (
    <div className="flex flex-col h-screen bg-neutral-950 text-neutral-100 font-sans">
      <header className="flex items-center justify-between p-4 bg-neutral-900 border-b border-neutral-800 shadow-md">
        <h1 className="text-xl font-bold tracking-tight text-emerald-500">
          Rules Lawyer
        </h1>
        <select
          className="bg-neutral-800 border border-neutral-700 rounded-md px-3 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
          value={selectedLibrary}
          onChange={(e) => setSelectedLibrary(e.target.value)}
        >
          {libraries.map((lib) => (
            <option key={lib.id} value={lib.id}>
              {lib.label}
            </option>
          ))}
          {libraries.length === 0 && (
            <option value="">No libraries found</option>
          )}
        </select>
      </header>

      <main className="flex-1 overflow-y-auto p-4 space-y-6">
        {decorated.map((msg) => {
          const indentRem = Math.min(msg.depth, 4) * 1.25;
          return (
            <div
              key={msg.id}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              style={
                indentRem > 0 ? { paddingLeft: `${indentRem}rem` } : undefined
              }
            >
              <div
                className={`max-w-2xl rounded-2xl px-5 py-4 ${msg.role === "user" ? "bg-emerald-600 text-white" : "bg-neutral-900 border border-neutral-800"}`}
              >
                {msg.role === "assistant" &&
                  msg.status &&
                  msg.status !== "error" && (
                    <div className="flex items-center space-x-2 text-emerald-400 text-sm animate-pulse mb-2">
                      <div className="w-2 h-2 bg-emerald-400 rounded-full"></div>
                      <span>{msg.status}</span>
                    </div>
                  )}
                {msg.role === "assistant" && msg.status === "error" && (
                  <div className="flex items-center space-x-2 text-red-400 text-sm font-bold mb-2">
                    <div className="w-2 h-2 bg-red-500 rounded-full"></div>
                    <span>Generation Error</span>
                  </div>
                )}

                <div className="prose prose-invert max-w-none text-sm leading-relaxed">
                  {msg.content}
                </div>

                {msg.result && msg.result.confidence === "not_in_book" && (
                  <div className="mt-4 text-xs font-medium text-amber-500 bg-amber-500/10 px-3 py-2 rounded-md border border-amber-500/20">
                    ⚠️ Not found in the selected ruleset.
                  </div>
                )}

                {msg.result && msg.result.citations.length > 0 && (
                  <div className="mt-5 space-y-2 border-t border-neutral-800 pt-4">
                    <h4 className="text-[10px] font-bold text-neutral-500 uppercase tracking-widest">
                      Citations
                    </h4>
                    <div className="flex flex-col gap-2">
                      {msg.result.citations.map((c, idx) => (
                        <details
                          key={`${msg.id}-cite-${idx}`}
                          className="group text-sm"
                        >
                          <summary className="cursor-pointer text-emerald-400 hover:text-emerald-300 transition-colors list-none inline-flex items-center bg-emerald-400/10 px-2 py-1.5 rounded-md border border-emerald-400/20 text-xs font-medium">
                            <span className="mr-2">📄</span> {c.documentLabel} (
                            {c.pageHint})
                          </summary>
                          <div className="mt-2 text-xs text-neutral-300 bg-black/60 p-3 rounded-md border border-neutral-800/50 leading-relaxed italic">
                            "{c.snippet}"
                          </div>
                        </details>
                      ))}
                    </div>
                  </div>
                )}

                {msg.role === "assistant" && !msg.status && msg.result && (
                  <div className="mt-4 flex justify-end">
                    {followUpThreadId === msg.threadId ? (
                      <button
                        type="button"
                        onClick={() => {
                          setFollowUpThreadId(null);
                          setFollowUpInput("");
                        }}
                        className="text-xs px-3 py-1.5 rounded-md border border-neutral-700 text-neutral-300 hover:bg-neutral-800"
                      >
                        Cancel follow-up
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setFollowUpThreadId(msg.threadId);
                          setFollowUpInput("");
                        }}
                        disabled={isProcessing}
                        className="text-xs px-3 py-1.5 rounded-md border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        ↳ Follow up
                      </button>
                    )}
                  </div>
                )}

                {msg.role === "assistant" &&
                  !msg.status &&
                  msg.result &&
                  followUpThreadId === msg.threadId && (
                    <form
                      className="mt-3 flex gap-2"
                      onSubmit={(e) => handleFollowUpSubmit(e, msg.threadId)}
                    >
                      <input
                        type="text"
                        // biome-ignore lint/a11y/noAutofocus: explicit user opt-in via Follow up button
                        autoFocus
                        className="flex-1 bg-neutral-950 border border-neutral-800 rounded-full px-4 py-1.5 text-sm focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/50 text-neutral-100 placeholder-neutral-600"
                        placeholder="Follow up on this answer..."
                        value={followUpInput}
                        onChange={(e) => setFollowUpInput(e.target.value)}
                        disabled={isProcessing}
                      />
                      <button
                        type="submit"
                        disabled={isProcessing || !followUpInput.trim()}
                        className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-1.5 rounded-full text-sm font-semibold"
                      >
                        Send
                      </button>
                    </form>
                  )}
              </div>
            </div>
          );
        })}
      </main>

      <footer className="p-4 bg-neutral-900 border-t border-neutral-800">
        <div className="max-w-4xl mx-auto">
          <p className="text-[10px] text-neutral-500 mb-2 text-center">
            New questions are sent without prior chat context. Use{" "}
            <span className="text-emerald-400">↳ Follow up</span> on an answer
            to continue that thread.
          </p>
          <form onSubmit={handleSubmit} className="flex gap-3">
            {speechSupported ? (
              <button
                type="button"
                onClick={startVoice}
                className={`p-3 rounded-full flex-shrink-0 transition-all duration-300 shadow-md ${isRecording ? "bg-red-500 hover:bg-red-600 text-white animate-pulse shadow-red-500/20" : "bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 text-neutral-300"}`}
                title="Push to talk"
              >
                🎤
              </button>
            ) : (
              <div
                className="p-3 bg-neutral-800 rounded-full cursor-help border border-neutral-700"
                title="Web Speech not supported. In Firefox, enable media.webspeech.recognition.enable"
              >
                🚫
              </div>
            )}
            <input
              type="text"
              className="flex-1 bg-neutral-950 border border-neutral-800 rounded-full px-6 focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/50 transition-all text-neutral-100 placeholder-neutral-600 shadow-inner"
              placeholder="Ask a rule question..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={isProcessing}
            />
            <button
              type="submit"
              disabled={isProcessing || !input.trim() || !selectedLibrary}
              className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-8 py-2 rounded-full font-semibold transition-all shadow-md shadow-emerald-900/20"
            >
              Send
            </button>
          </form>
        </div>
      </footer>
    </div>
  );
}
