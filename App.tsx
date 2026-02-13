import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { AppStep, HeroDetails, StoryResponse, Companion, Mood, StoryHistoryItem, QuizData } from './types';
import { COMPANIONS, SKIN_TONES, HAIR_COLORS, HAIR_STYLES, PROPS, MOODS, VOICE_MAP, INSPIRATION_TOPICS } from './constants';
import { generateStory, generateAllPageImages, generateAllPageAudio, generateQuiz, decodeBase64, pcm16ToAudioBuffer } from './services/geminiService';

const FloatingSparkles = () => (
  <div className="fixed inset-0 pointer-events-none z-0">
    <div className="absolute top-10 left-[10%] animate-sparkle text-2xl">✨</div>
    <div className="absolute top-40 right-[15%] animate-sparkle text-xl" style={{ animationDelay: '1s' }}>✨</div>
    <div className="absolute bottom-20 left-[20%] animate-sparkle text-3xl" style={{ animationDelay: '0.5s' }}>✨</div>
    <div className="absolute bottom-40 right-[10%] animate-sparkle text-2xl" style={{ animationDelay: '1.5s' }}>✨</div>
  </div>
);

type NarrationStatus = 'stopped' | 'playing' | 'paused' | 'loading';

const fmtTime = (s: number) => {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
};

const App: React.FC = () => {
  const [step, setStep] = useState<AppStep>(AppStep.HERO_SETUP);

  const [totalSparkPoints, setTotalSparkPoints] = useState<number>(() => {
    const saved = localStorage.getItem('storyspark_points');
    return saved ? parseInt(saved, 10) : 0;
  });

  const [storyHistory, setStoryHistory] = useState<StoryHistoryItem[]>(() => {
    const saved = localStorage.getItem('storyspark_history');
    return saved ? JSON.parse(saved) : [];
  });

  const [hero, setHero] = useState<HeroDetails>({
    name: '',
    age: 5,
    gender: 'Explorer',
    skinTone: SKIN_TONES[1],
    hairStyle: HAIR_STYLES[0],
    hairColor: HAIR_COLORS[0],
    prop: PROPS[1],
    narrationMode: 'magical'
  });

  const [selectedCompanions, setSelectedCompanions] = useState<Companion[]>([]);
  const [mood, setMood] = useState<Mood>('Adventurous');
  const [topic, setTopic] = useState('');
  const [story, setStory] = useState<StoryResponse | null>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const [loadingMsg, setLoadingMsg] = useState('Opening the magic book...');
  const [imageProgress, setImageProgress] = useState({ current: 0, total: 5 });
  const [audioProgress, setAudioProgress] = useState({ current: 0, total: 5 });
  const audioBase64ByPageRef = useRef<Record<number, string | null>>({});

  // ===== Quiz State =====
  const [quizData, setQuizData] = useState<QuizData | null>(null);
  const [quizStep, setQuizStep] = useState<'recap' | 'questions'>('recap');
  const [currentQuestionIdx, setCurrentQuestionIdx] = useState(0);
  const [quizScore, setQuizScore] = useState(0);
  const [selectedAnswer, setSelectedAnswer] = useState<string | null>(null);
  const [isAnswered, setIsAnswered] = useState(false);

  // ===== Narration State =====
  const [narrationStatus, setNarrationStatus] = useState<NarrationStatus>('stopped');
  const narrationStatusRef = useRef<NarrationStatus>('stopped');
  useEffect(() => {
    narrationStatusRef.current = narrationStatus;
  }, [narrationStatus]);

  const [playhead, setPlayhead] = useState(0);
  const [duration, setDuration] = useState(0);

  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const currentBufferRef = useRef<AudioBuffer | null>(null);

  const startTimeRef = useRef<number>(0);
  const offsetRef = useRef<number>(0);

  const rafRef = useRef<number | null>(null);
  const [currentNarratedPage, setCurrentNarratedPage] = useState<number | null>(null);

  const [isBlindBoxRolling, setIsBlindBoxRolling] = useState(false);
  const [rollingProp, setRollingProp] = useState<string | null>(null);
  const [finalRevealProp, setFinalRevealProp] = useState<string | null>(null);

  useEffect(() => {
    localStorage.setItem('storyspark_points', totalSparkPoints.toString());
  }, [totalSparkPoints]);

  useEffect(() => {
    localStorage.setItem('storyspark_history', JSON.stringify(storyHistory));
  }, [storyHistory]);

  useEffect(() => {
    return () => {
      stopNarration();
    };
  }, []);

  const unlockedCompanions = useMemo(() => {
    return COMPANIONS.filter(c => (c.unlockThreshold || 0) <= totalSparkPoints);
  }, [totalSparkPoints]);

  const nextCompanionUnlock = useMemo(() => {
    return COMPANIONS.find(c => (c.unlockThreshold || 0) > totalSparkPoints);
  }, [totalSparkPoints]);

  const randomInspirations = useMemo(() => {
    return [...INSPIRATION_TOPICS].sort(() => 0.5 - Math.random()).slice(0, 3);
  }, []);

  const initAudioContext = () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    }
    if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume();
    }
    return audioContextRef.current;
  };

  const stopRAF = () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  const startRAF = useCallback(() => {
    stopRAF();
    const tick = () => {
      const ctx = audioContextRef.current;
      const buf = currentBufferRef.current;
      if (!ctx || !buf) return;
      if (narrationStatusRef.current !== 'playing') return;
      const played = offsetRef.current + (ctx.currentTime - startTimeRef.current);
      const clamped = Math.min(Math.max(played, 0), buf.duration);
      setPlayhead(clamped);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const handleAudioEnded = useCallback(() => {
    stopRAF();
    setNarrationStatus('stopped');
    offsetRef.current = 0;
    startTimeRef.current = 0;
    setPlayhead(0);
  }, []);

  const stopNarration = useCallback(() => {
    stopRAF();
    if (sourceNodeRef.current) {
      try {
        sourceNodeRef.current.onended = null;
        sourceNodeRef.current.stop();
      } catch { /* ignore */ }
      sourceNodeRef.current = null;
    }
    offsetRef.current = 0;
    startTimeRef.current = 0;
    setPlayhead(0);
    setDuration(0);
    setNarrationStatus('stopped');
    setCurrentNarratedPage(null);
    currentBufferRef.current = null;
  }, []);

  const pauseNarration = useCallback(() => {
    if (narrationStatusRef.current !== 'playing') return;
    stopRAF();
    const ctx = audioContextRef.current;
    const buf = currentBufferRef.current;
    if (ctx && sourceNodeRef.current && buf) {
      const playedSinceResume = ctx.currentTime - startTimeRef.current;
      offsetRef.current = Math.min(offsetRef.current + playedSinceResume, buf.duration);
      try {
        sourceNodeRef.current.onended = null;
        sourceNodeRef.current.stop();
      } catch { /* ignore */ }
      sourceNodeRef.current = null;
      setNarrationStatus('paused');
      setPlayhead(offsetRef.current);
    }
  }, []);

  const playNarration = useCallback(async () => {
    if (!story) return;
    if (narrationStatusRef.current === 'loading') return;
    
    // Resume from paused state
    if (narrationStatusRef.current === 'paused' && currentBufferRef.current && currentNarratedPage === currentPage) {
      const ctx = initAudioContext();
      const source = ctx.createBufferSource();
      source.buffer = currentBufferRef.current;
      source.connect(ctx.destination);
      source.onended = handleAudioEnded;
      sourceNodeRef.current = source;
      startTimeRef.current = ctx.currentTime;
      source.start(0, offsetRef.current);
      setNarrationStatus('playing');
      startRAF();
      return;
    }

    // Use preloaded audio
    const base64 = audioBase64ByPageRef.current[currentPage];
    if (!base64) {
      setNarrationStatus('stopped');
      return;
    }

    setNarrationStatus('loading');
    const ctx = initAudioContext();
    try {
      const bytes = decodeBase64(base64);
      const buffer = pcm16ToAudioBuffer(bytes, ctx, 24000, 1);
      
      currentBufferRef.current = buffer;
      setCurrentNarratedPage(currentPage);
      setDuration(buffer.duration);
      offsetRef.current = 0;
      setPlayhead(0);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.onended = handleAudioEnded;
      sourceNodeRef.current = source;
      startTimeRef.current = ctx.currentTime;
      source.start(0);
      setNarrationStatus('playing');
      startRAF();
    } catch (error) {
      console.error('Narration Play Error:', error);
      setNarrationStatus('stopped');
    }
  }, [story, currentNarratedPage, currentPage, handleAudioEnded, startRAF]);

  const handleBlindBox = () => {
    if (isBlindBoxRolling) return;
    setIsBlindBoxRolling(true);
    setFinalRevealProp(null);
    const availableProps = PROPS.filter(p => p !== 'None');
    let iterations = 0;
    const maxIterations = 20;
    const baseDelay = 50;
    const roll = () => {
      iterations++;
      const currentIdx = rollingProp ? availableProps.indexOf(rollingProp) : -1;
      let nextIdx;
      do {
        nextIdx = Math.floor(Math.random() * availableProps.length);
      } while (nextIdx === currentIdx && availableProps.length > 1);
      const nextProp = availableProps[nextIdx];
      setRollingProp(nextProp);
      if (iterations < maxIterations) {
        const easing = Math.pow(iterations / maxIterations, 2);
        const delay = baseDelay + easing * 200;
        setTimeout(roll, delay);
      } else {
        setFinalRevealProp(nextProp);
        setHero(prev => ({ ...prev, prop: nextProp }));
        setRollingProp(null);
        setTimeout(() => {
            setIsBlindBoxRolling(false);
            setFinalRevealProp(null);
        }, 1200);
      }
    };
    roll();
  };

  const handleRandomTopic = () => {
    const randomTopic = INSPIRATION_TOPICS[Math.floor(Math.random() * INSPIRATION_TOPICS.length)];
    setTopic(randomTopic);
  };

  const startGeneration = async () => {
    setStep(AppStep.GENERATING);
    setImageProgress({ current: 0, total: 5 });
    setAudioProgress({ current: 0, total: 5 });
    setLoadingMsg('Asking the story wizards...');
    
    try {
      const storyData = await generateStory(topic, hero, mood, selectedCompanions);
      
      setLoadingMsg('Painting your world...');
      const storyWithImages = await generateAllPageImages(storyData, (current, total) => {
        setImageProgress({ current, total });
        setLoadingMsg(`Painting magic scene ${current} of ${total}...`);
      });

      setLoadingMsg('Preparing magical voices...');
      const audioData = await generateAllPageAudio(storyWithImages, hero, mood, (current, total) => {
        setAudioProgress({ current, total });
        setLoadingMsg(`Preparing magical voice ${current} of ${total}...`);
      });
      audioBase64ByPageRef.current = audioData;

      setStory(storyWithImages);
      setStep(AppStep.STORY_READER);
    } catch (err) {
      console.error(err);
      alert("Oh no! The magic wizards were interrupted. Let's try once more.");
      setStep(AppStep.HERO_SETUP);
    }
  };

  const handlePageChange = (index: number) => {
    if (!story) return;
    stopNarration();
    setCurrentPage(index);
  };

  const handleAdventureComplete = async () => {
    if (!story) return;
    stopNarration();
    setStep(AppStep.GENERATING);
    setLoadingMsg('hold on generating quiz');
    try {
      const data = await generateQuiz(story.tricky_words);
      setQuizData(data);
      setQuizStep('recap');
      setStep(AppStep.QUIZ);
    } catch (err) {
      console.error(err);
      finalizeStory();
    }
  };

  const finalizeStory = (bonusPoints: number = 0) => {
    if (story) {
      const historyItem: StoryHistoryItem = {
        id: Date.now().toString(),
        title: story.story_title,
        topic: topic,
        date: new Date().toLocaleDateString(),
        sticker: story.magic_sticker
      };
      setStoryHistory(prev => [historyItem, ...prev]);
      setTotalSparkPoints(prev => prev + story.spark_points_earned + bonusPoints);
      setStep(AppStep.REWARDS);
    }
  };

  const handleQuizAnswer = (answer: string) => {
    if (isAnswered || !quizData) return;
    setSelectedAnswer(answer);
    setIsAnswered(true);
    if (answer === quizData.quiz[currentQuestionIdx].correct_answer) {
      setQuizScore(prev => prev + 1);
    }
  };

  const nextQuizQuestion = () => {
    if (!quizData) return;
    setSelectedAnswer(null);
    setIsAnswered(false);
    if (currentQuestionIdx < quizData.quiz.length - 1) {
      setCurrentQuestionIdx(prev => prev + 1);
    } else {
      finalizeStory(quizScore);
    }
  };

  const renderQuiz = () => {
    if (!quizData) return null;

    if (quizStep === 'recap') {
      return (
        <div className="max-w-4xl mx-auto p-6 space-y-12 animate-fadeIn relative z-10">
          <div className="text-center space-y-4">
            <h1 className="text-6xl text-purple-600 drop-shadow-md">Word Power!</h1>
            <p className="text-2xl text-stone-600 font-medium">Let's look at the cool words you learned today.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {quizData.vocab_recap.map((item, idx) => (
              <div key={idx} className="bg-white p-8 rounded-[3rem] shadow-xl border-b-8 border-purple-100 space-y-4 transform hover:scale-105 transition-all">
                <h3 className="text-4xl text-purple-600">{item.word}</h3>
                <p className="text-xl text-stone-700 font-bold">{item.definition}</p>
                <p className="text-lg text-stone-400 italic">"{item.example_sentence}"</p>
              </div>
            ))}
          </div>

          <button
            onClick={() => setQuizStep('questions')}
            className="w-full bg-purple-600 text-white font-black py-8 rounded-[3rem] shadow-[0_20px_0_0_rgb(126,34,206)] hover:shadow-[0_15px_0_0_rgb(126,34,206)] active:shadow-none active:translate-y-4 text-3xl transition-all"
          >
            I'm Ready for the Quiz! <i className="fas fa-bolt ml-2"></i>
          </button>
        </div>
      );
    }

    const q = quizData.quiz[currentQuestionIdx];
    const progress = ((currentQuestionIdx + 1) / quizData.quiz.length) * 100;

    return (
      <div className="max-w-3xl mx-auto p-6 space-y-12 animate-fadeIn relative z-10">
        <div className="flex flex-col items-center gap-6">
          <div className="w-full h-4 bg-stone-200 rounded-full overflow-hidden shadow-inner">
            <div className="h-full bg-purple-500 transition-all duration-500" style={{ width: `${progress}%` }} />
          </div>
          <p className="text-2xl font-black text-purple-600 uppercase tracking-widest">Question {currentQuestionIdx + 1} of {quizData.quiz.length}</p>
        </div>

        <div className="bg-white p-12 md:p-16 rounded-[4rem] shadow-2xl border-b-[16px] border-stone-100 space-y-12">
          <h2 className="text-4xl font-black text-stone-800 text-center leading-tight">{q.question}</h2>

          <div className="grid grid-cols-1 gap-6">
            {q.options.map((opt, idx) => {
              let btnClass = "bg-stone-50 border-stone-200 text-stone-700";
              if (isAnswered) {
                if (opt === q.correct_answer) {
                  btnClass = "bg-green-100 border-green-400 text-green-700 shadow-[0_8px_0_0_rgb(74,222,128)] translate-y-2";
                } else if (opt === selectedAnswer) {
                  btnClass = "bg-red-100 border-red-400 text-red-700 opacity-50";
                } else {
                  btnClass = "bg-stone-50 border-stone-100 text-stone-300 opacity-30";
                }
              } else {
                btnClass = "bg-white border-stone-100 text-stone-700 hover:bg-stone-50 hover:border-purple-200 hover:-translate-y-2";
              }

              return (
                <button
                  key={idx}
                  disabled={isAnswered}
                  onClick={() => handleQuizAnswer(opt)}
                  className={`p-8 rounded-[2.5rem] border-4 text-2xl font-black transition-all text-center flex items-center justify-center gap-4 ${btnClass} shadow-md`}
                >
                  {isAnswered && opt === q.correct_answer && <i className="fas fa-check-circle"></i>}
                  {isAnswered && opt === selectedAnswer && opt !== q.correct_answer && <i className="fas fa-times-circle"></i>}
                  {opt}
                </button>
              );
            })}
          </div>

          {isAnswered && (
            <div className="pt-6 animate-bounce text-center">
              <button
                onClick={nextQuizQuestion}
                className="bg-orange-500 text-white px-12 py-6 rounded-full text-3xl font-black shadow-xl hover:bg-orange-600 transition-all active:scale-95"
              >
                {currentQuestionIdx === quizData.quiz.length - 1 ? "Finish Journey" : "Next Question"} <i className="fas fa-arrow-right ml-2"></i>
              </button>
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderDashboard = () => (
    <div className="max-w-5xl mx-auto p-6 space-y-12 animate-fadeIn relative z-10">
      <div className="text-center space-y-4">
        <h1 className="text-6xl md:text-8xl text-purple-600 drop-shadow-md">My Adventure Journal</h1>
        <p className="text-2xl text-stone-600 font-medium">Look at all the magic worlds you've explored!</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
        <div className="bg-white p-8 rounded-[3rem] shadow-xl border-b-8 border-purple-200 flex flex-col items-center justify-center space-y-2">
          <span className="text-5xl">🌍</span>
          <p className="text-4xl font-black text-purple-600">{storyHistory.length}</p>
          <p className="text-stone-500 font-bold uppercase tracking-widest text-sm">Worlds Explored</p>
        </div>
        <div className="bg-white p-8 rounded-[3rem] shadow-xl border-b-8 border-yellow-200 flex flex-col items-center justify-center space-y-2">
          <span className="text-5xl">✨</span>
          <p className="text-4xl font-black text-yellow-600">{totalSparkPoints}</p>
          <p className="text-stone-500 font-bold uppercase tracking-widest text-sm">Total Sparkle</p>
        </div>
        <div className="bg-white p-8 rounded-[3rem] shadow-xl border-b-8 border-green-200 flex flex-col items-center justify-center space-y-2">
          <span className="text-5xl">🤝</span>
          <p className="text-4xl font-black text-green-600">{unlockedCompanions.length}</p>
          <p className="text-stone-500 font-bold uppercase tracking-widest text-sm">Friends Met</p>
        </div>
      </div>

      <div className="bg-white/50 backdrop-blur-md p-10 md:p-16 rounded-[4rem] shadow-2xl border-4 border-white space-y-8">
        <h2 className="text-4xl font-black text-stone-800 flex items-center gap-4">
          <i className="fas fa-book-open text-purple-500"></i> Past Stories
        </h2>

        {storyHistory.length === 0 ? (
          <div className="text-center py-20 space-y-6">
            <div className="text-8xl opacity-20 grayscale">📖</div>
            <p className="text-2xl text-stone-400 font-bold">Your journal is empty! Time to start a new quest.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {storyHistory.map(item => (
              <div key={item.id} className="bg-white p-6 rounded-[2.5rem] shadow-md border-2 border-stone-50 hover:border-purple-200 transition-all group">
                <div className="flex items-start gap-4">
                  <div className="w-16 h-16 bg-purple-50 rounded-2xl flex items-center justify-center text-3xl group-hover:scale-110 transition-transform">
                    🎨
                  </div>
                  <div className="flex-1 space-y-1">
                    <h3 className="text-xl font-black text-stone-800 line-clamp-1">{item.title}</h3>
                    <p className="text-stone-400 font-bold text-sm uppercase tracking-tighter italic">{item.topic}</p>
                    <div className="flex items-center justify-between pt-2">
                      <span className="text-xs font-black text-purple-400">{item.date}</span>
                      <span className="bg-yellow-50 text-yellow-600 px-3 py-1 rounded-full text-xs font-bold border border-yellow-100">
                        {item.sticker}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <button
        onClick={() => setStep(AppStep.HERO_SETUP)}
        className="w-full bg-purple-600 text-white font-black py-8 rounded-[3rem] shadow-[0_20px_0_0_rgb(126,34,206)] hover:shadow-[0_15px_0_0_rgb(126,34,206)] active:shadow-none active:translate-y-4 text-3xl transition-all"
      >
        <i className="fas fa-arrow-left mr-4"></i> Back to Start
      </button>
    </div>
  );

  const renderSetup = () => (
    <div className="max-w-4xl mx-auto p-4 md:p-8 space-y-12 animate-fadeIn relative z-10">
      <div className="flex justify-between items-center px-4">
        <div className="flex justify-center items-center gap-4 text-2xl relative">
          <div className="flex flex-col items-center">
            <div className="w-14 h-14 bg-orange-500 text-white rounded-full flex items-center justify-center shadow-lg ring-8 ring-orange-50 z-10">
              <i className="fas fa-user-astronaut"></i>
            </div>
            <span className="text-sm font-bold mt-2 text-orange-600 uppercase tracking-tighter">Hero</span>
          </div>
          <div className="h-1 w-16 bg-stone-200 rounded-full scroll-map-path"></div>
          <div className="flex flex-col items-center opacity-30">
            <div className="w-14 h-14 bg-stone-300 text-white rounded-full flex items-center justify-center">
              <i className="fas fa-compass"></i>
            </div>
            <span className="text-sm font-bold mt-2 text-stone-500 uppercase tracking-tighter">Quest</span>
          </div>
        </div>

        <button
          onClick={() => setStep(AppStep.DASHBOARD)}
          className="flex items-center gap-3 bg-white px-6 py-3 rounded-full font-black text-purple-600 border-2 border-purple-100 hover:bg-purple-50 transition-all shadow-sm group"
        >
          <i className="fas fa-book-open group-hover:rotate-12 transition-transform"></i>
          My Adventures
        </button>
      </div>

      <div className="text-center space-y-4">
        <h1 className="text-6xl md:text-8xl text-orange-600 drop-shadow-md">Choose Your Hero!</h1>
        <p className="text-2xl text-stone-600 max-w-xl mx-auto leading-relaxed font-medium">
          Every great story needs a brave explorer. Who will you be today?
        </p>
      </div>

      <div className="bg-white rounded-[4rem] p-10 md:p-16 shadow-2xl border-b-[16px] border-stone-200 border-x-4 border-orange-50 space-y-16 transition-all relative overflow-hidden">
        <i className="fas fa-magic absolute -top-10 -right-10 text-[15rem] text-orange-50/50 -rotate-12 pointer-events-none"></i>

        <div className="text-center space-y-8 relative">
          <label className="text-3xl font-black text-stone-800 block">What shall we call you, Brave Explorer?</label>
          <div className="relative max-w-lg mx-auto">
            <input
              type="text"
              className="w-full p-4 text-center text-5xl font-black text-orange-600 border-b-8 border-dashed border-orange-100 focus:border-orange-500 bg-transparent outline-none transition-all placeholder:text-stone-100"
              value={hero.name}
              onChange={e => setHero({ ...hero, name: e.target.value })}
              placeholder="Your Hero Name..."
              maxLength={15}
            />
          </div>
          {hero.name && (
            <div className="animate-bounce flex items-center justify-center gap-2">
              <span className="text-2xl">✨</span>
              <p className="text-purple-600 text-2xl font-black italic">A legendary name, {hero.name}!</p>
              <span className="text-2xl">✨</span>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-16">
          <div className="space-y-8">
            <label className="text-2xl font-black text-stone-800 flex items-center gap-3">
              <span className="w-10 h-10 bg-yellow-400 rounded-2xl flex items-center justify-center text-white text-xl shadow-sm">
                🎂
              </span>
              How many candles on your cake?
            </label>
            <div className="flex items-center gap-6 bg-stone-50 p-6 rounded-[2.5rem] justify-between border-4 border-stone-100 shadow-inner">
              <button
                onClick={() => setHero({ ...hero, age: Math.max(3, hero.age - 1) })}
                className="w-16 h-16 bg-white rounded-2xl shadow-md border-b-4 border-stone-200 text-3xl font-black text-stone-400 hover:text-orange-500 hover:border-orange-200 active:scale-90 transition-all"
              >
                –
              </button>
              <div className="text-center">
                <span className="text-7xl font-black text-stone-800 leading-none">{hero.age}</span>
                <p className="text-stone-400 font-bold text-sm uppercase">Years Old</p>
              </div>
              <button
                onClick={() => setHero({ ...hero, age: Math.min(12, hero.age + 1) })}
                className="w-16 h-16 bg-white rounded-2xl shadow-md border-b-4 border-stone-200 text-3xl font-black text-stone-400 hover:text-orange-500 hover:border-orange-200 active:scale-90 transition-all"
              >
                +
              </button>
            </div>
          </div>

          <div className="space-y-8">
            <label className="text-2xl font-black text-stone-800 flex items-center gap-3">
              <span className="w-10 h-10 bg-orange-400 rounded-2xl flex items-center justify-center text-white text-xl shadow-sm">
                🎨
              </span>
              Choose your look!
            </label>
            <div className="grid grid-cols-5 gap-4">
              {SKIN_TONES.map(s => (
                <button
                  key={s}
                  onClick={() => setHero({ ...hero, skinTone: s })}
                  className={`aspect-square rounded-2xl border-4 transition-all transform hover:rotate-6 ${
                    hero.skinTone === s ? 'border-orange-500 scale-125 shadow-xl rotate-0 z-10' : 'border-white hover:border-stone-200'
                  }`}
                  style={{
                    backgroundColor:
                      s === 'Porcelain'
                        ? '#FFE0D1'
                        : s === 'Honey'
                        ? '#F3C594'
                        : s === 'Bronze'
                        ? '#D99164'
                        : s === 'Caramel'
                        ? '#9C623E'
                        : '#4E2C1A'
                  }}
                  title={s}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-8">
          <div className="flex items-center justify-between gap-3">
            <label className="text-2xl font-black text-stone-800 flex items-center gap-3">
              <span className="w-10 h-10 bg-purple-400 rounded-2xl flex items-center justify-center text-white text-xl shadow-sm">
                🎒
              </span>
              Pick your Magic Gear!
            </label>
            <button
              onClick={handleBlindBox}
              disabled={isBlindBoxRolling}
              className={`flex items-center gap-2 px-6 py-3 rounded-full font-black text-purple-600 bg-purple-50 transition-all border-4 shadow-sm ${
                isBlindBoxRolling ? 'animate-shake animate-rainbow scale-95' : 'hover:scale-105 active:scale-95 border-purple-200 hover:bg-purple-100'
              }`}
            >
              <i className={`fas ${isBlindBoxRolling ? 'fa-magic fa-spin' : 'fa-gift'}`}></i>
              {isBlindBoxRolling ? 'Casting Magic...' : 'Surprise Me!'}
            </button>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            {PROPS.map(p => {
              const isSelected = hero.prop === p;
              const isRolling = rollingProp === p;
              const isFinalReveal = finalRevealProp === p;
              
              let icon = '';
              switch (p) {
                case 'None': icon = '👋'; break;
                case 'Smart Glasses': icon = '👓'; break;
                case 'Hero Cape': icon = '🧥'; break;
                case 'Shiny Crown': icon = '👑'; break;
                case 'Star Wand': icon = '🪄'; break;
                case 'Explorer Bag': icon = '🎒'; break;
                case 'Magic Camera': icon = '📸'; break;
              }

              return (
                <button
                  key={p}
                  disabled={isBlindBoxRolling}
                  onClick={() => setHero({ ...hero, prop: p })}
                  className={`p-6 rounded-[2rem] border-4 transition-all text-left flex flex-col items-center justify-center gap-4 relative overflow-hidden ${
                    isSelected && !isBlindBoxRolling
                      ? 'border-purple-500 bg-purple-50 scale-105 shadow-xl ring-8 ring-purple-100 z-10'
                      : isRolling
                      ? 'border-yellow-400 bg-yellow-50 scale-110 shadow-2xl z-20 magical-glow'
                      : isFinalReveal
                      ? 'border-orange-500 bg-orange-50 scale-110 shadow-2xl z-20 animate-magic-reveal'
                      : 'border-stone-100 bg-white hover:bg-stone-50 hover:border-stone-200'
                  }`}
                >
                  <span className={`text-6xl drop-shadow-sm transition-transform ${isRolling ? 'animate-slot-blur' : ''} ${isFinalReveal ? 'animate-pop-in' : ''}`}>
                    {icon}
                  </span>
                  <span className="font-black text-lg text-stone-700 text-center">{p === 'None' ? 'Just Me' : p}</span>
                  
                  {isRolling && (
                    <div className="absolute inset-0 bg-purple-500/5 pointer-events-none animate-pulse"></div>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <button
          onClick={() => setStep(AppStep.COMPANION_SELECTION)}
          disabled={!hero.name || isBlindBoxRolling}
          className="w-full bg-orange-500 hover:bg-orange-600 text-white font-black py-8 rounded-[3rem] shadow-[0_20px_0_0_rgb(234,88,12)] hover:shadow-[0_15px_0_0_rgb(234,88,12)] active:shadow-none active:translate-y-4 text-3xl transition-all disabled:opacity-50 flex items-center justify-center gap-4 mt-8"
        >
          Next: Choose Friends! <i className="fas fa-arrow-right"></i>
        </button>
      </div>
    </div>
  );

  const renderCompanions = () => (
    <div className="max-w-4xl mx-auto p-6 space-y-8 animate-fadeIn relative z-10">
      <div className="flex justify-center items-center gap-4 text-2xl mb-12">
        <div className="flex flex-col items-center">
          <div className="w-14 h-14 bg-green-500 text-white rounded-full flex items-center justify-center shadow-lg">
            <i className="fas fa-check"></i>
          </div>
          <span className="text-sm font-bold mt-2 text-green-600 uppercase">Hero</span>
        </div>
        <div className="h-1 w-16 bg-green-500 rounded-full"></div>
        <div className="flex flex-col items-center">
          <div className="w-14 h-14 bg-orange-500 text-white rounded-full flex items-center justify-center shadow-lg ring-8 ring-orange-100">
            <i className="fas fa-map-marked-alt"></i>
          </div>
          <span className="text-sm font-bold mt-2 text-orange-600 uppercase">Quest</span>
        </div>
      </div>

      <div className="text-center">
        <h2 className="text-6xl text-purple-600 mb-2">Who is coming with you?</h2>
        <p className="text-2xl text-stone-600 font-medium">Pick up to 3 magical companions!</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {unlockedCompanions.map(comp => {
          const isSelected = selectedCompanions.find(c => c.id === comp.id);
          return (
            <div
              key={comp.id}
              onClick={() => {
                if (isSelected) {
                  setSelectedCompanions(selectedCompanions.filter(c => c.id !== comp.id));
                } else if (selectedCompanions.length < 3) {
                  setSelectedCompanions([...selectedCompanions, comp]);
                }
              }}
              className={`p-8 rounded-[3rem] border-4 cursor-pointer transition-all ${
                isSelected ? 'border-purple-500 bg-purple-50 scale-105 shadow-2xl rotate-2' : 'border-white bg-white hover:border-purple-100 shadow-xl hover:-translate-y-2'
              }`}
            >
              <div className="text-7xl mb-6 text-center">{comp.emoji}</div>
              <h3 className="text-3xl font-black text-center text-stone-800">{comp.name}</h3>
              <p className="text-lg text-stone-500 text-center mt-4 leading-relaxed font-medium">{comp.personality}</p>
              {isSelected && (
                <div className="mt-4 flex justify-center">
                  <span className="bg-purple-500 text-white text-xs font-black px-3 py-1 rounded-full uppercase tracking-widest">
                    Selected!
                  </span>
                </div>
              )}
            </div>
          );
        })}

        {nextCompanionUnlock && (
          <div className="p-8 rounded-[3rem] border-4 border-dashed border-stone-200 bg-stone-50/50 flex flex-col items-center justify-center opacity-60">
            <div className="text-7xl mb-6 grayscale filter">❓</div>
            <h3 className="text-2xl font-black text-stone-400">Locked Friend</h3>
            <p className="text-sm text-stone-400 text-center mt-2">
              Earn {(nextCompanionUnlock.unlockThreshold || 0) - totalSparkPoints} more Spark Points to meet them!
            </p>
          </div>
        )}
      </div>

      <div className="bg-white p-10 md:p-16 rounded-[4rem] shadow-2xl border-b-[16px] border-stone-200 space-y-12 relative overflow-hidden">
        <i className="fas fa-feather-alt absolute -bottom-10 -left-10 text-[12rem] text-purple-50 -rotate-12"></i>

        <div className="space-y-6 relative">
          <div className="flex items-center justify-between">
            <label className="block text-3xl font-black text-stone-800">What is the story about?</label>
            <button
              onClick={handleRandomTopic}
              className="text-purple-600 font-black flex items-center gap-2 hover:scale-110 transition-transform active:scale-95"
            >
              <i className="fas fa-magic"></i> Surprise Me!
            </button>
          </div>
          <div className="relative">
            <input
              type="text"
              className="w-full p-8 rounded-[2.5rem] border-4 border-stone-100 text-3xl font-bold text-purple-600 focus:border-purple-400 outline-none placeholder:text-stone-200 text-center bg-stone-50 focus:bg-white transition-all shadow-inner"
              placeholder="e.g. A space adventure, A magic garden..."
              value={topic}
              onChange={e => setTopic(e.target.value)}
            />
          </div>

          <div className="space-y-4">
            <p className="text-center text-stone-400 font-bold text-sm uppercase tracking-widest">Need a spark of inspiration? Tap one!</p>
            <div className="flex flex-wrap justify-center gap-3">
              {randomInspirations.map(insp => (
                <button
                  key={insp}
                  onClick={() => setTopic(insp)}
                  className="bg-stone-50 hover:bg-purple-50 border-2 border-stone-100 hover:border-purple-200 px-6 py-3 rounded-2xl text-stone-600 hover:text-purple-700 font-bold transition-all shadow-sm active:scale-95"
                >
                  {insp}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-8 relative">
          <label className="block text-2xl font-black text-stone-800 text-center">Storyteller Style</label>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-2xl mx-auto">
            <button
              onClick={() => setHero({ ...hero, narrationMode: 'single' })}
              className={`p-6 rounded-[2rem] border-4 transition-all flex items-center gap-4 ${
                hero.narrationMode === 'single' ? 'border-orange-500 bg-orange-50 scale-105 shadow-md' : 'border-stone-100 bg-white hover:bg-stone-50'
              }`}
            >
              <div className="w-16 h-16 bg-white rounded-2xl flex items-center justify-center text-4xl shadow-sm">👤</div>
              <div className="text-left">
                <p className="font-black text-xl text-stone-800">One Storyteller</p>
                <p className="text-sm text-stone-500">The same warm voice throughout.</p>
              </div>
            </button>

            <button
              onClick={() => setHero({ ...hero, narrationMode: 'magical' })}
              className={`p-6 rounded-[2rem] border-4 transition-all flex items-center gap-4 ${
                hero.narrationMode === 'magical' ? 'border-purple-500 bg-purple-50 scale-105 shadow-md' : 'border-stone-100 bg-white hover:bg-stone-50'
              }`}
            >
              <div className="w-16 h-16 bg-white rounded-2xl flex items-center justify-center text-4xl shadow-sm">✨</div>
              <div className="text-left">
                <p className="font-black text-xl text-stone-800">Magical Voices</p>
                <p className="text-sm text-stone-500">Voices change with the magic!</p>
              </div>
            </button>
          </div>
        </div>

        <div className="space-y-6">
          <label className="block text-2xl font-black text-stone-800 text-center italic">How should the story feel?</label>
          <div className="flex flex-wrap justify-center gap-4">
            {MOODS.map(m => (
              <button
                key={m}
                onClick={() => setMood(m as Mood)}
                className={`px-10 py-4 rounded-full font-black text-xl transition-all ${
                  mood === m ? 'bg-purple-600 text-white shadow-xl scale-110' : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col md:flex-row gap-6 pt-10">
          <button
            onClick={() => setStep(AppStep.HERO_SETUP)}
            className="order-2 md:order-1 flex-1 bg-stone-100 text-stone-600 py-8 rounded-[3rem] font-black text-2xl hover:bg-stone-200 transition-colors"
          >
            Back
          </button>
          <button
            onClick={startGeneration}
            disabled={!topic}
            className="order-1 md:order-2 flex-[2] bg-purple-600 hover:bg-purple-700 text-white font-black py-8 rounded-[3rem] shadow-[0_20px_0_0_rgb(126,34,206)] hover:shadow-[0_15px_0_0_rgb(126,34,206)] active:shadow-none active:translate-y-4 text-3xl transition-all disabled:opacity-50 flex items-center justify-center gap-4"
          >
            Start My Journey! <i className="fas fa-sparkles"></i>
          </button>
        </div>
      </div>
    </div>
  );

  const renderGenerating = () => (
    <div className="flex flex-col items-center justify-center min-h-[80vh] text-center p-6 space-y-12 animate-fadeIn relative z-10">
      <div className="relative">
        <div className="w-48 h-48 border-[20px] border-orange-100 border-t-orange-500 rounded-full animate-spin"></div>
        <div className="absolute inset-0 flex items-center justify-center">
          <i className="fas fa-magic text-orange-500 text-6xl animate-pulse"></i>
        </div>
      </div>
      <div className="space-y-6">
        <h2 className="text-5xl font-black text-stone-800">{loadingMsg}</h2>
        {imageProgress.total > 0 && (
          <div className="max-w-md w-full mx-auto space-y-4">
             <div className="space-y-2">
              <div className="w-full h-4 bg-stone-200 rounded-full overflow-hidden shadow-inner">
                <div 
                  className="h-full bg-orange-500 transition-all duration-500" 
                  style={{ width: `${(imageProgress.current / imageProgress.total) * 100}%` }} 
                />
              </div>
              <p className="text-xs font-black text-stone-400 uppercase tracking-widest">
                Painting magic scenes... {imageProgress.current}/{imageProgress.total}
              </p>
            </div>
            <div className="space-y-2">
              <div className="w-full h-4 bg-stone-200 rounded-full overflow-hidden shadow-inner">
                <div 
                  className="h-full bg-purple-500 transition-all duration-500" 
                  style={{ width: `${(audioProgress.current / audioProgress.total) * 100}%` }} 
                />
              </div>
              <p className="text-xs font-black text-stone-400 uppercase tracking-widest">
                Warming up magical voices... {audioProgress.current}/{audioProgress.total}
              </p>
            </div>
          </div>
        )}
        <p className="text-2xl text-stone-500 italic font-medium max-w-xl mx-auto leading-relaxed">
          "The story wizards are busy mixing magic words and painting sparkly stars for your adventure..."
        </p>
      </div>
    </div>
  );

  const renderReader = () => {
    if (!story) return null;
    const page = story.pages[currentPage];
    const isAudioReady = !!audioBase64ByPageRef.current[currentPage];

    return (
      <div className="max-w-7xl mx-auto p-4 md:p-8 space-y-10 animate-fadeIn relative z-10">
        <div className="flex justify-between items-center bg-white/70 backdrop-blur-md p-6 rounded-[3rem] shadow-lg border-2 border-white">
          <h2 className="text-3xl md:text-5xl text-stone-800 truncate pr-8 drop-shadow-sm">{story.story_title}</h2>
          <div className="bg-orange-500 px-8 py-3 rounded-full font-black text-white shadow-xl whitespace-nowrap text-xl">
            Page {currentPage + 1} <span className="text-orange-200 mx-1">/</span> 5
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 bg-white p-8 md:p-16 rounded-[5rem] shadow-[0_40px_100px_-20px_rgba(0,0,0,0.1)] border-b-[20px] border-stone-200 border-x-4 border-white/50 relative">
          <div className="flex flex-col space-y-8">
            <div className="relative group overflow-hidden rounded-[4rem] shadow-inner border-[6px] border-stone-50 bg-stone-50 aspect-square flex items-center justify-center">
              {page.image_url ? (
                <img src={page.image_url} alt="Story scene" className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105" />
              ) : (
                <div className="text-center space-y-4">
                  <i className="fas fa-paint-brush text-7xl text-stone-200 animate-bounce"></i>
                  <p className="text-stone-400 font-black text-xl">Painting your adventure...</p>
                </div>
              )}
            </div>

            {/* Narration Controls */}
            <div className="bg-stone-50 p-6 rounded-[3rem] border-4 border-stone-100 flex items-center justify-center gap-4 shadow-inner">
              <div className="flex items-center gap-3">
                <button
                  onClick={stopNarration}
                  className="w-16 h-16 rounded-2xl bg-white border-b-4 border-stone-200 flex items-center justify-center text-stone-400 hover:text-red-500 hover:border-red-200 transition-all active:scale-90"
                  title="Stop"
                >
                  <i className="fas fa-stop text-2xl"></i>
                </button>

                {narrationStatus === 'playing' ? (
                  <button
                    onClick={pauseNarration}
                    className="w-20 h-20 rounded-2xl bg-white border-b-4 border-purple-200 flex items-center justify-center text-purple-600 hover:bg-purple-50 transition-all active:scale-90 shadow-sm"
                    title="Pause"
                  >
                    <i className="fas fa-pause text-3xl"></i>
                  </button>
                ) : (
                  <button
                    onClick={playNarration}
                    disabled={!isAudioReady || narrationStatus === 'loading'}
                    className={`w-20 h-20 rounded-2xl bg-orange-500 border-b-4 border-orange-700 flex items-center justify-center text-white hover:bg-orange-600 transition-all active:scale-90 shadow-lg ${
                      !isAudioReady ? 'opacity-30' : ''
                    }`}
                    title={isAudioReady ? "Play" : "Audio unavailable"}
                  >
                    <i className={`fas ${narrationStatus === 'loading' ? 'fa-spinner fa-spin' : 'fa-play'} text-3xl`}></i>
                  </button>
                )}
              </div>

              <div className="flex-1 px-4">
                <div className="h-2 bg-stone-200 rounded-full overflow-hidden">
                  <div
                    className={`h-full bg-orange-400 transition-all duration-300 ${narrationStatus === 'playing' ? 'opacity-100' : 'opacity-50'}`}
                    style={{ width: duration > 0 ? `${(playhead / duration) * 100}%` : '0%' }}
                  />
                </div>

                <div className="flex justify-between text-xs font-black text-stone-400 mt-2 uppercase tracking-widest">
                  <span>{fmtTime(playhead)}</span>
                  <span>{fmtTime(duration)}</span>
                </div>

                <p className="text-xs font-black text-stone-400 mt-2 uppercase tracking-widest text-center">
                  {narrationStatus === 'loading' ? 'Deciphering magic...' : (isAudioReady ? 'Narration Ready' : 'Audio Unavailable')}
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-col justify-between space-y-12 py-4">
            <div className="prose prose-stone prose-2xl max-w-none">
              <p className="text-4xl leading-[1.7] text-stone-800 font-bold whitespace-pre-wrap selection:bg-orange-100">
                {page.text.replace(/\[.*?\]/g, '')}
              </p>
            </div>

            <div className="space-y-8 pt-8 border-t-4 border-stone-50">
              {currentPage === 0 && (
                <div className="space-y-4">
                  <p className="text-sm font-black text-purple-400 uppercase tracking-[0.2em]">New Adventure Words</p>
                  <div className="flex flex-wrap gap-3">
                    {story.tricky_words.map(w => (
                      <span
                        key={w}
                        className="bg-purple-50 text-purple-600 px-6 py-2 rounded-[1.5rem] text-2xl font-black border-4 border-purple-100 shadow-sm hover:scale-110 transition-transform cursor-default"
                      >
                        {w}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex gap-6">
                <button
                  disabled={currentPage === 0}
                  onClick={() => handlePageChange(currentPage - 1)}
                  className="flex-1 bg-stone-100 text-orange-600 py-8 rounded-[3rem] font-black text-2xl disabled:opacity-30 hover:bg-stone-200 transition-all flex items-center justify-center gap-3 border-b-8 border-stone-200"
                >
                  <i className="fas fa-arrow-left text-orange-600"></i> Back
                </button>
                <button
                  onClick={() => (currentPage === 4 ? handleAdventureComplete() : handlePageChange(currentPage + 1))}
                  className="flex-1 bg-orange-500 text-white py-8 rounded-[3rem] font-black text-2xl shadow-xl hover:bg-orange-600 transition-all flex items-center justify-center gap-3 border-b-8 border-orange-700"
                >
                  {currentPage === 4 ? 'Adventure Complete' : 'Next Page'} <i className="fas fa-arrow-right ml-2"></i>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderRewards = () => {
    if (!story) return null;
    return (
      <div className="max-w-4xl mx-auto p-6 space-y-12 animate-fadeIn text-center relative z-10">
        <div className="space-y-6 relative py-10">
          <div className="text-9xl animate-bounce mb-8 drop-shadow-2xl">🏆</div>
          <h2 className="text-7xl md:text-8xl text-orange-600 drop-shadow-sm">Great Job, Explorer!</h2>
          <p className="text-3xl text-stone-600 font-bold">You completed an amazing journey with {hero.name}!</p>
        </div>

        <div className="bg-white rounded-[5rem] p-12 md:p-20 shadow-2xl border-b-[20px] border-yellow-200 border-x-4 border-white space-y-16 relative overflow-hidden">
          <i className="fas fa-star absolute -top-10 -right-10 text-[18rem] text-yellow-50 rotate-12 pointer-events-none"></i>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 relative">
            <div className="p-10 bg-yellow-50 rounded-[4rem] border-4 border-yellow-100 transform hover:scale-105 transition-all shadow-xl">
              <div className="text-7xl mb-6">✨</div>
              <p className="text-2xl font-black text-yellow-800 uppercase tracking-widest">Spark Points</p>
              <p className="text-8xl font-black text-yellow-600 mt-4 leading-none">+{story.spark_points_earned + quizScore}</p>
              <div className="flex flex-col gap-1 mt-2">
                <p className="text-sm text-yellow-500 font-bold tracking-widest">({story.spark_points_earned} Story + {quizScore} Bonus)</p>
                <p className="text-lg text-yellow-600 font-black uppercase tracking-tighter">Total: {totalSparkPoints}</p>
              </div>
            </div>
            <div className="p-10 bg-blue-50 rounded-[4rem] border-4 border-blue-100 transform hover:scale-105 transition-all shadow-xl">
              <div className="text-7xl mb-6">🎨</div>
              <p className="text-2xl font-black text-blue-800 uppercase tracking-widest">New Sticker</p>
              <p className="text-4xl font-black text-blue-600 mt-6 leading-tight italic">"{story.magic_sticker}"</p>
            </div>
          </div>

          <button
            onClick={() => {
              setStep(AppStep.HERO_SETUP);
              setHero({ ...hero, name: '' });
              setSelectedCompanions([]);
              setTopic('');
              setStory(null);
              setQuizData(null);
              setQuizScore(0);
              setCurrentQuestionIdx(0);
              setCurrentPage(0);
              stopNarration();
            }}
            className="w-full bg-orange-500 text-white font-black py-10 rounded-[4rem] shadow-[0_25px_0_0_rgb(234,88,12)] hover:shadow-[0_15px_0_0_rgb(234,88,12)] active:shadow-none active:translate-y-6 text-4xl transition-all flex items-center justify-center gap-6"
          >
            New Adventure <i className="fas fa-redo-alt"></i>
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-[#FDF6E3] sparkle-bg py-20 px-6 relative overflow-x-hidden">
      <FloatingSparkles />
      {step === AppStep.HERO_SETUP && renderSetup()}
      {step === AppStep.COMPANION_SELECTION && renderCompanions()}
      {step === AppStep.GENERATING && renderGenerating()}
      {step === AppStep.STORY_READER && renderReader()}
      {step === AppStep.QUIZ && renderQuiz()}
      {step === AppStep.REWARDS && renderRewards()}
      {step === AppStep.DASHBOARD && renderDashboard()}
    </div>
  );
};

export default App;
