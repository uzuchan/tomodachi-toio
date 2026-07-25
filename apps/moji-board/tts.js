/* tts.js — VOICEVOX ローカルエンジン優先の読み上げ。無ければ Web Speech API へ自動フォールバック。
   使い方: TTS.speak('こんにちは')  /  TTS.speak('...', {speaker: 3, speed: 1.2})
   ・VOICEVOXアプリ(エンジン)を起動しておくと http://127.0.0.1:50021 を自動検出
   ・URLに ?vv=http://host:50021 を付けるとエンジンの場所を変えられる
   ・話者ID: 1=ずんだもん(あまあま) 3=ずんだもん(ノーマル) 0=四国めたん(あまあま) 2=めたん(ノーマル)
*/
const TTS = (() => {
  const VV_URL = new URLSearchParams(location.search).get('vv') || 'http://127.0.0.1:50021';
  const DEFAULT_SPEAKER = 1;          // ずんだもん あまあま（かわいい寄り）
  let available = null, audio = null, probing = null;

  async function probe() {
    if (probing) return probing;
    probing = (async () => {
      try {
        const ctl = new AbortController();
        setTimeout(() => ctl.abort(), 1500);
        const r = await fetch(`${VV_URL}/version`, { signal: ctl.signal });
        available = r.ok;
        if (available) console.log('[TTS] VOICEVOX engine', await r.text());
      } catch (e) { available = false; }
      console.log('[TTS] VOICEVOX', available ? 'あり' : 'なし → Web Speech APIで代用');
      return available;
    })();
    return probing;
  }
  probe();

  async function speak(text, opt = {}) {
    const t = String(text).replace(/[♡♥]/g, '').trim();
    if (!t) return;
    if (available === null) await probe();

    if (available && opt.lang !== 'en-US') {
      try {
        const sp = opt.speaker ?? DEFAULT_SPEAKER;
        const qr = await fetch(`${VV_URL}/audio_query?text=${encodeURIComponent(t)}&speaker=${sp}`,
                               { method: 'POST' });
        const q = await qr.json();
        q.speedScale      = opt.speed ?? 1.1;
        q.pitchScale      = opt.pitch ?? 0.04;
        q.intonationScale = opt.intonation ?? 1.25;
        const wav = await (await fetch(`${VV_URL}/synthesis?speaker=${sp}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(q),
        })).arrayBuffer();
        if (audio) { audio.pause(); URL.revokeObjectURL(audio.src); }
        audio = new Audio(URL.createObjectURL(new Blob([wav], { type: 'audio/wav' })));
        audio.play().catch(() => {});
        return;
      } catch (e) { console.warn('[TTS] VOICEVOX失敗→fallback', e); available = false; }
    }
    if (!window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(t);
    u.lang = opt.lang || 'ja-JP';
    u.pitch = opt.webPitch ?? 1.7; u.rate = opt.webRate ?? 1.1;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }

  return { speak, probe, get available() { return available; }, url: VV_URL };
})();
