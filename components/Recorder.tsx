
import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { StopIcon } from '../icons/StopIcon';
import { MicIcon } from '../icons/MicIcon';

interface RecorderProps {
  onStop: (audioBlob: Blob) => void;
  onCancel: () => void;
  topic: string;
}

const MAX_RECORDING_TIME = 180;
const SILENCE_THRESHOLD = 0.01;
const SILENCE_TIMEOUT = 5000;

const Recorder: React.FC<RecorderProps> = ({ onStop, onCancel, topic }) => {
  const { t, i18n } = useTranslation();

  const [hasStarted, setHasStarted] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isReviewing, setIsReviewing] = useState(false);
  const [timer, setTimer] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isSilent, setIsSilent] = useState(false);
  const [transcription, setTranscription] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const silenceTimerRef = useRef<any>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationFrameRef = useRef<number | null>(null);
  const transcriptionEndRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const isRecordingRef = useRef(false);

  const speechApiSupported =
    typeof window !== 'undefined' &&
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);

  useEffect(() => {
    if (transcriptionEndRef.current) {
      transcriptionEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [transcription, interimTranscript]);

  useEffect(() => {
    return () => cleanup();
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.code === 'Space') {
        e.preventDefault();
        if (error) return;
        if (!hasStarted) {
          startRecording();
        } else if (isRecording) {
          stopRecording();
        }
      } else if (e.code === 'Enter') {
        e.preventDefault();
        if (isReviewing) {
          handleEvaluate();
        }
      } else if (e.code === 'KeyR' || e.code === 'Backspace') {
        if (isReviewing) {
          handleRetry();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [hasStarted, isRecording, isReviewing, error, audioBlob, audioUrl, onStop]);

  useEffect(() => {
    if (isRecording) {
      const interval = setInterval(() => {
        setTimer((prev) => {
          if (prev >= MAX_RECORDING_TIME) {
            stopRecording();
            return prev;
          }
          return prev + 1;
        });
      }, 1000);
      return () => clearInterval(interval);
    }
  }, [isRecording]);

  const getSupportedMimeType = () => {
    const types = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/ogg', 'audio/wav'];
    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return '';
  };

  const drawVisualizer = () => {
    if (!analyserRef.current || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const analyser = analyserRef.current;
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const draw = () => {
      animationFrameRef.current = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArray);
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const barWidth = (canvas.width / bufferLength) * 2.5;
      let x = 0;
      const gradient = ctx.createLinearGradient(0, canvas.height, 0, 0);
      gradient.addColorStop(0, 'rgba(99, 102, 241, 0.05)');
      gradient.addColorStop(0.5, 'rgba(139, 92, 246, 0.4)');
      gradient.addColorStop(1, 'rgba(236, 72, 153, 0.7)');
      ctx.fillStyle = gradient;

      for (let i = 0; i < bufferLength; i++) {
        const barHeight = (dataArray[i] / 255) * canvas.height * 0.8;
        const radius = barWidth / 2;
        const centerY = canvas.height / 2 - barHeight / 2;

        ctx.beginPath();
        ctx.roundRect(canvas.width / 2 + x, centerY, barWidth, barHeight, radius);
        ctx.fill();
        ctx.beginPath();
        ctx.roundRect(canvas.width / 2 - x - barWidth, centerY, barWidth, barHeight, radius);
        ctx.fill();
        x += barWidth + 3;
      }
    };
    draw();
  };

  const startSpeechRecognition = () => {
    const SpeechRecognitionClass =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionClass) return;

    const recognition: SpeechRecognition = new SpeechRecognitionClass();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let finalTranscript = '';
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript + ' ';
        } else {
          interim += event.results[i][0].transcript;
        }
      }
      if (finalTranscript) {
        setTranscription(prev => prev + finalTranscript);
      }
      setInterimTranscript(interim);
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error !== 'no-speech' && event.error !== 'audio-capture') {
        console.warn('SpeechRecognition error:', event.error);
      }
    };

    recognition.onend = () => {
      // Auto-restart if still recording (browser stops after silence)
      if (isRecordingRef.current) {
        try { recognition.start(); } catch { /* already started */ }
      }
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch (e) {
      console.warn('SpeechRecognition.start() failed:', e);
    }
  };

  const startRecording = async () => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
    } catch (err: any) {
      setError(t('errors.micPermission'));
      return;
    }

    const AudioContextClass = (window.AudioContext || (window as any).webkitAudioContext);
    const audioContext = new AudioContextClass({ sampleRate: 16000 });
    audioContextRef.current = audioContext;

    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }

    setError(null);
    setHasStarted(true);
    setIsRecording(true);
    isRecordingRef.current = true;

    // Start Web Speech API for live transcription
    startSpeechRecognition();

    try {
      const mimeType = getSupportedMimeType();
      const mediaRecorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };
      mediaRecorder.start(1000);

      const source = audioContext.createMediaStreamSource(stream);
      sourceRef.current = source;

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyserRef.current = analyser;
      drawVisualizer();

      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      source.connect(analyser);
      analyser.connect(processor);
      processor.connect(audioContext.destination);

      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);

        // Silence detection
        let sum = 0;
        for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
        const rms = Math.sqrt(sum / inputData.length);
        if (rms < SILENCE_THRESHOLD) {
          if (!silenceTimerRef.current) {
            silenceTimerRef.current = setTimeout(() => setIsSilent(true), SILENCE_TIMEOUT);
          }
        } else {
          setIsSilent(false);
          if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = null;
          }
        }
      };
    } catch (err: any) {
      setError(t('errors.generic'));
      cleanup();
    }
  };

  const stopRecording = () => {
    if (!isRecording) return;
    setIsRecording(false);
    isRecordingRef.current = false;
    setInterimTranscript('');
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: mediaRecorderRef.current?.mimeType || 'audio/webm' });
        setAudioBlob(blob);
        const url = URL.createObjectURL(blob);
        setAudioUrl(url);
        setIsReviewing(true);
        cleanup();
      };
      mediaRecorderRef.current.stop();
    } else {
      cleanup();
    }
  };

  const handleEvaluate = () => {
    if (audioBlob) {
      onStop(audioBlob);
    }
  };

  const handleRetry = () => {
    setAudioBlob(null);
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      setAudioUrl(null);
    }
    setIsReviewing(false);
    setHasStarted(false);
    setTimer(0);
    setTranscription('');
    setInterimTranscript('');
  };

  const cleanup = () => {
    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    if (streamRef.current) streamRef.current.getTracks().forEach(track => track.stop());
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      try { audioContextRef.current.close(); } catch (e) {}
    }
    if (processorRef.current) processorRef.current.disconnect();
    if (analyserRef.current) analyserRef.current.disconnect();
    if (sourceRef.current) sourceRef.current.disconnect();
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch {}
      recognitionRef.current = null;
    }
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  if (error) {
    return (
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-[2.5rem] p-12 text-center max-w-xl mx-auto shadow-2xl animate-fade-in">
        <div className="w-24 h-24 bg-rose-100 dark:bg-rose-900/30 rounded-full flex items-center justify-center mx-auto mb-8 text-rose-500">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-12 h-12"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" /></svg>
        </div>
        <h3 className="text-2xl font-black text-slate-800 dark:text-white mb-4">{t('errors.micTitle')}</h3>
        <p className="text-slate-600 dark:text-slate-400 mb-8 text-lg leading-relaxed font-medium">{error}</p>
        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <button onClick={onCancel} className="px-10 py-4 bg-white dark:bg-slate-800 border-2 border-slate-100 dark:border-slate-700 rounded-2xl shadow-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 font-bold transition-all">{t('common.goBack')}</button>
          <button onClick={() => window.location.reload()} className="px-10 py-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl shadow-xl shadow-indigo-500/30 font-bold transition-all transform hover:scale-105">{t('common.retry')}</button>
        </div>
      </div>
    );
  }

  if (isReviewing) {
    return (
      <div className="w-full max-w-4xl mx-auto glass rounded-[2.5rem] shadow-2xl border border-white/20 dark:border-slate-800 overflow-hidden flex flex-col h-[700px] animate-fade-in">
        <div className="bg-white/50 dark:bg-slate-900/50 px-10 py-6 flex justify-between items-center border-b border-slate-200/50 dark:border-slate-700/50 backdrop-blur-md">
          <div className="flex items-center gap-4">
            <div className="flex items-center justify-center w-12 h-12 rounded-2xl bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            </div>
            <span className="text-slate-800 dark:text-slate-100 font-black text-lg tracking-tight">{t('common.reviewRecording')}</span>
          </div>
        </div>

        <div className="flex-1 relative flex flex-col p-8 overflow-hidden bg-gradient-to-b from-slate-50/30 to-white/30 dark:from-slate-900/30 dark:to-slate-950/30">
          <div className="text-center z-10 mb-8">
            <h3 className="text-slate-900 dark:text-white font-black text-2xl md:text-3xl truncate max-w-3xl mx-auto drop-shadow-sm italic">"{topic}"</h3>
          </div>

          <div className="flex-1 overflow-y-auto mb-8 bg-white/40 dark:bg-slate-950/40 rounded-[2rem] p-8 border border-white/40 dark:border-slate-800/50 shadow-inner custom-scrollbar backdrop-blur-sm">
            <div className="flex items-center justify-between mb-4">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-400">{t('evaluation.transcription')}</span>
            </div>
            <p className="text-lg md:text-xl font-bold text-slate-700 dark:text-slate-200 leading-relaxed">
              {transcription || <span className="text-slate-400 italic font-medium">{t('errors.noSpeechDetected')}</span>}
            </p>
          </div>

          <div className="bg-white/50 dark:bg-slate-800/50 p-6 rounded-3xl border border-white/20 dark:border-slate-700/50 shadow-lg">
            {audioUrl && (
              <audio src={audioUrl} controls className="w-full h-12 rounded-xl" />
            )}
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 p-10 flex flex-col sm:flex-row justify-center gap-4 sm:gap-8 border-t border-slate-200/50 dark:border-slate-800/50 z-30">
          <button onClick={handleRetry} className="flex-1 px-10 py-4 rounded-2xl font-black text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all uppercase tracking-widest text-sm border border-slate-200 dark:border-slate-700 flex flex-col items-center justify-center gap-1">
            <span>{t('common.retry')}</span>
            <span className="text-[10px] opacity-60 tracking-widest">R / BACKSPACE</span>
          </button>
          <button onClick={handleEvaluate} className="flex-[2] group flex items-center justify-center gap-4 px-12 py-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl font-black shadow-2xl shadow-indigo-500/40 transition-all hover:scale-105 hover:-translate-y-1">
            <div className="flex flex-col items-center gap-1">
              <span className="uppercase tracking-widest">{t('common.evaluate')}</span>
              <span className="text-[10px] opacity-80 tracking-widest bg-white/20 px-2 py-0.5 rounded">ENTER</span>
            </div>
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-6 h-6 group-hover:translate-x-1 transition-transform"><path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" /></svg>
          </button>
        </div>
      </div>
    );
  }

  if (!hasStarted) {
    return (
      <div className="w-full max-w-4xl mx-auto glass rounded-[3rem] p-12 md:p-20 shadow-2xl border border-white/20 dark:border-slate-800 flex flex-col items-center justify-center space-y-10 animate-fade-in min-h-[500px]">
        {!speechApiSupported && (
          <div className="w-full px-6 py-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-2xl text-center">
            <p className="text-sm font-bold text-amber-700 dark:text-amber-400">
              {i18n.language === 'tr'
                ? 'Tarayıcınız anlık yazıya dökme özelliğini desteklemiyor. Kayıt çalışmaya devam edecek ancak anlık döküm görünmeyecektir. Chrome veya Edge kullanmanızı öneririz.'
                : 'Your browser does not support live transcription. Recording will still work but no live transcript will appear. We recommend Chrome or Edge.'}
            </p>
          </div>
        )}
        <div className="text-center space-y-4">
          <h3 className="text-3xl md:text-4xl font-black text-slate-900 dark:text-white tracking-tight leading-tight italic">"{topic}"</h3>
          <p className="text-slate-500 dark:text-slate-400 font-bold uppercase tracking-widest text-xs">{t('recorder.readyPrompt')}</p>
        </div>
        <div className="relative group">
          <div className="absolute -inset-4 bg-indigo-500/20 rounded-full blur-2xl group-hover:bg-indigo-500/40 transition duration-500 animate-pulse"></div>
          <button
            onClick={startRecording}
            className="relative z-10 w-32 h-32 md:w-40 md:h-40 bg-indigo-600 hover:bg-indigo-700 text-white rounded-full flex flex-col items-center justify-center gap-2 shadow-2xl shadow-indigo-500/50 transition-all transform hover:scale-110 active:scale-95 group"
          >
            <MicIcon className="w-10 h-10 md:w-14 md:h-14 animate-bounce" />
            <div className="flex flex-col items-center gap-0.5">
              <span className="font-black text-xs uppercase tracking-widest">{t('common.start')}</span>
              <span className="text-[9px] opacity-80 font-bold tracking-widest bg-white/20 px-2 py-0.5 rounded">SPACE</span>
            </div>
          </button>
        </div>
        <p className="text-slate-400 dark:text-slate-500 text-sm font-medium text-center max-w-xs leading-relaxed">
          {t('recorder.startHint')}
        </p>
      </div>
    );
  }

  return (
    <div className="w-full max-w-4xl mx-auto glass rounded-[2.5rem] shadow-2xl border border-white/20 dark:border-slate-800 overflow-hidden flex flex-col h-[700px] transition-all duration-300">
      <div className="bg-white/50 dark:bg-slate-900/50 px-10 py-6 flex justify-between items-center border-b border-slate-200/50 dark:border-slate-700/50 backdrop-blur-md">
        <div className="flex items-center gap-4">
          <div className="flex items-center justify-center w-12 h-12 rounded-2xl bg-red-100 dark:bg-red-900/30">
            <div className="relative flex h-3.5 w-3.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3.5 w-3.5 bg-red-500"></span>
            </div>
          </div>
          <span className="text-slate-800 dark:text-slate-100 font-black text-lg tracking-tight">{t('dashboard.recording')}</span>
        </div>
        <div className="font-mono text-2xl text-slate-900 dark:text-slate-100 font-black bg-white dark:bg-slate-800 px-6 py-2 rounded-xl shadow-inner border border-slate-200 dark:border-slate-700">
          {formatTime(timer)} <span className="text-slate-400 text-lg">/ 03:00</span>
        </div>
      </div>

      <div className="flex-1 relative flex flex-col p-8 overflow-hidden bg-gradient-to-b from-slate-50/30 to-white/30 dark:from-slate-900/30 dark:to-slate-950/30">
        <div className="text-center z-10 mb-8">
          <h3 className="text-slate-900 dark:text-white font-black text-2xl md:text-3xl truncate max-w-3xl mx-auto drop-shadow-sm italic">"{topic}"</h3>
        </div>

        {/* Transcription Area */}
        <div className="flex-1 overflow-y-auto mb-8 bg-white/40 dark:bg-slate-950/40 rounded-[2rem] p-8 border border-white/40 dark:border-slate-800/50 shadow-inner custom-scrollbar backdrop-blur-sm">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2 opacity-60">
              <div className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse"></div>
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-400">{t('recorder.liveLabel')}</span>
            </div>
          </div>
          <p className="text-lg md:text-xl font-bold text-slate-700 dark:text-slate-200 leading-relaxed transition-all duration-300">
            {transcription || interimTranscript
              ? <>{transcription}<span className="text-slate-400 italic">{interimTranscript}</span></>
              : <span className="text-slate-400 italic font-medium">{t('recorder.listening')}</span>}
          </p>
          <div ref={transcriptionEndRef} />
        </div>

        {/* Accuracy Note */}
        <div className="mb-4 px-6 py-2 bg-slate-100/50 dark:bg-slate-800/50 rounded-xl border border-slate-200/50 dark:border-slate-700/50 text-center">
          <p className="text-[10px] font-bold text-slate-500 dark:text-slate-400 leading-tight">
            <span className="text-indigo-500">ℹ</span> {t('recorder.liveNote')}
          </p>
        </div>

        <div className="relative w-full h-[100px] flex items-center justify-center">
          <canvas ref={canvasRef} width={1000} height={100} className="absolute inset-0 w-full h-full opacity-100 pointer-events-none" />
          <div className="relative z-10 bg-white dark:bg-slate-800 p-5 rounded-full shadow-2xl shadow-indigo-500/20 border-4 border-slate-100/50 dark:border-slate-700/50">
            <MicIcon className="w-7 h-7 text-indigo-600 dark:text-indigo-400" />
          </div>
        </div>

        {isSilent && timer > 3 && (
          <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-16 bg-amber-500 text-white px-8 py-2.5 rounded-full text-sm font-black animate-bounce shadow-xl z-20 uppercase tracking-widest">
            {t('recorder.speakUp')}
          </div>
        )}
      </div>

      <div className="bg-white dark:bg-slate-900 p-10 flex justify-center gap-8 border-t border-slate-200/50 dark:border-slate-800/50 z-30">
        <button onClick={onCancel} className="px-10 py-4 rounded-2xl font-black text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all uppercase tracking-widest text-sm">{t('common.cancel')}</button>
        <button onClick={stopRecording} className="group flex items-center gap-4 px-12 py-4 bg-rose-500 hover:bg-rose-600 text-white rounded-2xl font-black shadow-2xl shadow-rose-500/40 transition-all hover:scale-105 hover:-translate-y-1">
          <div className="bg-white/20 rounded-xl p-1.5"><StopIcon className="w-6 h-6 fill-current" /></div>
          <div className="flex flex-col items-start gap-0.5">
            <span className="uppercase tracking-widest text-sm">{t('dashboard.stopRecording')}</span>
            <span className="text-[10px] opacity-80 font-bold tracking-widest bg-white/20 px-2 py-0.5 rounded">SPACE</span>
          </div>
        </button>
      </div>
    </div>
  );
};

export default Recorder;
