import { useCallback, useEffect, useRef, useState } from 'react';

// Web Speech API types aren't in lib.dom for every TS version; describe what we use.
interface RecognitionResultEvent {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: RecognitionResultEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

function getRecognitionCtor(): (new () => Recognition) | undefined {
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition || w.webkitSpeechRecognition;
}

// Older adults often pause mid-sentence; wait this long after the last word before sending
const SILENCE_MS = 2200;

/** Tap-to-talk speech input. Keeps listening through short pauses, then calls onFinal once with everything said. */
export function useSpeechInput(onFinal: (text: string) => void) {
  const supported = typeof window !== 'undefined' && Boolean(getRecognitionCtor());
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<Recognition | null>(null);
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  const stop = useCallback(() => recognitionRef.current?.stop(), []);

  const start = useCallback(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;
    window.speechSynthesis?.cancel(); // don't transcribe our own voice
    const recognition = new Ctor();
    recognition.lang = 'en-US';
    recognition.interimResults = true;
    recognition.continuous = true;

    let finalText = '';
    let silenceTimer: ReturnType<typeof setTimeout> | undefined;
    const armSilenceTimer = () => {
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => recognition.stop(), SILENCE_MS);
    };
    recognition.onresult = e => {
      armSilenceTimer();
      let partial = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        if (result.isFinal) finalText += ` ${result[0].transcript}`;
        else partial += result[0].transcript;
      }
      setInterim(`${finalText} ${partial}`.trim());
    };
    recognition.onerror = e => {
      setError(e.error === 'not-allowed' ? 'Microphone permission was blocked. You can type instead.' : "Sorry, I didn't catch that.");
    };
    recognition.onend = () => {
      clearTimeout(silenceTimer);
      setListening(false);
      setInterim('');
      const said = finalText.replace(/\s+/g, ' ').trim();
      if (said) onFinalRef.current(said);
    };

    recognitionRef.current = recognition;
    setError(null);
    setListening(true);
    recognition.start();
    // Nobody spoke at all: stop after a while instead of listening forever
    silenceTimer = setTimeout(() => recognition.stop(), 8000);
  }, []);

  useEffect(() => () => recognitionRef.current?.stop(), []);

  return { supported, listening, interim, error, start, stop };
}

/**
 * Reads text aloud at a slightly slower pace. Speaks one sentence per utterance because Chrome
 * cuts long utterances off partway, and waits a tick after cancel() because Chrome can drop an
 * utterance queued in the same tick as a cancel.
 */
export function speak(text: string) {
  if (!('speechSynthesis' in window) || !text) return;
  window.speechSynthesis.cancel();
  const sentences = text.match(/[^.!?]+[.!?]*/g)?.map(s => s.trim()).filter(Boolean) ?? [text];
  setTimeout(() => {
    for (const sentence of sentences) {
      const utterance = new SpeechSynthesisUtterance(sentence);
      utterance.rate = 0.92;
      utterance.lang = 'en-US';
      window.speechSynthesis.speak(utterance);
    }
  }, 50);
}
